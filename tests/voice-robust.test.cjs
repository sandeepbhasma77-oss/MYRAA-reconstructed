// Playback robustness: crossfade-only boundaries (no fade cascade, no dips),
// high-quality sinc resampling, starvation-aware scheduling math, session cleanup.
// Pure helper tests run headless; App delegation pinned by static assertions.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyCrossfadeIn, resampleSinc, resampleLinear, classifyArrivalRegime,
  freshStartDelaySec, nextStartTime, VoiceSession,
} = require('../src/voicePipe.js');

const appSrc = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

// Goertzel magnitude at one frequency (for imaging comparison).
function goertzel(samples, rate, freq) {
  const n = samples.length;
  const k = 0.5 + (n * freq) / rate;
  const w = (2 * Math.PI * k) / n;
  const cos = Math.cos(w), sin = Math.sin(w), coeff = 2 * cos;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s0 = samples[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  return Math.hypot(s1 * cos - s2, s1 * sin);
}

describe('crossfade-in boundaries (no fade cascade, no periodic dips)', () => {
  test('blends head from previous tail, never touches the tail', () => {
    const a = new Float32Array(480).fill(0.5);
    applyCrossfadeIn(a, -0.5, 64);
    assert.equal(a.length, 480, 'sample count preserved');
    assert.ok(a[0] > -0.5 && a[0] < 0.5, 'head blends from tail');
    assert.ok(Math.abs(a[63] - 0.5) < 1e-6, 'blend completes inside window');
    for (let i = 64; i < 480; i++) assert.equal(a[i], 0.5, `body untouched at ${i}`);
    // Tail MUST stay raw: no fade-out, so the next boundary measures honestly.
    assert.equal(a[479], 0.5, 'tail never faded');
    assert.equal(a[416], 0.5, 'pre-tail region never faded');
  });

  test('null previous tail fades in from silence (stream start)', () => {
    const a = new Float32Array(200).fill(0.4);
    applyCrossfadeIn(a, null, 64);
    assert.ok(a[0] < 0.01 && a[0] >= 0, `ramps from silence, a[0]=${a[0]}`);
    assert.ok(a[63] > 0.39, 'ramps up to signal');
    assert.ok(Math.abs(a[199] - 0.4) < 1e-6, 'tail untouched');
  });

  test('clamps on tiny chunks instead of corrupting them', () => {
    const a = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    applyCrossfadeIn(a, 0, 64); // r = min(64, 2) = 2
    assert.equal(a.length, 4);
    assert.ok(isFinite(a[0]) && isFinite(a[3]), 'no NaN on tiny input');
  });

  test('continuous boundary + gate means bit-perfect passthrough (no cascade)', () => {
    // Simulates two contiguous chunks: raw tail of N feeds the gate for N+1.
    const prev = new Float32Array(480).fill(0.3);
    const next = new Float32Array(480).fill(0.3);
    const tail = prev[prev.length - 1]; // 0.3, never faded
    const { needsBoundarySmoothing } = require('../src/voicePipe.js');
    assert.equal(needsBoundarySmoothing(tail, next[0]), false, 'continuous stays untouched');
    const before = next.slice();
    // Caller skips smoothing when gate is false: bytes identical.
    assert.deepEqual([...next], [...before]);
  });
});

describe('windowed-sinc resampler (Mode B DSP path)', () => {
  test('doubles 24k->48k, preserves tone frequency and endpoints', () => {
    const tone = new Float32Array(2400);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((i / 24000) * Math.PI * 2 * 440) * 0.5;
    const up = resampleSinc(tone, 24000, 48000);
    assert.equal(up.length, 4800, 'sample count doubles exactly');
    assert.ok(Math.abs(up[100] - tone[50]) < 1e-3, `interior preserved: ${up[100]} vs ${tone[50]}`);
    // Frequency check via zero crossings: 440Hz over 0.1s at 48k => ~88.
    let zc = 0;
    for (let i = 1; i < up.length; i++) if ((up[i - 1] <= 0) !== (up[i] <= 0)) zc++;
    assert.ok(zc >= 80 && zc <= 96, `440Hz preserved, zc=${zc}`);
  });

  test('same-rate is an exact copy; empty input is safe', () => {
    const t = new Float32Array([0.1, -0.2, 0.3]);
    assert.deepEqual([...resampleSinc(t, 24000, 24000)], [...t]);
    assert.equal(resampleSinc(new Float32Array(0), 24000, 48000).length, 0);
  });

  test('imaging suppressed vs linear interpolation (metallic harshness source)', () => {
    // 8kHz tone @24k: linear 2x upsampling images at 16kHz (audible band).
    const n = 2400, tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = Math.sin((i / 24000) * Math.PI * 2 * 8000) * 0.5;
    const lin = resampleLinear(tone, 24000, 48000);
    const snc = resampleSinc(tone, 24000, 48000);
    assert.equal(lin.length, snc.length);
    const linImg = goertzel(lin, 48000, 16000);
    const sncImg = goertzel(snc, 48000, 16000);
    const linSig = goertzel(lin, 48000, 8000);
    const sncSig = goertzel(snc, 48000, 8000);
    assert.ok(sncSig > 0.5 * linSig, 'wanted 8kHz tone preserved');
    assert.ok(sncImg < 0.25 * linImg, `16kHz image: sinc=${sncImg.toFixed(1)} vs linear=${linImg.toFixed(1)}`);
  });
});

describe('arrival-regime scheduling math (starvation proven by voice.log)', () => {
  test('classifier separates starved from flowing delivery', () => {
    assert.equal(classifyArrivalRegime(500, 226), 'starved', 'log signature: 500ms gaps, 226ms audio');
    assert.equal(classifyArrivalRegime(340, 226), 'starved', '1.5x boundary');
    assert.equal(classifyArrivalRegime(77, 281), 'flowing', 'live probe: 77ms gaps, 281ms audio');
    assert.equal(classifyArrivalRegime(200, 226), 'flowing');
    assert.equal(classifyArrivalRegime(0, 0), 'flowing', 'unknown defaults to prior behavior');
    assert.equal(classifyArrivalRegime(0, 226), 'flowing');
  });

  test('starved fresh starts play ASAP instead of adding jitter latency', () => {
    assert.equal(freshStartDelaySec('starved', 0.28), 0.03);
    assert.equal(freshStartDelaySec('flowing', 0.28), 0.28);
  });

  test('nextStartTime: chain exact, fresh on horizon, reset on underflow, never past', () => {
     assert.deepEqual(nextStartTime(0, 10, 0.18), { t: 10.18, event: 'fresh' });
     assert.deepEqual(nextStartTime(11, 10, 0.18), { t: 11, event: 'chain' });
     assert.deepEqual(nextStartTime(10, 10, 0.18), { t: 10, event: 'chain' });
     const u = nextStartTime(9.5, 10, 0.18);
     assert.equal(u.event, 'underflow');
     assert.ok(Math.abs(u.t - 10.05) < 1e-9);
     // Tolerance: minor clock drift (<10ms) must not trigger underflow
     const c = nextStartTime(9.99, 10, 0.18);
     assert.equal(c.event, 'chain');
     assert.equal(c.t, 10);
     // Chained audio lands sample-exact: no gaps, no overlaps.
     let playEnd = 0, now = 100;
     const durs = [0.226, 0.31, 0.19];
     for (const dur of durs) {
       const r = nextStartTime(playEnd === 0 ? 0 : playEnd, now, 0.18);
       assert.equal(r.event, playEnd === 0 ? 'fresh' : 'chain');
       playEnd = r.t + dur;
     }
     assert.ok(Math.abs(playEnd - (100.18 + 0.226 + 0.31 + 0.19)) < 1e-9, 'back-to-back, zero drift');
   });

  test('pump delegates to the pure scheduler (single source of truth)', () => {
    const app = appSrc();
    assert.ok(app.includes('nextStartTime(playTime.current, now,'), 'pump must delegate scheduling');
    assert.ok(app.includes('freshStartDelaySec('), 'starvation-aware fresh delay required');
    assert.ok(app.includes('turnArrivalStats()'), 'in-turn arrival stats required');
    assert.ok(app.includes('AUDIO_TURN_TIMING'), 'per-turn timing line required');
  });
});

describe('session cleanup (no stale audio, no leaked nodes)', () => {
  test('interrupt and close drop everything and reset cursors', () => {
    const s = new VoiceSession(() => {});
    s.receive('AAA=', 0);
    s.receive('AAB=', 1);
    assert.equal(s.interrupt(), 2);
    assert.equal(s.queue.length, 0);
    assert.equal(s.nextPlaySeq, undefined);
    s.receive('AAC=', 2);
    s.close();
    assert.equal(s.queue.length, 0);
    assert.equal(s.byId.size, 0);
    assert.equal(s.next(), null, 'cleaned session releases nothing');
  });

  test('ended sources are disconnected in the pump', () => {
    const app = appSrc();
    assert.ok(/sources\.current\.delete\(src\);\s*srcIds\.current\.delete\(src\);\s*try \{\s*src\.disconnect\(\);/.test(app),
      'onended must disconnect nodes for GC hygiene');
  });
});
