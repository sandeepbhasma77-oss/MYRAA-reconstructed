// MYRAA premium UI shell — presentation redesign only.
// All voice/engine/browser/memory logic is unchanged from the prior revision:
// same VoiceSession queue, same PCM path, same task API, same endpoints.
import { useEffect, useRef, useState } from 'react';
import {
  Home, MessageSquare, Globe, Zap, Brain, Cpu, FolderOpen, Settings as SettingsIcon,
  Mic, MicOff, Send, ChevronLeft, Bell, User, Square, Trash2, Search, Plus,
  RotateCw, ArrowLeft, ArrowRight, ExternalLink, Volume2, Camera, ClipboardList,
  FileSearch,   Play, X, Activity, CheckCircle2, XCircle, Loader2, FolderPlus, FilePlus2, Sparkles,
} from 'lucide-react';
import { api, liveSocket, type Memory } from './api';
import { VoiceSession, floatToPcm16Base64, base64ToBytes, parsePcmRate, parseAudioFormat, applyCrossfadeIn, needsBoundarySmoothing, countDiscontinuities, analyzePcm16, resampleSinc, classifyArrivalRegime, freshStartDelaySec, nextStartTime, estimatePcmSec, smoothGate, deliveryRate, reserveUpdate, windowedRate, validatePcmChunk } from './voicePipe.js';
import { VoiceConnection } from './voiceConnect.js';
import { newTurnId } from './voiceProto.js';

type Phase = 'idle' | 'thinking' | 'talking';
type View = 'home' | 'chat' | 'browser' | 'tasks' | 'memory' | 'pc' | 'files' | 'settings';
interface Line { role: string; text: string; ts: number }

// Gemini Live output: raw LE PCM16 mono @ 24kHz (ai.google.dev/gemini-api/docs/live-guide).
// Played bit-perfect: no gain, no compressor, no re-encode. Device-level resampling
// (24k -> 48k output) is done by the browser mixer, not by us.
const MODEL_OUT_RATE = 24000;
// Scheduled-playback tuning.
// Jitter buffer presets under human test (sec): 120 / 150 / 180 / 220 ms.
// DEFAULT (180ms) is the recommended target: the smallest value expected to
// eliminate audible gaps. Override per-browser for A/B listening via
// localStorage 'myraa_jitter_ms' (clamped to 80–400ms, no code change).
// The adaptive controller then moves the live target slowly around the base.
const JITTER_PRESETS_SEC = [0.12, 0.15, 0.18, 0.22];
const DEFAULT_JITTER_BUFFER_SEC = 0.18;
const JITTER_BUFFER_SEC = DEFAULT_JITTER_BUFFER_SEC;
const MIN_JITTER_BUFFER_SEC = 0.08;
const MAX_JITTER_BUFFER_SEC = 0.30;
const UNDERFLOW_RESET_SEC = 0.05;
// Boundary click threshold: normalized PCM step (~-34dB) above which two
// consecutive chunks are likely to click. At/below it, PCM stays bit-perfect.
const BOUNDARY_DISC_THRESHOLD = 0.02;
// Barge-in gate: Gemini's 'interrupted' signal also fires on acoustic feedback
// (speaker output leaking into the mic despite echo cancellation). Honor it
// only when the mic actually hears the user (smoothed RMS above this floor);
// otherwise honoring it destroys the queue mid-word with nothing spoken.
// If the mic is off entirely the level is 0, so spurious signals can never
// cut speech. Missed ultra-soft interruptions are retried louder by the user.
const BARGE_MIC_RMS_THRESHOLD = 0.02;
// Consecutive chunk-playback failures before the voice state goes ERROR.
const PLAY_FAIL_STREAK_LIMIT = 3;
function readJitterOverrideSec(): number | null {
  try {
    const raw = localStorage.getItem('myraa_jitter_ms');
    if (raw === null) return null;
    const ms = Number(raw);
    if (!isFinite(ms)) return null;
    return Math.min(0.40, Math.max(0.08, ms / 1000));
  } catch { return null; }
}
// CRITICAL DIAGNOSIS MODE (Step 3): minimal pipeline. When localStorage
// 'myraa_plain_pipeline' === '1': fixed base jitter (no adaptive changes),
// NO boundary smoothing (pure passthrough), NO reference tone, and barge-in
// 'interrupted' events are ignored — only explicit STOP terminates speech.
// Isolates: ordered PCM → Int16 → AudioBuffer → scheduled playback.
// A/B RESAMPLE EXPERIMENT (Step 7): localStorage 'myraa_ab_mode' === 'B'
// manually resamples 24kHz PCM to 48kHz before createBuffer (buffer @48kHz);
// default 'A' keeps the native 24kHz buffer (browser resamples). Same raw PCM
// both modes. Diagnostic only — do not keep both permanently.
function isPlainPipeline(): boolean {
  try { return localStorage.getItem('myraa_plain_pipeline') === '1'; } catch { return false; }
}
function getABMode(): 'A' | 'B' {
  try { return localStorage.getItem('myraa_ab_mode') === 'B' ? 'B' : 'A'; } catch { return 'A'; }
}
// SMOOTH VOICE MODE (default): buffer each turn briefly and start playback once
// enough audio is queued (or at turn completion), so speech plays as one
// continuous sentence. LATENCY FIX: target lowered 0.5s -> 0.16s and the
// min-fast rate 1.25x -> 1.1x so fast deliveries start speaking almost
// immediately instead of waiting for a full turn. Cut protection stays via
// SMOOTH_RESERVE_SEC (mid-turn pause) + gap-wait + boundary crossfades.
// Optional low-latency streaming for later experiments: localStorage
// 'myraa_live_stream' === '1' restores immediate per-chunk playback. Override
// (testing only): localStorage 'myraa_smooth_ms' (clamped 120–2,000 ms).
const SMOOTH_TARGET_SEC = 0.16;
const SMOOTH_MAX_BUFFER_SEC = 30;
const SMOOTH_RESERVE_SEC = 0.3;
const SMOOTH_MIN_FAST_RATE = 1.1;
function isStreamMode(): boolean {
  try { return localStorage.getItem('myraa_live_stream') === '1'; } catch { return false; }
}
function readSmoothTargetSec(): number {
  try {
    const raw = localStorage.getItem('myraa_smooth_ms');
    if (raw === null) return SMOOTH_TARGET_SEC;
    const ms = Number(raw);
    if (!isFinite(ms)) return SMOOTH_TARGET_SEC;
    return Math.min(2.0, Math.max(0.12, ms / 1000));
  } catch { return SMOOTH_TARGET_SEC; }
}
// LATENCY FIX: pump() runs per audio chunk (~10+/sec) and previously hit
// localStorage 5x per chunk (stream/smooth/plain/ab/dump flags) — sync I/O on
// the audio path. Cache all diagnostic overrides with a short TTL so hot-path
// reads are plain memory access; localStorage changes still apply within ~2s.
interface PipeFlags { stream: boolean; smoothSec: number; plain: boolean; ab: 'A' | 'B'; dump: boolean }
let pipeFlagsCache: { at: number; flags: PipeFlags } | null = null;
const PIPE_FLAGS_TTL_MS = 2000;
function readPipeFlags(now = Date.now()): PipeFlags {
  const hit = pipeFlagsCache;
  if (hit && now - hit.at < PIPE_FLAGS_TTL_MS) return hit.flags;
  const flags: PipeFlags = {
    stream: isStreamMode(),
    smoothSec: readSmoothTargetSec(),
    plain: isPlainPipeline(),
    ab: getABMode(),
    dump: (() => { try { return localStorage.getItem('myraa_dump') === '1'; } catch { return false; } })(),
  };
  pipeFlagsCache = { at: now, flags };
  return flags;
}

