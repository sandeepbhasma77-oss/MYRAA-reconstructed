// MYRAA voice connection controller — framework-free so node --test can verify it.
// EXACTLY ONE authoritative session state (see voiceProto CONN_STATES).
// Single-flight reconnect, idempotent close-once, generation-stamped stale
// guards. Side effects (sockets, mic, audio, UI) happen ONLY through the
// injected `actions` object, so tests can drive the real lifecycle with mocks.
import { canConnTransition } from './voiceProto.js';

export class VoiceConnection {
  constructor({ emit, timers, now } = {}) {
    this.emit = emit || (() => {});
    this.timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    this.now = now || (() => Date.now());
    this.actions = null;
    this.state = 'IDLE';
    this.generation = 0;
    this.attempt = 0;
    this.maxAttempts = 5;
    this.baseDelayMs = 2000;
    this.maxDelayMs = 30000;
    this.closeTimeoutMs = 1500;
    this.timerId = 0;
    this.timerGen = -1;
    this.timerKind = null;
    this.isConnecting = false;
    this.closedGens = new Set();
    this.stopAfterClose = false;
    this.voiceActive = false;
    this.lastReason = '';
    this.lastCloseReason = ''; // reason passed to the most recent closeSession (audit trail)
  }

  ev(type, detail) {
    try {
      this.emit(type, {
        generation: this.generation,
        state: this.state,
        attempt: this.attempt,
        at: new Date(this.now()).toISOString(),
        ...(detail || {}),
      });
    } catch { /* diagnostics never break control flow */ }
  }

  isCurrent(gen) {
    return gen === this.generation;
  }

  setState(next, why) {
    if (this.state === next) return true;
    if (!canConnTransition(this.state, next)) {
      this.ev('VOICE_BAD_TRANSITION', { from: this.state, to: next, why: why || '' });
      return false;
    }
    const from = this.state;
    this.state = next;
    this.ev('VOICE_CONN', { from, to: next, why: why || '' });
    return true;
  }

  backoffDelay(attempt1Based) {
    const d = this.baseDelayMs * 2 ** Math.max(0, attempt1Based - 1);
    return Math.min(this.maxDelayMs, d);
  }

  clearTimer() {
    if (this.timerId) {
      try { this.timers.clearTimeout(this.timerId); } catch { /* noop */ }
      this.timerId = 0;
      this.timerGen = -1;
      this.timerKind = null;
    }
  }

  // ---- user-initiated -------------------------------------------------------
  userConnect(reason) {
    if (this.isConnecting) {
      this.ev('VOICE_REFUSED', { why: 'already-connecting', reason: reason || '' });
      return { ok: false, why: 'already-connecting' };
    }
    if (this.state === 'CONNECTING' || this.state === 'RECONNECTING') {
      this.ev('VOICE_REFUSED', { why: 'connect-in-flight', reason: reason || '' });
      return { ok: false, why: 'connect-in-flight' };
    }
    this.clearTimer();
    this.stopAfterClose = false;
    this.attempt = 0;
    this.generation += 1;
    this.isConnecting = true;
    this.lastReason = reason || 'user';
    this.ev('VOICE_CONNECT_REQUESTED', { reason: this.lastReason });
    this.setState('CONNECTING', this.lastReason);
    this.ev('VOICE_CONNECTING', { reason: this.lastReason });
    this.ev('VOICE_SESSION_CREATED', { reason: this.lastReason });
    return { ok: true, generation: this.generation };
  }

  userDisconnect() {
    this.voiceActive = false;
    this.clearTimer();
    this.stopAfterClose = true;
    const gen = this.generation;
    const r = this.closeSession('user', gen);
    if (r.ok && this.state !== 'CLOSING') this.setState('STOPPED', 'user');
    else if (!r.ok) this.setState('STOPPED', 'user-already-closed');
    return r;
  }

