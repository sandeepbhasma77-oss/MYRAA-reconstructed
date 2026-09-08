// MYRAA execution engine: planned multi-step tasks with permission gating,
// verification, structured states, emergency stop, and per-task logging.
// Every task gets MYRAA-TASK-000001 style ID. Secrets are never logged.
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { callDesktopAgent, DESKTOP_AGENT_URL } from './agent.js';
import { DATA_DIR, dataFile } from './paths.js';
import { emitTaskEvent } from './taskEvents.js';
import {
  friendlyStartMessage, friendlyFailMessage,
  checkDuplicateAction, markActionStarted, markActionFinished, planParallelWaves,
} from './taskLogic.js';

// Pure logic (planner/dedup/messages) lives in taskLogic.js — node --test
// verifies it there. Re-exported here for server-bundle consumers.
export { checkDuplicateAction, markActionStarted, markActionFinished, planParallelWaves };
const PARALLEL_WAVE_CAP = 3;

export type TaskState =
  | 'PENDING' | 'RUNNING' | 'WAITING_CONFIRMATION' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface TaskStep {
  tool: string;
  args: Record<string, unknown>;
  verify?: { tool: string; args: Record<string, unknown> };
}

export interface StepResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  verified?: boolean;
  timings?: StepTimings;
}

export interface StepTimings {
  routingMs: number;   // permission check + dedup + event emit before exec
  toolMs: number;      // agent execution (incl. agent-side verify)
  verifyMs: number;    // server-side second verify round trip (0 when skipped)
  totalMs: number;
}

export interface TaskTimings {
  queueMs: number;     // POST received -> runTask start (event-loop delay)
  planMs: number;      // parallel-wave planning
  stepsMs: number;     // all waves wall time
  totalMs: number;     // runTask start -> terminal state
}

export interface Task {
  id: string;
  state: TaskState;
  steps: TaskStep[];
  results: StepResult[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  timings?: TaskTimings;
}

const tasks = new Map<string, Task>();
let stopAll = false;
let counter = 0;

const SECRET_KEYS = new Set(['apiKey', 'apikey', 'api_key', 'token', 'confirm_token', 'execute_token', 'password']);
function redact(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.has(k)) out[k] = '[redacted]';
  }
  return out;
}

function taskLog(id: string, msg: string): void {
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'logs', 'tasks.log'), `[${new Date().toISOString()}] [${id}] ${msg}\n`);
  } catch { /* never crash on logging */ }
}

function nextId(): string {
  counter += 1;
  try {
    fs.writeFileSync(dataFile('task-counter.txt'), String(counter), 'utf-8');
  } catch { /* best-effort */ }
  return `MYRAA-TASK-${String(counter).padStart(6, '0')}`;
}
try {
  const raw = fs.readFileSync(dataFile('task-counter.txt'), 'utf-8');
  counter = parseInt(raw, 10) || 0;
} catch { counter = 0; }

// Permission cache from agent /caps (level 0..3). Unknown tools default to 2.
let permCache: Record<string, number> | null = null;
let permAt = 0;
async function permissionOf(tool: string): Promise<number> {
  if (!permCache || Date.now() - permAt > 60_000) {
    try {
      const r = await fetch(`${DESKTOP_AGENT_URL}/caps`);
      if (r.ok) {
        const caps = (await r.json()) as { permissions?: Record<string, number> };
        permCache = caps.permissions ?? {};
        permAt = Date.now();
      }
    } catch { /* fall through */ }
  }
  return permCache?.[tool] ?? 2;
}

