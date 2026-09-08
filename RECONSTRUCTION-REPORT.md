# Reconstruction Report — MYRAA-Setup-1.0.0.exe → MYRAA-reconstructed/

## What was analyzed
Copy-only analysis in `%TEMP%\opencode\myraa_*`. 7-Zip listed NSIS-3 Unicode payload:
`app-64.7z` (Electron app), outer `resources/app/assets/*.mp4`, uninstaller.
Inner: `MYRAA.exe` launcher (442 KB), `MYRAA-runtime.exe` (225 MB Electron),
`resources/app/{package.json,electron/*,dist/*,build/*,node_modules/*}`,
`resources/agent/myraa-agent.exe` (14 MB PyInstaller) + `_internal/*.cp311-win_amd64.pyd`,
`assets/characters/evelyn/model.pmx` + textures, `logs/agent.log`.

## Recovered (byte-identical, reused with attribution)
- `electron/main.cjs` (261 lines), `preload.cjs`, `splash.html`, `launcher.cs`, `afterPack.cjs`
- `package.json` (name myraa 1.0.0, 13 deps), `dist/index.html`, `dist/server.cjs` (1,643 lines, reference in `recovered/`)
- `build/icon.ico/.png`, `assets/*.mp4` + `.aistudio` originals, `evelyn/model.pmx` + `textures.json` + 9 textures
- Behavioral facts: ports (3000/8765), 58 tool names, API routes, Gemini models
  (`gemini-3.1-flash-live-preview` live, `gemini-3.5-flash` memory), voice Aoede,
  `AppUserModelId com.myraa.desktop`, single-instance, taskkill tree cleanup.

## Inferred / recreated
- NSIS install dir/registry (electron-builder defaults; compressed script not decompiled):
  `%LOCALAPPDATA%\Programs\MYRAA`, HKCU uninstall key, per-user, asInvoker.
- `server/*.ts` modular port of the 1,643-line bundle (paths/memory/agent/proxy/server).
- `src/*` React UI approximation (stage videos, chat, browser proxy iframe, memory, settings).
- `agent/*.py` FastAPI reimplementation of all 58 tools; hardware tools stubbed honestly.
- `electron-builder.yml`, Vite config, PyInstaller guidance.

## Fixed vs original
- `tools_startup.enable_auto_start`: original crashed (`ValueError: illegal newline value: \r\n`
  at `tools_startup.py:76`, see agent.log 2026-07-30 23:46:19). Rewritten with `newline=''`.

## Could not be recovered
- Original Vite/TS component source (only built JS/CSS survived).
- Python agent `.py` source (only frozen exe + `_internal`).
- NSIS `.nsh` script, build pipelines, signing cert, MMD model license/origin.
- Exact pixel layout/animations (approximated from CSS + strings).

## Final verification (2026-09-05, unpacked build only — no source changes)
- Project files: all present (electron/server/src/agent/assets/recovered/tests,
  package.json, vite.config.ts, electron-builder.yml, README, this report).
  Recovered originals untouched.
- Tests: node 22/22 pass; pytest 3/3 pass; `vite build` OK; `esbuild server` OK
  (3.4 MB); electron v33.4.11; python agent syntax OK. Failures: 0.
- EXE (`release/win-unpacked/MYRAA.exe`, asar:false like original), verified against
  OUR backend only (bundle marker `index-CKlaa8om.js`; original serves `index-C06wV1d4.js`):
  start, splash+`MYRAA` window, single-instance (7→7 procs), UI 200, /api/status ok,
  memories CRUD (probe created+deleted), settings, startup/agent logs, 3/3 mp4s (200),
  bad-key 400 without overwriting real key, proxy scraper, web-proxy
  (X-Myraa-Proxied + base inject), youtube-search (fallback shape), model.pmx
  (2,986,453 B), /live handshake `connecting_gemini → connected`, shutdown
  (0 procs, port freed). Full-duplex chat audio NOT tested (needs mic + long session).
- Agent (58 registry entries, parity): runtime-tested file CRUD, systemInfo (real
  values), power token gate (bad token rejected), screenshot HONEST STUB.
  Stubs raising honest errors: 4 screenshot/OCR, copySelected/pasteClipboard,
  11 Playwright desktop-browser tools, volumeUp/Down (need pycaw/nircmd).
  Degraded-but-safe messages: setVolume/mute/brightness/gpu/temp.
- NOT resolved: packaged app exited twice after /live teardown (backend standalone
  survives the same sequence; cause unisolated — likely session-GoAway race, also
  seen as code=1008 closes in original logs). Needs follow-up with backend stderr
  capture under Electron.
- Installer NOT built: no NSIS/makensis on machine; electron-builder winCodeSign
  cache extraction fails (`Cannot create symbolic link ... libcrypto/libssl.dylib` —
  needs elevated/Developer-Mode shell). Unpacked ZIP is the distributable.
- Original install restored and running (7 procs, agent 58/58). Note: its
  /api/status returns index.html (installed build differs slightly from analyzed Setup).

## Secrets
None bundled. No API keys found in the installer. User key stored locally only.
