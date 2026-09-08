// MYRAA voice pipeline core — framework-free so node --test can verify it.
// Single ordered queue, single playback worker, session IDs, duplicate guard,
// interruption clearing, and a strict voice state machine.
// Audio transport (WebSocket, AudioContext) lives in App.tsx; this module owns
// ordering, lifecycle, and state. No secrets are ever logged here.
let sessionCounter = 0;
export function newSessionId() {
  sessionCounter += 1;
  return `VOICE_SESSION_${String(sessionCounter).padStart(3, '0')}`;
}

export const STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'INTERRUPTED', 'STOPPING', 'ERROR'];
const TRANSITIONS = {
  IDLE: ['LISTENING', 'STOPPING'],
  LISTENING: ['THINKING', 'STOPPING', 'IDLE', 'ERROR'],
  THINKING: ['SPEAKING', 'LISTENING', 'STOPPING', 'IDLE', 'ERROR'],
  SPEAKING: ['INTERRUPTED', 'IDLE', 'STOPPING', 'THINKING', 'ERROR'],
  INTERRUPTED: ['LISTENING', 'STOPPING', 'IDLE'],
  STOPPING: ['IDLE'],
  ERROR: ['IDLE', 'LISTENING'],
};

export class VoiceSession {
  constructor(onLog) {
    this.id = newSessionId();
    this.state = 'IDLE';
    this.queue = []; // {chunkId, seq, status: RECEIVED|QUEUED|PLAYING|COMPLETED}
    this.byId = new Map();
    this.seen = new Set(); // recent chunkIds for duplicate guard
    this.seq = 0;
    this.playing = false; // single-worker guard
    this.cleaned = false;
    this.retired = false; // GoAway rotation: no NEW chunks, old queue drains via pump
    this.generation = 0; // connection generation that owns this audio session
    this.log = onLog || (() => {});
    // ---- ordered-playback + diagnostics (audio-quality fix) ----
    this.expectedSeq = undefined; // next expected incoming seq
    this.nextPlaySeq = undefined; // next seq the playback worker should release
    this.gapWaitStart = null; // timestamp when current playback gap started waiting
    // LATENCY FIX: 250ms (was 350ms) — still absorbs normal WS jitter while
    // cutting tail latency when a chunk is genuinely lost (it gets skipped).
    this.maxGapWaitMs = 250; // never stall forever on one missing chunk
    this.diag = {
      incomingChunks: 0,
      playedChunks: 0,
      duplicateChunks: 0,
      outOfOrderChunks: 0,
      missingSequences: 0,
      skippedSequences: 0,
    };
  }

  // Retire on GoAway: receive() rejects from here on; already-queued audio
  // is left for the caller to drain (no mixing with the next generation).
  retire() {
    this.retired = true;
  }

  vlog(msg, extra) {
    this.log(`[VOICE] ${msg} sessionId=${this.id} voiceState=${this.state}` + (extra ? ` ${extra}` : ''));
  }

  transition(next) {
    const ok = (TRANSITIONS[this.state] || []).includes(next);
    if (!ok || this.cleaned || this.retired) return false;
    this.vlog(`state ${this.state} -> ${next}`);
    this.state = next;
    return true;
  }

  // Returns chunk record, or null if duplicate / stale / cleaned.
  // Tracks sequence gaps (missing chunks) and reports them instead of hiding them.
  // pending-map semantics: chunks are stored seq->rec (byId) and released to the
  // playback worker in expected sequence order via nextInOrder(). receive() itself
  // never blocks; ordering/waiting happens at release time so normal WebSocket
  // jitter is absorbed by the App-level jitter buffer + short gap wait.
  receive(b64, serverSeq, mime, nowMs) {
    if (this.cleaned || this.retired) return null;
    const seq = typeof serverSeq === 'number' ? serverSeq : this.seq++;
    if (typeof serverSeq === 'number') {
      if (this.expectedSeq === undefined) this.expectedSeq = seq;
      if (seq > this.expectedSeq) {
        const missing = seq - this.expectedSeq;
        this.gaps = (this.gaps || 0) + missing;
        this.diag.missingSequences += missing;
        this.vlog('chunk gap: missing seq', `expected=${this.expectedSeq} got=${seq} totalGaps=${this.gaps}`);
        this.expectedSeq = seq + 1;
      } else if (seq === this.expectedSeq) {
        this.expectedSeq = seq + 1;
      } else if (seq < this.expectedSeq) {
        // Late arrival for a seq we already passed (out-of-order delivery).
        this.diag.outOfOrderChunks += 1;
      }
    }
    const chunkId = `${this.id}#${seq}`;
    if (this.byId.has(chunkId) || this.seen.has(chunkId)) {
      this.diag.duplicateChunks += 1;
      this.vlog('duplicate audio chunk ignored', `chunkId=${chunkId}`);
      return null;
    }
    const at = typeof nowMs === 'number' ? nowMs : Date.now();
    const rec = { chunkId, seq, b64, mime: mime || null, status: 'RECEIVED', arrivedAt: at };
    this.byId.set(chunkId, rec);
    this.seen.add(chunkId);
    if (this.seen.size > 200) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
    // Ordered insert by seq. If we insert anywhere but the tail, the chunk
    // arrived out of WebSocket arrival order (jitter/reorder) — count it.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].seq > seq) i--;
    if (i < this.queue.length) this.diag.outOfOrderChunks += 1;
    this.queue.splice(i, 0, rec);
    rec.status = 'QUEUED';
    this.diag.incomingChunks += 1;
    this.vlog('audio queued', `chunkId=${chunkId} queueLength=${this.queue.length}`);
    return rec;
  }

