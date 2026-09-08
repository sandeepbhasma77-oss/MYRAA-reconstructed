// RECREATED — desktop-agent lifecycle ported from recovered dist/server.cjs.
// Spawns frozen myraa-agent.exe (extraResource) or falls back to `python -m uvicorn`.
// OPTIMIZED: keep-alive connection pool, parallel tool execution, faster health checks.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || 'http://127.0.0.1:8765';
const DESKTOP_AGENT_TIMEOUT = 15_000; // reduced: most tools respond in <100ms

// NOTE: connection reuse comes from undici's default global dispatcher
// (keep-alive pooling is on by default). Do NOT pass a node:http Agent as
// `dispatcher` — undici rejects it and EVERY agent call fails with
// "fetch failed" (this silently broke all backend→agent tools).

// Must stay in sync with agent/desktop_agent/main.py TOOL registry.
export const DESKTOP_TOOLS = new Set([
  'openApplication', 'closeApplication', 'openWebsite', 'searchWeb', 'searchYouTube',
  'searchGoogle', 'searchGitHub', 'createFile', 'readFile', 'renameFile', 'deleteFile',
  'moveFile', 'openFolder', 'listFiles', 'searchFiles', 'volumeUp', 'volumeDown',
  'muteToggle', 'setVolume', 'requestPowerAction', 'executePowerAction', 'minimizeWindow',
  'maximizeWindow', 'closeWindow', 'switchApplication', 'copySelected', 'pasteClipboard',
  'getClipboard', 'clearClipboard', 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot',
  'readScreen', 'desktopBrowserOpen', 'desktopBrowserNavigate', 'desktopBrowserOpenTab',
  'desktopBrowserCloseTab', 'desktopBrowserSearch', 'desktopBrowserClick', 'desktopBrowserType',
  'desktopBrowserFillForm', 'desktopBrowserGoBack', 'desktopBrowserGoForward', 'desktopBrowserScroll',
  'createPythonFile', 'runPythonScript', 'createProjectFolder', 'writeCodeFile', 'systemInfo',
  'gpuInfo', 'temperatureInfo', 'brightnessUp', 'brightnessDown', 'setBrightness',
  'enableAutoStart', 'disableAutoStart', 'getAutoStartStatus',
  // extended real-control tools (tools_ext)
  'launch_application', 'list_running_applications', 'application_exists', 'restart_application',
  'write_file', 'append_file', 'copy_file', 'create_directory', 'delete_directory',
  'list_directory', 'get_file_info', 'move_mouse', 'click', 'double_click', 'right_click',
  'middle_click', 'drag', 'scroll', 'press_key', 'hotkey', 'type_text', 'key_down', 'key_up',
  'screenshot', 'screenshot_region', 'screen_size', 'monitor_list', 'active_window',
  'list_windows', 'focus_window', 'restore_window', 'move_window', 'resize_window',
  'read_clipboard', 'write_clipboard', 'cpu_info', 'ram_info', 'disk_info', 'battery_status',
  'battery', 'host_info', 'uptime', 'list_processes', 'find_process', 'process_info',
  'terminate_process', 'process_cpu_usage', 'process_memory_usage', 'network_status',
  'list_adapters', 'ping', 'dns_lookup', 'local_ip', 'wifi_status', 'open_url',
  'get_volume', 'set_volume', 'volume_up', 'volume_down', 'mute', 'unmute',
  'get_brightness', 'set_brightness', 'lock_pc', 'sleep_pc', 'run_command', 'stop',
  'audio_devices', 'resolve_path', 'check_path_access', 'desktop_access_test',
  'write_file_verified', 'open_file', 'list_drives', 'drive_info',
  'find_windows_app', 'search_windows_app',
  'findApplication', 'listApplicationMatches', 'refreshApplicationIndex', 'focusApplication',
  'file_exists', 'file_info', 'find_file', 'search_drive',
]);

