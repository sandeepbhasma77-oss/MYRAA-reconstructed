// MYRAA voice diagnostics (additive only — never touches the live audio path).
// TEST A: raw Gemini bytes per turn -> debug/raw-gemini-response.pcm + .json metadata.
// TEST B: frontend POSTs the exact PCM16 bytes it handed to the device.
// TEST C: GET /api/voice-diag compares the two and reports resampling facts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { DATA_DIR } from './paths.js';

export const DUMP_ENABLED = process.env.MYRAA_VOICE_DUMP === '1';
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
// Numbered per-turn archive (Part 15): diagnostics/audio/gemini_raw_001.pcm/.wav/.json
// plus playback_001.* on TEST B. debug/ keeps the latest turn for compat.
const AUDIO_ARCHIVE_DIR = path.join(DATA_DIR, 'diagnostics', 'audio');

function ensureDir(): void {
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch { /* best-effort */ }
}

function ensureArchiveDir(): void {
  try { fs.mkdirSync(AUDIO_ARCHIVE_DIR, { recursive: true }); } catch { /* best-effort */ }
}

function nextArchiveIndex(prefix: string): string {
  try {
    ensureArchiveDir();
    let max = 0;
    for (const f of fs.readdirSync(AUDIO_ARCHIVE_DIR)) {
      const m = new RegExp(`^${prefix}_(\\d{3})\\.pcm$`).exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return String(max + 1).padStart(3, '0');
  } catch {
    return String(Date.now() % 1000).padStart(3, '0');
  }
}

// Read-only PCM16 mono analysis (Part 16): sample values are never altered here.
// Signed LE Int16 normalized by /32768 — the same convention as the live path.
export function analyzePcmBuffer(raw: Buffer, rate: number): {
  samples: number; byteLength: number; rms: number; peak: number;
  clippingPct: number; zeroCross: number; sha256: string; durationSec: number;
} {
  const n = Math.floor(raw.length / 2);
  const view = new Int16Array(raw.buffer, raw.byteOffset, n);
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
    byteLength: raw.length,
    rms: n ? Math.round(Math.sqrt(sumSq / n) * 1000) / 1000 : 0,
    peak: Math.round(peak * 1000) / 1000,
    clippingPct: n ? Math.round((clip / n) * 10000) / 100 : 0,
    zeroCross: zero,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    durationSec: rate ? Math.round((n / rate) * 1000) / 1000 : 0,
  };
}

// Abrupt-step counter over a raw PCM16LE buffer (same 0.02 convention as the
// live boundary check). Read-only analysis for pipeline-compare.json.
export function countDiscBuffer(raw: Buffer, threshold = 0.02): number {
  const n = Math.floor(raw.length / 2);
  if (n < 2) return 0;
  const view = new Int16Array(raw.buffer, raw.byteOffset, n);
  let c = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(view[i] / 32768 - view[i - 1] / 32768) > threshold) c++;
  }
  return c;
}

export interface RawTurn {
  chunks: Buffer[];
  mime: string | null;
  closed: boolean;
  truncated: boolean;
}

export function newRawTurn(): RawTurn {
  return { chunks: [], mime: null, closed: false, truncated: false };
}

// Called from the /live audio branch. Appends DECODED raw bytes unmodified.
// Capped so a turn that never completes can't grow memory without bound.
const MAX_DUMP_CHUNKS = 4000;
export function dumpRawChunk(turn: RawTurn, b64: string, mime: string | null): void {
  if (!DUMP_ENABLED || turn.closed) return;
  try {
    if (turn.chunks.length >= MAX_DUMP_CHUNKS) {
      turn.truncated = true;
      return;
    }
    turn.chunks.push(Buffer.from(b64, 'base64'));
    if (mime && !turn.mime) turn.mime = mime;
  } catch { /* diagnostics never break voice */ }
}

// Called on turnComplete. Writes one full response (unmodified concatenation).
// Latest turn -> debug/ (compat); every turn -> diagnostics/audio/gemini_raw_NNN.* (Part 15).
export function finalizeRawTurn(turn: RawTurn): string | null {
  turn.closed = true;
  if (!DUMP_ENABLED || turn.chunks.length === 0) return null;
  try {
    ensureDir();
    const raw = Buffer.concat(turn.chunks);
    const rateMatch = /rate=(\d+)/.exec(String(turn.mime || ''));
    const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const stats = analyzePcmBuffer(raw, rate);
    const meta = {
      mime: turn.mime,
      sampleRate: rate,
      channels: 1,
      bitDepth: 16,
      truncated: turn.truncated,
      byteLength: raw.length,
      durationSec: stats.durationSec,
      sha256: stats.sha256,
      rms: stats.rms,
      peak: stats.peak,
      clippingPct: stats.clippingPct,
      zeroCross: stats.zeroCross,
      samples: stats.samples,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-response.pcm'), raw);
    fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-response.wav'), withWavHeader(raw, rate));
    fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-response.json'), JSON.stringify(meta, null, 2));
    try {
      const idx = nextArchiveIndex('gemini_raw');
      fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `gemini_raw_${idx}.pcm`), raw);
      fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `gemini_raw_${idx}.wav`), withWavHeader(raw, rate));
      fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `gemini_raw_${idx}.json`), JSON.stringify(meta, null, 2));
    } catch { /* archive is best-effort; debug/ copy already saved */ }
    return meta.sha256;
  } catch {
    return null;
  }
}

