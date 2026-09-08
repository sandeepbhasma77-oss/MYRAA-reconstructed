// RECREATED — MYRAA Node backend (Express + ws + Gemini Live).
// Ported from recovered dist/server.cjs (1,643 lines) into clean TypeScript modules.
// Behavior preserved: memories/settings/secrets on disk, Gemini key validation,
// /live voice bridge with memory consolidation + desktop-tool routing, proxies.
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

// ESM-compatible __dirname. tsx dev runs ESM (no native __dirname) and the
// esbuild CJS bundle cannot use import.meta (it becomes {} and throws).
// process.argv[1] is the module entry in BOTH tsx dev and the packaged
// spawn (electron/main.cjs spawns node with the absolute server.cjs path).
const __dirname = path.dirname(process.argv[1] ?? process.cwd());
import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { DATA_DIR, dataFile, getGeminiApiKey, hasGeminiApiKey, setGeminiApiKey, clearGeminiApiKey } from './paths.js';
import { loadMemories, saveMemories, reloadMemories, formatSystemInstructionsWithMemories, processConversationSlice } from './memory.js';
import { DESKTOP_TOOLS, DESKTOP_AGENT_URL, bindAgentLogger, callDesktopAgent, ensureDesktopAgent } from './agent.js';
import { registerProxyRoutes } from './proxy.js';
import { registerTaskRoutes, executeVerifiedTool, checkDuplicateAction, markActionStarted, markActionFinished } from './tasks.js';
import { emitTaskEvent, subscribeTaskEvents, registerTaskEventRoutes } from './taskEvents.js';
import { friendlyStartMessage, friendlyFailMessage } from './taskLogic.js';
import { registerVoiceDiagRoutes, newRawTurn, dumpRawChunk, finalizeRawTurn } from './voiceDiag.js';
import { isGoAwaySignal, isGoAwayErrorText, sessionRetiringEvent, sessionClosedEvent, classifyGeminiClose, noteSeen } from '../src/voiceProto.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* best-effort */ }

function appendLog(fileName: string, message: string): void {
  try {
    fs.appendFile(path.join(LOGS_DIR, fileName), `[${new Date().toISOString()}] ${message}\n`, () => {});
  } catch { /* never crash on logging */ }
}
const logStartup = (m: string) => appendLog('startup.log', m);
const logError = (m: string) => appendLog('errors.log', m);
const logCommand = (m: string) => appendLog('commands.log', m);
bindAgentLogger({ onError: logError, onStartup: logStartup });

// --- Session-fault containment (TASK 1 fix) ---------------------------------
// A single dead /live session must never kill the backend process (which would
// make Electron quit the whole app). These process-level guards log loudly but
// keep serving; only a failed LISTEN is fatal (handled at server.listen).
// DG (diagnostic aid): set MYRAA_DIAG=1 for verbose session lifecycle traces.
const DIAG = process.env.MYRAA_DIAG === '1';
const diag = (m: string) => { if (DIAG) console.error(`[DIAG] ${m}`); };
process.on('uncaughtException', (err) => {
  logError(`GUARDED_UNCAUGHT ${err?.stack || err}`);
  console.error('[GUARDED] uncaughtException (backend kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logError(`GUARDED_REJECTION ${detail}`);
  console.error('[GUARDED] unhandledRejection (backend kept alive):', detail);
  diag(`rejection-guard code=${(reason as any)?.code} reason=${String(reason)?.slice(0, 120)}`);
});
function safeSend(ws: WebSocket, payload: string): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(payload);
    else diag(`safeSend dropped (${payload.length}B, readyState=${ws.readyState})`);
  } catch (e) { diag(`safeSend threw: ${(e as Error)?.message}`); }
}

const BASE_INSTRUCTIONS =
  'You are Myraa, a warm, soft-spoken, incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call. ' +
  'Speak sweet, calm, polite, affectionate, gentle and supportive with a slightly shy touch. ' +
  'Never sound loud, aggressive, corporate, robotic, or like a generic assistant. ' +
  'Use natural varied expressions — never repeat one acknowledgment. Keep replies concise for voice. ' +
  'You can also control this Windows PC with desktop tools (each tagged [L0]-[L3]). ' +
  'EXECUTION RULES (never break): for multi-step requests, plan steps aloud briefly, then call one tool at a time; ' +
  'only report success AFTER a tool returns success (the tool reply includes verified=true when checked); ' +
  'if a tool errors, say what failed and why — never say "done" when nothing executed; ' +
  'L2 tools (delete, terminate, settings) need user confirmation first; L3/critical (shutdown/restart) always need explicit confirmation; ' +
  'BLOCKED/DANGEROUS command refusals must be relayed honestly. ' +
  'FILES: "save to desktop" means resolve_path first, then write_file_verified, then report the real path — never say permission denied without a check_path_access diagnosis. ' +
  'APPS: "open/launch/start/run X" means findApplication then launch_application directly — NEVER ask the user for an exe path. ' +
  'If findApplication reports ambiguity, ask the user which match. "Refresh applications" means refreshApplicationIndex. ' +
  'NARRATION: the moment you call a tool, briefly say what you are doing in first person ("Sure, opening Chrome now.", "Searching for that…") ' +
  'and keep it to one short sentence — the user must hear progress WHILE tools run, never silence. ' +
  'When several independent actions were requested, do them together and say so naturally. ' +
  'Never mention task IDs, tool names, or internal states to the user. ';

function browserToolDeclarations() {
  return [
    { name: 'browserOpen', description: "Opens a URL in Myraa's web console.", parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ['url'] } },
    { name: 'browserSearch', description: 'Searches inside the active website.', parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ['query'] } },
    { name: 'browserClick', description: 'Clicks a target in the page.', parameters: { type: Type.OBJECT, properties: { selector: { type: Type.STRING }, description: { type: Type.STRING } }, required: ['selector'] } },
    { name: 'browserMediaControl', description: 'Controls media playback.', parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, enum: ['play', 'pause', 'volume', 'fullscreen', 'exit_fullscreen', 'mute', 'unmute', 'skip'] }, value: { type: Type.INTEGER } }, required: ['action'] } },
    { name: 'browserScroll', description: 'Scrolls the page.', parameters: { type: Type.OBJECT, properties: { direction: { type: Type.STRING, enum: ['up', 'down'] }, amount: { type: Type.INTEGER } } } },
    { name: 'browserType', description: 'Types into the active input.', parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING } }, required: ['text'] } },
    { name: 'browserGoBack', description: 'Navigates back.', parameters: { type: Type.OBJECT, properties: {} } },
    { name: 'browserTabAction', description: 'Tab open/close/switch.', parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, enum: ['new', 'close', 'switch'] }, tabId: { type: Type.STRING }, url: { type: Type.STRING } }, required: ['action'] } },
    { name: 'changeBackground', description: 'Changes interface theme.', parameters: { type: Type.OBJECT, properties: { color: { type: Type.STRING } }, required: ['color'] } },
    { name: 'saveCustomMemory', description: 'Saves user info to persistent memory.', parameters: { type: Type.OBJECT, properties: { category: { type: Type.STRING, enum: ['identity', 'preference', 'goal', 'project', 'relationship', 'emotional', 'behavior'] }, text: { type: Type.STRING } }, required: ['category', 'text'] } },
  ];
}

