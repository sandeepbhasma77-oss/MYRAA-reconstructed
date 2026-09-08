// MYRAA voice connection contract — framework-free shared shapes.
// Used by the renderer (App.tsx), the backend (server.ts, bundled via esbuild),
// and node --test. Single source of truth for session-retirement vocabulary.
export const CONN_STATES = [
  'IDLE',
  'CONNECTING',
  'CONNECTED',
  'GOAWAY_RECEIVED',
  'CLOSING',
  'RECONNECT_WAIT',
  'RECONNECTING',
  'ERROR',
  'STOPPED',
];

export const CONN_TRANSITIONS = {
  IDLE: ['CONNECTING', 'STOPPED'],
  CONNECTING: ['CONNECTED', 'ERROR', 'STOPPED', 'CLOSING'],
  CONNECTED: ['GOAWAY_RECEIVED', 'CLOSING', 'ERROR', 'STOPPED'],
  GOAWAY_RECEIVED: ['CLOSING', 'STOPPED'],
  CLOSING: ['RECONNECT_WAIT', 'STOPPED', 'IDLE'],
  RECONNECT_WAIT: ['RECONNECTING', 'STOPPED', 'IDLE'],
  RECONNECTING: ['CONNECTING', 'ERROR', 'STOPPED'],
  ERROR: ['RECONNECT_WAIT', 'STOPPED', 'IDLE', 'CONNECTING', 'CLOSING'],
  STOPPED: ['CONNECTING', 'IDLE'],
};

export function canConnTransition(from, to) {
  return (CONN_TRANSITIONS[from] || []).includes(to);
}

// GoAway detectors. Close CODES alone never qualify (a clean 1000/1005 close
// is not a retirement); the reason/error TEXT must carry the signal.
const GOAWAY_TEXT = [/goaway/i, /session[^a-z0-9]{0,12}(durat|expir|limit|retir|timeout)/i, /connection aborted/i];

export function isGoAwaySignal({ code, reason } = {}) {
  const text = String(reason || '');
  if (!text) return false;
  return GOAWAY_TEXT.some((re) => re.test(text));
}

export function isGoAwayErrorText(msg) {
  const text = String(msg || '');
  if (!text) return false;
  return GOAWAY_TEXT.some((re) => re.test(text));
}

// Structured retirement event (server -> renderer). The old fatal string
// ("Gemini Live closed (...)") must NEVER be sent for GoAway.
export function sessionRetiringEvent({ voiceSid, code, reason, generation, attempt }) {
  return {
    type: 'session_retiring',
    reason: 'goaway',
    voiceSid: voiceSid || null,
    code: typeof code === 'number' ? code : null,
    detail: String(reason || 'GoAway').slice(0, 200),
    generation: typeof generation === 'number' ? generation : null,
    attempt: typeof attempt === 'number' ? attempt : 0,
    at: new Date().toISOString(),
  };
}

// Close classification shared by backend + renderer + tests. Distinct from
// GoAway retirement: the Gemini leg died WITHOUT a retirement signal.
// NOTE: an abnormal WebSocket close (code 1006) NEVER carries a reason string
// (RFC 6455 forbids it) — an empty reason is EVIDENCE of an abnormal drop, not
// a missing log. Callers must preserve code + context, never substitute 'closed'.
export const CLOSE_CLASSES = [
  'USER_STOPPED', // renderer Disconnect/STOP button (explicit user intent)
  'USER_DISCONNECTED', // renderer socket went away (stop, reload, shutdown)
  'GOAWAY_ROTATION', // session_retiring path, not this event
  'NETWORK_DISCONNECT', // abnormal closure, empty reason (typically code 1006)
  'AUTH_OR_API_ERROR', // 1008 / credential / key rejection
  'SERVER_ERROR', // server-side failure codes (1011, 1013, 1014)
  'UNEXPECTED_CLOSE', // anything else remote-initiated
  'APPLICATION_SHUTDOWN', // backend/client process going away
];

export function classifyGeminiClose({ code, reasonText, localInitiated, clientGone } = {}) {
  const text = String(reasonText || '');
  if (localInitiated && clientGone) return 'USER_DISCONNECTED';
  if (localInitiated) return 'APPLICATION_SHUTDOWN';
  if (code === 1008 || /authentication|credential|api.?key|unauthenticated|forbidden|401|403/i.test(text)) {
    return 'AUTH_OR_API_ERROR';
  }
  if (code === 1011 || code === 1014 || code === 1013) return 'SERVER_ERROR';
  if (code === 1006 || code === 1005 || text === '') return 'NETWORK_DISCONNECT';
  return 'UNEXPECTED_CLOSE';
}

// Structured remote-close event (server -> renderer) for a dead Gemini leg.
// Carries the RAW code/reason (reason is often '' for 1006 — preserved as-is),
// the classification, and the last known server-side context. NEVER a fatal
// transcript string and NEVER 'Check Settings': the renderer decides recovery.
export function sessionClosedEvent({ voiceSid, code, reason, closeClass, lastServerEvent, lastSessionError, localOrRemote, generation, attempt }) {
  return {
    type: 'session_closed',
    voiceSid: voiceSid || null,
    code: typeof code === 'number' ? code : null,
    reason: typeof reason === 'string' ? reason.slice(0, 200) : '',
    closeClass: closeClass || 'UNEXPECTED_CLOSE',
    lastServerEvent: lastServerEvent || null,
    lastSessionError: lastSessionError ? String(lastSessionError).slice(0, 200) : null,
    localOrRemote: localOrRemote || 'remote',
    generation: typeof generation === 'number' ? generation : null,
    attempt: typeof attempt === 'number' ? attempt : 0,
    at: new Date().toISOString(),
  };
}

let turnCounter = 0;
export function newTurnId() {
  turnCounter += 1;
  return `TURN-${Date.now().toString(36).toUpperCase()}-${String(turnCounter).padStart(4, '0')}`;
}

// Idempotency helper: true when key is NEW (recorded), false on duplicates.
export function noteSeen(set, key) {
  if (!key) return true;
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

// CommonJS interop for node --test (Vite/esbuild ESM import works too).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONN_STATES, CONN_TRANSITIONS, canConnTransition,
    isGoAwaySignal, isGoAwayErrorText, sessionRetiringEvent, sessionClosedEvent,
    CLOSE_CLASSES, classifyGeminiClose,
    newTurnId, noteSeen,
  };
}