  // Peek at the head QUEUED record without consuming it (for scheduling).
  peek() {
    if (this.cleaned) return null;
    return this.queue.find((r) => r.status === 'QUEUED') || null;
  }

  // Single worker: caller plays rec.b64 then calls worked.done(rec,'COMPLETED'|'FAILED').
  // Legacy immediate path (kept for tests): returns head QUEUED regardless of gaps.
  next() {
    if (this.playing || this.cleaned) return null;
    const rec = this.queue.find((r) => r.status === 'QUEUED');
    if (!rec) return null;
    if (this.nextPlaySeq === undefined) this.nextPlaySeq = rec.seq;
    this.playing = true;
    rec.status = 'PLAYING';
    this.vlog('playback started', `chunkId=${rec.chunkId}`);
    return rec;
  }

  // Ordered release path (live playback must use this): only releases the chunk
  // whose seq === nextPlaySeq. Gaps wait up to maxGapWaitMs for the missing chunk,
  // then skip ahead and log — never stall forever, never repeat, never reorder.
  nextInOrder(nowMs) {
    if (this.playing || this.cleaned) return null;
    const t = typeof nowMs === 'number' ? nowMs : Date.now();
    const idx = this.queue.findIndex((r) => r.status === 'QUEUED');
    if (idx === -1) return null;
    if (this.nextPlaySeq === undefined) {
      this.nextPlaySeq = this.queue[idx].seq;
      this.gapWaitStart = null;
    }
    const head = this.queue[idx];
    if (head.seq === this.nextPlaySeq) {
      this.gapWaitStart = null;
      return this.next();
    }
    if (head.seq < this.nextPlaySeq) {
      // Stale (already played/skipped elsewhere): drop without playing.
      this.vlog('stale chunk dropped', `seq=${head.seq} expected=${this.nextPlaySeq}`);
      this.queue.splice(idx, 1);
      this.byId.delete(head.chunkId);
      this.gapWaitStart = null;
      return this.nextInOrder(t);
    }
    // head.seq > nextPlaySeq: sequence gap — wait briefly for the missing chunk.
    if (this.gapWaitStart === null || this.gapWaitStart === undefined) {
      this.gapWaitStart = t;
      this.vlog('sequence gap: waiting for missing chunk', `expected=${this.nextPlaySeq} head=${head.seq}`);
      return null;
    }
    if (t - this.gapWaitStart >= this.maxGapWaitMs) {
      const skipped = head.seq - this.nextPlaySeq;
      this.diag.skippedSequences += skipped;
      this.vlog('sequence gap timeout: skipping missing chunk(s)', `expected=${this.nextPlaySeq} head=${head.seq} skipped=${skipped}`);
      this.nextPlaySeq = head.seq;
      this.gapWaitStart = null;
      return this.next();
    }
    return null;
  }

  getDiagnostics() {
    return {
      ...this.diag,
      queuedNow: this.queue.filter((r) => r.status === 'QUEUED').length,
      playingNow: this.playing ? 1 : 0,
      expectedSeq: this.expectedSeq ?? null,
      nextPlaySeq: this.nextPlaySeq ?? null,
      totalGaps: this.gaps || 0,
    };
  }