export function registerVoiceDiagRoutes(app: Express): void {
  // Steps 1+2 receiver: ordered raw PCM (pre-queue/smoothing/playback) + exact
  // post-pipeline PCM (pre-playback) for ONE voice response. Writes the exact
  // filenames the A/B protocol needs; never touches the live audio path.
  app.post('/api/voice-ab-capture', (req, res) => {
    try {
      const { rawB64, postB64, rate, abMode, pipelineMode, playbackSampleRate, clientStats } = req.body ?? {};
      if (!rawB64 || !postB64) return res.status(400).json({ error: 'rawB64 and postB64 required.' });
      ensureDir();
      const sampleRate = Number(rate) || 24000;
      const raw = Buffer.from(String(rawB64), 'base64');
      const post = Buffer.from(String(postB64), 'base64');
      if (raw.length > 15 * 1024 * 1024 || post.length > 15 * 1024 * 1024) {
        return res.status(413).json({ error: 'capture too large (cap 15MB per stream).' });
      }
      const a = analyzePcmBuffer(raw, sampleRate);
      const b = analyzePcmBuffer(post, sampleRate);
      const aDisc = countDiscBuffer(raw);
      const bDisc = countDiscBuffer(post);
      const bitIdentical = raw.length === post.length && raw.equals(post);
      const rawMeta = {
        mime: `audio/pcm;rate=${sampleRate}`, sampleRate, channels: 1, bitDepth: 16,
        codec: 'PCM16LE', byteLength: raw.length, durationSec: a.durationSec,
        sha256: a.sha256, rms: a.rms, peak: a.peak, clippingPct: a.clippingPct,
        zeroCross: a.zeroCross, samples: a.samples, discontinuities: aDisc,
        abMode: abMode || 'A', pipelineMode: pipelineMode || 'full',
        savedAt: new Date().toISOString(),
      };
      const postMeta = {
        mime: `audio/pcm;rate=${sampleRate}`, sampleRate, channels: 1, bitDepth: 16,
        codec: 'PCM16LE', byteLength: post.length, durationSec: b.durationSec,
        sha256: b.sha256, rms: b.rms, peak: b.peak, clippingPct: b.clippingPct,
        zeroCross: b.zeroCross, samples: b.samples, discontinuities: bDisc,
        abMode: abMode || 'A', pipelineMode: pipelineMode || 'full',
        playbackSampleRate: Number(playbackSampleRate) || null,
        savedAt: new Date().toISOString(),
      };
      const compare = {
        rawSamples: a.samples, postSamples: b.samples,
        rawBytes: raw.length, postBytes: post.length,
        sampleCountMatch: a.samples === b.samples,
        rawRms: a.rms, postRms: b.rms,
        rawPeak: a.peak, postPeak: b.peak,
        rmsDelta: Math.round(Math.abs(a.rms - b.rms) * 1000) / 1000,
        peakDelta: Math.round(Math.abs(a.peak - b.peak) * 1000) / 1000,
        rawDiscontinuities: aDisc, postDiscontinuities: bDisc,
        bitIdentical,
        clientStats: clientStats ?? null,
        clientAgrees: clientStats ? Boolean(clientStats.bitIdentical) === bitIdentical : null,
        verdict: bitIdentical
          ? 'pipeline transparent for this turn — if playback sounds robotic, the cause is source audio or output device, not MYRAA processing'
          : 'MYRAA processing altered samples this turn — inspect smoothing/adaptation counts in AUDIO_SESSION_SUMMARY',
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-24k.pcm'), raw);
      fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-24k.wav'), withWavHeader(raw, sampleRate));
      fs.writeFileSync(path.join(DEBUG_DIR, 'raw-gemini-24k.json'), JSON.stringify(rawMeta, null, 2));
      fs.writeFileSync(path.join(DEBUG_DIR, 'post-pipeline-24k.pcm'), post);
      fs.writeFileSync(path.join(DEBUG_DIR, 'post-pipeline-24k.wav'), withWavHeader(post, sampleRate));
      fs.writeFileSync(path.join(DEBUG_DIR, 'post-pipeline-24k.json'), JSON.stringify(postMeta, null, 2));
      fs.writeFileSync(path.join(DEBUG_DIR, 'pipeline-compare.json'), JSON.stringify(compare, null, 2));
      res.json({ ok: true, compare });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // TEST B receiver: exact PCM16 bytes the frontend gave to the AudioContext.
  app.post('/api/voice-dump', (req, res) => {
    try {
      const { pcmBase64, playbackSampleRate, bufferRate } = req.body ?? {};
      if (!pcmBase64) return res.status(400).json({ error: 'pcmBase64 required.' });
      ensureDir();
      const raw = Buffer.from(String(pcmBase64), 'base64');
      const rate = Number(bufferRate) || 24000;
      const stats = analyzePcmBuffer(raw, rate);
      const meta = {
        playbackSampleRate: Number(playbackSampleRate) || null,
        bufferRate: rate,
        channels: 1,
        bitDepth: 16,
        byteLength: raw.length,
        durationSec: stats.durationSec,
        sha256: stats.sha256,
        rms: stats.rms,
        peak: stats.peak,
        clippingPct: stats.clippingPct,
        zeroCross: stats.zeroCross,
        samples: stats.samples,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(DEBUG_DIR, 'playback-response.pcm'), raw);
      fs.writeFileSync(path.join(DEBUG_DIR, 'playback-response.wav'), withWavHeader(raw, rate));
      fs.writeFileSync(path.join(DEBUG_DIR, 'playback-response.json'), JSON.stringify(meta, null, 2));
      try {
        const idx = nextArchiveIndex('playback');
        fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `playback_${idx}.pcm`), raw);
        fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `playback_${idx}.wav`), withWavHeader(raw, rate));
        fs.writeFileSync(path.join(AUDIO_ARCHIVE_DIR, `playback_${idx}.json`), JSON.stringify(meta, null, 2));
      } catch { /* archive best-effort */ }
      res.json({ ok: true, ...meta });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // TEST C: compare + resampling facts (Part 16: A=raw Gemini, B=playback PCM,
  // C=buffer actually scheduled — B and C are identical by construction since the
  // frontend POSTs the exact bytes handed to the AudioContext).
  app.get('/api/voice-diag', (_req, res) => {
    try {
      const rawMeta = readJson('raw-gemini-response.json');
      const playMeta = readJson('playback-response.json');
      const rawPcm = readBin('raw-gemini-response.pcm');
      const playPcm = readBin('playback-response.pcm');
      const out: Record<string, unknown> = {
        dumpEnabled: DUMP_ENABLED,
        raw: rawMeta, playback: playMeta,
        SOURCE_SAMPLE_RATE: rawMeta?.sampleRate ?? null,
        PLAYBACK_SAMPLE_RATE: playMeta?.playbackSampleRate ?? null,
        BUFFER_RATE: playMeta?.bufferRate ?? null,
      };
      if (rawMeta && playMeta) {
        out.RESAMPLING_REQUIRED = playMeta.playbackSampleRate !== playMeta.bufferRate;
        out.RESAMPLING_METHOD = playMeta.playbackSampleRate !== playMeta.bufferRate
          ? 'browser mixer (OS audio engine), outside MYRAA code'
          : 'none — buffer rate equals device rate';
        if (rawPcm && playPcm) {
          const a = analyzePcmBuffer(rawPcm, Number(rawMeta.sampleRate) || 24000);
          const b = analyzePcmBuffer(playPcm, Number(playMeta.bufferRate) || 24000);
          out.A = { bytes: a.byteLength, samples: a.samples, rms: a.rms, peak: a.peak, clippingPct: a.clippingPct, zeroCross: a.zeroCross, sha256: a.sha256 };
          out.B = { bytes: b.byteLength, samples: b.samples, rms: b.rms, peak: b.peak, clippingPct: b.clippingPct, zeroCross: b.zeroCross, sha256: b.sha256 };
          out.BYTE_IDENTICAL = a.sha256 === b.sha256;
          out.rawBytes = rawPcm.length;
          out.playbackBytes = playPcm.length;
          out.SAMPLE_COUNT_MATCH = a.samples === b.samples;
          out.RMS_DELTA = Math.round(Math.abs(a.rms - b.rms) * 1000) / 1000;
          out.PEAK_DELTA = Math.round(Math.abs(a.peak - b.peak) * 1000) / 1000;
          // Verdict: which stage modifies audio (Part 16).
          out.MODIFIED_BY = a.sha256 === b.sha256
            ? 'none — Gemini/source → playback pipeline is bit-identical'
            : 'MYRAA processing/resampling modified the audio between Gemini and playback';
        } else {
          out.BYTE_IDENTICAL = null;
        }
      } else {
        out.RESAMPLING_REQUIRED = null;
        out.RESAMPLING_METHOD = null;
        out.BYTE_IDENTICAL = null;
        out.hint = 'No dumps yet. Set MYRAA_VOICE_DUMP=1, enable dump in UI (tasks tab note / localStorage myraa_dump=1), have one voice turn, then re-query.';
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

// Minimal WAV writer (44-byte header, PCM16 mono) so dumps play in any player
// with correct metadata — no audio bytes are altered.
export function withWavHeader(raw: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + raw.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(raw.length, 40);
  return Buffer.concat([h, raw]);
}

function readJson(name: string): Record<string, number | string> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(DEBUG_DIR, name), 'utf-8'));
  } catch {
    return null;
  }
}

function readBin(name: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(DEBUG_DIR, name));
  } catch {
    return null;
  }
}