function desktopToolDeclarations() {
  // Full parameter schemas — MUST match agent/desktop_agent/main.py REGISTRY arg names.
  // (Previous build sent only {_hint}, so the AI hallucinated arg names and every
  // desktop call failed. See MYRAA-TEST pipeline fix.)
  const S = Type.STRING, N = Type.NUMBER, I = Type.INTEGER, B = Type.BOOLEAN;
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: Type.OBJECT, properties, required,
  });
  const D: Record<string, { description: string; parameters: unknown }> = {
    openApplication: { description: 'Open a Windows app by exe name (e.g. notepad.exe, calc.exe).', parameters: obj({ name: { type: S, description: 'Exe name' } }, ['name']) },
    closeApplication: { description: 'Close a Windows app by exe name.', parameters: obj({ name: { type: S }, force: { type: B } }, ['name']) },
    openWebsite: { description: 'Open a URL in the default browser.', parameters: obj({ url: { type: S, description: 'https:// URL' }, name: { type: S } }, ['url']) },
    searchWeb: { description: 'Web search via named engine.', parameters: obj({ query: { type: S }, engine: { type: S } }, ['query']) },
    searchYouTube: { description: 'Search YouTube.', parameters: obj({ query: { type: S } }, ['query']) },
    searchGoogle: { description: 'Search Google.', parameters: obj({ query: { type: S } }, ['query']) },
    searchGitHub: { description: 'Search GitHub.', parameters: obj({ query: { type: S } }, ['query']) },
    createFile: { description: 'Create a text file at path.', parameters: obj({ path: { type: S }, content: { type: S }, overwrite: { type: B } }, ['path']) },
    readFile: { description: 'Read a text file.', parameters: obj({ path: { type: S }, max_chars: { type: I } }, ['path']) },
    renameFile: { description: 'Rename a file.', parameters: obj({ path: { type: S }, new_name: { type: S } }, ['path', 'new_name']) },
    deleteFile: { description: 'Delete a file (Recycle Bin unless permanent=true).', parameters: obj({ path: { type: S }, permanent: { type: B } }, ['path']) },
    moveFile: { description: 'Move a file.', parameters: obj({ path: { type: S }, destination: { type: S } }, ['path', 'destination']) },
    openFolder: { description: 'Open a folder in Explorer.', parameters: obj({ path: { type: S }, name: { type: S } }) },
    listFiles: { description: 'List files in a folder.', parameters: obj({ path: { type: S }, name: { type: S }, pattern: { type: S } }) },
    searchFiles: { description: 'Search files by name/extension.', parameters: obj({ name: { type: S }, extension: { type: S }, folder: { type: S }, limit: { type: I } }) },
    volumeUp: { description: 'Volume up (may be unavailable without audio backend).', parameters: obj({ amount: { type: N } }) },
    volumeDown: { description: 'Volume down (may be unavailable without audio backend).', parameters: obj({ amount: { type: N } }) },
    muteToggle: { description: 'Toggle mute (best-effort).', parameters: obj({}) },
    setVolume: { description: 'Set volume percent (best-effort without backend).', parameters: obj({ percent: { type: N } }) },
    requestPowerAction: { description: 'Stage 1 of power action: returns a 60s token.', parameters: obj({ action: { type: S, description: 'shutdown|restart|sleep|lock' } }, ['action']) },
    executePowerAction: { description: 'Stage 2: execute with token from requestPowerAction.', parameters: obj({ action: { type: S }, execute_token: { type: S } }, ['action', 'execute_token']) },
    minimizeWindow: { description: 'Minimize a window by title substring.', parameters: obj({ title: { type: S } }) },
    maximizeWindow: { description: 'Maximize a window by title substring.', parameters: obj({ title: { type: S } }) },
    closeWindow: { description: 'Close a window by title substring.', parameters: obj({ title: { type: S } }) },
    switchApplication: { description: 'Bring an app window to front by title.', parameters: obj({ title: { type: S } }) },
    copySelected: { description: 'Copy currently selected text.', parameters: obj({ wait: { type: N } }) },
    pasteClipboard: { description: 'Paste/type text via clipboard.', parameters: obj({ text: { type: S } }) },
    getClipboard: { description: 'Read clipboard text.', parameters: obj({ max_chars: { type: I } }) },
    clearClipboard: { description: 'Clear the clipboard.', parameters: obj({}) },
    takeScreenshot: { description: 'SEE the screen: pass include_image=true and the screenshot arrives as an image you can describe. (fails headless/VM without display).', parameters: obj({ include_image: { type: B }, max_dim: { type: I } }) },
    saveScreenshot: { description: 'Save screenshot to file.', parameters: obj({ name: { type: S } }) },
    analyzeScreenshot: { description: 'SEE the screen: screenshot arrives as an image — describe what is visible.', parameters: obj({ max_chars: { type: I } }) },
    readScreen: { description: 'SEE the screen: screenshot arrives as an image — read all visible text aloud.', parameters: obj({ max_chars: { type: I } }) },
    desktopBrowserOpen: { description: 'STUB: desktop browser open (not implemented).', parameters: obj({}) },
    desktopBrowserNavigate: { description: 'STUB: desktop browser navigate (not implemented).', parameters: obj({}) },
    desktopBrowserOpenTab: { description: 'STUB: desktop browser open tab (not implemented).', parameters: obj({}) },
    desktopBrowserCloseTab: { description: 'STUB: desktop browser close tab (not implemented).', parameters: obj({}) },
    desktopBrowserSearch: { description: 'STUB: desktop browser search (not implemented).', parameters: obj({}) },
    desktopBrowserClick: { description: 'STUB: desktop browser click (not implemented).', parameters: obj({}) },
    desktopBrowserType: { description: 'STUB: desktop browser type (not implemented).', parameters: obj({}) },
    desktopBrowserFillForm: { description: 'STUB: desktop browser fill form (not implemented).', parameters: obj({}) },
    desktopBrowserGoBack: { description: 'STUB: desktop browser back (not implemented).', parameters: obj({}) },
    desktopBrowserGoForward: { description: 'STUB: desktop browser forward (not implemented).', parameters: obj({}) },
    desktopBrowserScroll: { description: 'STUB: desktop browser scroll (not implemented).', parameters: obj({}) },
    createPythonFile: { description: 'Create a Python file.', parameters: obj({ path: { type: S }, content: { type: S }, overwrite: { type: B } }, ['path']) },
    runPythonScript: { description: 'Run a Python script file.', parameters: obj({ path: { type: S }, args: { type: Type.ARRAY, items: { type: S } }, timeout: { type: I } }, ['path']) },
    createProjectFolder: { description: 'Create a project folder.', parameters: obj({ path: { type: S }, subfolders: { type: Type.ARRAY, items: { type: S } }, scaffold_standard: { type: B }, files: { type: Type.OBJECT } }, ['path']) },
    writeCodeFile: { description: 'Write a code file.', parameters: obj({ path: { type: S }, content: { type: S }, language: { type: S }, overwrite: { type: B } }, ['path']) },
    systemInfo: { description: 'Return real Windows CPU/RAM/disk/uptime. No args.', parameters: obj({}) },
    gpuInfo: { description: 'Return GPU info (may be unavailable).', parameters: obj({}) },
    temperatureInfo: { description: 'Return temperature sensors (often unavailable on Windows).', parameters: obj({}) },
    brightnessUp: { description: 'STUB: brightness up (needs monitor control).', parameters: obj({ amount: { type: N } }) },
    brightnessDown: { description: 'STUB: brightness down (needs monitor control).', parameters: obj({}) },
    setBrightness: { description: 'STUB: set brightness (needs monitor control).', parameters: obj({ percent: { type: N } }) },
    enableAutoStart: { description: 'Enable launch at Windows login.', parameters: obj({}) },
    disableAutoStart: { description: 'Disable launch at Windows login.', parameters: obj({}) },
    getAutoStartStatus: { description: 'Check auto-start status.', parameters: obj({}) },
    // --- extended real-control tools (permission in description: L0 safe, L1 action, L2 sensitive, L3 critical) ---
    launch_application: { description: '[L1] Launch any installed Windows app by name (Chrome, Notepad, Spotify, VS Code, anything in Start Menu). Prefer findApplication first when unsure of the exact name. Verifies the process is running.', parameters: obj({ name: { type: S } }, ['name']) },
    list_running_applications: { description: '[L0] List running process names.', parameters: obj({ limit: { type: I } }) },
    application_exists: { description: '[L0] Check whether an app/process is running.', parameters: obj({ name: { type: S } }, ['name']) },
    restart_application: { description: '[L1] Close then relaunch an app.', parameters: obj({ name: { type: S } }, ['name']) },
    write_file: { description: '[L1] Write (overwrite) a text file. Use absolute path.', parameters: obj({ path: { type: S }, content: { type: S }, overwrite: { type: B } }, ['path', 'content']) },
    append_file: { description: '[L1] Append text to a file.', parameters: obj({ path: { type: S }, content: { type: S } }, ['path', 'content']) },
    copy_file: { description: '[L1] Copy a file.', parameters: obj({ path: { type: S }, destination: { type: S } }, ['path', 'destination']) },
    create_directory: { description: '[L1] Create a folder (parents included).', parameters: obj({ path: { type: S } }, ['path']) },
    delete_directory: { description: '[L2] Delete a folder tree. Ask the user to confirm first.', parameters: obj({ path: { type: S } }, ['path']) },
    list_directory: { description: '[L0] List folder entries.', parameters: obj({ path: { type: S }, name: { type: S }, pattern: { type: S } }) },
    get_file_info: { description: '[L0] File size/mtime.', parameters: obj({ path: { type: S } }, ['path']) },
    move_mouse: { description: '[L1] Move cursor to x,y pixels.', parameters: obj({ x: { type: I }, y: { type: I } }, ['x', 'y']) },
    click: { description: '[L1] Click at x,y (or current position).', parameters: obj({ x: { type: I }, y: { type: I }, button: { type: S } }) },
    double_click: { description: '[L1] Double-click.', parameters: obj({ x: { type: I }, y: { type: I } }) },
    right_click: { description: '[L1] Right-click.', parameters: obj({ x: { type: I }, y: { type: I } }) },
    middle_click: { description: '[L1] Middle-click.', parameters: obj({ x: { type: I }, y: { type: I } }) },
    drag: { description: '[L1] Drag from x1,y1 to x2,y2.', parameters: obj({ x1: { type: I }, y1: { type: I }, x2: { type: I }, y2: { type: I } }, ['x1', 'y1', 'x2', 'y2']) },
    scroll: { description: '[L1] Scroll by amount (positive up).', parameters: obj({ amount: { type: I } }) },
    press_key: { description: '[L1] Press a key (enter, esc, tab, f1..f12...).', parameters: obj({ key: { type: S } }, ['key']) },
    hotkey: { description: '[L1] Key combo as a list, e.g. keys=["ctrl","shift","esc"] opens Task Manager.', parameters: obj({ keys: { type: Type.ARRAY, items: { type: S } } }, ['keys']) },
    type_text: { description: '[L1] Type text into the focused window. Focus the target first.', parameters: obj({ text: { type: S } }, ['text']) },
    key_down: { description: '[L1] Hold a key down.', parameters: obj({ key: { type: S } }, ['key']) },
    key_up: { description: '[L1] Release a held key.', parameters: obj({ key: { type: S } }, ['key']) },
    screenshot: { description: '[L0] Capture the screen (returns size; use saveScreenshot for a file).', parameters: obj({}) },
    screenshot_region: { description: '[L0] Capture x,y,width,height region.', parameters: obj({ x: { type: I }, y: { type: I }, width: { type: I }, height: { type: I } }, ['x', 'y', 'width', 'height']) },
    screen_size: { description: '[L0] Primary monitor resolution.', parameters: obj({}) },
    monitor_list: { description: '[L0] List monitors.', parameters: obj({}) },
    active_window: { description: '[L0] Foreground window title.', parameters: obj({}) },
    list_windows: { description: '[L0] Visible window titles. Identify windows by title.', parameters: obj({ limit: { type: I } }) },
    focus_window: { description: '[L1] Bring window to front by title substring.', parameters: obj({ title: { type: S } }, ['title']) },
    restore_window: { description: '[L1] Restore a minimized window.', parameters: obj({ title: { type: S } }) },
    move_window: { description: '[L1] Move window to x,y.', parameters: obj({ title: { type: S }, x: { type: I }, y: { type: I } }, ['title', 'x', 'y']) },
    resize_window: { description: '[L1] Resize window.', parameters: obj({ title: { type: S }, width: { type: I }, height: { type: I } }, ['title', 'width', 'height']) },
    read_clipboard: { description: '[L0] Read clipboard text.', parameters: obj({ max_chars: { type: I } }) },
    write_clipboard: { description: '[L1] Write text to clipboard.', parameters: obj({ text: { type: S } }, ['text']) },
    cpu_info: { description: '[L0] Real CPU usage/cores.', parameters: obj({}) },
    ram_info: { description: '[L0] Real RAM usage.', parameters: obj({}) },
    disk_info: { description: '[L0] Real disk volumes/usage.', parameters: obj({}) },
    battery_status: { description: '[L0] Battery percent/charging (absent on desktops).', parameters: obj({}) },
    battery: { description: '[L0] Alias of battery_status.', parameters: obj({}) },
    host_info: { description: '[L0] Hostname, user, Windows version.', parameters: obj({}) },
    uptime: { description: '[L0] System uptime.', parameters: obj({}) },
    list_processes: { description: '[L0] Top processes by memory/CPU. Use to show running apps.', parameters: obj({ limit: { type: I }, sort_by: { type: S } }) },
    find_process: { description: '[L0] Find processes by name substring.', parameters: obj({ name: { type: S } }, ['name']) },
    process_info: { description: '[L0] Detail for a PID.', parameters: obj({ pid: { type: I } }, ['pid']) },
    terminate_process: { description: '[L2] Kill by pid or exact name. NEVER touch protected system processes; confirm with user first.', parameters: obj({ pid: { type: I }, name: { type: S } }) },
    process_cpu_usage: { description: '[L0] CPU detail for a PID.', parameters: obj({ pid: { type: I } }, ['pid']) },
    process_memory_usage: { description: '[L0] Memory detail for a PID.', parameters: obj({ pid: { type: I } }, ['pid']) },
    network_status: { description: '[L0] Up interfaces + traffic counters.', parameters: obj({}) },
    list_adapters: { description: '[L0] Network adapters + IPv4.', parameters: obj({}) },
    ping: { description: '[L0] Ping a host.', parameters: obj({ host: { type: S }, count: { type: I } }, ['host']) },
    dns_lookup: { description: '[L0] Resolve a hostname.', parameters: obj({ host: { type: S } }, ['host']) },
    local_ip: { description: '[L0] Local IP address.', parameters: obj({}) },
    wifi_status: { description: '[L0] Wi-Fi SSID if connected.', parameters: obj({}) },
    open_url: { description: '[L1] Open a URL in the default browser.', parameters: obj({ url: { type: S } }, ['url']) },
    get_volume: { description: '[L0] Current volume % + mute state.', parameters: obj({}) },
    set_volume: { description: '[L1] Set volume 0-100 (real via Windows audio API).', parameters: obj({ percent: { type: N } }, ['percent']) },
    volume_up: { description: '[L1] Raise volume by amount (default 10).', parameters: obj({ amount: { type: N } }) },
    volume_down: { description: '[L1] Lower volume by amount (default 10).', parameters: obj({ amount: { type: N } }) },
    mute: { description: '[L1] Mute.', parameters: obj({}) },
    unmute: { description: '[L1] Unmute.', parameters: obj({}) },
    get_brightness: { description: '[L0] Monitor brightness (laptops only; honest error otherwise).', parameters: obj({}) },
    set_brightness: { description: '[L2] Set brightness (laptops only).', parameters: obj({ percent: { type: N } }, ['percent']) },
    lock_pc: { description: '[L2] Lock the workstation. Confirm first.', parameters: obj({}) },
    sleep_pc: { description: '[L2] Sleep the PC. Confirm first.', parameters: obj({}) },
    run_command: { description: '[L2] Run a shell command (SAFE executes; DANGEROUS needs confirm_token round-trip; BLOCKED always refused). Prefer for "run ..." requests.', parameters: obj({ command: { type: S }, confirm_token: { type: S }, timeout: { type: I } }, ['command']) },
    stop: { description: '[L0] Acknowledge emergency stop.', parameters: obj({}) },
    audio_devices: { description: '[L0] List Windows output devices; flags Bluetooth hands-free (narrow-band) profiles.', parameters: obj({}) },
    resolve_path: { description: '[L0] Resolve "my desktop"/folder phrases or relative names to real Windows paths.', parameters: obj({ text: { type: S } }, ['text']) },
    check_path_access: { description: '[L0] Diagnose exists/readable/writable/elevation for a path.', parameters: obj({ path: { type: S } }, ['path']) },
    desktop_access_test: { description: '[L0] Write/read/delete probe in Desktop/Documents/Downloads.', parameters: obj({}) },
    write_file_verified: { description: '[L1] Write a file then read it back to verify. Use absolute path or resolve_path first.', parameters: obj({ path: { type: S }, content: { type: S }, overwrite: { type: B } }, ['path', 'content']) },
    open_file: { description: '[L1] Find a file by name on Desktop/Documents/Downloads/OneDrive and open it.', parameters: obj({ query: { type: S } }, ['query']) },
    list_drives: { description: '[L0] Available drives with free space.', parameters: obj({}) },
    drive_info: { description: '[L0] One drive, e.g. drive="C".', parameters: obj({ drive: { type: S } }, ['drive']) },
    find_windows_app: { description: '[L0] Discover an installed app (Start Menu, App Paths, PATH, installed-apps registry, Store) without needing an exe path.', parameters: obj({ name: { type: S } }, ['name']) },
    search_windows_app: { description: '[L0] Ranked candidates for a partial app name (Start Menu + StartApps, API only).', parameters: obj({ query: { type: S } }, ['query']) },
    findApplication: { description: '[L0] Best installed-app match for OPEN <name>: aliases, Start Menu, Desktop, registered apps, Store. Asks on ambiguity, never needs an exe path.', parameters: obj({ name: { type: S } }, ['name']) },
    listApplicationMatches: { description: '[L0] Ranked app candidates with scores/strategies for a (partial) name. Never launches.', parameters: obj({ name: { type: S }, limit: { type: I } }, ['name']) },
    refreshApplicationIndex: { description: '[L0] Rebuild the cached Start Menu/registered-app index ("refresh applications").', parameters: obj({}) },
    focusApplication: { description: '[L1] Resolve an app via the index and bring its window forward.', parameters: obj({ name: { type: S } }, ['name']) },
    file_exists: { description: '[L0] Check whether a file/folder exists.', parameters: obj({ path: { type: S } }, ['path']) },
    file_info: { description: '[L0] File size/mtime/is_dir for a path.', parameters: obj({ path: { type: S } }, ['path']) },
    find_file: { description: '[L0] Targeted file search (Desktop/Documents/Downloads/OneDrive first). Never a blind full-drive scan.', parameters: obj({ name: { type: S }, folder: { type: S }, limit: { type: I } }, ['name']) },
    search_drive: { description: '[L0] Targeted name search on ONE explicit drive (e.g. drive="D"). No automatic full-PC scan.', parameters: obj({ query: { type: S }, drive: { type: S }, limit: { type: I } }, ['query']) },
  };
  return [...DESKTOP_TOOLS].map((t) => ({ name: t, ...(D[t] ?? { description: `Desktop control: ${t}`, parameters: obj({}) }) }) as never);
}