  // ---- socket events (all generation-stamped) --------------------------------
  onSocketOpen(gen) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'open', gen });
      try { this.actions?.closeSocket?.(gen); } catch { /* noop */ }
      return false;
    }
    return true;
  }

  noteConnected(gen) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'connected', gen });
      try { this.actions?.closeSocket?.(gen); } catch { /* noop */ }
      return false;
    }
    this.isConnecting = false;
    const wasReconnect = this.state === 'RECONNECTING' || this.attempt > 0;
    this.setState('CONNECTED', wasReconnect ? 'reconnected' : 'connected');
    this.ev(wasReconnect ? 'VOICE_RECONNECTED' : 'VOICE_CONNECTED', {});
    return true;
  }

  noteHealthy(gen) {
    if (this.isCurrent(gen) && this.state === 'CONNECTED' && this.attempt !== 0) {
      this.attempt = 0;
      this.ev('VOICE_HEALTHY', {});
    }
  }

  onSocketMessage(gen, msg) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'message', gen, type: msg?.type });
      return { handled: false, stale: true };
    }
    if (msg && msg.type === 'session_retiring') {
      this.goAwayFlow(gen, msg);
      return { handled: true, retiring: true };
    }
    if (msg && msg.type === 'session_closed') {
      this.remoteCloseFlow(gen, msg);
      return { handled: true, remoteClosed: true };
    }
    return { handled: true, retiring: false };
  }

  // ---- GoAway: CONNECTED -> GOAWAY_RECEIVED, freeze input, no new socket yet --
  goAwayFlow(gen, msg) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'goaway', gen });
      return false;
    }
    if (this.state !== 'CONNECTED' && this.state !== 'CONNECTING') {
      this.ev('VOICE_STALE_IGNORED', { what: 'goaway-wrong-state', gen });
      return false;
    }
    this.ev('VOICE_GOAWAY_RECEIVED', {
      sessionId: msg?.voiceSid || msg?.sessionId || '',
      code: msg?.code ?? null,
      detail: String(msg?.detail || msg?.reason || '').slice(0, 160),
    });
    this.setState('GOAWAY_RECEIVED', 'gemini-goaway');
    try { this.actions?.setMicSend?.(false); } catch { /* noop */ }
    this.closeSession('goaway', gen);
    return true;
  }

  // ---- remote close: Gemini leg died WITHOUT a retirement signal ------------
  // Same recovery shape as GoAway (freeze input, close once, single-flight
  // reconnect) but the session is already dead server-side, so scheduled audio
  // drains via retireAudio/finalizeClose and the new generation starts clean.
  // Never a fatal UI string here — the renderer shows a transient status.
  remoteCloseFlow(gen, msg) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'remote-close', gen });
      return false;
    }
    if (this.state !== 'CONNECTED' && this.state !== 'CONNECTING') {
      this.ev('VOICE_STALE_IGNORED', { what: 'remote-close-wrong-state', gen });
      return false;
    }
    this.ev('VOICE_REMOTE_CLOSE', {
      sessionId: msg?.voiceSid || msg?.sessionId || '',
      code: msg?.code ?? null,
      reason: String(msg?.reason ?? ''),
      closeClass: msg?.closeClass || 'UNEXPECTED_CLOSE',
      lastServerEvent: msg?.lastServerEvent ?? null,
      lastSessionError: msg?.lastSessionError ?? null,
      localOrRemote: msg?.localOrRemote || 'remote',
    });
    try { this.actions?.setMicSend?.(false); } catch { /* noop */ }
    this.closeSession('remote-close', gen);
    return true;
  }
  closeSession(reason, gen) {
    if (this.closedGens.has(gen)) {
      this.ev('VOICE_CLOSE_DUPLICATE', { reason, gen });
      return { ok: false, why: 'already-closed' };
    }
    this.closedGens.add(gen);
    this.lastCloseReason = reason; // audit trail: who asked for this close
    this.ev('VOICE_LOCAL_CLOSE_REQUESTED', { reason, gen });
    this.ev('VOICE_CLOSE_REQUESTED', { reason, gen });
    if (this.state !== 'CLOSING') this.setState('CLOSING', reason);
    try { this.actions?.closeSocket?.(gen); } catch { /* close must never throw */ }
    // Bounded wait for the socket close event; force local cleanup on timeout.
    this.clearTimer();
    this.timerKind = 'close';
    this.timerGen = gen;
    const fireGen = gen;
    this.timerId = this.timers.setTimeout(() => {
      this.timerId = 0;
      if (this.isCurrent(fireGen) && this.state === 'CLOSING') {
        this.ev('VOICE_CLOSE_TIMEOUT', { reason });
        this.finalizeClose(fireGen, { timedOut: true });
      }
    }, this.closeTimeoutMs);
    return { ok: true };
  }

  onSocketClose(gen, info) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'close', gen });
      return false;
    }
    if (this.state !== 'CLOSING') {
      // Unexpected drop (network blip, no GoAway): error path, then rotate.
      this.ev('VOICE_UNEXPECTED_CLOSE', { code: info?.code ?? null });
      this.setState('ERROR', 'unexpected-close');
      this.closeSession('unexpected-close', gen);
      return true;
    }
    if (this.timerKind === 'close' && this.timerGen === gen) this.clearTimer();
    this.ev('VOICE_CLOSE_CONFIRMED', { code: info?.code ?? null });
    this.finalizeClose(gen, { timedOut: false });
    return true;
  }

  finalizeClose(gen, { timedOut } = {}) {
    if (!this.isCurrent(gen)) return false;
    try { this.actions?.retireAudio?.(gen); } catch { /* noop */ }
    this.isConnecting = false;
    if (this.stopAfterClose) {
      this.stopAfterClose = false;
      this.setState('STOPPED', 'user');
      return true;
    }
    this.setState('RECONNECT_WAIT', timedOut ? 'close-timeout' : 'closed');
    this.scheduleReconnect();
    return true;
  }

  onSocketError(gen, msg) {
    if (!this.isCurrent(gen)) {
      this.ev('VOICE_STALE_IGNORED', { what: 'error', gen });
      return false;
    }
    const text = String(msg || '');
    if (/goaway/i.test(text)) {
      // Some stacks surface GoAway as an error, not a close: retire properly.
      this.goAwayFlow(gen, { detail: text });
      return true;
    }
    this.ev('VOICE_SOCKET_ERROR', { detail: text.slice(0, 160) });
    this.ev('VOICE_ERROR', { detail: text.slice(0, 160) });
    if (this.state === 'CONNECTED' || this.state === 'CONNECTING') {
      this.setState('ERROR', 'socket-error');
      this.closeSession('socket-error', gen);
    }
    return true;
  }

  // ---- single-flight reconnect scheduler --------------------------------------
  scheduleReconnect() {
    this.clearTimer(); // NEVER two timers
    if (this.attempt >= this.maxAttempts) {
      this.ev('VOICE_RECONNECT_EXHAUSTED', { maxAttempts: this.maxAttempts });
      this.ev('VOICE_FINAL_FAILURE', { maxAttempts: this.maxAttempts });
      return false;
    }
    const delay = this.backoffDelay(this.attempt + 1);
    this.timerKind = 'reconnect';
    this.timerGen = this.generation;
    const fireGen = this.generation;
    this.ev('VOICE_RECONNECT_SCHEDULED', { delayMs: delay, nextAttempt: this.attempt + 1 });
    this.timerId = this.timers.setTimeout(() => {
      this.timerId = 0;
      this.fireReconnect(fireGen);
    }, delay);
    return true;
  }

  fireReconnect(fireGen) {
    if (!this.isCurrent(fireGen) || this.state !== 'RECONNECT_WAIT' || this.isConnecting) {
      this.ev('VOICE_STALE_IGNORED', { what: 'reconnect-fire', gen: fireGen });
      return false;
    }
    // Fresh generation per attempt: any lingering old socket becomes stale
    // by construction, so two sockets can never both be valid.
    this.generation += 1;
    this.attempt += 1;
    this.isConnecting = true;
    this.setState('RECONNECTING', `attempt-${this.attempt}`);
    this.setState('CONNECTING', `attempt-${this.attempt}`);
    this.ev('VOICE_CONNECTING', { reason: `reconnect-attempt-${this.attempt}` });
    this.ev('VOICE_RECONNECT_STARTED', {});
    try {
      this.actions?.openSocket?.(this.generation);
    } catch (e) {
      this.isConnecting = false;
      this.ev('VOICE_RECONNECT_FAILED', { error: String((e && e.message) || e).slice(0, 160) });
      this.setState('ERROR', 'reconnect-open-failed');
      this.closeSession('reconnect-open-failed', this.generation);
    }
    return true;
  }

  canSend() {
    return this.state === 'CONNECTED';
  }

  setVoiceActive(on) {
    this.voiceActive = Boolean(on);
  }

  snapshot() {
    return {
      state: this.state,
      generation: this.generation,
      attempt: this.attempt,
      isConnecting: this.isConnecting,
      timerPending: this.timerId !== 0,
      timerKind: this.timerKind,
    };
  }
}

// CommonJS interop for node --test.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VoiceConnection };
}