let verified = false;
let logError: (m: string) => void = () => {};
let logStartup: (m: string) => void = () => {};

// OPTIMIZED: fast path flag — agent responded once, assume alive until proven otherwise.
let lastHealthCheck = 0;
const HEALTH_STALE_MS = 5_000; // recheck only after 5s of inactivity


export function bindAgentLogger(hooks: { onError: (m: string) => void; onStartup: (m: string) => void }) {
  logError = hooks.onError;
  logStartup = hooks.onStartup;
}

function spawnDesktopAgent(): void {
  const agentEnv = { ...process.env, MYRAA_AGENT_HOST: '127.0.0.1', MYRAA_AGENT_PORT: '8765' };
  const frozen = [process.env.MYRAA_AGENT_EXE, path.join(process.cwd(), 'agent_dist', 'myraa-agent', 'myraa-agent.exe')]
    .find((c) => Boolean(c && c.length > 0 && fs.existsSync(c as string)));
  if (frozen) {
    try {
      const child = spawn(frozen as string, [], {
        cwd: path.dirname(frozen as string), detached: true, stdio: 'ignore',
        windowsHide: true, env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozen}`);
      return;
    } catch (e) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${(e as Error)?.message || e}`);
    }
  }
  const candidates = [process.env.MYRAA_PYTHON, 'python', 'python3'].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try { execSync(`"${p}" --version`, { stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (!py) {
    logError('AGENT_SPAWN_NO_RUNTIME: neither MYRAA_AGENT_EXE nor Python available');
    return;
  }
  try {
    // desktop_agent package lives in <project>/agent — uvicorn must resolve it
    // via --app-dir (cwd varies: project root in dev, resources/app in packaged EXE).
    const agentDir = fs.existsSync(path.join(process.cwd(), 'agent', 'desktop_agent', 'main.py'))
      ? path.join(process.cwd(), 'agent')
      : process.cwd();
    const child = spawn(py, ['-m', 'uvicorn', 'desktop_agent.main:app', '--host', '127.0.0.1', '--port', '8765', '--app-dir', agentDir, '--log-level', 'warning'],
      { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true, env: agentEnv });
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid} appDir=${agentDir}`);
  } catch (e) {
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${(e as Error)?.message || e}`);
  }
}

export async function isDesktopAgentAlive(): Promise<boolean> {
  // Fast path: skip HTTP check if we checked recently.
  if (verified && Date.now() - lastHealthCheck < HEALTH_STALE_MS) return true;
  try {
    lastHealthCheck = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500); // faster timeout
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      verified = true;
      return true;
    }
    verified = false;
    return false;
  } catch {
    verified = false;
    return false;
  }
}

export async function ensureDesktopAgent(): Promise<void> {
  if (verified && Date.now() - lastHealthCheck < HEALTH_STALE_MS) return;
  if (await isDesktopAgentAlive()) return;
  spawnDesktopAgent();
  // Faster retry: 500ms intervals, 15 tries = 7.5s total (was 20s)
  for (let i = 1; i <= 15; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDesktopAgentAlive()) return;
  }
}

export async function callDesktopAgent(tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!verified) await ensureDesktopAgent();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DESKTOP_AGENT_TIMEOUT);
    const url = `${DESKTOP_AGENT_URL}/execute`;
    const method = 'POST';
    const body = JSON.stringify({ tool, args });
    const headers = { 'Content-Type': 'application/json' };
    
    const options: Parameters<typeof fetch>[1] = {
      method,
      headers,
      body,
      signal: ctrl.signal,
    };
    
    const res = await fetch(url, options);
    clearTimeout(t);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.slice(0, 200)}`);
      verified = false; // mark as needing recheck
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return (await res.json()) as { ok: boolean; result?: unknown; error?: string };
  } catch (err) {
    verified = false;
    const msg = (err as Error)?.name === 'AbortError'
      ? 'Desktop agent timed out.'
      : 'Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765';
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}
