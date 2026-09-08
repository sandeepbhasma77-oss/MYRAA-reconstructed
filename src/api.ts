export interface Memory { id: string; category: string; text: string; createdAt: string; updatedAt: string; }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error || res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => fetch('/api/status').then(json<{ ok: boolean; hasApiKey: boolean } >),
  memories: () => fetch('/api/memories').then(json<Memory[]>),
  addMemory: (category: string, text: string) =>
    fetch('/api/memories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, text }) }).then(json<Memory>),
  forgetMemory: (id: string) => fetch(`/api/memories/${id}`, { method: 'DELETE' }).then(json<{ success: boolean }>),
  settings: () => fetch('/api/settings').then(json<Record<string, unknown>>),
  saveSettings: (patch: Record<string, unknown>) =>
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(json<Record<string, unknown>>),
  agentHealth: () => fetch('/api/agent-health').then(json<{ online: boolean; tool_count?: number }>),
  saveApiKey: (apiKey: string) =>
    fetch('/api/config/apikey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) }).then(json<{ ok: boolean } >),
  youtube: (q: string) => fetch(`/api/youtube-search?q=${encodeURIComponent(q)}`).then(json<{ results: unknown[] }>),
  tasks: () => fetch('/api/tasks').then(json<{ id: string; state: string }[]>),
  task: (id: string) => fetch(`/api/tasks/${id}`).then(json<TaskDetail>),
  createTask: (steps: { tool: string; args: Record<string, unknown> }[]) =>
    fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) }).then(json<{ id: string; state: string }>),
  cancelTask: (id: string) =>
    fetch(`/api/tasks/${id}/cancel`, { method: 'POST' }).then(json<{ id: string; state: string }>),
  stopAll: () => fetch('/api/stop', { method: 'POST' }).then(json<{ ok: boolean; stopped: boolean }>),
  doctor: () => fetch('/api/doctor').then(json<{ ok: boolean; checks: { name: string; status: string; detail: string }[] }>),
};

export interface TaskDetail {
  id: string; state: string; steps: unknown[]; results: { tool: string; ok: boolean; result?: unknown; error?: string; verified?: boolean }[]; error?: string;
}

export function liveSocket(): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${location.host}/live`);
}
