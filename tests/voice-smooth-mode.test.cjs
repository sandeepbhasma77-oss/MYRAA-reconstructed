// Smooth Voice Mode (default): buffer-then-play turns continuously instead of
// restarting per chunk under slow delivery. Streaming kept as an opt-out.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { estimatePcmSec, smoothGate, deliveryRate, reserveUpdate, windowedRate } = require('../src/voicePipe.js');

const appSrc = () => fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

describe('smooth buffer accounting (pure)', () => {
  test('base64 length estimates PCM seconds within a sample', () => {
    // 24000 samples = 48000 bytes = 64000 b64 chars -> exactly 1.0 s @24kHz.
    assert.equal(estimatePcmSec(64000, 24000), 1);
    assert.equal(estimatePcmSec(0, 24000), 0);
    assert.equal(estimatePcmSec(64000, 0), 0);
    // Odd-sized payload floors to whole samples, never invents audio.
    assert.ok(estimatePcmSec(100, 24000) >= 0);
  });

  test('gate waits for a completed turn on slow/unknown delivery', () => {
    const T = 1.0;
    const noRate = (o) => ({ ...o, rate: null });
    assert.equal(smoothGate(noRate({ started: false, turnDone: false, bufferedSec: 0.5 }), T), false, 'holds below target');
    assert.equal(smoothGate(noRate({ started: false, turnDone: false, bufferedSec: 0.999 }), T), false, 'holds just below target');
    assert.equal(smoothGate(noRate({ started: false, turnDone: true, bufferedSec: 0.3 }), T), true, 'turn end releases partial buffer');
    assert.equal(smoothGate(noRate({ started: false, turnDone: true, bufferedSec: 0 }), T), false, 'empty turn never starts');
    assert.equal(smoothGate(noRate({ started: true, turnDone: false, bufferedSec: 0 }), T), true, 'started stays started');
    assert.equal(smoothGate(noRate({ started: false, turnDone: false, bufferedSec: 31 }), T, 30), true, 'safety cap starts very long turns anyway');
    assert.equal(smoothGate(null, T), true, 'no state never blocks legacy paths');
  });

  test('early start ONLY on safely-fast measured delivery (>=1.25x)', () => {
    const T = 1.0;
    // Slow delivery must wait even far past the byte threshold.
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.5, rate: 0.45 }, T), false);
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 2.5, rate: 0.9 }, T), false);
    // Safely faster than real time with target buffered: early start allowed.
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.0, rate: 1.25 }, T), true);
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.2, rate: 3.6 }, T), true);
    // Unknown or below-threshold rate: wait (except turn end / safety cap).
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.2, rate: null }, T), false);
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.2, rate: 1.24 }, T), false, 'below 1.25x is not safe');
  });

  test('delivery rate needs enough evidence before it counts', () => {
    assert.ok(Math.abs(deliveryRate(2.26, 5000, 10) - 0.452) < 1e-9);
    assert.equal(deliveryRate(0.2, 100, 1), null, 'single chunk proves nothing');
    assert.equal(deliveryRate(0.6, 400, 4), null, 'too little elapsed');
    assert.equal(deliveryRate(0, 0, 0), null);
  });

  test('reserve hold pauses below 700ms, resumes at target or turn end', () => {
    assert.deepEqual(reserveUpdate({ started: true, turnDone: false, bufferedSec: 0.5, paused: false }), { hold: true, paused: true });
    assert.deepEqual(reserveUpdate({ started: true, turnDone: false, bufferedSec: 0.8, paused: true }, 0.7, 1.0), { hold: true, paused: true }, 'hysteresis until target');
    assert.deepEqual(reserveUpdate({ started: true, turnDone: false, bufferedSec: 1.2, paused: true }, 0.7, 1.0), { hold: false, paused: false });
    assert.deepEqual(reserveUpdate({ started: true, turnDone: true, bufferedSec: 0.1, paused: true }), { hold: false, paused: false }, 'turn end releases');
    assert.deepEqual(reserveUpdate({ started: false, turnDone: false, bufferedSec: 0, paused: false }), { hold: false, paused: false });
  });

  test('windowed rate ignores one stale stall (slow turn, fast tail)', () => {
    // 7.3 s audio over 17 s wall (cumulative 0.43x) but the last 10 chunks
    // arrived fast: the window must report fast so playback can start.
    const histT = [0, 15000, 16100, 16200, 16300, 16400, 16500, 16600, 16700, 16800, 16900, 17000];
    const histA = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    const r = windowedRate(histT, histA);
    assert.ok(r !== null && r > 1.25, `recent burst must read fast, got ${r}`);
    assert.ok(smoothGate({ started: false, turnDone: false, bufferedSec: 1.5, rate: r }, 1.0), 'fast tail starts despite stale stall');
    // Steady slow delivery still waits.
    const slowT = [0, 800, 1600, 2400, 3200, 4000];
    const slowA = [0.2, 0.2, 0.2, 0.2, 0.2, 0.2];
    const rs = windowedRate(slowT, slowA);
    assert.ok(rs !== null && rs < 1.25, `slow stream reads slow, got ${rs}`);
    assert.equal(smoothGate({ started: false, turnDone: false, bufferedSec: 1.5, rate: rs }, 1.0), false);
    // Insufficient evidence never decides.
    assert.equal(windowedRate([0, 100], [0.2, 0.2]), null);
    assert.equal(windowedRate([], []), null);
  });
});