// Single verified tool execution shared by /api/tasks and the /live AI path.
export async function executeVerifiedTool(
  taskId: string, tool: string, args: Record<string, unknown>,
  verify?: { tool: string; args: Record<string, unknown> },
): Promise<StepResult> {
  taskLog(taskId, `EXEC ${tool} args=${JSON.stringify(redact(args))}`);
  const t0 = performance.now();
  const r = await callDesktopAgent(tool, args);
  const toolMs = performance.now() - t0;
  if (!r.ok) {
    const needsConfirm = /confirm_token=|confirmation|Confirm .* token/i.test(String(r.error || ''));
    taskLog(taskId, `FAIL ${tool}: ${String(r.error || '').slice(0, 300)}`);
    return { tool, ok: false, error: r.error, timings: { routingMs: 0, toolMs, verifyMs: 0, totalMs: toolMs } };
  }
  let verified = false;
  let verifyMs = 0;
  if (verify) {
    // Skip the redundant second round trip when the agent already verified
    // (e.g. launch_application polls the process itself and reports
    // verificationResult=verified-running). Saves one full HTTP call.
    const agentData = (r.result ?? {}) as { data?: { verificationResult?: unknown; verified?: unknown } };
    const alreadyVerified = agentData?.data?.verificationResult === 'verified-running'
      || agentData?.data?.verified === true;
    if (alreadyVerified) {
      verified = true;
      taskLog(taskId, `VERIFY ${verify.tool}: SKIPPED (agent already verified)`);
    } else {
      const vt0 = performance.now();
      const v = await callDesktopAgent(verify.tool, verify.args);
      verifyMs = performance.now() - vt0;
      verified = v.ok;
      taskLog(taskId, `VERIFY ${verify.tool}: ${verified ? 'OK' : 'FAILED ' + String(v.error || '').slice(0, 200)}`);
    }
  }
  const totalMs = performance.now() - t0;
  taskLog(taskId, `DONE ${tool} verified=${verified} toolMs=${Math.round(toolMs)} verifyMs=${Math.round(verifyMs)}`);
  return { tool, ok: true, result: r.result, ...(verify ? { verified } : {}), timings: { routingMs: 0, toolMs, verifyMs, totalMs } };
}

const queueAt = new Map<string, number>(); // POST arrival -> runTask start (event-loop delay)

