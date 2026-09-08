// MYRAA TaskEvent system — centralized task progress events (additive module).
// Every task/action gets a unique task ID and emits structured events:
//   TaskEvent { task_id, status, message, timestamp }
// Statuses: QUEUED | STARTED | RUNNING | PROGRESS | COMPLETED | FAILED | CANCELLED
// Events fan out to: (1) SSE subscribers, (2) live /live sockets (UI push),
// (3) an in-memory ring buffer for late joiners + tests.
// Friendly wording lives in taskLogic.js (pure, node --test verified).
import type { Express } from 'express';
import { friendlyStartMessage, friendlyFailMessage } from './taskLogic.js';

export type TaskEventStatus =
  | 'QUEUED' | 'STARTED' | 'RUNNING' | 'PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface TaskEvent {
  task_id: string;
  status: TaskEventStatus;
  message: string; // friendly, spoken-style ("Opening Chrome…")
  timestamp: string;
  tool?: string;
  seq?: number;
}

type Listener = (e: TaskEvent) => void;

const RING_MAX = 200;
const ring: TaskEvent[] = [];
const listeners = new Set<Listener>();
let eventSeq = 0;

export function emitTaskEvent(e: Omit<TaskEvent, 'timestamp' | 'seq'> & { timestamp?: string }): TaskEvent {
  const ev: TaskEvent = {
    ...e,
    seq: ++eventSeq,
    timestamp: e.timestamp ?? new Date().toISOString(),
  };
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  for (const l of listeners) {
    try { l(ev); } catch { /* a broken listener never breaks the bus */ }
  }
  return ev;
}

export function subscribeTaskEvents(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function recentTaskEvents(limit = 50): TaskEvent[] {
  return ring.slice(-Math.max(1, Math.min(limit, RING_MAX)));
}

export { friendlyStartMessage, friendlyFailMessage };

// ---- HTTP surface: SSE stream + recent-events polling (additive) ----
export function registerTaskEventRoutes(app: Express): void {
  app.get('/api/task-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    // Late joiners get recent history first, then live events.
    for (const e of recentTaskEvents(20)) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    const unsub = subscribeTaskEvents((e) => {
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ }
    });
    const ka = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => { clearInterval(ka); unsub(); });
  });

  app.get('/api/task-events/recent', (_req, res) => {
    res.json({ events: recentTaskEvents(50) });
  });
}