describe('audibility: autoplay unlock + suspended-context gate', () => {
  test('unlock listener is persistent (never one-shot)', () => {
    const app = appSrc();
    assert.ok(app.includes("window.addEventListener('keydown', unlock)"), 'keyboard gestures must also unlock');
    assert.ok(!/addEventListener\('pointerdown', unlock, \{ once: true \}\)/.test(app),
      'one-shot unlock misses lazily created contexts and mutes voice permanently');
  });

  test('pump refuses to schedule into a frozen clock and hints the human', () => {
    const app = appSrc();
    assert.ok(app.includes('AUDIO_SUSPENDED'), 'suspended diagnostic tag required');
    assert.ok(app.includes('Click anywhere to enable audio'), 'human hint required');
    assert.ok(app.includes("ensurePlaybackEngine('pump-gate')"), 'readiness gate required before release');
    // Gate order: suspended check must precede queue consumption.
    const gateAt = app.indexOf("ensurePlaybackEngine('pump-gate')");
    const releaseAt = app.indexOf('sess.nextInOrder(');
    assert.ok(gateAt !== -1 && releaseAt !== -1 && gateAt < releaseAt, 'gate must run before nextInOrder');
  });
});

describe('smooth mode wiring (default on, stream opt-out)', () => {
  test('smooth is default; streaming requires explicit opt-in flag', () => {
    const app = appSrc();
    assert.ok(app.includes('SMOOTH_TARGET_SEC'), 'smooth target constant required');
    assert.ok(app.includes('myraa_live_stream'), 'stream opt-out flag required');
    assert.ok(/if\s*\(!retired && !(pipeFlags\.stream|isStreamMode\(\))\)/.test(app), 'gate must be skipped only in stream mode (cached pipeFlags allowed)');
  });

  test('pump gates release, accrues buffer, decrements on schedule', () => {
    const app = appSrc();
    assert.ok(app.includes('smoothGate(gateState,'), 'pump must consult the pure gate with measured rate');
    assert.ok(app.includes('deliveryRate('), 'delivery rate must be measured per turn');
    assert.ok(app.includes('turnFreshRate()'), 'windowed freshness-proof rate required');
    assert.ok(app.includes('SMOOTH_START'), 'playback-start diagnostic required');
    assert.ok(app.includes('SMOOTH_PAUSE') && app.includes('SMOOTH_RESUME'), 'reserve pause/resume required');
    assert.ok(app.includes('bufferedSec += estimatePcmSec') || app.includes('bufferedSec += estSec'), 'receive-side accrual required');
    assert.ok(app.includes('bufferedSec - buf.duration'), 'schedule-side decrement required');
  });

  test('turn completion releases pending audio; interruptions reset the turn', () => {
    const app = appSrc();
    assert.ok(app.includes('smoothTurn.current.turnDone = true'), 'turn end must be recorded');
    assert.ok(app.includes('resetSmoothTurn()'), 'reset helper required');
    assert.ok(app.includes('defensive start of stranded queue'), 'stranded audio must play, never strand silent');
  });

  test('worker can never wedge: stale ends still release, retired drain dies on stop', () => {
    const app = appSrc();
    assert.ok(app.includes("sess.done(rec, fresh ? 'COMPLETED' : 'STALE')"), 'stale ends must still unblock the worker');
    assert.ok(app.includes('retiredAudio.current?.interrupt()'), 'stop must kill retired drain sessions');
    assert.ok(app.includes('schedChain') && app.includes('schedFresh'), 'chain-vs-restart proof counters required');
  });

  test('per-turn smooth diagnostics in the summary', () => {
    const app = appSrc();
    for (const f of ['playMode=', 'bufBeforePlay=', 'waitedComplete=', 'turnAudioSec=', 'scheduledSec=', 'arrivalRate=', 'earlyStreamingAllowed=']) {
      assert.ok(app.includes(f), `summary field ${f} required`);
    }
  });
});
