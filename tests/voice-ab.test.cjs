// CRITICAL A/B diagnosis: raw-vs-post capture, minimal pipeline, source audit,
// resample experiment. Unit tests run headless; static tests pin the live paths.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { countDiscontinuities, resampleLinear } = require('../src/voicePipe.js');

const appSrc = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
const diagSrc = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'voiceDiag.ts'), 'utf-8');

describe('discontinuity counter (Step 2 comparison stat)', () => {
  test('flat line and gentle slopes count zero', () => {
    assert.equal(countDiscontinuities(new Int16Array([0, 0, 0, 0])), 0);
    assert.equal(countDiscontinuities(new Int16Array([100, 200, 300, 400])), 0);
    assert.equal(countDiscontinuities(new Int16Array([1])), 0);
  });

  test('abrupt steps counted at the 0.02 threshold', () => {
    // 0.02 * 32768 = 655.36 → step of 656+ counts, 655 does not.
    assert.equal(countDiscontinuities(new Int16Array([0, 655])), 0);
    assert.equal(countDiscontinuities(new Int16Array([0, 656])), 1);
    assert.equal(countDiscontinuities(new Int16Array([0, 16000, 16000, -16000])), 2);
  });
});

describe('post-capture round-trip is bit-exact when unsmoothed', () => {
  test('Int16 -> float32 -> Int16 reproduces every sample', () => {
    const src = new Int16Array(4096);
    let seed = 12345;
    for (let i = 0; i < src.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      src[i] = (seed % 65536) - 32768;
    }
    const f = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) f[i] = src[i] / 32768;
    const back = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.round(f[i] * 32768);
      back[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    assert.deepEqual([...back], [...src]);
  });

  test('manual 24k->48k resample doubles samples, preserves endpoints', () => {
    const tone = new Float32Array(2400);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((i / 24000) * Math.PI * 2 * 440) * 0.5;
    const up = resampleLinear(tone, 24000, 48000);
    assert.equal(up.length, 4800);
    assert.ok(Math.abs(up[0] - tone[0]) < 1e-6);
    assert.ok(Math.abs(up[up.length - 1] - tone[tone.length - 1]) < 1e-6);
  });
});

describe('renderer A/B capture + experiment paths (Steps 1-3, 7)', () => {
  test('exact filenames + capture endpoint wired', () => {
    const app = appSrc();
    assert.ok(app.includes('/api/voice-ab-capture'), 'POST endpoint required');
    assert.ok(app.includes('rawCapture') && app.includes('postCapture'), 'capture refs required');
  });

  test('minimal-pipeline flag gates jitter/smoothing/tone/barge-in', () => {
    const app = appSrc();
    assert.ok(app.includes('myraa_plain_pipeline'), 'flag key required');
    assert.ok(app.includes('isPlainPipeline()'), 'helper required');
    // Smoothing bypass + frozen adaptation + tone refusal + barge-in ignore.
    assert.ok(/if\s*\(!plain && needsBoundarySmoothing/.test(app), 'smoothing must be skipped in plain mode');
    assert.ok(/if\s*\(!isPlainPipeline\(\)\) adaptJitter/.test(app), 'adaptation must freeze in plain mode');
    assert.ok(app.includes('disabled in minimal-pipeline diagnostic mode'), 'tone refusal required');
    assert.ok(app.includes('barge-in ignored in minimal-pipeline mode'), 'barge-in ignore required');
  });

  test('A/B resample experiment present, defaulting to native 24k', () => {
    const app = appSrc();
    assert.ok(app.includes('myraa_ab_mode'), 'A/B flag key required');
    assert.ok(app.includes("getABMode()"), 'mode reader required');
    assert.ok(app.includes('resampleSinc(float, rate, 48000)'), 'manual 48k path required (windowed-sinc, not linear)');
    assert.ok(app.includes('bufRate'), 'buffer rate must be logged per turn');
  });
});

describe('source lifetime audit (Step 4)', () => {
  test('create/start/end/early/overlap counters + double-start guard', () => {
    const app = appSrc();
    for (const f of ['srcCreated', 'srcStarted', 'srcEnded', 'srcStoppedEarly', 'srcOverlaps']) {
      assert.ok(app.includes(f), `counter ${f} required`);
    }
    assert.ok(app.includes('source double-start prevented'), 'double-start guard required');
    assert.ok(app.includes('source overlap detected'), 'overlap detector required');
    assert.ok(app.includes('source ended naturally'), 'natural-end log required');
  });
});

describe('device facts (Step 6)', () => {
  test('latencies + output device enumeration logged', () => {
    const app = appSrc();
    assert.ok(app.includes('outputLatency') && app.includes('baseLatency'), 'latency probes required');
    assert.ok(app.includes('enumerateDevices'), 'device enumeration required');
    assert.ok(app.includes('AUDIO_DEVICE'), 'device log tag required');
  });
});

describe('server A/B capture endpoint (Steps 1-2)', () => {
  test('endpoint writes exact filenames + compare verdict', () => {
    const srv = diagSrc();
    assert.ok(srv.includes('/api/voice-ab-capture'), 'endpoint required');
    for (const f of ['raw-gemini-24k.pcm', 'raw-gemini-24k.wav', 'post-pipeline-24k.pcm', 'post-pipeline-24k.wav', 'pipeline-compare.json']) {
      assert.ok(srv.includes(f), `server must write ${f}`);
    }
    assert.ok(srv.includes('countDiscBuffer'), 'server discontinuity analysis required');
    assert.ok(srv.includes('bitIdentical'), 'bit-identical verdict required');
  });
});
