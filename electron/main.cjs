/* ===========================================================================
 * MYRAA — Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      silently as a child process — no console window, no browser tab.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim — nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// --- Constants -------------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');
const APP_ICON = path.join(APP_ROOT, 'build', 'icon.png');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Process-lifecycle forensics (release-blocker instrumentation).
// Every shutdown path must leave evidence. Writes are SYNCHRONOUS
// (appendFileSync) so a disappearing process still leaves a trace.
// Log file: <userData>/logs/process-lifecycle.log
// ---------------------------------------------------------------------------
function lifecycleLog(category, detail) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${category}] pid=${process.pid} ppid=${process.ppid} ${detail || ''}\n`;
    fs.appendFileSync(path.join(logDir, 'process-lifecycle.log'), line);
  } catch { /* forensics must never crash the app */ }
}

// Central shutdown gate: EVERY intentional app.quit() must pass through here
// with a reason. Direct app.quit() calls elsewhere are a bug.
function requestAppShutdown(reason) {
  let stack = '';
  try { stack = String(new Error('shutdown-trace').stack || '').split('\n').slice(1, 5).join(' <- '); } catch { /* noop */ }
  lifecycleLog('QUIT_CALLER', `reason=${reason} isQuitting=${isQuitting} stack=${stack}`);
  isQuitting = true;
  app.quit();
}

// Early process-level guards: catch anything that would silently kill main.
process.on('uncaughtException', (err) => {
  lifecycleLog('UNCAUGHT_EXCEPTION', `error=${err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  lifecycleLog('UNHANDLED_REJECTION', `detail=${String(detail).split('\n').slice(0, 3).join(' | ')}`);
});
process.on('exit', (code) => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] [PROCESS_EXIT] pid=${process.pid} code=${code}\n`;
    fs.appendFileSync(path.join(logDir, 'process-lifecycle.log'), line);
  } catch { /* last resort: nothing left to do */ }
});

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  lifecycleLog('MAIN_START', 'second instance detected — quitting (single-instance guard)');
  requestAppShutdown('second-instance');
} else {
  lifecycleLog('MAIN_START', `first instance lock acquired electron=${process.versions.electron} node=${process.versions.node}`);
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'myraa-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    MYRAA_LAUNCHED_BY: 'electron',
    MYRAA_DATA_DIR: dataDir,
    MYRAA_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.MYRAA_AGENT_EXE = agentExe;
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  lifecycleLog('BACKEND_SPAWN', `pid=${serverProcess.pid} entry=${SERVER_ENTRY} cwd=${APP_ROOT}`);

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    lifecycleLog('BACKEND_EXIT', `code=${code} signal=${signal} pid=${serverProcess?.pid} isQuitting=${isQuitting}`);
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const line = `[${new Date().toISOString()}] BACKEND_EXIT code=${code} signal=${signal} pid=${serverProcess?.pid}\n`;
      fs.appendFileSync(path.join(logDir, 'main-exit.log'), line);
    } catch { /* logging must never crash shutdown path */ }
    if (process.env.MYRAA_DIAG === '1') process.stderr.write(`[DIAG] backend exit code=${code} signal=${signal}\n`);
    if (!isQuitting) {
      dialog.showErrorBox(
        'MYRAA backend stopped',
        `The MYRAA backend process exited unexpectedly (code ${code}, signal ${signal}).`,
      );
      requestAppShutdown(`backend-exit code=${code} signal=${signal}`);
    }
  });
  serverProcess.on('error', (err) => {
    lifecycleLog('BACKEND_SPAWN_ERROR', `error=${err && err.message ? err.message : String(err)}`);
  });
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(SERVER_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  lifecycleLog('WINDOW_CREATED', 'kind=splash');
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'MYRAA',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    // Full-window experience: open maximized (normal window, not exclusive
    // OS fullscreen — the user can restore/resize freely).
    try { mainWindow?.maximize(); } catch { /* best-effort */ }
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('close', (e) => {
    lifecycleLog('WINDOW_CLOSE_REQUEST', `isQuitting=${isQuitting} minimized=${mainWindow?.isMinimized?.()}`);
  });
  mainWindow.on('closed', () => {
    lifecycleLog('WINDOW_CLOSED', `isQuitting=${isQuitting} remainingWindows=${BrowserWindow.getAllWindows().length}`);
    mainWindow = null;
  });
  mainWindow.webContents.on('crashed', (_e, killed) => {
    lifecycleLog('RENDERER_CRASH', `killed=${killed}`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    lifecycleLog('RENDERER_UNRESPONSIVE', '');
  });
  mainWindow.webContents.on('responsive', () => {
    lifecycleLog('RENDERER_RESPONSIVE', '');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    lifecycleLog('RENDERER_LOADED', `url=${SERVER_ORIGIN}`);
  });

  mainWindow.loadURL(SERVER_ORIGIN);
  lifecycleLog('WINDOW_CREATED', 'kind=main');
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.myraa.desktop');
  lifecycleLog('BOOTSTRAP', 'starting (splash + backend + wait)');
  createSplashWindow();

  try {
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    lifecycleLog('BACKEND_READY', `origin=${SERVER_ORIGIN}`);
    createMainWindow();
  } catch (err) {
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'MYRAA failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    requestAppShutdown(`bootstrap-fail: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  lifecycleLog('WINDOW_ALL_CLOSED', `platform=${process.platform}`);
  if (process.platform !== 'darwin') requestAppShutdown('window-all-closed');
});

app.on('before-quit', () => {
  lifecycleLog('APP_BEFORE_QUIT', '');
  isQuitting = true;
  stopBackend();
});

app.on('will-quit', (e) => {
  lifecycleLog('APP_WILL_QUIT', '');
});

app.on('quit', (_e, exitCode) => {
  lifecycleLog('APP_QUIT', `exitCode=${exitCode}`);
});

process.on('exit', stopBackend);