async function runTask(t: Task): Promise<void> {
  const runStart = performance.now();
  const queueMs = queueAt.has(t.id) ? runStart - (queueAt.get(t.id) as number) : 0;
  queueAt.delete(t.id);
  t.state = 'RUNNING';
  t.updatedAt = new Date().toISOString();
  taskLog(t.id, `START ${t.steps.length} steps`);
  emitTaskEvent({ task_id: t.id, status: 'STARTED', message: "Got it. I'm starting that now.", tool: t.steps[0]?.tool });
  // Parallel planner: waves of independent steps; failures stop the task.
  const planT0 = performance.now();
  const waves = planParallelWaves(t.steps);
  const planMs = performance.now() - planT0;
  const stepsT0 = performance.now();
  const finishTimings = (extra: Partial<TaskTimings> = {}) => {
    t.timings = {
      queueMs, planMs,
      stepsMs: performance.now() - stepsT0,
      totalMs: performance.now() - runStart, ...extra,
    };
  };
  for (const wave of waves) {
    if (stopAll || t.state === 'CANCELLED') break;
    const bounded = wave.indices.slice(0, PARALLEL_WAVE_CAP);
    const ran = await Promise.all(bounded.map(async (idx) => {
      const step = t.steps[idx];
      // args may be omitted by callers — default before touching `.confirmed`.
      const args = (step.args ?? {}) as Record<string, unknown>;
      const routeT0 = performance.now();
      const level = await permissionOf(step.tool);
      if (level >= 3 && !args.confirmed) {
        return { step, idx, r: null as StepResult | null, waiting: `Tool ${step.tool} is LEVEL 3 (critical). Re-submit with args.confirmed=true.` };
      }
      const dup = checkDuplicateAction(step.tool, args);
      if (dup.dup) {
        taskLog(t.id, `DEDUP ${step.tool}: ${dup.why}`);
        emitTaskEvent({ task_id: t.id, status: 'PROGRESS', message: `That's already ${dup.why} — skipping the repeat.`, tool: step.tool });
        return { step, idx, r: { tool: step.tool, ok: true, result: { result: `Already ${dup.why}.` } } as StepResult, waiting: null };
      }
      emitTaskEvent({ task_id: t.id, status: 'RUNNING', message: friendlyStartMessage(step.tool, args), tool: step.tool });
      markActionStarted(step.tool, args);
      try {
        const r = await executeVerifiedTool(t.id, step.tool, args, step.verify);
        if (r.timings) r.timings.routingMs = performance.now() - routeT0 - (r.timings.totalMs || 0);
        return { step, idx, r, waiting: null };
      } finally {
        markActionFinished(step.tool, args);
      }
    }));
    for (const item of ran) {
      if (item.waiting) {
        t.state = 'WAITING_CONFIRMATION';
        t.error = item.waiting;
        taskLog(t.id, `WAITING_CONFIRMATION ${item.step.tool}`);
        emitTaskEvent({ task_id: t.id, status: 'FAILED', message: 'I need your confirmation for that one.', tool: item.step.tool });
        finishTimings();
        return;
      }
      const r = item.r as StepResult;
      t.results[item.idx] = r;
      t.updatedAt = new Date().toISOString();
      if (!r.ok) {
        if (/confirm_token=|Confirm .* token/i.test(String(r.error || ''))) {
          t.state = 'WAITING_CONFIRMATION';
          t.error = String(r.error);
          taskLog(t.id, 'WAITING_CONFIRMATION (agent token gate)');
          emitTaskEvent({ task_id: t.id, status: 'FAILED', message: 'I need your confirmation for that one.', tool: item.step.tool });
        } else {
          t.state = 'FAILED';
          t.error = String(r.error);
          emitTaskEvent({ task_id: t.id, status: 'FAILED', message: friendlyFailMessage(item.step.tool, r.error), tool: item.step.tool });
        }
        finishTimings();
        return;
      }
      emitTaskEvent({ task_id: t.id, status: 'PROGRESS', message: `Finished ${item.step.tool}.`, tool: item.step.tool });
    }
  }
  if (stopAll || t.state === 'CANCELLED') {
    t.state = 'CANCELLED';
    taskLog(t.id, 'CANCELLED');
    emitTaskEvent({ task_id: t.id, status: 'CANCELLED', message: 'Stopped that for you.' });
    finishTimings();
    return;
  }
  t.state = 'SUCCESS';
  t.updatedAt = new Date().toISOString();
  taskLog(t.id, 'SUCCESS');
  emitTaskEvent({ task_id: t.id, status: 'COMPLETED', message: 'Done.' });
  finishTimings();
}

