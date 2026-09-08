// Voice-diag endpoint tests — no microphone needed. Writes synthetic dumps,
// then verifies TEST C comparison logic through the live backend.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = 'http://localhost:3000';
const AGENT = 'http://127.0.0.1:8765';

function tonePcm16(seconds, rate, freq) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((i / rate) * Math.PI * 2 * freq) * 20000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

describe('voice diagnostics (TEST A/B/C logic)', () => {
  test('TEST B+C: identical dumps compare BYTE_IDENTICAL=true with rates', async () => {
    const pcm = tonePcm16(0.5, 24000, 440);
    const post = await (await fetch(`${BASE}/api/voice-dump`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcmBase64: pcm.toString('base64'), playbackSampleRate: 48000, bufferRate: 24000 }),
    })).json();
    assert.equal(post.ok, true);
    assert.equal(post.byteLength, pcm.length);
    assert.equal(post.sha256, crypto.createHash('sha256').update(pcm).digest('hex'));
    // Seed a matching TEST A file directly (live turns need quota+mic).
    const dbg = path.join(process.cwd(), 'debug');
    fs.mkdirSync(dbg, { recursive: true });
    fs.writeFileSync(path.join(dbg, 'raw-gemini-response.pcm'), pcm);
    fs.writeFileSync(path.join(dbg, 'raw-gemini-response.json'), JSON.stringify({
      mime: 'audio/pcm;rate=24000', sampleRate: 24000, channels: 1, bitDepth: 16,
      byteLength: pcm.length, durationSec: 0.5,
      sha256: crypto.createHash('sha256').update(pcm).digest('hex'),
    }));
    const diag = await (await fetch(`${BASE}/api/voice-diag`)).json();
    assert.equal(diag.SOURCE_SAMPLE_RATE, 24000);
    assert.equal(diag.PLAYBACK_SAMPLE_RATE, 48000);
    assert.equal(diag.BYTE_IDENTICAL, true);
    assert.equal(diag.RESAMPLING_REQUIRED, true);
    assert.match(String(diag.RESAMPLING_METHOD), /browser mixer/);
  });

  test('TEST C: differing bytes compare BYTE_IDENTICAL=false', async () => {
    const dbg = path.join(process.cwd(), 'debug');
    const other = tonePcm16(0.5, 24000, 880);
    fs.writeFileSync(path.join(dbg, 'raw-gemini-response.pcm'), other);
    const diag = await (await fetch(`${BASE}/api/voice-diag`)).json();
    assert.equal(diag.BYTE_IDENTICAL, false);
    // Restore identical pair so later runs stay consistent.
    const play = fs.readFileSync(path.join(dbg, 'playback-response.pcm'));
    fs.writeFileSync(path.join(dbg, 'raw-gemini-response.pcm'), play);
  });

  test('TEST D: audio_devices reports render devices (no mic needed)', async () => {
    const r = await (await fetch(`${AGENT}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'audio_devices', args: {} }),
    })).json();
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.equal(r.result.success, true);
    assert.ok(Array.isArray(r.result.data.render));
    assert.ok(Array.isArray(r.result.data.warnings));
    void os;
  });
});
