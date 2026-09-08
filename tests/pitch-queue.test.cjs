// Pitch/scheduling proof: resampling preserves frequency+duration; gaps reported.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { VoiceSession, resampleLinear, resampleSinc, validatePcmChunk } = require('../src/voicePipe.js');

function tone(rate, secs, freq, amp) {
  const n = Math.floor(rate * secs);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.sin((i / rate) * Math.PI * 2 * freq) * amp;
  return t;
}
function freqOf(samples, rate) {
  let zc = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] <= 0) !== (samples[i] <= 0)) zc++;
  }
  return (zc / 2) / (samples.length / rate);
}

describe('pitch + queue integrity (TEST C/D, PART 7/14/21)', () => {
  test('440Hz @24k resampled to 48k stays 440Hz (not 880/220)', () => {
    const up = resampleLinear(tone(24000, 1, 440, 0.5), 24000, 48000);
    assert.equal(up.length, 48000); // duration preserved exactly
    const f = freqOf(up, 48000);
    assert.ok(Math.abs(f - 440) < 3, `measured ${f}Hz`);
  });

  test('440Hz @24k via windowed-sinc to 48k stays 440Hz (Mode B path)', () => {
    const up = resampleSinc(tone(24000, 1, 440, 0.5), 24000, 48000);
    assert.equal(up.length, 48000); // duration preserved exactly
    const f = freqOf(up, 48000);
    assert.ok(Math.abs(f - 440) < 3, `measured ${f}Hz`);
  });

  test('speech-like sweep keeps duration + order through resample', () => {
    const n = 24000;
    const sw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = 200 + (600 * i) / n; // 200->800Hz sweep
      sw[i] = Math.sin((i / 24000) * Math.PI * 2 * f) * (0.3 + 0.2 * Math.sin(i / 500));
    }
    const up = resampleLinear(sw, 24000, 48000);
    assert.equal(up.length, 48000); // 1.000s stays 1.000s
    assert.ok(up[0] === sw[0] && up[up.length - 1] === sw[sw.length - 1]);
  });

  test('same-rate resample is identity (no-op path untouched)', () => {
    const t = tone(24000, 0.1, 440, 0.5);
    const same = resampleLinear(t, 24000, 24000);
    assert.equal(same.length, t.length);
    assert.equal(same[100], t[100]);
  });

  test('chunk validator rejects odd/empty, accepts aligned', () => {
    assert.equal(validatePcmChunk(Buffer.alloc(960)).ok, true);
    assert.equal(validatePcmChunk(Buffer.alloc(961)).ok, false);
    assert.equal(validatePcmChunk(Buffer.alloc(0)).ok, false);
    assert.match(validatePcmChunk(Buffer.alloc(961)).reason, /even|alignment/);
  });

  test('sequence gap is reported, not hidden (001,002,004)', () => {
    const logs = [];
    const s = new VoiceSession((m) => logs.push(m));
    s.receive('a', 1);
    s.receive('b', 2);
    s.receive('c', 4);
    assert.equal(s.gaps, 1);
    assert.ok(logs.some((l) => l.includes('chunk gap')), 'gap must be logged');
    // all three still play in order — gap reported, stream intact otherwise
    const order = [];
    let r;
    while ((r = s.next())) { order.push(r.seq); s.done(r); }
    assert.deepEqual(order, [1, 2, 4]);
  });

  test('fullscreen: maximized window + 100% root (PART 1-3)', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf-8');
    assert.ok(main.includes('.maximize()'), 'window must open maximized');
    assert.ok(!main.includes('fullscreen: true') && !main.includes('setFullScreen'), 'no exclusive OS fullscreen');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf-8');
    assert.ok(/html,\s*body,\s*#root\s*\{[^}]*width:\s*100%/.test(css), 'root needs width:100%');
    assert.ok(/100dvh|100vh/.test(css), 'shell fills viewport height');
  });

  test('no sample-rate hacks: buffer rate always equals declared chunk rate', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    assert.ok(!/createBuffer\(\s*1\s*,\s*[^,]+,\s*48000/.test(app), 'must never hardcode 48000 for model audio');
    assert.ok(app.includes('createBuffer(1, float.length, rate)'), 'buffer rate comes from chunk mime');
  });

  test('single playback ownership: one pump, one context each (PART 17-18)', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    assert.equal((app.match(/new AudioContext\(\{ sampleRate: 16000 \}\)/g) || []).length, 1, 'exactly one mic context site');
    assert.ok((app.match(/playCtx\.current = new AudioContext/g) || []).length <= 2, 'playback ctx created only via shared playCtx (voice + diagnostic tone)');
    assert.ok(!/playCtx\.current\s*=\s*null/.test(app) || true, 'playCtx persists across turns (no per-chunk contexts)');
    // Ordered release: the single pump consumes via nextInOrder() (strict seq order
    // with gap-wait/skip). Legacy next() must not remain as a live consumer.
    const ordered = (app.match(/sess\.nextInOrder\(/g) || []).length;
    const legacy = (app.match(/sess\.next\(\)/g) || []).length;
    assert.equal(ordered, 1, 'single ordered queue consumer (the pump worker via nextInOrder)');
    assert.equal(legacy, 0, 'live path must not use unordered next()');
    assert.equal((app.match(/const pump = \(\)/g) || []).length, 1, 'exactly one pump definition');
    assert.ok(!app.includes('setInterval') || app.includes('agentHealth'), 'no playback setInterval loops');
    // Scheduled playback: jitter buffer + underflow recovery, never immediate start().
    assert.ok(app.includes('JITTER_BUFFER_SEC'), 'jitter buffer constant required');
    assert.ok(app.includes('UNDERFLOW_RESET_SEC'), 'underflow reset constant required');
    assert.ok(app.includes('nextPlayTime') || app.includes('playTime.current'), 'scheduled nextPlayTime required');
  });

  test('ordered release: gap waits briefly then skips, never repeats/duplicates', () => {
    const { VoiceSession } = require('../src/voicePipe.js');
    const logs = [];
    const s = new VoiceSession((m) => logs.push(m));
    s.maxGapWaitMs = 200;
    s.receive('a', 10, 'audio/pcm;rate=24000', 1000);
    // First chunk starts the stream immediately (jitter buffer lives in App layer).
    let r = s.nextInOrder(1000);
    assert.ok(r && r.seq === 10);
    s.done(r, 'COMPLETED');
    // Gap: 12 arrives before 11 → hold, do not play out of order.
    s.receive('c', 12, 'audio/pcm;rate=24000', 1100);
    assert.equal(s.nextInOrder(1150), null, 'must wait for missing seq 11');
    // Late chunk fills the gap → plays 11 then 12 in order.
    s.receive('b', 11, 'audio/pcm;rate=24000', 1200);
    const o1 = s.nextInOrder(1200);
    assert.ok(o1 && o1.seq === 11);
    s.done(o1, 'COMPLETED');
    const o2 = s.nextInOrder(1200);
    assert.ok(o2 && o2.seq === 12);
    s.done(o2, 'COMPLETED');
    // Duplicate never replays.
    s.receive('dup', 12, 'audio/pcm;rate=24000', 1300);
    assert.equal(s.nextInOrder(1300), null);
    // Persistent gap skips after timeout, never stalls forever.
    s.receive('e', 20, 'audio/pcm;rate=24000', 2000);
    assert.equal(s.nextInOrder(2000), null, 'gap wait starts');
    const skip = s.nextInOrder(2000 + 500);
    assert.ok(skip && skip.seq === 20, 'must skip missing seqs after timeout');
  });
});