  done(rec, status) {
    rec.status = status || 'COMPLETED';
    this.playing = false;
    const i = this.queue.indexOf(rec);
    if (i !== -1) this.queue.splice(i, 1);
    this.byId.delete(rec.chunkId);
    if (rec.status === 'COMPLETED') {
      this.diag.playedChunks += 1;
      if (this.nextPlaySeq === undefined || rec.seq >= this.nextPlaySeq) {
        this.nextPlaySeq = rec.seq + 1;
      }
    }
    this.vlog('playback finished', `chunkId=${rec.chunkId} status=${rec.status}`);
  }

  // Barge-in: stop current, drop everything queued. Returns dropped count.
  // Resets ordered-playback cursor so the next post-interruption chunk starts
  // fresh (no gap-wait against pre-interruption sequence numbers).
  interrupt() {
    const dropped = this.queue.filter((r) => r.status === 'QUEUED').length;
    this.queue.length = 0;
    this.playing = false; // worker checks generation below; current buffer fades by caller stopping source
    this.nextPlaySeq = undefined;
    this.gapWaitStart = null;
    this.vlog('clearing audio queue', `dropped=${dropped}`);
    return dropped;
  }

  close() {
    this.cleaned = true;
    const dropped = this.queue.length;
    this.queue.length = 0;
    this.byId.clear();
    this.playing = false;
    this.nextPlaySeq = undefined;
    this.gapWaitStart = null;
    this.vlog('session stopped', `dropped=${dropped}`);
  }
}

