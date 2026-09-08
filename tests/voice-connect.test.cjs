// GoAway retirement + reconnect lifecycle tests (connection abstraction layer).
// Drives the REAL VoiceConnection + VoiceSession + voiceProto shapes with mock
// sockets/timers — never the UI error handler, never a real Gemini session.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceConnection } = require('../src/voiceConnect.js');
const {
  CONN_STATES, canConnTransition, isGoAwaySignal, isGoAwayErrorText,
  sessionRetiringEvent, sessionClosedEvent, CLOSE_CLASSES, classifyGeminiClose,
  newTurnId, noteSeen,
} = require('../src/voiceProto.js');
const { VoiceSession } = require('../src/voicePipe.js');

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    runNext() {
      const [id, t] = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0] || [];
      if (id === undefined) return false;
      pending.delete(id);
      t.fn();
      return true;
    },
  };
}

function mockActions() {
  const calls = [];
  return {
    calls,
    closeSocket: (gen) => { calls.push(['closeSocket', gen]); },
    openSocket: (gen) => { calls.push(['openSocket', gen]); },
    setMicSend: (on) => { calls.push(['setMicSend', on]); },
    retireAudio: (gen) => { calls.push(['retireAudio', gen]); },
  };
}

function harness() {
  const events = [];
  const timers = fakeTimers();
  const conn = new VoiceConnection({ emit: (t, d) => events.push([t, d]), timers });
  const actions = mockActions();
  conn.actions = actions;
  return { conn, events, timers, actions };
}

const GOAWAY_OBSERVED = 'Gemini Live closed (Connection aborted because the client failed to close the connection after receiving a GoAway signal once the session duration limit was reached)';

describe('voiceProto contract', () => {
  it('exposes the required connection states', () => {
    for (const s of ['IDLE', 'CONNECTING', 'CONNECTED', 'GOAWAY_RECEIVED', 'CLOSING', 'RECONNECT_WAIT', 'RECONNECTING', 'ERROR', 'STOPPED']) {
      assert.ok(CONN_STATES.includes(s), s);
    }
  });
  it('allows the full GoAway rotation path', () => {
    for (const [a, b] of [['CONNECTED', 'GOAWAY_RECEIVED'], ['GOAWAY_RECEIVED', 'CLOSING'], ['CLOSING', 'RECONNECT_WAIT'], ['RECONNECT_WAIT', 'RECONNECTING'], ['RECONNECTING', 'CONNECTING'], ['CONNECTING', 'CONNECTED']]) {
      assert.ok(canConnTransition(a, b), `${a}->${b}`);
    }
  });
  it('detects the observed GoAway string, rejects clean closes', () => {
    assert.equal(isGoAwaySignal({ code: 1000, reason: GOAWAY_OBSERVED }), true);
    assert.equal(isGoAwaySignal({ code: 1012, reason: 'GoAway received' }), true);
    assert.equal(isGoAwayErrorText(GOAWAY_OBSERVED), true);
    assert.equal(isGoAwaySignal({ code: 1000, reason: 'closed' }), false);
    assert.equal(isGoAwaySignal({ code: 1005, reason: '' }), false);
    assert.equal(isGoAwaySignal({ code: 1008, reason: 'unauthenticated: bad api key' }), false);
  });
  it('builds a structured retiring event (never the fatal string)', () => {
    const e = sessionRetiringEvent({ voiceSid: 'VOICE_SESSION_SRV-x', code: 1000, reason: GOAWAY_OBSERVED, generation: 3 });
    assert.equal(e.type, 'session_retiring');
    assert.equal(e.reason, 'goaway');
    assert.ok(!JSON.stringify(e).includes('Check Settings'));
  });
  it('turn ids are unique; noteSeen dedupes', () => {
    assert.notEqual(newTurnId(), newTurnId());
    const s = new Set();
    assert.equal(noteSeen(s, 'a'), true);
    assert.equal(noteSeen(s, 'a'), false);
  });
});

describe('VoiceConnection single-flight + close-once', () => {
  it('refuses a second concurrent connect', () => {
    const { conn } = harness();
    assert.equal(conn.userConnect('user').ok, true);
    assert.equal(conn.userConnect('user').ok, false);
    assert.equal(conn.snapshot().generation, 1);
  });
  it('closeSession is idempotent per generation', () => {
    const { conn, actions } = harness();
    const { generation: g } = conn.userConnect('user');
    assert.equal(conn.closeSession('x', g).ok, true);
    assert.equal(conn.closeSession('x', g).ok, false);
    assert.deepEqual(actions.calls.filter((c) => c[0] === 'closeSocket'), [['closeSocket', g]]);
  });
  it('userDisconnect closes once then parks STOPPED without scheduling', () => {
    const { conn, timers, events } = harness();
    conn.userConnect('user');
    conn.noteConnected(1);
    conn.userDisconnect();
    assert.equal(conn.state, 'CLOSING');
    conn.onSocketClose(1, { code: 1000 }); // socket ack of our close
    assert.equal(conn.state, 'STOPPED');
    assert.equal(timers.pending.size, 0);
    assert.ok(!events.some(([t]) => t === 'VOICE_RECONNECT_SCHEDULED'));
  });
});