export function registerTaskRoutes(app: Express): void {
  app.post('/api/tasks', (req, res) => {
    try {
      const steps = (req.body?.steps ?? []) as TaskStep[];
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 25) {
        return res.status(400).json({ error: 'steps must be a non-empty array (max 25).' });
      }
      for (const s of steps) {
        if (!s || typeof s.tool !== 'string') return res.status(400).json({ error: 'Each step needs {tool, args}.' });
      }
      const t: Task = {
        id: nextId(), state: 'PENDING', steps,
        results: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      tasks.set(t.id, t);
      queueAt.set(t.id, performance.now());
      emitTaskEvent({ task_id: t.id, status: 'QUEUED', message: 'Queued.' });
      // Bound the registry: evict oldest beyond 200 so long-running servers don't leak.
      while (tasks.size > 200) {
        const oldest = tasks.keys().next().value;
        if (oldest === undefined) break;
        tasks.delete(oldest);
      }
      taskLog(t.id, `CREATED ${steps.map((s) => s.tool).join(',')}`);
      runTask(t).catch((e) => {
        t.state = 'FAILED';
        t.error = `Engine error: ${(e as Error)?.message || e}`;
        t.updatedAt = new Date().toISOString();
        taskLog(t.id, `ENGINE_FAIL ${t.error}`);
      });
      res.status(201).json({ id: t.id, state: t.state });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/tasks/:id', (req, res) => {
    const t = tasks.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Unknown task.' });
    res.json(t);
  });

  app.get('/api/tasks', (_req, res) => {
    res.json([...tasks.values()].slice(-50).map((t) => ({ id: t.id, state: t.state, updatedAt: t.updatedAt })));
  });

  app.post('/api/tasks/:id/cancel', (req, res) => {
    const t = tasks.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Unknown task.' });
    if (t.state === 'RUNNING' || t.state === 'PENDING' || t.state === 'WAITING_CONFIRMATION') {
      t.state = 'CANCELLED';
      t.updatedAt = new Date().toISOString();
      taskLog(t.id, 'CANCELLED by user');
      emitTaskEvent({ task_id: t.id, status: 'CANCELLED', message: 'Stopped that for you.' });
    }
    res.json({ id: t.id, state: t.state });
  });

  // Emergency stop: halts all running/pending tasks. Agent calls are short-lived
  // (25s timeout); in-flight mouse/keyboard step finishes, nothing new starts.
  app.post('/api/stop', (_req, res) => {
    stopAll = true;
    for (const t of tasks.values()) {
      if (t.state === 'RUNNING' || t.state === 'PENDING') {
        t.state = 'CANCELLED';
        t.updatedAt = new Date().toISOString();
        taskLog(t.id, 'CANCELLED by STOP');
      }
    }
    try {
      void fetch(`${DESKTOP_AGENT_URL}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'stop', args: {} }),
      }).catch(() => {});
    } catch { /* best-effort */ }
    setTimeout(() => { stopAll = false; }, 5000);
    res.json({ ok: true, stopped: true });
  });

  app.get('/api/doctor', async (_req, res) => {
    const checks: { name: string; status: 'PASS' | 'FAIL' | 'DEGRADED' | 'MISSING'; detail: string }[] = [];
    const push = (name: string, status: (typeof checks)[number]['status'], detail: string) =>
      checks.push({ name, status, detail });
    push('node', 'PASS', process.version);
    try {
      const { execSync } = await import('node:child_process');
      const py = (execSync('python --version', { timeout: 8000 }).toString() || '').trim();
      push('python', 'PASS', py);
    } catch {
      push('python', 'FAIL', 'python --version failed');
    }
    try {
      const h = await (await fetch(`${DESKTOP_AGENT_URL}/health`)).json() as { ok?: boolean; tool_count?: number };
      push('desktop-agent', h.ok ? 'PASS' : 'FAIL', `tools=${h.tool_count ?? '?'}`);
    } catch {
      push('desktop-agent', 'FAIL', 'port 8765 unreachable');
    }
    try {
      const caps = await (await fetch(`${DESKTOP_AGENT_URL}/caps`)).json() as {
        libs?: Record<string, boolean>; tool_count?: number; permissions?: Record<string, number>;
      };
      const libs = caps.libs ?? {};
      for (const [lib, ok] of Object.entries(libs)) {
        push(`lib:${lib}`, ok ? 'PASS' : 'MISSING', ok ? 'installed' : 'not installed');
      }
      const { DESKTOP_TOOLS } = await import('./agent.js');
      const missing = [...DESKTOP_TOOLS].filter((t) => !(t in (caps.permissions ?? {})));
      push('tool-router-parity', missing.length === 0 ? 'PASS' : 'FAIL',
        missing.length === 0 ? `${DESKTOP_TOOLS.size} declared, all in agent registry` : `missing: ${missing.join(',')}`);
    } catch {
      push('tool-router-parity', 'FAIL', '/caps unreachable');
    }
    try {
      const s = await (await fetch('http://127.0.0.1:3000/api/status')).json() as { hasApiKey?: boolean };
      push('backend+api-key', 'PASS', `backend ok, key=${Boolean(s.hasApiKey)}`);
    } catch {
      push('backend+api-key', 'FAIL', 'backend unreachable');
    }
    try {
      const t = await (await fetch(`${DESKTOP_AGENT_URL}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'screen_size', args: {} }),
      })).json() as { ok?: boolean };
      push('screenshot-support', t.ok ? 'PASS' : 'DEGRADED', t.ok ? 'mss capture works' : 'no display backend');
    } catch {
      push('screenshot-support', 'FAIL', 'agent unreachable');
    }
    const hasFail = checks.some((c) => c.status === 'FAIL');
    res.json({ ok: !hasFail, checks });
  });
}
