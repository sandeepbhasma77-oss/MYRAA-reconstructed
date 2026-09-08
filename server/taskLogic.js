// MYRAA task logic — pure, framework-free (node --test can verify it).
// Friendly status messages, parallel planner, action deduplication.
// No imports: safe to load from tests and from TS server modules.
// ESM exports + guarded CJS interop (same convention as src/voicePipe.js).

// ---- friendly message helpers (spec §19: natural conversational status) ----
const TOOL_PHRASES = {
  openApplication: (a) => `Opening ${label(a.name)}…`,
  launch_application: (a) => `Opening ${label(a.name)}…`,
  findApplication: (a) => `Looking up ${label(a.name)}…`,
  focusApplication: (a) => `Bringing ${label(a.name)} to the front…`,
  openWebsite: (a) => `Opening ${label(a.url || a.name)}…`,
  open_url: (a) => `Opening ${label(a.url)}…`,
  searchWeb: (a) => `Searching for ${label(a.query)}…`,
  searchGoogle: (a) => `Searching Google for ${label(a.query)}…`,
  searchYouTube: (a) => `Searching YouTube for ${label(a.query)}…`,
  createFile: (a) => `Creating ${label(a.path)}…`,
  write_file: (a) => `Writing ${label(a.path)}…`,
  write_file_verified: () => 'Creating your file…',
  create_directory: () => 'Creating the folder…',
  screenshot: () => 'Taking a screenshot…',
  saveScreenshot: (a) => `Saving the screenshot${a && a.name ? ` ${label(a.name)}` : ''}…`,
  systemInfo: () => 'Checking your system…',
  cpu_info: () => 'Checking the CPU…',
  ram_info: () => 'Checking memory…',
  disk_info: () => 'Checking storage…',
  list_directory: () => 'Looking through that folder…',
  run_command: () => "I'm working on it…",
  set_volume: (a) => `Setting volume to ${label(a && a.percent)}…`,
  volume_up: () => 'Turning the volume up…',
  volume_down: () => 'Turning the volume down…',
  mute: () => 'Muting…',
  unmute: () => 'Unmuting…',
};

function label(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 'that';
  const exe = s.replace(/\.exe$/i, '');
  return exe.charAt(0).toUpperCase() + exe.slice(1);
}

function friendlyStartMessage(tool, args) {
  const fn = TOOL_PHRASES[tool];
  if (fn) return fn(args || {});
  return "Got it. I'm starting that now.";
}

function friendlyDoneMessage() {
  return 'Done.';
}

function friendlyFailMessage(tool, err) {
  const clean = String(err || '').replace(/\s+/g, ' ').slice(0, 120);
  return clean ? `I couldn't complete that. ${clean}` : "I couldn't complete that task.";
}

// ---- action deduplication (spec §10) ----
// A duplicate (tool, args) within DEDUP_WINDOW_MS is rejected safely instead of
// executing twice (double Chrome windows from retried turns / double clicks).
const DEDUP_WINDOW_MS = 8000;
const inFlight = new Set();
const recentExec = new Map();

function fingerprint(tool, args) {
  const a = args || {};
  const sorted = Object.keys(a).sort();
  const parts = sorted.map((k) => `${k}:${JSON.stringify(a[k])}`);
  return `${tool}:${parts.join(',')}`;
}

function checkDuplicateAction(tool, args) {
  const fp = fingerprint(tool, args);
  if (inFlight.has(fp)) return { dup: true, why: 'already running' };
  const last = recentExec.get(fp);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return { dup: true, why: 'just executed' };
  return { dup: false };
}

function markActionStarted(tool, args) {
  inFlight.add(fingerprint(tool, args));
}

function markActionFinished(tool, args) {
  const fp = fingerprint(tool, args);
  inFlight.delete(fp);
  recentExec.set(fp, Date.now());
  if (recentExec.size > 200) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, t] of recentExec) if (t < cutoff) recentExec.delete(k);
  }
}

// ---- parallel planner (spec §9) ----
// Independent steps run concurrently (bounded); dependent steps stay sequential.
// Heuristic: steps targeting the SAME tool must stay ordered (same-resource
// assumption); distinct tools with no explicit `dependsOn` run in parallel.
// Explicit `dependsOn: [stepIndex]` always wins. Cycle-safe fallback.
function planParallelWaves(steps) {
  const n = steps.length;
  const dependsOn = steps.map((s, i) => {
    const d = s && s.dependsOn;
    return Array.isArray(d) ? d.filter((j) => j >= 0 && j < i) : [];
  });
  const lastSameTool = new Map();
  steps.forEach((s, i) => {
    if (!s) return;
    if (lastSameTool.has(s.tool)) dependsOn[i].push(lastSameTool.get(s.tool));
    lastSameTool.set(s.tool, i);
  });
  const waves = [];
  const done = new Set();
  const ready = (i) => dependsOn[i].every((j) => done.has(j));
  let guard = 0;
  while (done.size < n && guard++ < n * 2) {
    const wave = [];
    for (let i = 0; i < n; i++) {
      if (!done.has(i) && ready(i)) wave.push(i);
    }
    if (wave.length === 0) {
      // Dependency cycle guard: run everything remaining sequentially.
      for (let i = 0; i < n; i++) if (!done.has(i)) { waves.push({ indices: [i] }); done.add(i); }
      break;
    }
    waves.push({ indices: wave });
    for (const i of wave) done.add(i);
  }
  return waves;
}

export {
  friendlyStartMessage,
  friendlyDoneMessage,
  friendlyFailMessage,
  checkDuplicateAction,
  markActionStarted,
  markActionFinished,
  planParallelWaves,
  DEDUP_WINDOW_MS,
};

// CommonJS interop for node --test (guarded: absent in ESM scope).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    friendlyStartMessage,
    friendlyDoneMessage,
    friendlyFailMessage,
    checkDuplicateAction,
    markActionStarted,
    markActionFinished,
    planParallelWaves,
    DEDUP_WINDOW_MS,
  };
}