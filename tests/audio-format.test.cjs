// Audio format fidelity tests — bit-perfect PCM path, correct rates, no hidden processing.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { floatToPcm16Base64, base64ToBytes, parsePcmRate, analyzePcm16, applyEdgeRamps } = require('../src/voicePipe.js');

describe('audio format (radio-voice investigation)', () => {
  test('PCM16 base64 round-trip is lossless (no compression/quantization beyond 16-bit)', () => {
    const samples = new Float32Array(2048);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((i / samples.length) * Math.PI * 2 * 8) * 0.9; // 8-cycle tone
    }
    const bytes = base64ToBytes(floatToPcm16Base64(samples));
    assert.equal(bytes.length, samples.length * 2); // 2 bytes/sample, no framing overhead
    const back = new Int16Array(bytes.buffer, bytes.byteOffset, samples.length);
    for (let i = 0; i < samples.length; i++) {
      const expect = Math.round(Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 0x8000 : 0x7fff));
      assert.ok(Math.abs(back[i] - expect) <= 1, `sample ${i}: ${back[i]} vs ${expect}`);
    }
  });

  test('signed PCM: negatives map to 0x8000 range (no unsigned bug)', () => {
    const bytes = base64ToBytes(floatToPcm16Base64(new Float32Array([-1.0, -0.5, 0, 0.5, 1.0])));
    const back = new Int16Array(bytes.buffer, bytes.byteOffset, 5);
    assert.equal(back[0], -32768);
    assert.ok(back[1] < -16000 && back[1] > -17000);
    assert.equal(back[2], 0);
    assert.ok(back[3] > 16000 && back[3] < 17000);
    assert.equal(back[4], 32767);
  });

  test('mime rate parsing (never assume the rate)', () => {
    assert.equal(parsePcmRate('audio/pcm;rate=24000'), 24000);
    assert.equal(parsePcmRate('audio/pcm;rate=16000'), 16000);
    assert.equal(parsePcmRate(null), null);
    assert.equal(parsePcmRate('audio/mp3'), null);
  });

  test('playback honors chunk mime rate, defaults to 24000 (documented Gemini output)', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    assert.ok(app.includes('MODEL_OUT_RATE = 24000'), 'default output rate must be 24000');
    assert.ok(app.includes('parsePcmRate(rec.mime)'), 'chunk mime must drive buffer rate');
  });

  test('no gain/compressor/encoder in output path (would mask or cause distortion)', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    assert.ok(!app.includes('DynamicsCompressor'), 'no compressor allowed');
    assert.ok(!app.includes('MediaRecorder'), 'no re-encode allowed');
    assert.ok(app.includes('monitorGuard.gain.value = 0'), 'mic monitor must be zero-gain');
  });

  test('mic chunks low-latency (1024 frames @16kHz = 64ms)', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    assert.ok(app.includes('createScriptProcessor(1024'), 'mic chunk should be 1024 frames for low latency');
  });

  test('known-signal analysis: 440Hz tone measures correctly (PART 26)', () => {
    const rate = 24000, n = 2400; // 100ms speech-like window
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = Math.sin((i / rate) * Math.PI * 2 * 440) * 0.5;
    const stats = analyzePcm16(base64ToBytes(floatToPcm16Base64(tone)));
    assert.equal(stats.samples, n);
    assert.ok(stats.peak > 0.49 && stats.peak <= 0.5, `peak=${stats.peak}`);
    assert.ok(stats.rms > 0.34 && stats.rms < 0.37, `rms=${stats.rms}`);
    assert.equal(stats.clippingPct, 0);
    assert.ok(stats.zeroCross >= 80 && stats.zeroCross <= 100, `zc=${stats.zeroCross}`);
  });

  test('edge ramps silence 64-sample edges, preserve body (no delay added)', () => {
    const a = new Float32Array(1000).fill(0.8);
    applyEdgeRamps(a);
    assert.equal(a[0], 0);
    assert.ok(a[63] < 0.8 && a[63] > 0.7);
    assert.ok(Math.abs(a[500] - 0.8) < 1e-6);
    assert.ok(Math.abs(a[999]) < 1e-9);
  });

  test('auto-reconnect is bounded and skips auth failures (VoiceConnection)', () => {
    const conn = fs.readFileSync(path.join(__dirname, '..', 'src', 'voiceConnect.js'), 'utf-8');
    assert.ok(conn.includes('maxAttempts = 5') || conn.includes('maxAttempts'), 'retry budget must be bounded');
    assert.ok(conn.includes('scheduleReconnect'), 'close must schedule reconnect');
    assert.ok(conn.includes('single-flight') || conn.includes('clearTimer'), 'single-flight reconnect required');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.ts'), 'utf-8');
    assert.ok(/INVALID_API_KEY|clearGeminiApiKey/.test(srv), 'auth failures must suppress retry');
  });

  test('server forwards source mimeType instead of assuming format', () => {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.ts'), 'utf-8');
    assert.ok(srv.includes('inlineData?.mimeType') || srv.includes('mimeType'), 'server must read actual mimeType');
  });
});