const MENU: { section: string; items: { id: View; label: string; Icon: typeof Home }[] }[] = [
  { section: 'MYRAA', items: [
    { id: 'chat', label: 'Chat', Icon: MessageSquare },
    { id: 'memory', label: 'Memory', Icon: Brain },
    { id: 'tasks', label: 'Tasks', Icon: Zap },
  ] },
  { section: 'EXPLORE', items: [
    { id: 'browser', label: 'Browser', Icon: Globe },
    { id: 'files', label: 'Files', Icon: FolderOpen },
    { id: 'pc', label: 'System', Icon: Cpu },
  ] },
  { section: 'SYSTEM', items: [
    { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  ] },
];

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [agentOnline, setAgentOnline] = useState(false);
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [booted, setBooted] = useState(false); // startup splash (visual only, non-blocking)
  useEffect(() => {
    const t = window.setTimeout(() => setBooted(true), 1600);
    return () => window.clearTimeout(t);
  }, []);
  // Live amplitude taps (refs only — never re-render React per audio frame).
  // `out`: RMS of model PCM computed in the playback worker; `mic`: RMS of mic input.
  const ampRef = useRef({ out: 0, mic: 0 });
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState('');
  const [devMode, setDevMode] = useState(() => { try { return localStorage.getItem('myraa_dev') === '1'; } catch { return false; } });
  const ws = useRef<WebSocket | null>(null);
  const wsGen = useRef(0); // connection generation that owns ws.current
  const micStream = useRef<MediaStream | null>(null);
  const micStarting = useRef(false); // guards the async connect→mic sequence
  const micCtx = useRef<AudioContext | null>(null);
  const micProc = useRef<ScriptProcessorNode | null>(null);
  const micSend = useRef(false); // true only while the user intends voice AND link is CONNECTED
  const playCtx = useRef<AudioContext | null>(null);
  const playTime = useRef(0); // nextPlayTime: continuously scheduled device time
  const session = useRef<VoiceSession | null>(null);
  const retiredAudio = useRef<VoiceSession | null>(null); // draining old generation, never mixed
  const sources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const playGen = useRef(0); // invalidates stale onended callbacks after interrupt/close
  const playSid = useRef(''); // playback_session_id: one per voice socket, logged with every audio event
  const dumpChunks = useRef<string[]>([]); // TEST B: exact PCM16 bytes handed to device
  const turnSamples = useRef(0); // scheduled-sample counter for duration proof
  const turnRate = useRef(MODEL_OUT_RATE);
  // AUDIO_DIAGNOSTICS: per-session counters (no audio bytes logged).
  // Human-quality fields: jitter target/adaptation, arrival jitter, min queue,
  // interruptions, engine lifecycle counts, boundary smoothing counts.
  const audioDiag = useRef({
    incomingChunks: 0,
    playedChunks: 0,
    duplicateChunks: 0,
    outOfOrderChunks: 0,
    missingSequences: 0,
    skippedSequences: 0,
    queueUnderflows: 0,
    totalChunkSec: 0,
    lastArrivalAt: 0,
    totalArrivalGapMs: 0,
    arrivalGaps: 0,
    maxArrivalGapMs: 0,
    avgArrivalMs: 0, // EWMA of arrival interval (alpha 0.15, slow — never oscillates per chunk)
    arrivalJitterMs: 0, // EWMA of |gap - avg| (RFC3550-style, alpha 0.15)
    maxQueueSec: 0,
    minQueueSec: Number.POSITIVE_INFINITY,
    sumQueueSec: 0,
    queueSamples: 0,
    decodeMsMax: 0,
    convertMsMax: 0,
    incomingSampleRate: 0,
    audioContextSampleRate: 0,
    mimeType: '',
    channels: 1,
    turnCount: 0,
    jitterTargetSec: DEFAULT_JITTER_BUFFER_SEC,
    jitterBaseSec: DEFAULT_JITTER_BUFFER_SEC,
    jitterAdaptEvents: 0,
    stableTurns: 0,
    engineCalls: 0,
    engineCreations: 0,
    engineCloses: 0,
    audioCtxCloses: 0,
    interruptions: 0,
    falseBargeIgnored: 0, // 'interrupted' signals ignored: mic silent (echo, not user)
    playFailStreak: 0, // consecutive chunk-playback failures (ERROR at limit)
    boundaryChecked: 0,
    boundaryAbrupt: 0,
    boundarySmoothed: 0,
    boundaryMaxDisc: 0,
    turnMaxGapMs: 0,
    turnMinQueueSec: Number.POSITIVE_INFINITY,
    turnMaxQueueSec: 0,
    gapLt150: 0, // in-turn arrival-gap histogram: <150ms
    gap150to300: 0, // 150-300ms
    gap300to600: 0, // 300-600ms
    gapGt600: 0, // >600ms (stalls/turn pauses)
    srcCreated: 0,
    srcStarted: 0,
    srcEnded: 0,
    srcStoppedEarly: 0,
    srcOverlaps: 0,
    schedChain: 0, // schedules continuing exactly at the previous end (no gap)
    schedFresh: 0, // schedules starting a fresh horizon (first chunk / restart)
    lastBufRate: 0,
    outputLatencyMs: 0,
    baseLatencyMs: 0,
  });
  const resetAudioDiag = () => {
    const d = audioDiag.current;
    d.incomingChunks = 0; d.playedChunks = 0; d.duplicateChunks = 0;
    d.outOfOrderChunks = 0; d.missingSequences = 0; d.skippedSequences = 0;
    d.queueUnderflows = 0; d.totalChunkSec = 0; d.lastArrivalAt = 0;
    d.totalArrivalGapMs = 0; d.arrivalGaps = 0; d.maxArrivalGapMs = 0;
    d.avgArrivalMs = 0; d.arrivalJitterMs = 0;
    d.maxQueueSec = 0; d.minQueueSec = Number.POSITIVE_INFINITY;
    d.sumQueueSec = 0; d.queueSamples = 0;
    d.decodeMsMax = 0; d.convertMsMax = 0;
    d.incomingSampleRate = 0; d.audioContextSampleRate = 0;
    d.mimeType = ''; d.turnCount = 0;
    d.jitterTargetSec = d.jitterBaseSec; d.jitterAdaptEvents = 0; d.stableTurns = 0;
    d.engineCalls = 0; d.engineCreations = 0; d.engineCloses = 0; d.audioCtxCloses = 0;
    d.interruptions = 0;
    d.falseBargeIgnored = 0;
    d.playFailStreak = 0;
    d.boundaryChecked = 0; d.boundaryAbrupt = 0; d.boundarySmoothed = 0; d.boundaryMaxDisc = 0;
    d.turnMaxGapMs = 0;
    d.turnMinQueueSec = Number.POSITIVE_INFINITY; d.turnMaxQueueSec = 0;
    d.gapLt150 = 0; d.gap150to300 = 0; d.gap300to600 = 0; d.gapGt600 = 0;
    d.srcCreated = 0; d.srcStarted = 0; d.srcEnded = 0; d.srcStoppedEarly = 0; d.srcOverlaps = 0;
    d.schedChain = 0; d.schedFresh = 0;
    d.lastBufRate = 0;
    d.outputLatencyMs = 0; d.baseLatencyMs = 0;
  };
  // Live adaptive target + scheduled-tail continuity, kept out of React state.
  const jitterTarget = useRef(DEFAULT_JITTER_BUFFER_SEC);
  const prevTailSample = useRef<number | null>(null); // last scheduled float sample, for boundary analysis
  // Per-turn snapshot: differences printed at turnComplete = that turn's human-quality record.
  const turnMark = useRef<null | {
    playedChunks: number; queueUnderflows: number; interruptions: number;
    engineCreations: number; boundarySmoothed: number; boundaryChecked: number;
    arrivalGaps: number; totalArrivalGapMs: number;
  }>(null);
  // Step 1+2 capture: raw received bytes by seq (pre-queue) + post-pipeline
  // Int16 values in scheduled order (pre-playback). Built per turn, POSTed at
  // turnComplete to /api/voice-ab-capture, then cleared (bounded memory).
  const rawCapture = useRef(new Map<number, string>());
  const postCapture = useRef<Int16Array[]>([]);
  const rawCaptureRate = useRef(MODEL_OUT_RATE);
  const clearAbCapture = () => { rawCapture.current.clear(); postCapture.current = []; };
  // Smooth Voice Mode per-turn buffering state. bufferedSec accumulates estimated
  // audio seconds received-but-unscheduled; audioSec/chunks/firstAtMs/lastAtMs
  // measure delivery rate (audioSec/elapsed); histT/histA keep the last chunks'
  // (arrivalMs, audioSec) for the stall-proof windowed rate; scheduledSec totals
  // what reached the speakers; started/turnDone/paused drive the gate;
  // waitedForComplete, bufBeforePlaySec and earlyStream are recorded at start
  // for diagnostics. Reset at each turn start / interruption.
  const smoothTurn = useRef({ active: false, bufferedSec: 0, started: false, turnDone: false, waitedForComplete: false, bufBeforePlaySec: 0, chunks: 0, audioSec: 0, firstAtMs: 0, lastAtMs: 0, scheduledSec: 0, paused: false, earlyStream: false, histT: [] as number[], histA: [] as number[] });
  const resetSmoothTurn = () => {
    smoothTurn.current = { active: false, bufferedSec: 0, started: false, turnDone: false, waitedForComplete: false, bufBeforePlaySec: 0, chunks: 0, audioSec: 0, firstAtMs: 0, lastAtMs: 0, scheduledSec: 0, paused: false, earlyStream: false, histT: [], histA: [] };
  };
  // Freshness-proof delivery rate: windowed over recent chunks first (a single
  // long stall must not poison the whole turn), cumulative as early fallback.
  const turnFreshRate = (): number | null => {
    const st = smoothTurn.current;
    return windowedRate(st.histT, st.histA) ?? deliveryRate(st.audioSec, (st.lastAtMs || 0) - (st.firstAtMs || 0), st.chunks || 0);
  };
  // Step 4 audit: source-node identity + scheduled horizon for overlap checks.
  const srcSeq = useRef(0);
  const srcIds = useRef(new Map<AudioBufferSourceNode, number>());
  const lastSchedEnd = useRef(0);
  const [dumpOn, setDumpOn] = useState(() => { try { return localStorage.getItem('myraa_dump') === '1'; } catch { return false; } });
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null); // transient link status (refreshing/ready)
  // TASK EVENT PIPELINE (spec §3/§7/§14): live task_status events from the server
  // update the UI status text INSTANTLY — never waiting for task completion.
  const [taskStatus, setTaskStatus] = useState<{ message: string; at: number } | null>(null);
  const taskStatusTimer = useRef<number | null>(null);
  const showTaskStatus = (message: string) => {
    setTaskStatus({ message, at: Date.now() });
    if (taskStatusTimer.current) window.clearTimeout(taskStatusTimer.current);
    taskStatusTimer.current = window.setTimeout(() => setTaskStatus(null), 6000);
  };
  const vlog = (m: string) => console.debug(`[VOICE] ${m}`);

  // Persistent voice diagnostics: console (devtools/chrome log) AND the
  // backend voice.log via fire-and-forget (survives renderer restarts).
  // Throttled suspended-context hint: tells the human why transcripts flow
  // with no sound (browser autoplay block), at most once every 10 s.
  const lastSuspendHintAt = useRef(0);
  const dSuspendedHint = (ctx: AudioContext) => {
    const nowMs = Date.now();
    if (nowMs - lastSuspendHintAt.current < 10000) return;
    lastSuspendHintAt.current = nowMs;
    vdiag('AUDIO_SUSPENDED', `playback AudioContext suspended (sampleRate=${ctx.sampleRate}): click/keypress the page to enable audio`);
    setVoiceStatus('Click anywhere to enable audio');
  };
  const vdiag = (tag: string, detail: string) => {
    try { console.debug(`[VOICE] [${tag}] ${detail}`); } catch { /* noop */ }
    try {
      fetch('/api/voice-event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, detail: String(detail).slice(0, 500) }),
      }).catch(() => {});
    } catch { /* diagnostics never break voice */ }
  };

  // Single authoritative connection controller (state machine + generations +
  // single-flight reconnect). Wired to real sockets/audio below.
  const connRef = useRef<VoiceConnection | null>(null);
  if (!connRef.current) {
    const c = new VoiceConnection({
      emit: (type, d) => {
        const g = d && typeof d.generation === 'number' ? d.generation : '-';
        vdiag(type, `gen=${g} state=${(d && d.state) || ''} attempt=${(d && d.attempt) ?? ''} ${(d && (d.why || d.detail || d.reason)) || ''}`.trim());
        if (type === 'VOICE_GOAWAY_RECEIVED') setVoiceStatus('Refreshing voice connection…');
        else if (type === 'VOICE_REMOTE_CLOSE') setVoiceStatus('Refreshing voice connection…');
        else if (type === 'VOICE_RECONNECTED' || type === 'VOICE_CONNECTED') {
          setVoiceStatus('Voice ready');
          window.setTimeout(() => setVoiceStatus((s) => (s === 'Voice ready' ? null : s)), 4000);
          // Resume mic SENDING only if the user still intends voice (never hot-mic).
          if (micStream.current && c.voiceActive) micSend.current = true;
        } else if (type === 'VOICE_RECONNECT_EXHAUSTED' || type === 'VOICE_FINAL_FAILURE') {
          setVoiceStatus(null);
          push('error', 'Voice connection lost. Tap Connect to retry.');
        }
      },
    });
    c.actions = {
      closeSocket: (gen: number) => {
        const s = ws.current;
        if (s && wsGen.current === gen) {
          try {
            if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
          } catch { /* close must never throw */ }
        }
      },
      openSocket: (gen: number) => { openVoiceSocket(gen); },
      setMicSend: (on: boolean) => { micSend.current = on; },
      retireAudio: (gen: number) => {
        const s = session.current;
        if (s && s.generation === gen) {
          s.retire();
          retiredAudio.current = s;
          session.current = null;
        }
      },
    };
    connRef.current = c;
  }

  const syncPhase = () => {
    const s = session.current?.state;
    setPhase(s === 'SPEAKING' ? 'talking' : s === 'LISTENING' || s === 'THINKING' || s === 'INTERRUPTED' ? 'thinking' : 'idle');
  };

  const autoDone = useRef(false); // launch greeting runs at most once
  // DEFAULT IS IDLE: no auto-connect, no mic, no greeting, no live session
  // unless the user explicitly opts into hands-free mode (Settings → Voice).
  const [autoCfg, setAutoCfg] = useState({ connect: false, mic: false, greet: false, handsFree: false });

  useEffect(() => {
    api.status().then((s) => setHasKey(s.hasApiKey)).catch(() => setHasKey(false));
    api.memories().then(setMemories).catch(() => {});
    api.agentHealth().then((h) => setAgentOnline(h.online)).catch(() => {});
    // Launch behavior (Settings → Voice): everything defaults to OFF/IDLE.
    // Auto voice starts ONLY when the user opts into hands-free mode.
    api.settings().then((s) => {
      const cfg = {
        connect: s.autoConnect === true,
        mic: s.autoMic === true,
        greet: s.autoGreet === true,
        handsFree: s.handsFree === true,
      };
      setAutoCfg(cfg);
      if (cfg.handsFree && cfg.connect && !autoDone.current) {
        autoDone.current = true;
        window.setTimeout(() => autoLaunch(cfg), 1200);
      }
    }).catch(() => {});
    // Browser autoplay policy: audio contexts start suspended without user
    // activation. This listener is PERSISTENT (not once): the playback context
    // is created lazily on first audio, usually AFTER the first click, so a
    // one-shot unlock would miss it and leave voice permanently silent while
    // transcripts keep flowing. Every gesture retries the resume.
    const unlock = () => {
      try {
        if (micCtx.current && micCtx.current.state === 'suspended') void micCtx.current.resume().catch(() => {});
        if (playCtx.current && playCtx.current.state === 'suspended') void playCtx.current.resume().catch(() => {});
      } catch { /* noop */ }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    const t = window.setInterval(() => {
      api.agentHealth().then((h) => setAgentOnline(h.online)).catch(() => {});
    }, 15000);
    return () => { window.clearInterval(t); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); disconnect(); closePlaybackEngine('unmount'); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Task progress reaches the composer even when no voice /live socket is open:
  // one SSE subscription (server /api/task-events) mirrors the voice-socket push.
  // Statuses arrive within ms of a task transition; a simultaneous push from the
  // /live socket just re-renders the same message once (idempotent).
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/task-events');
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(String(ev.data)) as { status?: string; message?: string };
          if (e && typeof e.message === 'string' && e.message && e.status !== 'QUEUED') showTaskStatus(e.message);
        } catch { /* malformed SSE frame — ignore */ }
      };
      es.onerror = () => { /* EventSource auto-reconnects; server holds the event ring */ };
    } catch { /* SSE unsupported — voice-socket push still covers connected sessions */ }
    return () => { try { es?.close(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto launch sequence: connect → socket open → mic → spoken greeting.
  const autoLaunch = (cfg: { connect: boolean; mic: boolean; greet: boolean }) => {
    connect();
    if (!cfg.mic && !cfg.greet) return;
    let tries = 0;
    const wait = window.setInterval(() => {
      tries++;
      if (ws.current?.readyState === WebSocket.OPEN || tries > 40) {
        window.clearInterval(wait);
        if (ws.current?.readyState !== WebSocket.OPEN) return;
        if (cfg.mic) void startMic();
        if (cfg.greet) {
          window.setTimeout(() => {
            if (ws.current?.readyState === WebSocket.OPEN) {
              sendText('Hello MYRAA! Please greet me warmly in one short sentence.');
            }
          }, 2500);
        }
      }
    }, 500);
  };

  const push = (role: string, text: string) =>
    setTranscript((t) => [...t.slice(-100), { role, text, ts: Date.now() }]);

  // ---- single playback engine: exactly one AudioContext + one queue + one pump ----
  // Created once, reused across turns. Never per-chunk. Closed only on unmount.
  // Every lifecycle call carries a reason and is counted: during one normal voice
  // response creations must stay at (session total) 1 — never restart mid-turn
  // because of renders, UI updates, or transient network/Gemini events.
  const ensurePlaybackEngine = (reason: string): AudioContext => {
    const d = audioDiag.current;
    d.engineCalls += 1;
    if (!playCtx.current) {
      // Default device rate: the browser mixer resamples each 24kHz buffer to the
      // device automatically. Requesting 24kHz here would force a whole-context
      // resample and is NOT needed — buffers carry the true source rate.
      playCtx.current = new AudioContext();
      playTime.current = 0;
      d.engineCreations += 1;
      // Step 6: device facts at creation — sample rate + output/base latency.
      // outputLatency includes the OS mixer path; baseLatency is the context's own.
      try {
        const anyCtx = playCtx.current as AudioContext & { outputLatency?: number; baseLatency?: number };
        d.audioContextSampleRate = playCtx.current.sampleRate;
        d.outputLatencyMs = Math.round((anyCtx.outputLatency ?? 0) * 10000) / 10;
        d.baseLatencyMs = Math.round((anyCtx.baseLatency ?? 0) * 10000) / 10;
      } catch { /* best-effort probes only */ }
      vlog(`playback AudioContext created sampleRate=${playCtx.current.sampleRate} channels=1 format=PCM16LE reason=${reason} outputLatency=${d.outputLatencyMs}ms baseLatency=${d.baseLatencyMs}ms`);
      vdiag('AUDIO_ENGINE', `ctxRate=${playCtx.current.sampleRate} created reason=${reason} creations=${d.engineCreations} calls=${d.engineCalls} outLat=${d.outputLatencyMs}ms baseLat=${d.baseLatencyMs}ms`);
    }
    return playCtx.current;
  };

  const closePlaybackEngine = (reason: string) => {
    // ONLY legal from component unmount. Never mid-turn, never on reconnect.
    const d = audioDiag.current;
    d.engineCloses += 1;
    vdiag('AUDIO_ENGINE', `closePlaybackEngine reason=${reason} closes=${d.engineCloses}`);
    playGen.current += 1;
    for (const src of sources.current) {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* noop */ }
    }
    sources.current.clear();
    if (playCtx.current) {
      try { void playCtx.current.close(); d.audioCtxCloses += 1; } catch { /* noop */ }
      playCtx.current = null;
    }
    playTime.current = 0;
    prevTailSample.current = null;
    lastSchedEnd.current = 0;
  };

  const stopSources = (reason: string) => {
    // Explicit-stop path only (STOP / user interruption / session termination).
    // Transient errors must NEVER call this — see the 'error' branch below.
    // Resets scheduling so the next turn restarts with a fresh jitter buffer.
    // Step 4: every still-active source stopped here died before its natural
    // onended — counted as stopped-early with node ids (must be 0 mid-turn).
    const d = audioDiag.current;
    const earlyIds = [...sources.current].map((s) => srcIds.current.get(s) ?? -1);
    if (sources.current.size > 0) d.srcStoppedEarly += sources.current.size;
    vdiag('AUDIO_STOP', `stopSources reason=${reason} activeSources=${sources.current.size} earlyIds=[${earlyIds.join(',')}]`);
    playGen.current += 1;
    for (const src of sources.current) {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* noop */ }
    }
    sources.current.clear();
    // A retired generation draining in the background must die here too:
    // otherwise its record stays PLAYING forever and the pump keeps selecting
    // the dead session, starving the live one.
    try { retiredAudio.current?.interrupt(); } catch { /* noop */ }
    retiredAudio.current = null;
    for (const src of sources.current) {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* noop */ }
    }
    sources.current.clear();
    if (playCtx.current) playTime.current = playCtx.current.currentTime;
    prevTailSample.current = null; // next chunk starts from silence: fade-in applies
    lastSchedEnd.current = 0; // overlap horizon restarts with the fresh schedule
    resetSmoothTurn(); // aborted turn: next audio starts a fresh turn buffer
    clearAbCapture(); // aborted turn: discard partial capture so next turn stays clean
  };

  // Single playback worker: schedules the head of the ordered queue, chains via onended.
  // Bit-perfect: PCM16 -> float32 (/32768) -> mono buffer at the chunk's native rate.
  // SMOOTH VOICE MODE (default): a turn's chunks collect in sequence and playback
  // starts only with SMOOTH_TARGET_SEC buffered (or at turn completion), so the
  // response plays as one continuous sentence. Scheduling: nextPlayTime chains
  // exactly; underflow recovers to currentTime + 0.05 and is counted. Ordered
  // release via the pending-map path (seq->chunk): duplicates never replay, gaps
  // wait briefly then skip with a log — never stall, never repeat, never overlap.
  // GoAway drain policy: a retired (old-generation) session drains first WITHOUT
  // mixing — new-generation chunks queue separately and start only when the old
  // session has nothing left scheduled or playing.
  const pump = () => {
    const pipeFlags = readPipeFlags();
    const retired = retiredAudio.current;
    const sess = (retired && (retired.playing || retired.queue.length > 0))
      ? retired
      : session.current;
    if (!sess || sess.cleaned) {
      if (retired && !retired.playing && retired.queue.length === 0) retiredAudio.current = null;
      return;
    }
    // Smooth gate: hold playback until delivery proves fast with enough buffer,
    // or the turn completes. A bare 1s buffer NEVER starts a slow turn — that
    // only postpones the underflow. Retired-generation drain is never gated:
    // old audio must finish, not wait.
    if (!retired && !pipeFlags.stream) {
      const st = smoothTurn.current;
      const rate = turnFreshRate();
      const gateState = { started: st.started, turnDone: st.turnDone, bufferedSec: st.bufferedSec, rate };
      if (!smoothGate(gateState, pipeFlags.smoothSec, SMOOTH_MAX_BUFFER_SEC, SMOOTH_MIN_FAST_RATE)) return;
      if (!st.started) {
        st.started = true;
        st.waitedForComplete = st.turnDone;
        st.bufBeforePlaySec = Math.round(st.bufferedSec * 1000) / 1000;
        st.earlyStream = !st.turnDone;
        vdiag('SMOOTH_START', `buffered=${st.bufBeforePlaySec}s waitedComplete=${st.waitedForComplete} rate=${rate === null ? 'unknown' : rate.toFixed(2)} earlyStream=${st.earlyStream} sess=${sess.id} play=${playSid.current}`);
      } else {
        // Reserve rule: mid-turn, buffer below 700ms -> stop scheduling, wait
        // for turnComplete (or buffer recovery); resume from the exact next
        // unplayed chunk. Queue untouched: never replay, never drop.
        const ru = reserveUpdate({ started: true, turnDone: st.turnDone, bufferedSec: st.bufferedSec, paused: st.paused }, SMOOTH_RESERVE_SEC, pipeFlags.smoothSec);
        if (ru.hold) {
          if (!st.paused) vdiag('SMOOTH_PAUSE', `buffered=${st.bufferedSec.toFixed(2)}s < reserve — holding for turnComplete sess=${sess.id}`);
          st.paused = true;
          return;
        }
        if (st.paused) {
          st.paused = false;
          vdiag('SMOOTH_RESUME', `buffered=${st.bufferedSec.toFixed(2)}s resuming at exact next chunk sess=${sess.id}`);
        }
      }
    }
    // Output readiness gate (audibility fix): never schedule into a suspended
    // (frozen-clock) AudioContext and never consume queue records for it.
    // Without this, transcripts flow while nothing can sound, and the worker
    // stalls with a record stuck PLAYING. Retries on a short timer; every real
    // user gesture also resumes via the persistent unlock listener above.
    const outCtx = ensurePlaybackEngine('pump-gate');
    if (outCtx.state === 'suspended') {
      try { void outCtx.resume().catch(() => {}); } catch { /* noop */ }
      dSuspendedHint(outCtx);
      window.setTimeout(() => { if (!sess.cleaned) pump(); }, 500);
      return;
    }
    const rec = sess.nextInOrder(Date.now());
    if (!rec) {
      // Either empty, or waiting for a missing seq to arrive within the gap window.
      // Retry shortly so a late chunk still plays in order without stalling forever.
      const waiting = sess.peek() && sess.nextPlaySeq !== undefined && sess.peek()!.seq !== sess.nextPlaySeq;
      if (waiting) window.setTimeout(() => { if (!sess.cleaned) pump(); }, 60);
      if (retired && !retired.playing && retired.queue.length === 0) retiredAudio.current = null;
      return;
    }
    const gen = playGen.current;
    try {
      const fmt = parseAudioFormat(rec.mime);
      const rate = parsePcmRate(rec.mime) ?? MODEL_OUT_RATE;
      const d = audioDiag.current;
      if (!d.mimeType && fmt.mime) d.mimeType = String(fmt.mime);
      if (!d.incomingSampleRate) d.incomingSampleRate = rate;
      const tDecode0 = performance.now();
      const bytes = base64ToBytes(rec.b64);
      const decodeMs = performance.now() - tDecode0;
      if (decodeMs > d.decodeMsMax) d.decodeMsMax = Math.round(decodeMs * 100) / 100;
      if (pipeFlags.dump) { try { dumpChunks.current.push(rec.b64); } catch { /* noop */ } }
      const valid = validatePcmChunk(bytes);
      if (!valid.ok) throw new Error(`malformed chunk rejected: ${valid.reason}`);
      // Turn duration proof: expected = samples/rate; browser plays exactly this.
      turnSamples.current += Math.floor(bytes.length / 2);
      turnRate.current = rate;
      const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      if (pcm16.length === 0) throw new Error('empty chunk');
      const ctx = ensurePlaybackEngine('pump-schedule');
      d.audioContextSampleRate = ctx.sampleRate;
      if (ctx.sampleRate !== rate) vlog(`mixer resample ${rate} -> ${ctx.sampleRate} (chunk mime honored, buffer @${rate}Hz)`);
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const tConv0 = performance.now();
      const float = new Float32Array(pcm16.length);
      let sumSq = 0;
      for (let i = 0; i < pcm16.length; i++) { float[i] = pcm16[i] / 32768; sumSq += float[i] * float[i]; }
      const convertMs = performance.now() - tConv0;
      if (convertMs > d.convertMsMax) d.convertMsMax = Math.round(convertMs * 100) / 100;
      // Real amplitude tap for the orb (read-only measurement, no DSP change).
      const rms = Math.sqrt(sumSq / pcm16.length);
      ampRef.current.out = ampRef.current.out * 0.6 + rms * 0.4;
      // Minimal-pipeline diagnostic mode (Step 3): pure passthrough — measure the
      // boundary step for the record but never touch a sample.
      const plain = pipeFlags.plain;
      const abMode = pipeFlags.ab;
      // Boundary handling: measure the step between the previously scheduled tail
      // and this chunk's head BEFORE touching samples. Continuous boundaries stay
      // bit-perfect. Abrupt steps get a micro-crossfade INTO the head only
      // (<=64 samples, ~2.7ms @24kHz): the tail is never faded, so chained
      // chunks cannot develop periodic dips and no fade cascade can form.
      const disc = prevTailSample.current === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(float[0] - (prevTailSample.current as number));
      d.boundaryChecked += 1;
      if (disc > d.boundaryMaxDisc) d.boundaryMaxDisc = Math.round(Math.min(disc, 9) * 10000) / 10000;
      if (!plain && needsBoundarySmoothing(prevTailSample.current, float[0], BOUNDARY_DISC_THRESHOLD)) {
        if (disc !== Number.POSITIVE_INFINITY && disc > BOUNDARY_DISC_THRESHOLD) d.boundaryAbrupt += 1;
        applyCrossfadeIn(float, prevTailSample.current, 64);
        d.boundarySmoothed += 1;
      } else if (!plain && disc !== Number.POSITIVE_INFINITY && disc > BOUNDARY_DISC_THRESHOLD) {
        d.boundaryAbrupt += 1;
      }
      prevTailSample.current = float[float.length - 1]; // raw tail (never faded): honest next measurement
      // A/B resample experiment (Step 7): MODE A = native 24kHz buffer (browser
      // mixer resamples with its high-quality filter); MODE B = one manual
      // windowed-sinc resample to 48kHz here, buffer @48kHz. Same raw PCM either
      // way. Diagnostic only.
      let outFloat: Float32Array = float;
      let bufRate = rate;
      if (abMode === 'B' && rate !== 48000) {
        outFloat = resampleSinc(float, rate, 48000);
        bufRate = 48000;
      }
      const buf = ctx.createBuffer(1, outFloat.length, bufRate);
      buf.getChannelData(0).set(outFloat);
      d.lastBufRate = bufRate;
      // Step 2 capture: exact Int16 bytes of what the AudioContext will play.
      // Float32 passthrough (i/32768) is bit-exact, so unsmoothed chunks compare
      // bit-identical against raw; smoothed chunks show the true delta.
      try {
        const post = new Int16Array(outFloat.length);
        for (let i = 0; i < outFloat.length; i++) {
          const v = Math.round(outFloat[i] * 32768);
          post[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
        postCapture.current.push(post);
        if (postCapture.current.length > 4000) postCapture.current.splice(0, postCapture.current.length - 4000);
      } catch { /* capture never breaks playback */ }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination); // direct: no gain/compressor — volume changes would mask clipping, not fix it
      // Scheduled playback (single source of truth: nextStartTime).
      // Fresh (re)starts use the adaptive jitter target ONLY when arrivals keep
      // up (flowing regime). When audio arrives slower than real time (starved
      // regime — proven by underflow≈played + maxQueue=0 in voice.log), no
      // buffer can invent missing audio, so the chunk plays ASAP (30ms) instead
      // of pointlessly adding 180-280ms of latency on top of every gap.
      const now = ctx.currentTime;
      const tStats = turnArrivalStats();
      const freshDelay = freshStartDelaySec(tStats.regime, jitterTarget.current);
      const sched = nextStartTime(playTime.current, now, freshDelay, UNDERFLOW_RESET_SEC);
      let t: number;
      if (sched.event === 'underflow') {
        // Queue underflow: previously scheduled audio already finished.
        // Fast attack: bump the live target immediately so the very next chunk
        // gets more cover; slow decay happens once per turn in adaptJitter().
        // Skipped in minimal-pipeline mode (frozen target isolates scheduling).
        d.queueUnderflows += 1;
        if (!plain) {
          const bumped = Math.min(MAX_JITTER_BUFFER_SEC, jitterTarget.current + 0.03);
          if (bumped !== jitterTarget.current) {
            jitterTarget.current = Math.round(bumped * 1000) / 1000;
            d.jitterTargetSec = jitterTarget.current;
            d.jitterAdaptEvents += 1;
          }
        }
        sess.vlog('queue underflow: resetting schedule', `was=${playTime.current.toFixed(3)} now=${now.toFixed(3)} target=${jitterTarget.current.toFixed(2)} regime=${tStats.regime} qLen=${sess.queue.length} playing=${sess.playing}`);
        vdiag('AUDIO_UNDERFLOW', `count=${d.queueUnderflows} sess=${sess.id} play=${playSid.current} target=${jitterTarget.current.toFixed(2)} qLen=${sess.queue.length} playing=${sess.playing}`);
        t = sched.t;
      } else {
        // 'fresh' (jitter/ASAP horizon) or 'chain' (exact continuation).
        t = sched.t;
        if (sched.event === 'chain') d.schedChain += 1;
        else d.schedFresh += 1;
      }
      if (!(t >= now)) t = now + UNDERFLOW_RESET_SEC; // never allow negative/past start
      const queuedAheadSec = Math.max(0, playTime.current - now);
      d.sumQueueSec += queuedAheadSec; d.queueSamples += 1;
      if (queuedAheadSec > d.maxQueueSec) d.maxQueueSec = Math.round(queuedAheadSec * 1000) / 1000;
      if (queuedAheadSec < d.minQueueSec) d.minQueueSec = Math.round(queuedAheadSec * 1000) / 1000;
      if (queuedAheadSec > d.turnMaxQueueSec) d.turnMaxQueueSec = Math.round(queuedAheadSec * 1000) / 1000;
      if (queuedAheadSec < d.turnMinQueueSec) d.turnMinQueueSec = Math.round(queuedAheadSec * 1000) / 1000;
      d.totalChunkSec += buf.duration;
      // Smooth accounting: this chunk leaves the turn buffer for the speakers.
      if (smoothTurn.current.active) {
        smoothTurn.current.bufferedSec = Math.max(0, smoothTurn.current.bufferedSec - buf.duration);
        smoothTurn.current.scheduledSec += buf.duration;
      }
      // Step 4 audit: each source node is created once, connected once, started
      // once, and allowed to finish. Overlaps (a start before the previous
      // scheduled end) and double-starts are logged, never silent.
      const srcId = (srcSeq.current += 1);
      srcIds.current.set(src, srcId);
      d.srcCreated += 1;
      if (t < lastSchedEnd.current - 0.001) {
        d.srcOverlaps += 1;
        sess.vlog('source overlap detected', `src=${srcId} start=${t.toFixed(3)} prevEnd=${lastSchedEnd.current.toFixed(3)}`);
      }
      sources.current.add(src);
      src.onended = () => {
        sources.current.delete(src);
        srcIds.current.delete(src);
        try { src.disconnect(); } catch { /* GC hygiene; ended nodes stay disconnected */ }
        // Wedge-proof: ALWAYS release the record (unblocks the worker) even for
        // stale generations — done() on a cleared queue is a harmless no-op.
        // Only fresh chains continue scheduling and count playback.
        const fresh = gen === playGen.current && !sess.cleaned;
        sess.done(rec, fresh ? 'COMPLETED' : 'STALE');
        if (!fresh) return; // stale: interrupted/closed
        d.srcEnded += 1;
        d.playedChunks += 1;
        sess.vlog('source ended naturally', `src=${srcId} seq=${rec.seq}`);
        if (retiredAudio.current === sess && !sess.playing && sess.queue.length === 0) {
          retiredAudio.current = null; // old generation fully drained
        }
        syncPhase();
        pump(); // chain next chunk — the ONLY worker
      };
      try {
        src.start(t);
        d.srcStarted += 1;
      } catch (e) {
        // start() twice on one node throws — node is single-use by design.
        srcIds.current.delete(src);
        sources.current.delete(src);
        throw new Error(`source double-start prevented src=${srcId}: ${(e as Error)?.message}`);
      }
      sess.vlog('source started', `src=${srcId} seq=${rec.seq} t=${t.toFixed(3)} dur=${buf.duration.toFixed(3)} abMode=${abMode} bufRate=${bufRate}`);
      d.playFailStreak = 0; // scheduled cleanly: failure streak resets
      lastSchedEnd.current = t + buf.duration;
      playTime.current = t + buf.duration;
      sess.transition('SPEAKING');
      syncPhase();
    } catch (e) {
      sess.done(rec, 'FAILED');
      d.playFailStreak += 1;
      if (d.playFailStreak >= PLAY_FAIL_STREAK_LIMIT) {
        // Persistent playback failure (not one bad chunk): mark ERROR so the UI
        // state is honest, then keep retrying remaining chunks below.
        sess.transition('ERROR');
        d.playFailStreak = 0;
      }
      vlog(`playback failed ${(e as Error)?.message}`);
      pump();
    }
  };

  // Diagnostic reference tone: 2s 440Hz sine through the SAME converters +
  // AudioContext/destination MYRAA voice uses (no separate player library).
  // Single-output-path guard: never overlaps live voice (would mix + corrupt
  // nextPlayTime). Refuses while any voice source is scheduled or playing.
  const playReferenceTone = async (sinkId: string | null): Promise<string> => {
    // Minimal-pipeline diagnostic mode: tone playback is an optional processor —
    // disabled so the experiment hears voice only.
    if (isPlainPipeline()) {
      return 'DEVICE TEST disabled in minimal-pipeline diagnostic mode (myraa_plain_pipeline=1)';
    }
    if (sources.current.size > 0 || session.current?.state === 'SPEAKING' || (session.current && session.current.queue.length > 0)) {
      return 'DEVICE TEST skipped: live voice active (single output path — tone suppressed to avoid overlap)';
    }
    const rate = MODEL_OUT_RATE, secs = 2, freq = 440, peak = 0.5;
    const n = rate * secs;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((i / rate) * Math.PI * 2 * freq) * peak;
    const bytes = base64ToBytes(floatToPcm16Base64(sine)); // identical round-trip as voice chunks
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const ctx = ensurePlaybackEngine('ref-tone');
    if (ctx.state === 'suspended') await ctx.resume();
    let routed = 'default';
    try {
      const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (sinkId && typeof anyCtx.setSinkId === 'function') {
        await anyCtx.setSinkId(sinkId);
        routed = sinkId.slice(0, 12) + '…';
      }
    } catch (e) { return `DEVICE TEST device=${routed} error=setSinkId failed: ${(e as Error)?.message}`; }
    const float = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float[i] = pcm16[i] / 32768;
    const buf = ctx.createBuffer(1, float.length, rate);
    buf.getChannelData(0).set(float);
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => resolve();
      src.start();
    });
    try {
      const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (sinkId && typeof anyCtx.setSinkId === 'function') await anyCtx.setSinkId('');
    } catch { /* restore best-effort */ }
    return `DEVICE TEST device=${routed} sample_rate=${ctx.sampleRate} channels=1 format=PCM16LE buffer=${rate}Hz playback_started=yes playback_completed=yes peak=${peak} error=none`;
  };

  // Adaptive jitter (Part 2): runs ONCE per turn + on underflow bumps above.
  // Slow attack / slower decay with clamped steps, so the target tracks real
  // network conditions without oscillating every chunk. Raises are skipped in
  // the starved regime (raising the buffer cannot fix slower-than-real-time
  // arrivals — it only adds latency); decay toward base still applies.
  const turnArrivalStats = (): { n: number; meanMs: number; chunkMs: number; regime: string } => {
    const dd = audioDiag.current;
    const mm = turnMark.current;
    const n = mm ? dd.arrivalGaps - mm.arrivalGaps : dd.arrivalGaps;
    const sum = mm ? dd.totalArrivalGapMs - mm.totalArrivalGapMs : dd.totalArrivalGapMs;
    const meanMs = n >= 3 ? sum / Math.max(1, n) : (dd.avgArrivalMs > 0 ? dd.avgArrivalMs : 0);
    const chunkMs = dd.playedChunks > 0 ? (dd.totalChunkSec / dd.playedChunks) * 1000 : 0;
    return { n, meanMs, chunkMs, regime: classifyArrivalRegime(meanMs, chunkMs) };
  };
  const adaptJitter = (underflowsThisTurn: number) => {
    const d = audioDiag.current;
    const base = d.jitterBaseSec;
    let goal = base;
    const regime = turnArrivalStats().regime;
    if (regime !== 'starved') {
      if (d.arrivalJitterMs > 60) goal += 0.06;
      else if (d.arrivalJitterMs > 35) goal += 0.03;
      if (underflowsThisTurn > 0) goal += 0.04;
    }
    if (underflowsThisTurn === 0 && d.arrivalJitterMs < 25) {
      d.stableTurns += 1;
      if (d.stableTurns >= 2) goal -= 0.02; // stable link: ease back toward base
    } else {
      d.stableTurns = 0;
    }
    goal = Math.min(MAX_JITTER_BUFFER_SEC, Math.max(MIN_JITTER_BUFFER_SEC, Math.round(goal * 1000) / 1000));
    const cur = jitterTarget.current;
    // Slew-rate limit: +50ms attack / -20ms decay per turn. No oscillation.
    const next = cur < goal
      ? Math.min(goal, Math.round((cur + 0.05) * 1000) / 1000)
      : Math.max(goal, Math.round((cur - 0.02) * 1000) / 1000);
    if (next !== cur) {
      jitterTarget.current = next;
      d.jitterTargetSec = next;
      d.jitterAdaptEvents += 1;
      vdiag('AUDIO_JITTER', `adapt base=${base.toFixed(2)} goal=${goal.toFixed(2)} target=${next.toFixed(2)} jitter=${d.arrivalJitterMs.toFixed(1)}ms underflowsThisTurn=${underflowsThisTurn}`);
    }
  };

  const printAudioSummary = (reason: string) => {
    const d = audioDiag.current;
    const avgArrival = d.arrivalGaps > 0 ? Math.round((d.totalArrivalGapMs / d.arrivalGaps) * 10) / 10 : 0;
    const avgQueue = d.queueSamples > 0 ? Math.round((d.sumQueueSec / d.queueSamples) * 1000) / 1000 : 0;
    const avgChunk = d.playedChunks > 0 ? Math.round((d.totalChunkSec / d.playedChunks) * 1000) / 1000 : 0;
    const minQ = d.minQueueSec === Number.POSITIVE_INFINITY ? 0 : d.minQueueSec;
    // Per-turn deltas since the turn's first chunk (human-quality record).
    const m = turnMark.current;
    const tPlayed = m ? d.playedChunks - m.playedChunks : d.playedChunks;
    const tUnder = m ? d.queueUnderflows - m.queueUnderflows : d.queueUnderflows;
    const tInt = m ? d.interruptions - m.interruptions : d.interruptions;
    const tEns = m ? d.engineCreations - m.engineCreations : d.engineCreations;
    const tSmooth = m ? d.boundarySmoothed - m.boundarySmoothed : d.boundarySmoothed;
    const tChecked = m ? d.boundaryChecked - m.boundaryChecked : d.boundaryChecked;
    const tGaps = m ? d.arrivalGaps - m.arrivalGaps : d.arrivalGaps;
    const tGapMs = m ? d.totalArrivalGapMs - m.totalArrivalGapMs : d.totalArrivalGapMs;
    const tAvgGap = tGaps > 0 ? Math.round((tGapMs / tGaps) * 10) / 10 : 0;
    const tMinQ = d.turnMinQueueSec === Number.POSITIVE_INFINITY ? 0 : d.turnMinQueueSec;
    const summary =
      `AUDIO_SESSION_SUMMARY reason=${reason} voice_session_id=${session.current?.id ?? retiredAudio.current?.id ?? 'none'} playback_session_id=${playSid.current || 'none'} incomingChunks=${d.incomingChunks} playedChunks=${d.playedChunks} ` +
      `duplicateChunks=${d.duplicateChunks} outOfOrderChunks=${d.outOfOrderChunks} missingSequences=${d.missingSequences} ` +
      `skippedSequences=${d.skippedSequences} queueUnderflows=${d.queueUnderflows} averageChunkDuration=${avgChunk}s ` +
      `averageArrivalInterval=${avgArrival}ms arrivalJitter=${d.arrivalJitterMs.toFixed(1)}ms maxArrivalGap=${Math.round(d.maxArrivalGapMs * 10) / 10}ms ` +
      `averageQueueDuration=${avgQueue}s minQueueDuration=${minQ}s maxQueueDuration=${d.maxQueueSec}s ` +
      `jitterTarget=${jitterTarget.current.toFixed(2)}s jitterBase=${d.jitterBaseSec.toFixed(2)}s jitterAdapts=${d.jitterAdaptEvents} regime=${turnArrivalStats().regime} ` +
      `interruptions=${d.interruptions} falseBarge=${d.falseBargeIgnored} engineCalls=${d.engineCalls} engineCreations=${d.engineCreations} engineCloses=${d.engineCloses} audioCtxCloses=${d.audioCtxCloses} ` +
      `srcCreated=${d.srcCreated} srcStarted=${d.srcStarted} srcEnded=${d.srcEnded} srcStoppedEarly=${d.srcStoppedEarly} srcOverlaps=${d.srcOverlaps} ` +
      `schedChain=${d.schedChain} schedFresh=${d.schedFresh} ` +
      `boundaryChecked=${d.boundaryChecked} boundaryAbrupt=${d.boundaryAbrupt} boundarySmoothed=${d.boundarySmoothed} boundaryMaxDisc=${d.boundaryMaxDisc} ` +
      `turnPlayed=${tPlayed} turnUnderflows=${tUnder} turnAvgArrival=${tAvgGap}ms turnMaxGap=${Math.round(d.turnMaxGapMs * 10) / 10}ms ` +
      `turnMinQueue=${tMinQ}s turnMaxQueue=${d.turnMaxQueueSec}s turnInterruptions=${tInt} turnEngineCreations=${tEns} turnSmoothed=${tSmooth}/${tChecked} ` +
      `pipelineMode=${isPlainPipeline() ? 'minimal' : 'full'} abMode=${getABMode()} bufRate=${d.lastBufRate || d.incomingSampleRate || turnRate.current} ` +
      `playMode=${isStreamMode() ? 'stream' : 'smooth'} smoothTarget=${readSmoothTargetSec().toFixed(2)}s bufBeforePlay=${smoothTurn.current.bufBeforePlaySec.toFixed(2)}s waitedComplete=${smoothTurn.current.waitedForComplete} ` +
      `turnAudioSec=${Math.round(smoothTurn.current.audioSec * 1000) / 1000}s scheduledSec=${Math.round(smoothTurn.current.scheduledSec * 1000) / 1000}s ` +
      `arrivalRate=${smoothTurn.current.audioSec > 0 && smoothTurn.current.lastAtMs > smoothTurn.current.firstAtMs ? (smoothTurn.current.audioSec / ((smoothTurn.current.lastAtMs - smoothTurn.current.firstAtMs) / 1000)).toFixed(2) : 'n/a'} ` +
      `earlyStreamingAllowed=${smoothTurn.current.earlyStream} ` +
      `outputLatency=${d.outputLatencyMs}ms baseLatency=${d.baseLatencyMs}ms ` +
      `incomingSampleRate=${d.incomingSampleRate || turnRate.current} audioContextSampleRate=${d.audioContextSampleRate || playCtx.current?.sampleRate || 0} ` +
      `mimeType=${d.mimeType || 'n/a'} channels=1 decodeMsMax=${d.decodeMsMax} convertMsMax=${d.convertMsMax}`;
    vlog(summary);
    vdiag('AUDIO_SESSION_SUMMARY', summary);
  };

  // ---- voice connection: single state machine, generations, close-once ----
  // (See src/voiceConnect.js. No parallel booleans: conn.state is authoritative.)

  // User-initiated full stop: cancel retries, close once, park STOPPED.
  // Never touches a newer generation; never schedules. Explicit-stop path:
  // stops sources, closes session, prints diagnostics. Engine context is kept
  // for reuse; only unmount closes it.
  const disconnect = () => {
    vlog('session stopped (disconnect)');
    try { printAudioSummary('disconnect'); } catch { /* noop */ }
    connRef.current!.userDisconnect();
    connRef.current!.setVoiceActive(false);
    micSend.current = false;
    stopMic();
    stopSources('disconnect-stop');
    session.current?.close();
    session.current = null;
    retiredAudio.current = null;
    setPhase('idle');
  };

  // Open exactly one socket for exactly one generation. Refuses duplicates.
  const openVoiceSocket = (gen: number) => {
    const cur = ws.current;
    if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) {
      if (wsGen.current === gen) { vlog('socket already active for generation, not duplicating'); return; }
      // A live socket from another generation: only supersede it if that
      // generation is already closed; otherwise refuse (single-flight).
      if (!connRef.current!.isCurrent(gen)) { vlog('stale generation open refused'); return; }
      try { cur.close(); } catch { /* noop */ }
    }
    const sess = new VoiceSession((m: string) => console.debug(m));
    sess.generation = gen;
    session.current = sess;
    resetAudioDiag();
    // Jitter base: localStorage override (A/B listening) else 180ms default.
    // Logged so before/after summaries show exactly which base was tested.
    const dInit = audioDiag.current;
    dInit.jitterBaseSec = readJitterOverrideSec() ?? JITTER_BUFFER_SEC;
    dInit.jitterTargetSec = dInit.jitterBaseSec;
    jitterTarget.current = dInit.jitterBaseSec;
    turnMark.current = null;
    prevTailSample.current = null;
    vlog(`jitter base=${dInit.jitterBaseSec.toFixed(2)}s target=${jitterTarget.current.toFixed(2)}s presets=[${JITTER_PRESETS_SEC.join(',')}] (override via localStorage myraa_jitter_ms)`);
    playSid.current = `PLAY-${Date.now().toString(36).toUpperCase()}-${String(gen).padStart(3, '0')}`;
    vlog(`playback session ${playSid.current} voice_session_id=${sess.id} (exactly one pipeline per voice session)`);
    const sock = liveSocket();
    ws.current = sock;
    wsGen.current = gen;
    sess.vlog('session started');
    sess.transition('LISTENING');
    syncPhase();
    vlog('microphone stream follows on Start mic; Gemini Live connecting');
    sock.onmessage = (ev) => {
      let msg: any = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const route = connRef.current!.onSocketMessage(gen, msg);
      if (!route.handled) return; // stale generation: ignore everything
      if (route.retiring) return; // GoAway: input frozen, cleanup owns the rest
      if (route.remoteClosed) {
        // Recoverable Gemini-leg death (Step 3): the single-flight reconnect
        // scheduler owns recovery. Transient status only — NEVER a fatal
        // transcript line, NEVER 'Check Settings'. Scheduled audio drains.
        setVoiceStatus('Refreshing voice connection…');
        syncPhase();
        return;
      }
      if (msg.type === 'transcription') {
        push(msg.role, msg.text);
        if (msg.role === 'model') { sess.transition('SPEAKING'); }
        else { if (sess.state === 'SPEAKING') sess.transition('INTERRUPTED'), sess.transition('LISTENING'); else sess.transition('THINKING'); }
        syncPhase();
      } else if (msg.type === 'task_status') {
        // Instant UI update: task progress arrives as a push, never polled.
        if (typeof msg.message === 'string' && msg.message) showTaskStatus(String(msg.message));
      } else if (msg.type === 'audio' && msg.audio) {
        connRef.current!.noteHealthy(gen);
        // STEP 1 logging: exact incoming format, never assumed.
        const b64str = String(msg.audio);
        const fmt0 = parseAudioFormat(msg.mime);
        const estBytes = Math.floor(b64str.length * 3 / 4);
        const nowMs = Date.now();
        const d0 = audioDiag.current;
        if (d0.lastArrivalAt > 0) {
          const gapMs = nowMs - d0.lastArrivalAt;
          d0.totalArrivalGapMs += gapMs; d0.arrivalGaps += 1;
          if (gapMs > d0.maxArrivalGapMs) d0.maxArrivalGapMs = Math.round(gapMs * 10) / 10;
          if (gapMs > d0.turnMaxGapMs) d0.turnMaxGapMs = Math.round(gapMs * 10) / 10;
          // In-turn gap histogram (zeroed at each turnComplete): distinguishes
          // steady streaming (<150ms) from jitter (150-600ms) and stalls (>600ms).
          if (gapMs < 150) d0.gapLt150 += 1;
          else if (gapMs < 300) d0.gap150to300 += 1;
          else if (gapMs < 600) d0.gap300to600 += 1;
          else d0.gapGt600 += 1;
          // Slow EWMA stats (alpha 0.15): track conditions without reacting per chunk.
          const a = 0.15;
          if (d0.arrivalGaps <= 1) {
            d0.avgArrivalMs = Math.round(gapMs * 10) / 10;
            d0.arrivalJitterMs = 0;
          } else {
            const prevAvg = d0.avgArrivalMs || gapMs;
            d0.avgArrivalMs = Math.round((prevAvg + a * (gapMs - prevAvg)) * 10) / 10;
            d0.arrivalJitterMs = Math.round((d0.arrivalJitterMs + a * (Math.abs(gapMs - d0.avgArrivalMs) - d0.arrivalJitterMs)) * 10) / 10;
          }
        }
        d0.lastArrivalAt = nowMs;
        // First chunk of a turn: snapshot counters so turnComplete prints per-turn deltas.
        if (!turnMark.current) {
          turnMark.current = {
            playedChunks: d0.playedChunks, queueUnderflows: d0.queueUnderflows,
            interruptions: d0.interruptions, engineCreations: d0.engineCreations,
            boundarySmoothed: d0.boundarySmoothed, boundaryChecked: d0.boundaryChecked,
            arrivalGaps: d0.arrivalGaps, totalArrivalGapMs: d0.totalArrivalGapMs,
          };
        }
        sess.vlog('audio chunk received',
          `seq=${msg.seq ?? '?'} mime=${msg.mime ?? 'n/a'} codec=${fmt0.codec} rate=${fmt0.sampleRate} channels=${fmt0.channels} bitDepth=${fmt0.bitDepth} b64chars=${b64str.length} estBytes=${estBytes}`);
        // Step 1 capture: exact received bytes keyed by seq, BEFORE queue
        // scheduling or any processing. Sorted + concatenated at turnComplete.
        try {
          if (typeof msg.seq === 'number') {
            rawCapture.current.set(msg.seq, b64str);
            if (rawCapture.current.size > 4000) {
              const first = rawCapture.current.keys().next().value;
              rawCapture.current.delete(first);
            }
            if (!rawCaptureRate.current) rawCaptureRate.current = fmt0.sampleRate;
          }
        } catch { /* capture never breaks voice */ }
        const rec = sess.receive(b64str, typeof msg.seq === 'number' ? msg.seq : undefined, msg.mime, nowMs);
        // Mirror session-level ordering diagnostics into the turn summary.
        try {
          const sd = sess.getDiagnostics();
          d0.incomingChunks = sd.incomingChunks;
          d0.duplicateChunks = sd.duplicateChunks;
          d0.outOfOrderChunks = sd.outOfOrderChunks;
          d0.missingSequences = sd.missingSequences;
          d0.skippedSequences = sd.skippedSequences || 0;
        } catch { /* noop */ }
        if (!rec) {
          // Duplicate/stale/retired: never replay, never stall. Counts already logged.
          if (d0.incomingChunks === 0) vlog('audio chunk ignored (duplicate/stale/retired)');
        } else {
          const estSec = estimatePcmSec(b64str.length, fmt0.sampleRate);
          // Smooth Voice Mode: accrue turn buffer + delivery-rate evidence.
          // New turn starts buffering here; playback begins at a fast measured
          // rate with enough reserve, or at turn completion — never on a bare
          // byte count while delivery is slow.
          if (!smoothTurn.current.active) resetSmoothTurn();
          smoothTurn.current.active = true;
           smoothTurn.current.bufferedSec += estSec;
           smoothTurn.current.audioSec += estSec;
           smoothTurn.current.chunks += 1;
           if (!smoothTurn.current.firstAtMs) smoothTurn.current.firstAtMs = nowMs;
           smoothTurn.current.lastAtMs = nowMs;
           // Windowed-rate history (capped): recent chunks only, so one stall
           // cannot brand the rest of the turn slow.
           smoothTurn.current.histT.push(nowMs);
           smoothTurn.current.histA.push(estSec);
          if (smoothTurn.current.histT.length > 20) {
            smoothTurn.current.histT.splice(0, smoothTurn.current.histT.length - 20);
            smoothTurn.current.histA.splice(0, smoothTurn.current.histA.length - 20);
          }
          sess.vlog('audio chunk queued for scheduled playback', `seq=${rec.seq} estDurSec=${estSec} queueLength=${sess.queue.length} turnBuf=${smoothTurn.current.bufferedSec.toFixed(2)}s`);
          pump();
        }
      } else if (msg.type === 'interrupted') {
        // Explicit user interruption: the ONLY non-STOP path that clears audio.
        // Counted separately so summaries prove transient events never cut speech.
        // Minimal-pipeline diagnostic mode (Step 3): barge-in ignored entirely —
        // only explicit STOP terminates speech, isolating the minimum pipeline.
        if (isPlainPipeline()) {
          sess.vlog('barge-in ignored in minimal-pipeline mode (explicit STOP only)');
          syncPhase();
        } else {
          const micLevel = ampRef.current.mic || 0;
          // Barge-in gate: Gemini's 'interrupted' also fires on acoustic feedback
          // (speaker output leaking into the mic despite echo cancellation). Honor
          // it only when the mic actually hears the user; otherwise the queue is
          // destroyed mid-word with nothing spoken (cut words). Ignored events are
          // counted in falseBargeIgnored. A real interruption sustains mic energy,
          // so genuine barge-ins still pass on this or the next signal.
          if (micLevel < BARGE_MIC_RMS_THRESHOLD) {
            sess.vlog('barge-in ignored (mic silent — likely echo, not user)', `micRms=${micLevel.toFixed(4)}`);
            vdiag('BARGE_IGNORED', `micRms=${micLevel.toFixed(4)} sess=${sess.id}`);
            audioDiag.current.falseBargeIgnored += 1;
            syncPhase();
          } else {
            sess.vlog('user interruption detected', `micRms=${micLevel.toFixed(4)}`);
            try { printAudioSummary('interrupted'); } catch { /* noop */ }
            audioDiag.current.interruptions += 1;
            stopSources('user-interrupt');
            sess.interrupt();
            sess.transition('INTERRUPTED');
            sess.transition('LISTENING');
            syncPhase();
          }
        }
      } else if (msg.type === 'turnComplete') {
        // Duration proof: scheduled samples/rate must equal wall-clock speech.
        // Plus full AUDIO_DIAGNOSTICS at the end of every voice turn.
        if (turnSamples.current > 0) {
          sess.vlog('turn audio scheduled',
            `samples=${turnSamples.current} rate=${turnRate.current} expectedSec=${(turnSamples.current / turnRate.current).toFixed(2)} gaps=${sess.gaps || 0}`);
          turnSamples.current = 0;
        }
        try {
          const sd = sess.getDiagnostics();
          const d = audioDiag.current;
          d.incomingChunks = sd.incomingChunks; d.playedChunks = Math.max(d.playedChunks, sd.playedChunks);
          d.duplicateChunks = sd.duplicateChunks; d.outOfOrderChunks = sd.outOfOrderChunks;
          d.missingSequences = sd.missingSequences; d.skippedSequences = sd.skippedSequences || 0;
          d.turnCount += 1;
          // Slow adaptation, once per turn: uses this turn's underflows.
          // Frozen in minimal-pipeline diagnostic mode (Step 3).
          const tUnder = turnMark.current ? d.queueUnderflows - turnMark.current.queueUnderflows : 0;
          if (!isPlainPipeline()) adaptJitter(tUnder);
          // Smooth Voice Mode: the turn is complete — release any still-buffered
          // audio now (records whether playback waited for completion), then
          // summarize. Late audio after this starts a fresh turn buffer.
          // Defensive: if turn bookkeeping was reset mid-turn (interruption path)
          // while unplayed audio remains queued, re-init minimally and play it
          // rather than stranding it silent. Queue holds only unplayed chunks,
          // so this can never replay audio.
          if (sess.queue.length > 0) {
            if (!smoothTurn.current.active) {
              resetSmoothTurn();
              smoothTurn.current.active = true;
              smoothTurn.current.turnDone = true;
              smoothTurn.current.started = true;
              smoothTurn.current.waitedForComplete = true;
              vdiag('SMOOTH_START', `defensive start of stranded queue len=${sess.queue.length} sess=${sess.id} play=${playSid.current}`);
            } else {
              smoothTurn.current.turnDone = true;
            }
            pump();
          } else if (smoothTurn.current.active) {
            smoothTurn.current.turnDone = true;
          }
          printAudioSummary(`turnComplete#${d.turnCount}`);
          // In-turn arrival timing: compact histogram proving whether this turn
          // streamed steadily (<150ms gaps) or stalled. Zeroed for the next turn.
          try {
            const tStats = turnArrivalStats();
            vdiag('AUDIO_TURN_TIMING', `turn=${d.turnCount} gaps=${tStats.n} meanGap=${Math.round(tStats.meanMs)}ms chunkMs=${Math.round(tStats.chunkMs)}ms regime=${tStats.regime} b150/b300/b600/gt=${d.gapLt150}/${d.gap150to300}/${d.gap300to600}/${d.gapGt600}`);
          } catch { /* diagnostics never break voice */ }
          // Reset per-turn extremes + snapshot for the next turn. New turn starts
          // from silence, so boundary continuity restarts (crossfade-in applies).
          // Smooth turn closes here: late audio opens a fresh turn buffer.
          turnMark.current = null;
          smoothTurn.current.active = false;
          d.turnMaxGapMs = 0;
          d.turnMinQueueSec = Number.POSITIVE_INFINITY; d.turnMaxQueueSec = 0;
          d.gapLt150 = 0; d.gap150to300 = 0; d.gap300to600 = 0; d.gapGt600 = 0;
          prevTailSample.current = null;
        } catch { /* diagnostics never break voice */ }
        // Steps 1+2 capture: ordered raw PCM (pre-queue) + post-pipeline PCM
        // (pre-playback) for one voice response. Gated on the Diag toggle so the
        // per-turn base64 round-trip costs nothing in normal use.
        try {
          if (localStorage.getItem('myraa_dump') === '1' && rawCapture.current.size > 0) {
            const seqs = [...rawCapture.current.keys()].sort((a, b) => a - b);
            const raws: Uint8Array[] = [];
            let rawTotal = 0;
            for (const s of seqs) {
              const by = base64ToBytes(rawCapture.current.get(s) as string);
              const even = by.subarray(0, by.length - (by.length % 2));
              raws.push(even); rawTotal += even.length;
            }
            const rawMerged = new Uint8Array(rawTotal);
            let ro = 0;
            for (const r of raws) { rawMerged.set(r, ro); ro += r.length; }
            let postTotal = 0;
            for (const p of postCapture.current) postTotal += p.length * 2;
            const postMerged = new Uint8Array(postTotal);
            let po = 0;
            for (const p of postCapture.current) {
              postMerged.set(new Uint8Array(p.buffer, p.byteOffset, p.length * 2), po);
              po += p.length * 2;
            }
            const toB64 = (u8: Uint8Array): string => {
              let bin = '';
              for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
              return btoa(bin);
            };
            // Local stats for the log (server re-analyzes independently).
            const r16 = new Int16Array(rawMerged.buffer, rawMerged.byteOffset, Math.floor(rawMerged.length / 2));
            const p16 = new Int16Array(postMerged.buffer, postMerged.byteOffset, Math.floor(postMerged.length / 2));
            const rs = analyzePcm16(rawMerged);
            const ps = analyzePcm16(postMerged);
            let identical = r16.length === p16.length;
            if (identical) { for (let i = 0; i < r16.length; i++) { if (r16[i] !== p16[i]) { identical = false; break; } } }
            const rDisc = countDiscontinuities(r16);
            const pDisc = countDiscontinuities(p16);
            sess.vlog('A/B capture built',
              `rawSamples=${rs.samples} postSamples=${ps.samples} rawRMS=${rs.rms} postRMS=${ps.rms} rawPeak=${rs.peak} postPeak=${ps.peak} ` +
              `rawDisc=${rDisc} postDisc=${pDisc} bitIdentical=${identical} abMode=${getABMode()} pipeline=${isPlainPipeline() ? 'minimal' : 'full'}`);
            fetch('/api/voice-ab-capture', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                rawB64: toB64(rawMerged),
                postB64: toB64(postMerged),
                rate: rawCaptureRate.current || turnRate.current || MODEL_OUT_RATE,
                abMode: getABMode(),
                pipelineMode: isPlainPipeline() ? 'minimal' : 'full',
                playbackSampleRate: playCtx.current?.sampleRate ?? null,
                clientStats: {
                  rawSamples: rs.samples, postSamples: ps.samples,
                  rawRms: rs.rms, postRms: ps.rms, rawPeak: rs.peak, postPeak: ps.peak,
                  rawDisc: rDisc, postDisc: pDisc, bitIdentical: identical,
                },
              }),
            }).then((r) => r.json()).then((j) => {
              if (j && j.compare) sess.vlog('A/B compare (server)', JSON.stringify(j.compare).slice(0, 400));
            }).catch(() => {});
          }
        } catch { /* capture never breaks voice */ }
        clearAbCapture();
        // TEST B: post the exact device-bound PCM of this response (diagnostics only).
        try {
          if (localStorage.getItem('myraa_dump') === '1' && dumpChunks.current.length > 0) {
            const parts = dumpChunks.current;
            dumpChunks.current = [];
            const total = parts.reduce((nn, b) => nn + Math.floor(base64ToBytes(b).length / 2) * 2, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const b of parts) {
              const by = base64ToBytes(b);
              merged.set(by.subarray(0, by.length - (by.length % 2)), off);
              off += by.length - (by.length % 2);
            }
            let bin = '';
            for (let i = 0; i < merged.length; i += 8192) bin += String.fromCharCode(...merged.subarray(i, i + 8192));
            fetch('/api/voice-dump', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pcmBase64: btoa(bin),
                playbackSampleRate: playCtx.current?.sampleRate ?? null,
                bufferRate: turnRate.current || MODEL_OUT_RATE,
              }),
            }).catch(() => {});
          }
        } catch { /* diagnostics never break voice */ }
        if (sess.state === 'SPEAKING' && sess.queue.length === 0 && !sess.playing) {
          sess.transition('IDLE');
          syncPhase();
        }
      } else if (msg.type === 'memory_sync') {
        setMemories(msg.memories);
      } else if (msg.type === 'toolCall') {
        push('model', `[tool ${msg.name}]`);
      } else if (msg.type === 'error') {
        if (msg.code === 'INVALID_API_KEY' || /NO_API_KEY|rejected.*key|unauthenticated/i.test(String(msg.error || ''))) {
          // Key problems need the user — stop everything, never auto-retry.
          // Explicit session termination: clearing the queue is correct here.
          push('error', 'Voice authentication failed. Check Settings.');
          setVoiceStatus('Voice authentication failed. Check Settings.');
          try { printAudioSummary('invalid-key'); } catch { /* noop */ }
          sess.transition('ERROR');
          connRef.current!.userDisconnect();
          stopMic();
          stopSources('invalid-key-termination');
          session.current?.close();
          session.current = null;
          setPhase('idle');
        } else {
          // Transient error: surface it but DO NOT interrupt own speech.
          // Only explicit STOP / user interruption / session termination clears audio.
          push('error', msg.error);
          sess.vlog('non-fatal error (playback preserved)', String(msg.error || '').slice(0, 160));
          syncPhase();
        }
      }
    };
    sock.onopen = () => {
      // Generation-stamped: a stale socket is closed, never adopted.
      if (!connRef.current!.onSocketOpen(gen)) return;
      connRef.current!.noteConnected(gen);
      // Step 6: output-device facts (best-effort; labels need granted permission).
      // Never blocks the voice path. Feed the Windows-processing checklist in TEST D.
      try {
        navigator.mediaDevices?.enumerateDevices?.().then((devs) => {
          const outs = (devs || []).filter((dd) => dd.kind === 'audiooutput')
            .map((dd) => dd.label || '(unnamed device)');
          vlog(`output devices: ${outs.length ? outs.join(' | ') : 'none visible'}`);
          vdiag('AUDIO_DEVICE', `outputs=[${outs.join(' | ').slice(0, 300)}]`);
        }).catch(() => {});
      } catch { /* best-effort only */ }
    };
    sock.onerror = () => {
      connRef.current!.onSocketError(gen, 'socket error');
    };
    sock.onclose = (ev) => {
      const conn = connRef.current!;
      const before = conn.state;
      const live = conn.onSocketClose(gen, { code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason });
      if (!live) return; // stale generation: its death must never touch the live session
      // Drain vs hard-stop (Step 3/5): rotation closes (goaway, remote-close,
      // unexpected-close, socket-error) must let already-scheduled audio finish
      // via retireAudio — the new generation starts clean and stale audio never
      // mixes in. ONLY an explicit user STOP hard-stops local audio here.
      const userStop = conn.stopAfterClose || conn.lastCloseReason === 'user';
      if (!userStop) {
        // Controlled rotation or unexpected drop under recovery: audio drains,
        // reconnect owns the next session. No self-interruption.
        vlog(`connection ${before} closed (reason=${conn.lastCloseReason || '?'}); audio drains, reconnect owns the next session`);
        syncPhase();
        return;
      }
      // Explicit user STOP: hard stop local audio.
      vlog('connection closed by user; playback stopped, queue cleared');
      try { printAudioSummary('socket-close'); } catch { /* noop */ }
      stopSources('socket-close-termination');
      const s = session.current;
      if (s && s.generation === gen) {
        s.interrupt();
        s.transition('STOPPING');
        s.transition('IDLE');
      }
      syncPhase();
    };
  };

  // User (or auto-launch) initiates exactly one connection attempt.
  const connect = () => {
    const r = connRef.current!.userConnect('user');
    if (!r.ok) { vlog(`connect refused: ${r.why}`); return; }
    connRef.current!.setVoiceActive(micStream.current ? true : connRef.current!.voiceActive);
    openVoiceSocket(r.generation);
  };

  const sendText = (text: string) => {
    const t = text.trim();
    if (!t) return;
    // Never send into a retiring/closed socket: CONNECTED + current generation only.
    if (!connRef.current!.canSend() || ws.current?.readyState !== WebSocket.OPEN || wsGen.current !== connRef.current!.generation) {
      vlog('send dropped: voice link not connected');
      return;
    }
    ws.current.send(JSON.stringify({ type: 'text', text: t, turnId: newTurnId() }));
    push('user', t);
    setPhase('thinking');
  };

  const stopMic = () => {
    connRef.current?.setVoiceActive(false);
    micSend.current = false;
    if (!micStream.current && !micCtx.current) { setMicActive(false); return; }
    vlog('microphone stopped');
    try { micProc.current?.disconnect(); } catch { /* noop */ }
    try { micCtx.current?.close(); } catch { /* noop */ }
    micStream.current?.getTracks().forEach((t) => t.stop());
    micProc.current = null;
    micCtx.current = null;
    micStream.current = null;
    setMicActive(false);
  };

  // Resolves true once the voice link reaches OPEN (auto-connect path for the
  // mic button). Mirrors autoLaunch's polling; reads ws.current live, so a new
  // generation replacing the socket mid-wait is picked up automatically.
  const waitForVoiceLinkOpen = (timeoutMs = 20000): Promise<boolean> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      const t = window.setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) { window.clearInterval(t); resolve(true); }
        else if (Date.now() - startedAt > timeoutMs) { window.clearInterval(t); resolve(false); }
      }, 250);
    });

  const startMic = async () => {
    if (micStarting.current || micStream.current) return; // never double-start
    micStarting.current = true;
    setMicError('');
    try {
      if (ws.current?.readyState !== WebSocket.OPEN) {
        // Tap-to-talk: connect first, then enable the mic once the link is open.
        vlog('mic requested while disconnected — auto-connecting first');
        connect();
        if (!(await waitForVoiceLinkOpen())) {
          setMicError('Could not establish the voice link for the mic. Tap Connect and retry.');
          return;
        }
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicError('Mic not supported in this browser. Use Chrome/Edge on localhost.');
        return;
      }
      // Echo cancellation suite prevents the speaker feeding back into Gemini.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      vlog(`microphone started sampleRate=${settings.sampleRate ?? 16000} channels=${settings.channelCount ?? 1} echoCancellation=${settings.echoCancellation ?? 'n/a'} format=PCM16`);
      const ctx = new AudioContext({ sampleRate: 16000 }); // Gemini Live input: 16kHz mono PCM16
      const src = ctx.createMediaStreamSource(stream);
      // LATENCY FIX: 1024 frames @16kHz = 64ms chunks (was 2048/128ms).
      // Halves mic capture floor so speech reaches Gemini sooner; message
      // rate (~16/sec of tiny base64 frames) is negligible for the socket.
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (e) => {
        if (!micStream.current) return; // stream torn down: stay silent
        const input = e.inputBuffer.getChannelData(0);
        let msq = 0;
        for (let i = 0; i < input.length; i += 4) msq += input[i] * input[i];
        const mrms = Math.sqrt(msq / Math.ceil(input.length / 4));
        ampRef.current.mic = ampRef.current.mic * 0.7 + mrms * 0.3;
        const b64 = floatToPcm16Base64(input);
        // Single mic stream, generation-gated send: only while the user intends
        // voice AND the link is CONNECTED. Never feeds a retiring socket.
        if (micSend.current && connRef.current!.canSend() && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ audio: b64 }));
        }
      };
      // Zero-gain monitor: ScriptProcessor must be connected to run, but the mic
      // must NEVER bleed to the speakers (feedback path). Gain 0 proves it.
      const monitorGuard = ctx.createGain();
      monitorGuard.gain.value = 0;
      src.connect(proc);
      proc.connect(monitorGuard);
      monitorGuard.connect(ctx.destination);
      micStream.current = stream;
      micCtx.current = ctx;
      micProc.current = proc;
      setMicActive(true);
      // User intends voice from here on (manual mic or hands-free auto-mic).
      connRef.current!.setVoiceActive(true);
      micSend.current = true;
      session.current?.transition('LISTENING');
      syncPhase();
    } catch (e) {
      setMicError(`Mic blocked: ${(e as Error)?.message || e}. Allow microphone permission and retry.`);
      stopMic();
    } finally {
      micStarting.current = false;
    }
  };

  const toggleMic = () => {
    if (micActive) stopMic();
    else void startMic();
  };

  const toggleDump = () => {
    const v = !dumpOn;
    setDumpOn(v);
    try { localStorage.setItem('myraa_dump', v ? '1' : '0'); } catch { /* noop */ }
  };
  const toggleDev = () => {
    const v = !devMode;
    setDevMode(v);
    try { localStorage.setItem('myraa_dev', v ? '1' : '0'); } catch { /* noop */ }
  };

  const statusLabel = taskStatus?.message
    ?? voiceStatus
    ?? (phase === 'talking' ? 'Speaking' : phase === 'thinking' ? 'Working' : 'Ready');

  const openSheet = (v: View) => { setView(v); setMenuOpen(false); };
  return (
    <div className="shell luxe">
      {!booted && (
        <div className="boot" aria-hidden>
          <div className="boot-glow" />
          <div className="brand-mark lg" />
          <div className="boot-name">MYRAA</div>
          <VoiceMini phase="thinking" ampRef={ampRef} />
        </div>
      )}
      <MinimalHeader agentOnline={agentOnline} onAvatar={() => setMenuOpen(true)} />
      <main className={`workspace ${view === 'home' ? 'home-mode' : ''}`} aria-live="polite">
        {view === 'home' && (
          <HomeView
            phase={phase} statusLabel={statusLabel} hasKey={hasKey}
            transcript={transcript} onSend={(t) => { setView('chat'); sendText(t); }}
            micActive={micActive} onToggleMic={toggleMic} micError={micError}
            onConnect={connect} setView={setView} ampRef={ampRef}
          />
        )}
        {view !== 'home' && (
          <div className="sheet-wrap">
            <div className="sheet">
              <button className="icon-btn sheet-close" onClick={() => setView('home')} aria-label="Back to home"><X size={16} /></button>
              {view === 'chat' && (
                <ChatView
                  transcript={transcript} onSend={sendText} micActive={micActive}
                  onToggleMic={toggleMic} micError={micError}
                  onConnect={connect} onDisconnect={disconnect}
                  statusLabel={statusLabel} phase={phase}
                />
              )}
              {view === 'browser' && <BrowserView devMode={devMode} />}
              {view === 'tasks' && <TasksView />}
              {view === 'memory' && (
                <MemoryView memories={memories} refresh={() => api.memories().then(setMemories).catch(() => {})} />
              )}
              {view === 'pc' && <PcView />}
              {view === 'files' && <FilesView />}
              {view === 'settings' && (
                <SettingsView
                  onKeySaved={() => setHasKey(true)} dumpOn={dumpOn} onToggleDump={toggleDump}
                  devMode={devMode} onToggleDev={toggleDev} onPlayTone={playReferenceTone}
                />
              )}
            </div>
          </div>
        )}
      </main>
      <FloatingMenu open={menuOpen} onClose={() => setMenuOpen(false)} onPick={openSheet} agentOnline={agentOnline} />
      <MicroBar agentOnline={agentOnline} micActive={micActive} />
    </div>
  );
}

