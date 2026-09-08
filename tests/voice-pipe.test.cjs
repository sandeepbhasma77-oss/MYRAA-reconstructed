// Voice pipeline protocol tests — no microphone/speaker required.
// Verifies queue ordering, dedupe, interruption, session isolation, cleanup.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { VoiceSession } = require('../src/voicePipe.js');

const silent = () => {};
const played = (sess) => {
  // Simulate the single playback worker draining the queue in order.
  const order = [];
  let rec;
  while ((rec = sess.next())) {
    order.push(rec.chunkId);
    sess.done(rec, 'COMPLETED');
  }
  return order;
};

describe('voice audio queue (single worker, ordered)', () => {
  test('Test 1 — one chunk in, one playback out', () => {
    const s = new VoiceSession(silent);
    const rec = s.receive('AAA', 0);
    assert.ok(rec);
    assert.equal(played(s).length, 1);
  });

  test('Test 2 — chunks play 1,2,3 in order even if received 3,1,2', () => {
    const s = new VoiceSession(silent);
    s.receive('C', 2);
    s.receive('A', 0);
    s.receive('B', 1);
    assert.deepEqual(played(s), [`${s.id}#0`, `${s.id}#1`, `${s.id}#2`]);
  });

  test('Test 3 — duplicate chunk plays once', () => {
    const s = new VoiceSession(silent);
    assert.ok(s.receive('A', 7));
    assert.equal(s.receive('A', 7), null);
    assert.equal(played(s).length, 1);
  });

  test('Test 4 — interruption clears old audio; new audio plays alone', () => {
    const s = new VoiceSession(silent);
    s.receive('OLD1', 0);
    s.receive('OLD2', 1);
    s.transition('LISTENING');
    s.transition('THINKING');
    s.transition('SPEAKING');
    assert.equal(s.interrupt(), 2);
    assert.equal(played(s).length, 0);
    s.transition('INTERRUPTED');
    s.transition('LISTENING');
    s.receive('NEW', 2);
    assert.deepEqual(played(s), [`${s.id}#2`]);
  });

  test('Test 5 — old session audio never valid in a new session', () => {
    const a = new VoiceSession(silent);
    a.receive('STALE', 0);
    a.close();
    const b = new VoiceSession(silent);
    assert.notEqual(a.id, b.id);
    assert.equal(played(a).length, 0);
    b.receive('FRESH', 0);
    const out = played(b);
    assert.equal(out.length, 1);
    assert.ok(!out[0].startsWith(a.id));
  });

  test('Test 6 — repeated start/stop leaves no orphans', () => {
    for (let i = 0; i < 5; i++) {
      const s = new VoiceSession(silent);
      s.transition('LISTENING');
      s.receive('x', 0);
      s.close();
      assert.equal(s.queue.length, 0);
      assert.equal(s.byId.size, 0);
      assert.equal(s.next(), null);
    }
  });

  test('state machine rejects invalid transitions (no duplicate edges)', () => {
    const s = new VoiceSession(silent);
    assert.equal(s.transition('SPEAKING'), false); // IDLE -> SPEAKING illegal
    assert.equal(s.transition('LISTENING'), true);
    assert.equal(s.transition('LISTENING'), false); // duplicate edge
    assert.equal(s.transition('THINKING'), true);
    assert.equal(s.transition('SPEAKING'), true);
    assert.equal(s.transition('SPEAKING'), false);
  });

  test('mic constraints in App use echo cancellation suite', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');
    for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'channelCount']) {
      assert.ok(app.includes(k), `App.tsx must set mic constraint ${k}`);
    }
    assert.ok(app.includes('16000'), 'mic must target 16kHz for Gemini Live input');
    assert.ok(app.includes('24000'), 'playback must use 24kHz Gemini Live output rate');
  });
});