// ---- bit-perfect PCM converters (shared by app + tests) ----
export function floatToPcm16Base64(input) {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

export function base64ToBytes(b64) {
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Parse `audio/pcm;rate=24000` style MIME to a sample rate; null if unknown.
export function parsePcmRate(mime) {
  const m = String(mime || '').match(/rate=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Full incoming-format descriptor. Gemini Live sends raw LE PCM16 mono;
// the MIME carries the only authoritative field (rate). Never assume 44.1k/48k/stereo.
export function parseAudioFormat(mime) {
  const rate = parsePcmRate(mime) ?? 24000;
  return {
    mime: mime || null,
    codec: 'PCM',
    sampleRate: rate,
    channels: 1,
    bitDepth: 16,
    signed: true,
    littleEndian: true,
  };
}

// Measure PCM16 mono bytes: peak/RMS/clipping/zero-crossings. Read-only analysis.
export function analyzePcm16(bytes) {
  const n = Math.floor(bytes.length / 2);
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, n);
  let peak = 0, sumSq = 0, clip = 0, zero = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const v = view[i] / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    if (a >= 0.999) clip++;
    if (i > 0 && (prev <= 0) !== (v <= 0)) zero++;
    prev = v;
  }
  return {
    samples: n,
    peak: Math.round(peak * 1000) / 1000,
    rms: n ? Math.round(Math.sqrt(sumSq / n) * 1000) / 1000 : 0,
    clippingPct: n ? Math.round((clip / n) * 10000) / 100 : 0,
    zeroCross: zero,
  };
}

// Validate raw PCM16 bytes before playback. Returns {ok, reason} — malformed
// chunks are rejected by the caller, never silently patched.
export function validatePcmChunk(bytes) {
  if (!bytes || bytes.length < 2) return { ok: false, reason: `too short (${bytes ? bytes.length : 0}B)` };
  if (bytes.length % 2 !== 0) return { ok: false, reason: `odd byteLength ${bytes.length} (PCM16 needs 2-byte alignment)` };
  return { ok: true, reason: 'ok' };
}

// Windowed-sinc resampler (Blackman window, configurable taps): one
// deterministic high-quality conversion with proper imaging suppression —
// audibly cleaner than linear interpolation for 24kHz->48kHz voice, where
// linear leaves images inside the audible band. Same-rate input is copied.
// This is the DSP fallback when the browser mixer path cannot be used.
export function resampleSinc(input, fromRate, toRate, taps = 32) {
  if (fromRate === toRate) return Float32Array.from(input);
  if (!input || input.length === 0) return new Float32Array(0);
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const half = Math.floor(taps / 2);
  const cutoff = Math.min(1, ratio); // widen kernel only when downsampling (anti-alias)
  const sinc = (x) => {
    if (Math.abs(x) < 1e-9) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
  };
  // Blackman window over [-half, half].
  const window = (n) => {
    const a0 = 0.42, a1 = 0.5, a2 = 0.08;
    const t = (n + half) / (2 * half);
    return a0 - a1 * Math.cos(2 * Math.PI * t) + a2 * Math.cos(4 * Math.PI * t);
  };
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    let acc = 0, wsum = 0;
    for (let k = -half + 1; k <= half; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= input.length) continue;
      const x = (pos - idx) * cutoff;
      const w = sinc(x) * window(k);
      acc += input[idx] * w;
      wsum += w;
    }
    out[i] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}

// Arrival-regime classifier (deterministic, unit-tested). Compares mean chunk
// arrival interval against mean chunk audio duration from the SAME turn:
// 'starved' — audio arrives slower than real time (interval > 1.5x duration).
//   No buffer can invent missing audio; adding delay only hurts. Play ASAP.
// 'flowing' — arrivals keep up; the adaptive jitter target absorbs variance.
// Unknown/zero inputs default to 'flowing' (previous behavior preserved).
export function classifyArrivalRegime(avgIntervalMs, avgChunkMs) {
  if (!(avgIntervalMs > 0) || !(avgChunkMs > 0)) return 'flowing';
  return avgIntervalMs > 1.5 * avgChunkMs ? 'starved' : 'flowing';
}

// Fresh-start delay for a starved regime: minimal fixed horizon, not the
// adaptive target (which only helps when later chunks can overlap earlier ones).
export function freshStartDelaySec(regime, jitterTargetSec) {
  if (regime === 'starved') return 0.03;
  return jitterTargetSec;
}

// Smooth Voice Mode helpers (deterministic, unit-tested). The mode buffers a
// turn's chunks in sequence and starts playback only with enough audio queued
// (or at turn completion), so speech plays as one continuous sentence instead
// of restarting per chunk under slow delivery.

// Estimate PCM seconds from a base64 chunk without decoding (padding ±2B).
export function estimatePcmSec(b64len, sampleRate) {
  if (!(b64len > 0) || !(sampleRate > 0)) return 0;
  const bytes = Math.floor(Number(b64len) * 3 / 4);
  return Math.floor(bytes / 2) / sampleRate;
}

// Delivery-rate measurement (deterministic, unit-tested): received audio seconds
// over real elapsed arrival time for one turn. Returns null until enough data
// (min chunks AND min elapsed) so early-turn noise never drives decisions.
export function deliveryRate(audioSec, elapsedMs, chunks, minChunks = 3, minElapsedMs = 500) {
  if (!(chunks >= minChunks) || !(elapsedMs >= minElapsedMs) || !(audioSec > 0)) return null;
  return audioSec / (elapsedMs / 1000);
}

// Windowed delivery rate over recent chunk history: immune to one long stall
// poisoning the whole turn. histT/histA are parallel arrays (arrival ms,
// audio seconds), newest last; uses up to the last `window` chunks and
// requires minSpanMs of wall time inside the window. Returns null when the
// recent evidence is insufficient — never a stale cumulative average.
export function windowedRate(histT, histA, window = 10, minSpanMs = 500, minChunks = 3) {
  if (!histT || !histA || histT.length < minChunks || histA.length < minChunks) return null;
  const t = histT.slice(-window);
  const a = histA.slice(-window);
  const span = t[t.length - 1] - t[0];
  if (!(span >= minSpanMs)) return null;
  const sum = a.reduce((x, y) => x + y, 0);
  if (!(sum > 0)) return null;
  return sum / (span / 1000);
}

// Safely faster than real time, with headroom: only then may playback start
// before the turn completes.
export function isFastDelivery(rate, minFastRate = 1.25) {
  return typeof rate === 'number' && isFinite(rate) && rate >= minFastRate;
}

// Start gate: pure decision for "may the worker release the next chunk yet?"
// state: { started, turnDone, bufferedSec, rate } (rate null = unknown).
// Playback starts once started, at turn completion with audio buffered, at the
// safety cap — or early ONLY when measured delivery is safely faster than real
// time (>= minFastRate, default 1.25x). A bare buffer threshold never starts a
// slow turn: that merely postpones the underflow instead of preventing it.
export function smoothGate(state, targetSec, maxBufferSec = 30, minFastRate = 1.25) {
  if (!state) return true;
  if (state.started) return true;
  if (state.bufferedSec >= maxBufferSec) return true;
  if (state.turnDone && state.bufferedSec > 0) return true;
  if (state.bufferedSec >= targetSec && isFastDelivery(state.rate, minFastRate)) return true;
  return false;
}

// Reserve-hold decision during playback (pure; hysteresis via paused flag).
// While the turn is still arriving, stop releasing new chunks once the buffer
// falls below reserveSec; resume at/above resumeSec or at turn completion.
// Never replays or drops: the queue stays intact, release simply pauses.
export function reserveUpdate(s, reserveSec = 0.7, resumeSec = 1.0) {
  if (!s || !s.started || s.turnDone) return { hold: false, paused: false };
  if (s.bufferedSec < reserveSec) return { hold: true, paused: true };
  if (s.paused && s.bufferedSec < resumeSec) return { hold: true, paused: true };
  return { hold: false, paused: false };
}
// playEnd = end time of previously scheduled audio (0 when none).
// Returns { t, event }: 'chain' (exact continuation), 'fresh' (jitter horizon),
// 'underflow' (starved restart). Never schedules in the past.
// Pure no-gap scheduling math (single source of truth; App pump delegates).
// playEnd = end time of previously scheduled audio (0 when none).
// Returns { t, event }: 'chain' (exact continuation), 'fresh' (jitter horizon),
// 'underflow' (starved restart). Never schedules in the past.
 export function nextStartTime(playEnd, now, freshDelaySec, resetDelaySec = 0.05) {
    // Allow 10ms tolerance before treating playEnd < now as a real underflow
    // to avoid false underflows from AudioContext clock drift between scheduling
    // ticks (each false underflow adds 50ms delay + bumps jitter target).
    if (playEnd + 0.01 < now) {
        if (playEnd > 0) {
            return { t: now + resetDelaySec, event: 'underflow' };
        }
        return { t: now + freshDelaySec, event: 'fresh' };
    }
    if (playEnd <= now) {
        return { t: now, event: 'chain' };
    }
    return { t: playEnd, event: 'chain' };
}

// Linear-interpolated resampler (kept as a test reference + legacy path).
// Prefer resampleSinc for live audio: linear leaves audible images.
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// 64-sample linear edge ramps (fade in/out) to prevent boundary clicks.
// ~2.7ms at 24kHz: inaudible, adds no delay. Applied per chunk in the worker.
export function applyEdgeRamps(floatArr) {
  const r = Math.min(64, Math.floor(floatArr.length / 2));
  for (let i = 0; i < r; i++) {
    const g = i / r;
    floatArr[i] *= g;
    floatArr[floatArr.length - 1 - i] *= g;
  }
  return floatArr;
}

// Micro-crossfade INTO a chunk head (replaces fade-in+fade-out for chained
// playback). Blends the first `count` samples from prevTail (or 0 at stream
// start) toward the signal; the tail is NEVER touched, so consecutive chunks
// cannot develop the periodic dip amplitude of paired fades, and continuous
// boundaries stay bit-perfect when the caller skips this via
// needsBoundarySmoothing. Max 64 samples (~2.7ms @24kHz): zero added latency.
export function applyCrossfadeIn(floatArr, prevTail, count = 64) {
  const r = Math.max(1, Math.min(count, Math.floor(floatArr.length / 2)));
  const start = (prevTail === null || prevTail === undefined || !isFinite(prevTail)) ? 0 : prevTail;
  for (let i = 0; i < r; i++) {
    const g = (i + 1) / r;
    floatArr[i] = start * (1 - g) + floatArr[i] * g;
  }
  return floatArr;
}

// Conditional micro-smoothing decision: measure the waveform step between the
// previously scheduled tail sample and this chunk's head sample (both float32
// normalized). Returns true only when the step is large enough to click.
// Threshold default 0.02 (~-34dB step). Null prevTail = stream start from
// silence, which always needs a fade-in. Continuous boundaries return false so
// the caller leaves PCM bit-perfect.
export function needsBoundarySmoothing(prevTail, curHead, threshold = 0.02) {
  if (prevTail === null || prevTail === undefined) return true;
  if (typeof curHead !== 'number' || !isFinite(curHead)) return true;
  return Math.abs(curHead - prevTail) > threshold;
}

// Count abrupt waveform steps inside one PCM16 stream (normalized threshold,
// same 0.02 convention as needsBoundarySmoothing). Read-only: used to compare
// raw vs post-pipeline captures and to report discontinuity counts.
export function countDiscontinuities(int16arr, threshold = 0.02) {
  if (!int16arr || int16arr.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < int16arr.length; i++) {
    if (Math.abs(int16arr[i] / 32768 - int16arr[i - 1] / 32768) > threshold) n++;
  }
  return n;
}

// CommonJS interop for node --test (Vite ESM import works too).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceSession, newSessionId, STATES, floatToPcm16Base64, base64ToBytes, parsePcmRate, parseAudioFormat, analyzePcm16, applyEdgeRamps, applyCrossfadeIn, needsBoundarySmoothing, countDiscontinuities, validatePcmChunk, resampleLinear, resampleSinc, classifyArrivalRegime, freshStartDelaySec, nextStartTime, estimatePcmSec, smoothGate, deliveryRate, isFastDelivery, reserveUpdate, windowedRate };
}