export async function startServer(): Promise<void> {
  // FIX: memories.json was never loaded into the in-memory cache, so every
  // backend restart forgot all memories (and any save could clobber the file
  // with an empty list). Load from disk before serving.
  try {
    const restored = await reloadMemories();
    logStartup(`memories restored: ${restored.length} entries`);
  } catch (e) {
    logError(`memories restore failed: ${(e as Error)?.message || e}`);
  }
  const app = express();
  const PORT = 3000;
  // 12mb: /api/voice-dump receives full-response PCM base64 (Express default 100kb would 413 it).
  app.use(express.json({ limit: '12mb' }));

  // Release build identifier (dist/build-info.json stamped at build time).
  // Packaged-safe resolution: never rely on cwd alone — the bundle lives in
  // dist/, so fall back to the module location (works under Electron too).
  let buildInfo: Record<string, unknown> = {};
  for (const p of [path.join(process.cwd(), 'dist', 'build-info.json'), path.join(__dirname, 'build-info.json')]) {
    try { buildInfo = JSON.parse(fs.readFileSync(p, 'utf-8')); if (buildInfo && typeof buildInfo === 'object') break; } catch { /* try next */ }
  }
  // Renderer-persisted voice diagnostics: one line per lifecycle event.
  // The renderer cannot write local files; this endpoint is append-only.
  app.post('/api/voice-event', (req, res) => {
    try {
      const tag = String(req.body?.tag || 'VOICE_EVENT').slice(0, 64);
      const detail = String(req.body?.detail || '').slice(0, 500);
      appendLog('voice.log', `[${tag}] ${detail}`);
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });

  app.get('/api/status', (_req, res) => res.json({ ok: true, version: '1.0.0', hasApiKey: hasGeminiApiKey(), build: buildInfo }));
  app.get('/api/memories', async (_req, res) => {
    try { res.json(await loadMemories()); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.post('/api/memories', async (req, res) => {
    try {
      const { category, text } = req.body ?? {};
      if (!category || !text) return res.status(400).json({ error: 'Category and text parameters are required.' });
      const memories = await loadMemories();
      const ts = new Date().toISOString();
      const m = { id: Math.random().toString(36).slice(2, 11), category, text, createdAt: ts, updatedAt: ts };
      memories.push(m);
      await saveMemories(memories);
      res.status(201).json(m);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.delete('/api/memories/:id', async (req, res) => {
    try {
      const memories = (await loadMemories()).filter((m) => m.id !== req.params.id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  const SETTINGS_FILE = dataFile('settings.json');
  const loadSettings = () => {
    try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch { /* empty */ }
    return {};
  };
  app.get('/api/settings', (_req, res) => { try { res.json(loadSettings()); } catch (e) { res.status(500).json({ error: (e as Error).message }); } });
  app.post('/api/settings', async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Request body must be a JSON object.' });
      const next = { ...loadSettings(), ...patch };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
      if ('autoStart' in patch) {
        callDesktopAgent(patch.autoStart ? 'enableAutoStart' : 'disableAutoStart', {}).catch(() => {});
      }
      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e) { logError(`SETTINGS_SAVE_ERROR: ${(e as Error).message}`); res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/config', (_req, res) => res.json({ hasApiKey: hasGeminiApiKey() }));
  app.post('/api/config/apikey', async (req, res) => {
    try {
      const key = String(req.body?.apiKey ?? '').trim();
      if (!key) return res.status(400).json({ error: 'API key is required.' });
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next();
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        if (/API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg)) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({ error: 'That key was rejected by Google. Check it and try again.' });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand('APIKEY_SAVED');
      res.json({ ok: true, hasApiKey: true });
    } catch (e) { res.status(500).json({ error: (e as Error)?.message || 'Failed to save API key.' }); }
  });

  app.get('/api/agent-health', async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      res.json(r.ok ? { online: true, ...(await r.json() as object) } : { online: false });
    } catch { res.json({ online: false }); }
  });
  app.get('/api/logs/:file', (req, res) => {
    try {
      const f = String(req.params.file);
      if (!['commands', 'startup', 'errors'].includes(f)) return res.status(400).json({ error: 'Use: commands, startup, or errors.' });
      const p = path.join(LOGS_DIR, `${f}.log`);
      if (!fs.existsSync(p)) return res.json({ lines: [], file: f });
      res.json({ lines: fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).slice(-100), file: f });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  registerProxyRoutes(app);
  registerTaskRoutes(app);
  registerTaskEventRoutes(app);
  registerVoiceDiagRoutes(app);

  // Push TaskEvents into every live /live socket instantly (UI latency fix).
  subscribeTaskEvents((e) => {
    const payload = JSON.stringify({ type: 'task_status', task_id: e.task_id, status: e.status, message: e.message, timestamp: e.timestamp });
    for (const ws of liveClients) {
      try { if (ws.readyState === ws.OPEN) ws.send(payload); } catch { /* never break the loop */ }
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const liveClients = new Set<WebSocket>(); // all open /live sockets for event push
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '', `http://${req.headers.host}`).pathname;
    if (pathname === '/live') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else socket.destroy();
  });

  wss.on('connection', async (clientWs: WebSocket) => {
    diag('live connection open');
    liveClients.add(clientWs);
    clientWs.on('close', () => { liveClients.delete(clientWs); });
    clientWs.on('error', (e) => { diag(`clientWs error: ${(e as Error)?.message}`); logError(`WS_CLIENT_ERROR: ${(e as Error)?.message}`); });
    clientWs.on('close', (code: number, reason: Buffer) => {
      clientGone = true; // renderer went away: any later Gemini onclose is a cascade
      diag(`clientWs close pre-session code=${code} reason=${reason?.toString()?.slice(0, 80)}`);
    });
    // Inbound frames can arrive BEFORE the Gemini session is ready (fast client,
    // auto-greet). Buffer them instead of dropping — flush in order on ready.
    const early: Buffer[] = [];
    let sessionReady = false;
    let handleFrame: ((raw: Buffer) => void) | null = null;
    // Session-retirement state (GoAway rotation). Once retiring, the old Gemini
    // session receives NOTHING more — no buffered replays, no new input.
    let retiring = false;
    let sessionRef: any = null; // assigned after connect; null-safe by design
    // Close-evidence trail (Step 1): everything needed to say WHY a session died.
    // Abnormal closes (1006) never carry a reason string — the empty reason plus
    // code IS the evidence. Nothing here is ever overwritten with 'closed'.
    let lastServerEvent: { kind: string; at: string } | null = null;
    let lastSessionError: string | null = null;
    let localCloseRequested = false;
    let localCloseWhy = '';
    let clientGone = false; // renderer socket went away (stop/reload/shutdown)
    const noteServerEvent = (kind: string) => {
      lastServerEvent = { kind, at: new Date().toISOString() };
    };
    // closeGeminiSession is defined after vlog/voiceSid (same scope, below).
    const executedFcIds = new Set<string>(); // tool calls already executed here
    const seenTurnIds = new Set<string>(); // client text turns already accepted
    let pendingExec = 0;
    clientWs.on('message', (raw: Buffer) => {
      if (retiring) { diag('drop client frame: session retiring'); return; }
      if (!sessionReady || !handleFrame) {
        if (early.length < 50) early.push(Buffer.from(raw));
        diag(`client frame buffered pre-session (depth=${early.length})`);
        return;
      }
      handleFrame(raw);
    });
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      clientWs.send(JSON.stringify({ type: 'error', error: 'NO_API_KEY: Add your Gemini API key in Settings to start talking to MYRAA.' }));
      clientWs.close();
      return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
      clientWs.send(JSON.stringify({ type: 'status', status: 'connecting_gemini' }));
      const memories = await loadMemories();
      const finalInstructions = formatSystemInstructionsWithMemories(BASE_INSTRUCTIONS, memories);
      const dialogueHistory: { role: string; text: string }[] = [];
      let currentModelText = '';
      // Voice pipeline: one server-side session per socket, sequential chunk IDs.
      const voiceSid = `VOICE_SESSION_SRV-${Date.now().toString(36)}`;
      let audioSeq = 0;
      let turnChunks = 0;
      let lastMime: string | null = null;
      let rawTurn = newRawTurn(); // TEST A capture (active only with MYRAA_VOICE_DUMP=1)
      const vlog = (m: string) => console.debug(`[VOICE] ${m} sessionId=${voiceSid}`);
      const closeGeminiSession = (why: string) => {
        // Single audited local-close path (Step 5): every intentional close of
        // the Gemini leg funnels through here with a reason. Callers: GoAway
        // paths + renderer-disconnect cascade. Never from renders or UI ticks.
        localCloseRequested = true;
        localCloseWhy = why;
        vlog(`[VOICE_LOCAL_CLOSE_REQUESTED] why=${why} sessionId=${voiceSid}`);
        try { sessionRef?.close?.(); } catch { /* already closing */ }
      };
      vlog('[VOICE_CONNECT_REQUESTED] Gemini Live connecting');
      const session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
          systemInstruction: finalInstructions,
          // MYRAA_NO_TOOLS=1: diagnostic isolation (voice stall bisection).
          tools: (process.env.MYRAA_NO_TOOLS === '1' ? [] : [{ functionDeclarations: [...browserToolDeclarations(), ...desktopToolDeclarations()] }]) as never,
        },
        callbacks: {
          onmessage: (message: any) => {
            // Retired sessions forward NOTHING: no audio, no turns, no tools.
            if (retiring) return;
            // Exactly one forward per event — no duplicate listeners on this socket.
            const part = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;
            const audio = part?.data;
            if (message.setupComplete) noteServerEvent('setupComplete');
            if (audio) {
              noteServerEvent(`audio-chunk seq~${audioSeq}`);
              const seq = audioSeq++;
              const mime = part?.mimeType || null; // actual source format, never assumed
              const rawLen = Buffer.byteLength(String(audio), 'base64');
              // Per-chunk validation: mime drift + PCM alignment anomalies get logged, never hidden.
              if (seq === 0) vlog(`first audio chunk mime=${mime} bytes=${rawLen}`);
              else if (mime !== lastMime) vlog(`mime change ${lastMime} -> ${mime} at seq=${seq}`);
              if (rawLen % 2 !== 0) vlog(`ODD chunk byteLength=${rawLen} seq=${seq} (PCM16 needs even)`);
              lastMime = mime;
              turnChunks++;
              dumpRawChunk(rawTurn, String(audio), mime); // TEST A: raw pre-processing bytes
              safeSend(clientWs, JSON.stringify({ type: 'audio', audio, seq, mime }));
            }
            if (message.serverContent?.turnComplete) {
              noteServerEvent('turnComplete');
              vlog(`turn complete chunks=${turnChunks}`);
              turnChunks = 0;
              finalizeRawTurn(rawTurn); // TEST A: one file per response
              rawTurn = newRawTurn();
            }
            if (message.serverContent?.interrupted) {
              noteServerEvent('interrupted');
              vlog('user interruption detected (Gemini signal)');
              safeSend(clientWs, JSON.stringify({ type: 'interrupted' }));
            }
            if (message.serverContent?.turnComplete) {
              safeSend(clientWs, JSON.stringify({ type: 'turnComplete' }));
              if (currentModelText.trim()) { dialogueHistory.push({ role: 'model', text: currentModelText }); currentModelText = ''; }
              if (dialogueHistory.length > 40) dialogueHistory.splice(0, dialogueHistory.length - 40);
              if (dialogueHistory.length >= 2) {
                processConversationSlice(apiKey, dialogueHistory)
                  .then((u) => { if (u) safeSend(clientWs, JSON.stringify({ type: 'memory_sync', memories: u })); })
                  .catch((e) => console.error('[Memory Sync] error:', e));
              }
            }
            const modelText = message.serverContent?.outputTranscription?.text ?? message.serverContent?.modelTurn?.parts?.[0]?.text;
            if (modelText) { safeSend(clientWs, JSON.stringify({ type: 'transcription', role: 'model', text: modelText })); currentModelText += modelText; }
            const userText = message.serverContent?.inputTranscription?.text;
            if (userText) { safeSend(clientWs, JSON.stringify({ type: 'transcription', role: 'user', text: userText })); dialogueHistory.push({ role: 'user', text: userText }); }
            for (const fc of message.toolCall?.functionCalls ?? []) {
              // Function-call idempotency: the same call never executes twice,
              // even if a retiring session redelivers it.
              if (fc?.id && !noteSeen(executedFcIds, String(fc.id))) { diag(`dup tool call dropped id=${fc.id} name=${fc.name}`); continue; }
              if (retiring) { diag(`drop tool call for retiring session name=${fc?.name}`); continue; }
              if (fc.name === 'saveCustomMemory') {
                pendingExec++;
                (async () => {
                  const list = await loadMemories();
                  const ts = new Date().toISOString();
                  const m = { id: Math.random().toString(36).slice(2, 11), category: fc.args.category, text: fc.args.text, createdAt: ts, updatedAt: ts };
                  list.push(m); await saveMemories(list);
                  if (!retiring) safeSend(clientWs, JSON.stringify({ type: 'memory_sync', memories: list }));
                  sessionCall('tool-response-memory', () => sessionRef?.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { result: 'Memory saved.' } }, id: fc.id }] }));
                })().catch((e) => { logError(`TOOLMEM_ERROR: ${(e as Error)?.message || e}`); diag('saveCustomMemory branch failed contained'); }).finally(() => { pendingExec--; });
              } else if (DESKTOP_TOOLS.has(fc.name)) {
                pendingExec++;
                (async () => {
                  const a = (fc.args ?? {}) as Record<string, unknown>;
                  const taskId = `LIVE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                  // ---- NON-BLOCKING NARRATION (spec §5/§8) ----
                  // Acknowledge IMMEDIATELY as a spoken client-content turn so the
                  // user hears "Opening Chrome…" while the tool runs. The tool
                  // response is delivered later, when execution finishes — Gemini
                  // may keep talking meanwhile. Never await the tool before speaking.
                  const ackMsg = friendlyStartMessage(fc.name, a);
                  emitTaskEvent({ task_id: taskId, status: 'STARTED', message: ackMsg, tool: fc.name });
                  try {
                    sessionCall('ack-turn', () => sessionRef?.sendClientContent({
                      turns: [{ role: 'user', parts: [{ text: `(system: action started — ${ackMsg} acknowledge very briefly or stay silent)` }] }],
                      turnComplete: true,
                    }));
                  } catch { /* ack is best-effort; tool still runs */ }
                  // ---- CROSS-SESSION ACTION DEDUP (spec §10) ----
                  const dup = checkDuplicateAction(fc.name, a);
                  if (dup.dup) {
                    diag(`dup tool action rejected ${fc.name}: ${dup.why}`);
                    emitTaskEvent({ task_id: taskId, status: 'FAILED', message: `That's already ${dup.why}.`, tool: fc.name });
                    const out = { result: `Skipped: this exact action is already ${dup.why}. Tell the user it is already done/running.` };
                    sessionCall('tool-response-dedup', () => sessionRef?.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: out }, id: fc.id }] }));
                    return;
                  }
                  // Auto-verification: never report success without a real check.
                  let verify: { tool: string; args: Record<string, unknown> } | undefined;
                  if ((fc.name === 'openApplication' || fc.name === 'launch_application') && a.name) {
                    verify = { tool: 'application_exists', args: { name: String(a.name) } };
                  } else if ((fc.name === 'createFile' || fc.name === 'write_file') && a.path) {
                    verify = { tool: 'readFile', args: { path: String(a.path), max_chars: 200 } };
                  }
                  markActionStarted(fc.name, a);
                  try {
                    const r = await executeVerifiedTool(taskId, fc.name, a, verify);
                    if (retiring) { diag(`tool result suppressed (retiring) name=${fc.name}`); return; }
                    emitTaskEvent({
                      task_id: taskId, status: r.ok ? 'COMPLETED' : 'FAILED',
                      message: r.ok ? 'Done.' : friendlyFailMessage(fc.name, r.error), tool: fc.name,
                    });
                    // SCREEN VISION: screenshot tools return {imageBase64}. Function
                    // responses are text-only, so inject the frame as live video
                    // input (Gemini SEES it) and keep only a short note in text.
                    let toolResult: unknown = (r.result ?? { result: 'Done.' });
                    const maybeImg = (toolResult ?? {}) as { imageBase64?: unknown; message?: unknown };
                    if (r.ok && typeof maybeImg.imageBase64 === 'string' && maybeImg.imageBase64.length > 100) {
                      const b64 = maybeImg.imageBase64;
                      sessionCall('screen-frame', () => sessionRef?.sendRealtimeInput({
                        video: { data: b64, mimeType: 'image/png' },
                      }));
                      diag(`screen frame injected (${b64.length} b64 chars) name=${fc.name}`);
                      toolResult = { result: `${String(maybeImg.message || 'Screenshot captured.')} The current screen image was just shown to you — describe what you see.` };
                    }
                    const out = r.ok
                      ? { result: toolResult as never, verified: (r as { verified?: boolean }).verified ?? false }
                      : { result: `Desktop control error: ${r.error}` };
                    sessionCall('tool-response-desktop', () => sessionRef?.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: out }, id: fc.id }] }));
                  } finally {
                    markActionFinished(fc.name, a);
                  }
                })().catch((e) => { logError(`TOOLDESK_ERROR ${fc?.name}: ${(e as Error)?.message || e}`); diag('desktop-tool branch failed contained'); }).finally(() => { pendingExec--; });
              } else {
                safeSend(clientWs, JSON.stringify({ type: 'toolCall', callId: fc.id, name: fc.name, args: fc.args }));
              }
            }
          },
          onerror: (e: any) => {
            const d = String(e?.error?.message || e?.message || 'Unknown error');
            lastSessionError = d;
            vlog(`[VOICE_ERROR] sessionId=${voiceSid} detail=${d.slice(0, 160)}`);
            if (!retiring && isGoAwayErrorText(d)) {
              // Some stacks deliver GoAway as an error, not a close: retire now.
              retiring = true;
              vlog(`[VOICE_GOAWAY_RECEIVED] via onerror sessionId=${voiceSid}`);
              safeSend(clientWs, JSON.stringify(sessionRetiringEvent({ voiceSid, reason: d })));
              closeGeminiSession('goaway-via-onerror');
              return;
            }
            if (retiring) { diag(`session onerror while retiring (contained): ${d.slice(0, 120)}`); return; }
            logError(`GEMINI_LIVE_ERROR: ${d}`);
            diag(`session onerror: ${d.slice(0, 160)}`);
            safeSend(clientWs, JSON.stringify({ type: 'error', error: `Gemini Live error: ${d}` }));
          },
          onclose: (e: any) => {
            // ROOT-CAUSE FIX for "Gemini Live closed (closed)": the old code did
            // `String(e?.reason || 'closed')`. An abnormal WebSocket close (code
            // 1006 — the common transient Gemini drop) NEVER carries a reason
            // string per RFC 6455, so the fallback literally manufactured the
            // word "closed" and the UI displayed it as a fatal diagnosis.
            // Now: preserve raw code + raw reason (empty stays empty) alongside
            // the last server event, last error, and whether WE closed it.
            try {
              const code = typeof e?.code === 'number' ? e.code : null;
              const reason = typeof e?.reason === 'string' ? e.reason : '';
              if (!retiring && isGoAwaySignal({ code: code ?? undefined, reason })) {
                // SESSION RETIREMENT REQUIRED: freeze input, tell the renderer
                // with a structured event (never the fatal string), close now.
                retiring = true;
                vlog(`[VOICE_GOAWAY_RECEIVED] sessionId=${voiceSid} code=${code} attempts-off`);
                diag(`session onclose GOAWAY code=${code} reason=${reason.slice(0, 160)}`);
                safeSend(clientWs, JSON.stringify(sessionRetiringEvent({ voiceSid, code: code ?? undefined, reason })));
                closeGeminiSession('goaway-via-onclose');
                return;
              }
              if (retiring) { diag(`session onclose after retirement code=${code} (contained)`); return; }
              const closeClass = classifyGeminiClose({
                code: code ?? undefined,
                reasonText: reason,
                localInitiated: localCloseRequested,
                clientGone,
              });
              vlog(`[VOICE_REMOTE_CLOSE] sessionId=${voiceSid} code=${code} reason=${reason.slice(0, 160) || '(empty — abnormal closure carries no reason)'} class=${closeClass} ` +
                `localInitiated=${localCloseRequested} localWhy=${localCloseWhy || '-'} clientGone=${clientGone} ` +
                `lastServerEvent=${lastServerEvent ? `${lastServerEvent.kind}@${lastServerEvent.at}` : 'none'} ` +
                `lastSessionError=${(lastSessionError || '-').slice(0, 120)}`);
              const auth = closeClass === 'AUTH_OR_API_ERROR';
              if (auth) clearGeminiApiKey();
              if (auth) {
                try {
                  clientWs.send(JSON.stringify(
                    { type: 'error', code: 'INVALID_API_KEY', error: 'Google rejected the saved Gemini API key. Enter a new key.' }));
                } catch { /* closed */ }
                return;
              }
              // Recoverable remote close: NO fatal transcript string, NO
              // 'Check Settings'. The renderer rotates on session_closed.
              safeSend(clientWs, JSON.stringify(sessionClosedEvent({
                voiceSid, code, reason, closeClass,
                lastServerEvent, lastSessionError, localOrRemote: 'remote',
              })));
            } catch (err) {
              // A session close must NEVER kill the backend process.
              logError(`GOAWAY_HANDLER_ERROR: ${(err as Error)?.message || err}`);
            }
          },
        },
      });
      clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
      sessionRef = session;
      diag('live session established');
      vlog('[VOICE_CONNECTED] Gemini Live session established');
      // Session-bound calls: a dead Gemini session must reject into the log,
      // never into an unhandled rejection that kills the backend process.
      const sessionCall = (label: string, fn: () => unknown) => {
        try {
          const r = fn() as unknown;
          if (r instanceof Promise) r.catch((e) => { logError(`SESS_${label}: ${(e as Error)?.message || e}`); diag(`sessionCall ${label} rejected (contained)`); });
        } catch (e) { logError(`SESS_${label}_SYNC: ${(e as Error)?.message || e}`); diag(`sessionCall ${label} threw sync (contained)`); }
      };
      handleFrame = (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as any;
          if (retiring) { diag('drop client frame: session retiring'); return; }
          diag(`client frame: keys=${Object.keys(msg).join(',')} type=${msg.type} audioLen=${msg.audio ? String(msg.audio).length : 0}`);
          if (msg.audio) sessionCall('realtime-audio', () => sessionRef?.sendRealtimeInput({ audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' } }));
          else if (msg.type === 'video' && msg.video) sessionCall('realtime-video', () => sessionRef?.sendRealtimeInput({ video: { data: msg.video, mimeType: 'image/jpeg' } }));
          else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
            // Turn idempotency: a retried/replayed turn never executes twice.
            if (msg.turnId && !noteSeen(seenTurnIds, String(msg.turnId))) { diag(`dup turn dropped turnId=${msg.turnId}`); return; }
            safeSend(clientWs, JSON.stringify({ type: 'transcription', role: 'user', text: msg.text.trim() }));
            dialogueHistory.push({ role: 'user', text: msg.text.trim() });
            if (dialogueHistory.length > 40) dialogueHistory.splice(0, dialogueHistory.length - 40);
            sessionCall('client-content', () => sessionRef?.sendClientContent({ turns: [{ role: 'user', parts: [{ text: msg.text.trim() }] }], turnComplete: true }));
          } else if (msg.type === 'toolResponse') {
            const out = msg.output;
            sessionCall('tool-response', () => sessionRef?.sendToolResponse({ functionResponses: [{ name: msg.name, response: { output: out }, id: msg.id }] }));
          }
        } catch (e) { console.error('client frame error:', e); }
      };
      // Flush pre-session frames in arrival order, then go live — unless the
      // session already retired while connecting (drop, never replay).
      sessionReady = true;
      if (early.length > 0) {
        if (retiring) { diag(`dropping ${early.length} buffered frames: session retiring`); early.length = 0; }
        else {
          diag(`flushing ${early.length} buffered pre-session frames`);
          for (const buf of early.splice(0)) handleFrame(buf);
        }
      }
      clientWs.on('close', () => {
        clientGone = true;
        diag('clientWs close handler: closing session only (renderer went away)');
        closeGeminiSession('renderer-socket-closed');
      });
    } catch (err) {
      diag(`live connect failed: ${(err as Error)?.message}`);
      safeSend(clientWs, JSON.stringify({ type: 'error', error: `Could not connect to Gemini: ${(err as Error).message}` }));
      try { clientWs.close(); } catch { /* noop */ }
    }
  });

  app.use('/assets', express.static(path.join(process.cwd(), 'assets')));
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
  }
  // Dual-stack bind (no host = IPv6 :: with IPv4-mapped): 'localhost' resolves
  // to ::1 first on Windows, and an IPv4-only bind ('0.0.0.0') forces every
  // such client through a ~2s connection-fallback stall (measured). Binding
  // dual-stack removes that latency for browsers, the voice socket, and API.
  server.listen(PORT, () => {
    logStartup(`MYRAA V2 server started on http://localhost:${PORT}`);
    ensureDesktopAgent().catch((e) => console.warn('[Desktop Agent] boot probe failed:', e?.message || e));
  });
}

startServer().catch((e) => console.error('Failed to start server:', e));