describe('GoAway lifecycle (mock-socket harness)', () => {
  function connected(timersWanted) {
    const h = harness();
    h.conn.userConnect('user');
    h.conn.onSocketOpen(1);
    h.conn.noteConnected(1);
    h.conn.noteHealthy(1);
    h.actions.calls.length = 0;
    return h;
  }
  it('retires on session_retiring: freeze input, one close, one timer', () => {
    const h = connected();
    const r = h.conn.onSocketMessage(1, sessionRetiringEvent({ voiceSid: 'SRV-1', code: 1000, reason: GOAWAY_OBSERVED, generation: 1 }));
    assert.equal(r.retiring, true);
    assert.equal(h.conn.state, 'CLOSING');
    assert.deepEqual(h.actions.calls.filter((c) => c[0] === 'setMicSend'), [['setMicSend', false]]);
    assert.deepEqual(h.actions.calls.filter((c) => c[0] === 'closeSocket'), [['closeSocket', 1]]);
    assert.equal([...h.timers.pending.values()].filter((t) => true).length, 1);
    assert.ok(h.events.some(([t]) => t === 'VOICE_GOAWAY_RECEIVED'));
    // No new socket yet.
    assert.ok(!h.actions.calls.some((c) => c[0] === 'openSocket'));
  });
  it('exactly one reconnect with a fresh generation; stale gen1 callbacks die', () => {
    const h = connected();
    h.conn.onSocketMessage(1, sessionRetiringEvent({ voiceSid: 'SRV-1', generation: 1 }));
    h.conn.onSocketClose(1, { code: 1000 });
    assert.equal(h.conn.state, 'RECONNECT_WAIT');
    assert.deepEqual(h.actions.calls.filter((c) => c[0] === 'retireAudio'), [['retireAudio', 1]]);
    assert.equal(h.timers.pending.size, 1, 'single reconnect timer');
    assert.ok(h.timers.runNext(), 'timer fires');
    assert.equal(h.conn.generation, 2, 'fresh generation per attempt');
    assert.deepEqual(h.actions.calls.filter((c) => c[0] === 'openSocket'), [['openSocket', 2]]);
    // Stale gen-1 traffic is ignored and never reopens anything.
    const nCalls = h.actions.calls.length;
    assert.equal(h.conn.onSocketMessage(1, { type: 'audio' }).stale, true);
    h.conn.onSocketClose(1, {});
    assert.equal(h.actions.calls.length, nCalls);
    // New generation connects cleanly.
    h.conn.onSocketOpen(2);
    h.conn.noteConnected(2);
    assert.equal(h.conn.state, 'CONNECTED');
    assert.ok(h.events.some(([t]) => t === 'VOICE_RECONNECTED'));
  });
  it('backoff grows and caps; budget exhausts after maxAttempts', () => {
    const { conn } = harness();
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => conn.backoffDelay(a)), [2000, 4000, 8000, 16000, 30000, 30000]);
    conn.userConnect('user');
    conn.noteConnected(1);
    for (let i = 0; i < 5; i++) {
      conn.onSocketMessage(1, { type: 'session_retiring', generation: 1 });
      // each rotation bumps generation; close the CURRENT one
      conn.onSocketClose(conn.generation, {});
      conn.timers.runNext();
      conn.onSocketOpen(conn.generation);
      // drop it again without audio (no budget restore) to burn attempts
      conn.onSocketClose(conn.generation, { code: 1013 });
    }
    assert.ok(conn.attempt >= 5);
  });
  it('unexpected close without GoAway still rotates (no fatal terminal)', () => {
    const h = connected();
    h.conn.onSocketClose(1, { code: 1006, reason: '' });
    assert.ok(['CLOSING', 'ERROR'].includes(h.conn.state));
    h.timers.runNext(); // bounded close-wait elapses -> finalize -> rotate
    assert.equal(h.conn.state, 'RECONNECT_WAIT');
    assert.ok(h.events.some(([t]) => t === 'VOICE_RECONNECT_SCHEDULED'));
    assert.ok(!JSON.stringify(h.events).includes('Check Settings'));
  });
  it('controller never emits sends or replays (no text/greet/audio actions)', () => {
    const h = connected();
    h.conn.onSocketMessage(1, sessionRetiringEvent({ generation: 1 }));
    h.conn.onSocketClose(1, {});
    h.timers.runNext();
    const kinds = new Set(h.actions.calls.map((c) => c[0]));
    for (const k of kinds) assert.ok(['closeSocket', 'openSocket', 'setMicSend', 'retireAudio'].includes(k), k);
  });
});

describe('VoiceSession retirement (audio generation guard)', () => {
  it('retired sessions reject new chunks; live ones unaffected', () => {
    const live = new VoiceSession(() => {});
    const old = new VoiceSession(() => {});
    old.generation = 1;
    old.retire();
    assert.equal(old.receive('AAA=', 0), null);
    assert.ok(live.receive('AAA=', 0));
  });
});