/* ---------------- chrome (minimal luxury) ---------------- */

function MinimalHeader({ agentOnline, onAvatar }: { agentOnline: boolean; onAvatar: () => void }) {
  return (
    <header className="mini-head">
      <div className="mini-brand">
        <span className="mini-name">MYRAA</span>
        <span className="mini-sub">Personal AI</span>
        <span className={`dot ${agentOnline ? '' : 'off'}`} title={agentOnline ? 'Online' : 'Offline'} />
      </div>
      <button className="avatar-btn" onClick={onAvatar} aria-label="Open menu" title="Menu">
        <User size={16} />
      </button>
    </header>
  );
}

function FloatingMenu({ open, onClose, onPick, agentOnline }: { open: boolean; onClose: () => void; onPick: (v: View) => void; agentOnline: boolean }) {
  if (!open) return null;
  return (
    <div className="menu-scrim" onClick={onClose}>
      <nav className="menu-panel" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-head">
          <span className="mini-name">MYRAA</span>
          <span className={`dot ${agentOnline ? '' : 'off'}`} title={agentOnline ? 'Online' : 'Offline'} />
        </div>
        {MENU.map((sec) => (
          <div key={sec.section} className="menu-sec">
            <div className="menu-sec-title">{sec.section}</div>
            {sec.items.map(({ id, label, Icon }) => (
              <button key={id} className="menu-item" onClick={() => onPick(id)}>
                <Icon size={16} /><span>{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

function MicroBar({ agentOnline, micActive }: { agentOnline: boolean; micActive: boolean }) {
  return (
    <footer className="microbar">
      <span className="micro-item"><span className={`dot ${agentOnline ? '' : 'off'}`} />{agentOnline ? 'Agent Online' : 'Agent Offline'}</span>
      <span className="micro-spacer" />
      <span className="micro-item dim" title={micActive ? 'Microphone live' : 'Voice ready'}>
        {micActive ? <Mic size={12} /> : <Volume2 size={12} />}
      </span>
    </footer>
  );
}

// Tiny voice visual reused by boot splash (same rAF pattern, no audio touch).
function VoiceMini({ phase, ampRef }: { phase: Phase; ampRef: React.MutableRefObject<{ out: number; mic: number }> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const v = phase === 'idle' ? 0.12 + 0.06 * Math.sin(Date.now() / 1400) : Math.min(1, (ampRef.current.out + ampRef.current.mic) * 2.4);
        el.style.setProperty('--amp', v.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, ampRef]);
  return (
    <div ref={ref} className={`mini-orb ${phase}`} aria-hidden>
      <span className="orb-core" /><span className="orb-ring r1" /><span className="orb-bloom" />
    </div>
  );
}

/* ---------------- shared ---------------- */

// PREMIUM COMPACT COMPOSER (spec §1): narrower pill, glass surface, soft glow,
// mic integrated right, and a DYNAMIC STATUS LINE rendered inside the bar.
// The status text animates between messages (fade + slide) — never an abrupt swap.
// When MYRAA speaks, the live response text streams inside the bar (spec §1B/§1C).
function Composer({ onSend, micActive, onToggleMic, compact, statusText, phase }: {
  onSend: (t: string) => void; micActive: boolean; onToggleMic: () => void; compact?: boolean;
  statusText?: string; phase?: Phase;
}) {
  const [draft, setDraft] = useState('');
  const busy = useRef(false); // duplicate-submit lock: one message per gesture
  const send = () => {
    const text = draft.trim();
    if (busy.current || !text) return;
    busy.current = true;
    try { onSend(text); } finally { setDraft(''); }
    window.setTimeout(() => { busy.current = false; }, 400);
  };
  const showStatus = Boolean(compact && statusText && !draft.trim());
  return (
    <div className={`composer ${compact ? 'compact' : ''} ${showStatus ? 'with-status' : ''} ${micActive ? 'mic-live' : ''}`}>
      <Sparkles size={16} className="spark" aria-hidden />
      <div className="composer-input-zone">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={compact && statusText && !draft.trim() ? '' : 'Ask MYRAA anything...'}
          aria-label="Ask MYRAA anything"
        />
        {showStatus && (
          <div key={statusText} className={`composer-status ${phase ?? ''} ${micActive && phase !== 'talking' ? 'listening' : ''}`} aria-live="polite">
            <span className="composer-status-text">{statusText}</span>
          </div>
        )}
      </div>
      <button className={`mic-fab ${micActive ? 'live' : ''}`} onClick={onToggleMic} title={micActive ? 'Stop microphone' : 'Start microphone'} aria-label="Toggle microphone" aria-pressed={micActive}>
        {micActive ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
      {draft.trim() && <button className="send-btn" onClick={send} aria-label="Send message"><Send size={15} /></button>}
    </div>
  );
}

// Circular audio-reactive orb — COMPACT variant (spec §2): much smaller, subtle,
// positioned just above / slightly overlapping the composer. Reads live RMS refs
// via rAF and writes CSS variables directly — zero React re-renders.
function VoiceOrb({ phase, ampRef }: { phase: Phase; ampRef: React.MutableRefObject<{ out: number; mic: number }> }) {
  const orb = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      // Speaking follows model output; listening follows mic; else breathe.
      const target = phase === 'talking'
        ? Math.min(1, ampRef.current.out * 3.2)
        : phase === 'thinking' || phase === 'idle'
          ? 0.12 + 0.06 * Math.sin(Date.now() / 1400)
          : Math.min(1, ampRef.current.mic * 4);
      smooth += (target - smooth) * 0.18;
      const el = orb.current;
      if (el) {
        el.style.setProperty('--amp', smooth.toFixed(3));
        el.dataset.state = phase;
      } else if (phase === 'idle') {
        ampRef.current.out *= 0.9;
        ampRef.current.mic *= 0.9;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, ampRef]);
  return (
    <div ref={orb} className={`orb compact ${phase}`} role="status" aria-label={`MYRAA ${phase}`}>
      <span className="orb-core" />
      <span className="orb-ring r1" />
      <span className="orb-wave" />
      <span className="orb-bloom" />
    </div>
  );
}

function fmtTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

/* ---------------- views ---------------- */

// Shared composer status-text builder (spec §1B/§1C): the input bar is MYRAA's
// status surface everywhere. Idle → nothing (placeholder shows); listening →
// "Listening..."; thinking → task/voice status or "Thinking..."; talking → the
// live streamed model text. Used by Home AND Chat so the behavior never diverges.
function buildStatusText({ phase, statusLabel, micActive, transcript }: {
  phase: Phase; statusLabel: string; micActive: boolean; transcript: Line[];
}): string | undefined {
  if (phase === 'talking') {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === 'model') return transcript[i].text || 'Speaking…';
    }
    return 'Speaking…';
  }
  if (phase === 'thinking') return statusLabel !== 'Ready' ? statusLabel : 'Thinking...';
  if (micActive) return 'Listening...';
  return statusLabel !== 'Ready' ? statusLabel : undefined;
}

function HomeView({ phase, statusLabel, hasKey, transcript, onSend, micActive, onToggleMic, micError, onConnect, setView, ampRef }: {
  phase: Phase; statusLabel: string; hasKey: boolean | null;
  transcript: Line[]; onSend: (t: string) => void;
  micActive: boolean; onToggleMic: () => void; micError: string;
  onConnect: () => void; setView: (v: View) => void;
  ampRef: React.MutableRefObject<{ out: number; mic: number }>;
}) {
  const [presence, setPresence] = useState(0);
  const greet = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  useEffect(() => {
    if (phase !== 'idle' || transcript.length > 0) return;
    const t = window.setInterval(() => setPresence((p) => p + 1), 14000);
    return () => window.clearInterval(t);
  }, [phase, transcript.length]);
  const whispers = ['How can I help you?', "I'm here.", 'Ready when you are.', 'What would you like to do?'];
  const whisper = whispers[presence % whispers.length];
  // Static hero: single optimized WebP (no video decoding, instant start).
  // Voice/state changes animate the orb + glow only — the portrait never reloads.
  // Compact orb sits just above the composer, slightly overlapping it (spec §2).
  // Status text lives INSIDE the composer bar; the separate big status line is gone.
  const composerStatus = buildStatusText({ phase, statusLabel, micActive, transcript });
  return (
    <div className={`home fullscreen ${micActive ? 'voice-mode' : ''}`}>
      <div className="scene" aria-hidden>
        <span className="sc-base" />
        <span className="sc-atmo" />
        <span className="sc-horizon" />
        <span className="sc-floor" />
        <span className="sc-holo" />
        <span className="sc-ring r1" />
        <span className="sc-ring r2" />
        <span className="sc-trail t1" />
        <span className="sc-trail t2" />
        <span className="sc-trail t3" />
        {Array.from({ length: 18 }).map((_, i) => (
          <span key={i} className={`sc-mote m${i % 7}`} style={{ left: `${(i * 37 + 11) % 100}%`, animationDelay: `${(i * 1.7) % 9}s` }} />
        ))}
      </div>
      <img src="/assets/myraa-hero.webp" alt="MYRAA" className="character" draggable={false} />
      <div className="stage-shade" aria-hidden />
      <div className="stage-vignette" aria-hidden />
      <div className="atmo" aria-hidden />
      <div className="stage-ui">
        <p className="eyebrow">● Online</p>
        <div className={`avatar-glow ${phase}`} aria-hidden />
        <h1 className="companion-name">MYRAA</h1>
        <p className="companion-sub">Your AI companion</p>
        {hasKey === false && (
          <button className="btn primary" onClick={() => setView('settings')}>Add your Gemini API key to start talking</button>
        )}
      {hasKey !== false && transcript.length === 0 && phase === 'idle' && (
        <p className="hero-hint">{greet}, Sandeep — {whisper.toLowerCase()} <button className="link" onClick={onConnect}>Connect</button></p>
      )}
        {micError && <p className="error">{micError}</p>}
        <div className="composer-dock">
          <VoiceOrb phase={phase} ampRef={ampRef} />
          <Composer
            onSend={onSend} micActive={micActive} onToggleMic={onToggleMic}
            statusText={composerStatus} phase={phase}
          />
        </div>
      </div>
    </div>
  );
}

function ChatView({ transcript, onSend, micActive, onToggleMic, micError, onConnect, onDisconnect, statusLabel, phase }: {
  transcript: Line[]; onSend: (t: string) => void;
  micActive: boolean; onToggleMic: () => void; micError: string;
  onConnect: () => void; onDisconnect: () => void;
  statusLabel: string; phase: Phase;
}) {
  // Spec §1B: the composer is the status surface in Chat too — same builder as
  // home, so "Thinking…", task progress and streamed reply text live in the pill.
  const composerStatus = buildStatusText({ phase, statusLabel, micActive, transcript });
  return (
    <div className="chat">
      <div className="chat-toolbar">
        <button className="btn" onClick={onConnect}>Connect</button>
        <button className="btn ghost" onClick={onDisconnect}>Disconnect</button>
        {micActive && <span className="pill live"><span className="dot" />Mic live</span>}
      </div>
      {micError && <p className="error">{micError}</p>}
      <div className="messages" role="log" aria-label="Conversation">
        {transcript.length === 0 && <p className="empty">Tap the mic or type — MYRAA connects automatically and replies with voice and text.</p>}
        {transcript.map((l, i) => (
          <div key={i} className={`msg ${l.role === 'user' ? 'user' : l.role === 'error' ? 'error' : 'myraa'}`}>
            {l.role !== 'user' && <div className="msg-head">MYRAA</div>}
            <div className="msg-body">{l.text}</div>
            <div className="msg-time">{fmtTime(l.ts)}</div>
          </div>
        ))}
      </div>
      <Composer onSend={onSend} micActive={micActive} onToggleMic={onToggleMic} compact statusText={composerStatus} phase={phase} />
    </div>
  );
}

function BrowserView({ devMode }: { devMode: boolean }) {
  const [url, setUrl] = useState('https://en.wikipedia.org');
  const [src, setSrc] = useState('/api/web-proxy?url=' + encodeURIComponent('https://en.wikipedia.org'));
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ videoId: string; title: string }[]>([]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'NAVIGATE' && typeof e.data.url === 'string') {
        // YouTube embeds allow framing — load directly, never via proxy.
        const direct = e.data.direct === true || e.data.url.includes('youtube.com/embed');
        setUrl(e.data.url);
        setLoading(true);
        setBlocked(false);
        setSrc(direct ? e.data.url : '/api/web-proxy?url=' + encodeURIComponent(e.data.url));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const go = (u: string) => {
    const direct = u.includes('youtube.com/embed');
    setUrl(u);
    setLoading(true);
    setBlocked(false);
    setSrc(direct ? u : '/api/web-proxy?url=' + encodeURIComponent(u));
    window.setTimeout(() => setLoading((v) => v ? (setBlocked(true), false) : v), 8000);
  };
  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn" onClick={() => go(url)} title="Reload" aria-label="Reload"><RotateCw size={15} /></button>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(url); }} placeholder="Search or enter URL" aria-label="Address" />
        <button className="btn" onClick={() => go(url)}>Go</button>
        <button className="icon-btn" onClick={() => window.open(url, '_blank')} title="Open in new tab" aria-label="Open in new tab"><ExternalLink size={15} /></button>
      </div>
      <div className="browser-cols">
        <div className="browser-side">
          <h4>YouTube search</h4>
          <div className="inline-form">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search YouTube…" aria-label="Search YouTube" />
            <button className="btn" onClick={() => api.youtube(q).then((r) => setResults(r.results as never[])).catch(() => {})}>Search</button>
          </div>
          <ul className="search-results">
            {results.map((r) => (
              <li key={r.videoId}>
                <button className="icon-btn" onClick={() => window.postMessage({ type: 'NAVIGATE', url: `https://www.youtube.com/embed/${r.videoId}?autoplay=1`, direct: true }, '*')} aria-label={`Play ${r.title}`}>▶</button>
                <span>{r.title}</span>
              </li>
            ))}
          </ul>
          {devMode && (
            <div className="dev-box">
              <h5>Diagnostics</h5>
              <div className="btn-row">
                <button className="btn ghost" onClick={() => go('https://example.com')}>example.com</button>
                <button className="btn ghost" onClick={() => go('https://en.wikipedia.org')}>wikipedia</button>
                <button className="btn ghost" onClick={() => go('https://www.youtube.com')}>youtube</button>
              </div>
            </div>
          )}
        </div>
        <div className="viewport-wrap">
          {loading && <p className="dim">Loading…</p>}
          {blocked && <p className="warn">Still blank? This site blocks proxy iframes — use “Open in new tab”.</p>}
          <iframe
            title="myraa-browser" src={src} className="viewport"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock allow-presentation allow-downloads"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            onLoad={() => { setLoading(false); setBlocked(false); }}
          />
        </div>
      </div>
    </div>
  );
}

function stateColor(s: string) {
  return s === 'SUCCESS' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'CANCELLED' ? 'muted' : 'warn';
}

function TasksView() {
  const [tool, setTool] = useState('systemInfo');
  const [argsJson, setArgsJson] = useState('{}');
  const [msg, setMsg] = useState('');
  const [list, setList] = useState<{ id: string; state: string }[]>([]);
  const [detail, setDetail] = useState<import('./api').TaskDetail | null>(null);
  const running = useRef(false); // one task launch per click — no duplicate execution
  const refresh = () => api.tasks().then(setList).catch(() => {});
  useEffect(refresh, []);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setMsg('');
    try {
      const args = JSON.parse(argsJson || '{}');
      const t = await api.createTask([{ tool, args }]);
      setMsg(`Started ${t.id}`);
      refresh();
      const poll = window.setInterval(async () => {
        try {
          const d = await api.task(t.id);
          setDetail(d);
          if (!['PENDING', 'RUNNING', 'WAITING_CONFIRMATION'].includes(d.state)) {
            window.clearInterval(poll);
            refresh();
          }
        } catch { window.clearInterval(poll); }
      }, 1000);
    } catch (e) { setMsg(`Error: ${(e as Error).message}`); }
    finally { running.current = false; }
  };
  return (
    <div className="page">
      <div className="page-head"><h2>Tasks</h2><p className="dim">Verified execution with live status.</p></div>
      <div className="card">
        <div className="inline-form">
          <select value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Tool">
            {['systemInfo', 'cpu_info', 'ram_info', 'disk_info', 'battery_status', 'host_info', 'openApplication', 'launch_application', 'find_windows_app', 'list_running_applications', 'createFile', 'readFile', 'write_file_verified', 'create_directory', 'list_directory', 'screenshot', 'screen_size', 'list_processes', 'list_windows', 'read_clipboard', 'write_clipboard', 'get_volume', 'run_command', 'open_url', 'open_file', 'ping', 'dns_lookup', 'audio_devices'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={argsJson} onChange={(e) => setArgsJson(e.target.value)} placeholder='args JSON, e.g. {"name":"notepad.exe"}' aria-label="Tool arguments as JSON" />
          <button className="btn primary" onClick={run}><Play size={14} /> Run</button>
          <button className="btn danger" onClick={() => api.stopAll().then(() => { setMsg('STOP sent — all tasks cancelled.'); refresh(); })}><Square size={14} /> STOP</button>
        </div>
        {msg && <p className="dim">{msg}</p>}
      </div>
      {detail && (
        <div className="card timeline">
          <div className="timeline-head">
            <strong className={stateColor(detail.state)}>{detail.id}: {detail.state}</strong>
            {(detail.state === 'RUNNING' || detail.state === 'PENDING' || detail.state === 'WAITING_CONFIRMATION') && (
              <button className="btn ghost" onClick={() => api.cancelTask(detail.id).then(refresh)}>Cancel</button>
            )}
          </div>
          {detail.error && <p className="error">{detail.error}</p>}
          <ul className="steps">
            {detail.results.map((r, i) => (
              <li key={i} className={r.ok ? 'ok' : 'bad'}>
                {r.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                <span>{r.tool}{r.verified ? ' (verified)' : ''}{r.error ? `: ${r.error}` : ''}</span>
              </li>
            ))}
            {(detail.state === 'RUNNING' || detail.state === 'PENDING') && (
              <li className="running"><Loader2 size={15} className="spin" /><span>Working…</span></li>
            )}
          </ul>
        </div>
      )}
      <div className="card">
        <h4>Recent tasks</h4>
        <ul className="task-list">
          {list.map((t) => (
            <li key={t.id}>
              <button className="link" onClick={() => api.task(t.id).then(setDetail).catch(() => {})}>{t.id}</button>
              <span className={stateColor(t.state)}>{t.state}</span>
            </li>
          ))}
          {list.length === 0 && <li className="dim">No tasks yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function MemoryView({ memories, refresh }: { memories: Memory[]; refresh: () => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('preference');
  const [text, setText] = useState('');
  const cats = ['identity', 'preference', 'goal', 'project', 'relationship', 'emotional', 'behavior'];
  const shown = memories.filter((m) =>
    (filter === 'all' || m.category === filter) &&
    (!q || (m.text + m.category).toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="page">
      <div className="page-head">
        <h2>Memory</h2>
        <p className="dim">{memories.length} memories <span className="pill ok"><span className="dot" />Sync active</span></p>
      </div>
      <div className="inline-form">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory…" aria-label="Search memory" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by category">
          <option value="all">All</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="mem-grid">
        {shown.slice(0, 60).map((m) => (
          <div key={m.id} className="mem-card">
            <div className="mem-cat"><Brain size={13} /> {m.category}</div>
            <div className="mem-text">{m.text}</div>
            <div className="mem-foot">
              <span className="dim">{new Date(m.updatedAt).toLocaleDateString()}</span>
              <button className="icon-btn danger" onClick={() => api.forgetMemory(m.id).then(refresh)} title="Delete memory" aria-label="Delete memory"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {shown.length === 0 && <p className="empty">No memories match.</p>}
      <div className="card">
        <h4>Commit a memory</h4>
        <div className="inline-form">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Commit memory…" aria-label="Memory text" />
          <button className="btn primary" onClick={() => api.addMemory(category, text).then(() => { setText(''); refresh(); })}><Plus size={14} /> Commit</button>
        </div>
      </div>
    </div>
  );
}

function PcView() {
  const [stats, setStats] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const runTool = async (tool: string, args: Record<string, unknown> = {}) => {
    setBusy(true);
    setOut('');
    try {
      const t = await api.createTask([{ tool, args }]);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const d = await api.task(t.id);
        if (!['PENDING', 'RUNNING', 'WAITING_CONFIRMATION'].includes(d.state)) {
          const r0 = d.results[0];
          setOut(r0?.ok ? JSON.stringify(r0.result, null, 2).slice(0, 800) : `Error: ${r0?.error}`);
          if (tool === 'cpu_info' || tool === 'ram_info' || tool === 'disk_info' || tool === 'network_status') {
            setStats((s) => ({ ...s, [tool]: JSON.stringify(r0?.result).slice(0, 160) }));
          }
          break;
        }
      }
    } catch (e) { setOut(`Error: ${(e as Error).message}`); }
    setBusy(false);
  };
  useEffect(() => {
    runTool('cpu_info');
    runTool('ram_info');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [appName, setAppName] = useState('');
  const [clip, setClip] = useState('');
  const cards = [
    { label: 'CPU', value: stats.cpu_info ?? '…', Icon: Activity },
    { label: 'RAM', value: stats.ram_info ?? '…', Icon: Activity },
    { label: 'Disk', value: stats.disk_info ?? '…', Icon: Activity },
    { label: 'Network', value: stats.network_status ?? '…', Icon: Activity },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h2>PC Control</h2>
        <button className="btn ghost" onClick={() => { runTool('cpu_info'); runTool('ram_info'); runTool('disk_info'); runTool('network_status'); }}><RotateCw size={14} /> Refresh</button>
      </div>
      <div className="stat-grid">
        {cards.map(({ label, value, Icon }) => (
          <div key={label} className="stat-card">
            <div className="stat-label"><Icon size={15} /> {label}</div>
            <div className="stat-value">{value}</div>
          </div>
        ))}
      </div>
      <h4>Quick actions</h4>
      <div className="action-grid">
        <div className="card inline-form">
          <input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="App name, e.g. Notepad" aria-label="Application name" />
          <button className="btn primary" onClick={() => runTool('launch_application', { name: appName || 'notepad.exe' })} disabled={busy}><Play size={14} /> Open</button>
        </div>
        <div className="card btn-row">
          <button className="btn" onClick={() => runTool('screenshot')} disabled={busy}><Camera size={14} /> Screenshot</button>
          <button className="btn" onClick={() => runTool('read_clipboard')} disabled={busy}><ClipboardList size={14} /> Clipboard</button>
          <button className="btn" onClick={() => runTool('get_volume')} disabled={busy}><Volume2 size={14} /> Volume</button>
          <button className="btn" onClick={() => runTool('search_windows_app', { query: appName || 'settings' })} disabled={busy}><Search size={14} /> Find app</button>
          <button className="btn" onClick={() => runTool('list_processes', { limit: 10 })} disabled={busy}><Activity size={14} /> Processes</button>
        </div>
        <div className="card inline-form">
          <input value={clip} onChange={(e) => setClip(e.target.value)} placeholder="Write to clipboard…" aria-label="Clipboard text" />
          <button className="btn" onClick={() => runTool('write_clipboard', { text: clip })} disabled={busy}>Copy</button>
        </div>
      </div>
      {busy && <p className="dim"><Loader2 size={14} className="spin" /> Working…</p>}
      {out && <pre className="output">{out}</pre>}
    </div>
  );
}

function FilesView() {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const runTask = async (tool: string, args: Record<string, unknown>) => {
    const t = await api.createTask([{ tool, args }]);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const d = await api.task(t.id);
      if (!['PENDING', 'RUNNING', 'WAITING_CONFIRMATION'].includes(d.state)) return d;
    }
    throw new Error('Timed out');
  };
  const browse = async (target?: string) => {
    setMsg('');
    try {
      const d = await runTask('list_directory', target ? { path: target } : { name: 'desktop' });
      const r = d.results[0];
      if (!r.ok) { setMsg(`Error: ${r.error}`); return; }
      const list = (r.result as { data?: { entries?: string[] } })?.data?.entries ?? [];
      setEntries(list);
      if (target) setDir(target);
    } catch (e) { setMsg(`Error: ${(e as Error).message}`); }
  };
  useEffect(() => { browse().catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <div className="page">
      <div className="page-head"><h2>Files</h2><p className="dim">{dir || 'Desktop'}</p></div>
      <div className="inline-form">
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Folder path (empty = Desktop)" aria-label="Folder path" />
        <button className="btn primary" onClick={() => browse(dir || undefined)}>Browse</button>
        <button className="btn ghost" onClick={() => browse()}>Desktop</button>
      </div>
      {msg && <p className="error">{msg}</p>}
      <div className="card file-list">
        {entries.slice(0, 100).map((e) => <div key={e} className="file-row"><FolderOpen size={14} /> {e}</div>)}
        {entries.length === 0 && <p className="dim">Empty folder.</p>}
      </div>
      <div className="card">
        <h4><FilePlus2 size={14} /> New file here</h4>
        <div className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name.txt" aria-label="File name" />
          <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="content" aria-label="File content" />
          <button
            className="btn primary"
            onClick={() => {
              const base = dir || 'Desktop';
              const full = base === 'Desktop' ? undefined : `${base}\\${name}`;
              runTask('write_file_verified', full ? { path: full, content, overwrite: true } : { path: name, content, overwrite: true })
                .then(() => { setMsg(`Saved ${name}`); browse(dir || undefined); })
                .catch((e) => setMsg(`Error: ${(e as Error).message}`));
            }}
          ><Plus size={14} /> Save</button>
        </div>
      </div>
      <div className="card">
        <h4><FolderPlus size={14} /> New folder</h4>
        <div className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="folder name" aria-label="Folder name" />
          <button
            className="btn"
            onClick={() => {
              const base = dir || undefined;
              runTask('create_directory', { path: base ? `${base}\\${name}` : name })
                .then(() => browse(dir || undefined))
                .catch((e) => setMsg(`Error: ${(e as Error).message}`));
            }}
          >Create</button>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ onKeySaved, dumpOn, onToggleDump, devMode, onToggleDev, onPlayTone }: {
  onKeySaved: () => void; dumpOn: boolean; onToggleDump: () => void;
  devMode: boolean; onToggleDev: () => void; onPlayTone: (sinkId: string | null) => Promise<string>;
}) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [autoVoice, setAutoVoice] = useState({ connect: false, mic: false, greet: false, handsFree: false });
  const saveVoice = (patch: Partial<typeof autoVoice>) => {
    const next = { ...autoVoice, ...patch };
    setAutoVoice(next);
    api.saveSettings({ autoConnect: next.connect, autoMic: next.mic, autoGreet: next.greet, handsFree: next.handsFree }).catch(() => {});
  };
  const [sinks, setSinks] = useState<{ deviceId: string; label: string }[]>([]);
  const [sinkId, setSinkId] = useState('');
  const [toneReport, setToneReport] = useState('');
  const [doctor, setDoctor] = useState<{ ok: boolean; checks: { name: string; status: string; detail: string }[] } | null>(null);
  useEffect(() => {
    api.settings().then((s) => {
      setAutoStart(Boolean(s.autoStart));
      setAutoVoice({ connect: s.autoConnect === true, mic: s.autoMic === true, greet: s.autoGreet === true, handsFree: s.handsFree === true });
    }).catch(() => {});
    navigator.mediaDevices?.enumerateDevices?.()
      .then((ds) => setSinks(ds.filter((d) => d.kind === 'audiooutput').map((d) => ({ deviceId: d.deviceId, label: d.label || `output ${d.deviceId.slice(0, 8)}` }))))
      .catch(() => {});
  }, []);
  const section = (title: string, body: React.ReactNode) => (
    <section className="card"><h4>{title}</h4>{body}</section>
  );
  return (
    <div className="page">
      <div className="page-head"><h2>Settings</h2></div>
      {section('General', (
        <label className="check"><input type="checkbox" checked={autoStart} onChange={(e) => { setAutoStart(e.target.checked); api.saveSettings({ autoStart: e.target.checked }).catch(() => {}); }} /> Start MYRAA when Windows logs in</label>
      ))}
      {section('AI', (
        <div>
          <p className="dim">Gemini API key (stored locally, never uploaded except to Google for validation)</p>
          <div className="inline-form">
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste Gemini API key" type="password" aria-label="Gemini API key" />
            <button className="btn primary" onClick={() => api.saveApiKey(key).then(() => { setMsg('Saved'); onKeySaved(); }).catch((e) => setMsg(e.message))}>Save</button>
          </div>
          {msg && <p className="dim">{msg}</p>}
        </div>
      ))}
      {section('Voice', (
        <div className="diag-stack">
          <p className="dim small">Default is manual (push to talk): microphone is OFF at launch and no voice session starts until you press Connect. Enable hands-free to opt into automatic voice on launch.</p>
          <label className="check"><input type="checkbox" checked={autoVoice.handsFree} onChange={(e) => saveVoice({ handsFree: e.target.checked })} /> Hands-free mode (automatic voice on launch)</label>
          <label className="check"><input type="checkbox" checked={autoVoice.connect} disabled={!autoVoice.handsFree} onChange={(e) => saveVoice({ connect: e.target.checked })} /> Auto-connect on launch (hands-free only)</label>
          <label className="check"><input type="checkbox" checked={autoVoice.mic} disabled={!autoVoice.handsFree} onChange={(e) => saveVoice({ mic: e.target.checked })} /> Microphone on at launch (hands-free only)</label>
          <label className="check"><input type="checkbox" checked={autoVoice.greet} disabled={!autoVoice.handsFree} onChange={(e) => saveVoice({ greet: e.target.checked })} /> Spoken greeting on launch (hands-free only)</label>
          <p className="dim small">Microphone: echo cancellation, noise suppression and auto gain are always on. Speaker: 24 kHz PCM voice output.</p>
          <p className="dim small">Note: browsers may keep audio suspended until your first click — one click anywhere unlocks it.</p>
        </div>
      ))}
      {section('Appearance', (
        <p className="dim">Dark premium theme with violet accent. Follows your OS reduced-motion setting automatically.</p>
      ))}
      {section('Diagnostics', (
        <div className="diag-stack">
          <label className="check"><input type="checkbox" checked={dumpOn} onChange={onToggleDump} /> Voice dump (save raw + playback PCM per response)</label>
          <label className="check"><input type="checkbox" checked={devMode} onChange={onToggleDev} /> Developer mode (browser test links)</label>
          <div className="inline-form">
            <select value={sinkId} onChange={(e) => setSinkId(e.target.value)} aria-label="Output device for test tone">
              <option value="">Default output</option>
              {sinks.map((s) => <option key={s.deviceId} value={s.deviceId}>{s.label}</option>)}
            </select>
            <button className="btn" onClick={() => { setToneReport('playing…'); onPlayTone(sinkId || null).then(setToneReport).catch((e) => setToneReport(`error: ${(e as Error)?.message}`)); }}>Play test tone</button>
          </div>
          {toneReport && <p className="dim small">{toneReport}</p>}
          <div className="btn-row">
            <button className="btn" onClick={() => api.doctor().then(setDoctor).catch(() => {})}><Activity size={14} /> Run doctor</button>
          </div>
          {doctor && (
            <ul className="steps">
              {doctor.checks.map((c) => (
                <li key={c.name} className={c.status === 'PASS' ? 'ok' : c.status === 'FAIL' ? 'bad' : ''}>
                  {c.status === 'PASS' ? <CheckCircle2 size={14} /> : c.status === 'FAIL' ? <XCircle size={14} /> : <Loader2 size={14} />}
                  <span>{c.name}: {c.status} — {c.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// Re-exported names kept for test compatibility (no-ops here).
export function ChatPanel() { return null; }
export function BrowserFrame() { return null; }
export function ArrowRightIcon() { return <ArrowRight size={14} />; }
export function CloseIcon() { return <X size={14} />; }
export function BackIcon() { return <ArrowLeft size={14} />; }