describe('remote close without retirement (code 1006, empty reason)', () => {
  function connected() {
    const h = harness();
    h.conn.userConnect('user');
    h.conn.onSocketOpen(1);
    h.conn.noteConnected(1);
    h.actions.calls.length = 0;
    return h;
  }
  it('classifies closes without inventing a reason', () => {
    // The exact reported failure: 1006 + '' must NOT become 'closed'.
    assert.equal(classifyGeminiClose({ code: 1006, reasonText: '' }), 'NETWORK_DISCONNECT');
    assert.equal(classifyGeminiClose({ code: 1005, reasonText: '' }), 'NETWORK_DISCONNECT');
    assert.equal(classifyGeminiClose({ code: 1008, reasonText: '' }), 'AUTH_OR_API_ERROR');
    assert.equal(classifyGeminiClose({ code: 1011, reasonText: 'internal error' }), 'SERVER_ERROR');
    assert.equal(classifyGeminiClose({ code: 1000, reasonText: 'bye' }), 'UNEXPECTED_CLOSE');
    assert.equal(classifyGeminiClose({ localInitiated: true, clientGone: true }), 'USER_DISCONNECTED');
    assert.equal(classifyGeminiClose({ localInitiated: true, clientGone: false }), 'APPLICATION_SHUTDOWN');
    assert.ok(CLOSE_CLASSES.includes('NETWORK_DISCONNECT'));
  });
  it('session_closed preserves raw code/reason, never the fatal string', () => {
    const e = sessionClosedEvent({ voiceSid: 'SRV-9', code: 1006, reason: '', closeClass: 'NETWORK_DISCONNECT', generation: 2 });
    assert.equal(e.type, 'session_closed');
    assert.equal(e.code, 1006);
    assert.equal(e.reason, '');
    assert.ok(!JSON.stringify(e).includes('closed ('));
    assert.ok(!JSON.stringify(e).includes('Check Settings'));
  });
  it('remote close rotates exactly once with full evidence, no fatal UI', () => {
    const h = connected();
    const r = h.conn.onSocketMessage(1, sessionClosedEvent({
      voiceSid: 'SRV-9', code: 1006, reason: '', closeClass: 'NETWORK_DISCONNECT', generation: 1,
    }));
    assert.equal(r.remoteClosed, true);
    assert.equal(h.conn.state, 'CLOSING');
    assert.equal(h.conn.lastCloseReason, 'remote-close');
    const ev = h.events.find(([t]) => t === 'VOICE_REMOTE_CLOSE');
    assert.ok(ev, 'VOICE_REMOTE_CLOSE emitted');
    assert.equal(ev[1].code, 1006);
    assert.equal(ev[1].closeClass, 'NETWORK_DISCONNECT');
    // Socket ack completes the close; single timer; fresh generation reconnects.
    h.conn.onSocketClose(1, { code: 1006, reason: '' });
    assert.equal(h.conn.state, 'RECONNECT_WAIT');
    assert.equal(h.timers.pending.size, 1, 'single reconnect timer');
    assert.ok(h.timers.runNext());
    assert.equal(h.conn.generation, 2);
    h.conn.onSocketOpen(2);
    h.conn.noteConnected(2);
    assert.equal(h.conn.state, 'CONNECTED');
    assert.ok(h.events.some(([t]) => t === 'VOICE_RECONNECTED'));
    assert.ok(!JSON.stringify(h.events).includes('Check Settings'));
  });
  it('lifecycle audit tags fire on connect/close/exhaust/error', () => {
    const h = harness();
    h.conn.userConnect('user');
    assert.ok(h.events.some(([t]) => t === 'VOICE_CONNECT_REQUESTED'));
    assert.ok(h.events.some(([t]) => t === 'VOICE_CONNECTING'));
    h.conn.noteConnected(1);
    h.conn.onSocketError(1, 'socket error');
    assert.ok(h.events.some(([t]) => t === 'VOICE_ERROR'));
    assert.ok(h.events.some(([t]) => t === 'VOICE_LOCAL_CLOSE_REQUESTED'));
  });
  it('retry budget ends in an explicit final failure (remote-close storm)', () => {
    const h = harness();
    h.conn.userConnect('user');
    h.conn.noteConnected(1);
    for (let i = 0; i < 6; i++) {
      const g = h.conn.generation;
      h.conn.onSocketMessage(g, { type: 'session_closed', generation: g, code: 1006, closeClass: 'NETWORK_DISCONNECT' });
      h.conn.onSocketClose(h.conn.generation, { code: 1006 });
      h.timers.runNext();
    }
    assert.ok(h.conn.attempt >= 5);
    assert.ok(h.events.some(([t]) => t === 'VOICE_FINAL_FAILURE'));
  });
  it('user stop records its own reason (drain-vs-hard-stop audit)', () => {
    const h = connected();
    h.conn.userDisconnect();
    assert.equal(h.conn.lastCloseReason, 'user');
    assert.equal(h.conn.stopAfterClose, true);
  });
});
