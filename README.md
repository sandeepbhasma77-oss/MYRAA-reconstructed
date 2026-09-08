# MYRAA — Reconstructed Source (v1.0.0)

Clean reimplementation of `MYRAA-Setup-1.0.0.exe` behavior. The original was an
**electron-builder NSIS** app: Electron shell + Node/Express backend + React/Vite/Three.js
frontend + frozen Python (PyInstaller) desktop agent.

> This is NOT the original source. It is a reconstruction: recovered files live in
> `recovered/`, reused Electron shell in `electron/`, everything else is rewritten
> from observed behavior. See `RECONSTRUCTION-REPORT.md`.

## Structure

```
electron/        main.cjs, preload.cjs, splash.html, launcher.cs, afterPack.cjs (recovered, attributed)
server/          server.ts, paths.ts, memory.ts, agent.ts, proxy.ts (recreated TS)
src/             App.tsx, main.tsx, api.ts, styles.css (recreated React UI)
agent/           desktop_agent/{main,tools,tools_startup,safe_paths}.py (recreated FastAPI agent)
assets/          idle/talking/thinking.mp4, characters/evelyn/* (recovered binaries)
build/           icon.ico/icon.png (recovered)
recovered/       original package.json, dist/server.cjs, index.html (reference only)
tests/           node + python smoke tests
```

## Prerequisites

- Node 20+, Python 3.11+, (Windows for full agent tools)
- `npm install`
- `pip install -r agent/requirements.txt`
- A per-user Gemini API key (never committed; stored in `%APPDATA%/MYRAA/secrets.json` with 0600)

## Run (dev)

```bat
npm install
npm run dev:server     ^|  node server via tsx on :3000
npm run dev            ^|  vite renderer on :5173 (in second terminal)
uvicorn desktop_agent.main:app --port 8765   ^|  from agent\ with PYTHONPATH=.
```

Production parity: `npm run build` → `dist/` renderer + `dist/server.cjs`,
then `node dist/server.cjs` (NODE_ENV=production, MYRAA_DATA_DIR set by Electron).

## Test

```bat
npm test
python -m pytest tests/test_agent.py -q
```

## Build EXE

```bat
npm run build
npx electron-builder --win nsis --publish never
```

Packaging notes:
- `electron-builder.yml` sets `asar: false` to match the original layout exactly
  (loose `resources/app/{dist,assets,electron}` + `resources/agent/` — the original
  ships no `app.asar`; `main.cjs` spawns `dist/server.cjs` from disk).
- Verified in this environment: `release/win-unpacked/MYRAA.exe` boots, serves
  `/api/status` (`ok:true`), reads the per-user key from `%APPDATA%/MYRAA/secrets.json`,
  and talks to the desktop agent (58 tools). Shipped as `release/MYRAA-1.0.0-win-x64.zip`.
- NSIS installer creation needs the `winCodeSign` cache; in sandboxes without symlink
  privilege (or without .NET for the C# launcher swap) run the above from an
  elevated / Developer-Mode shell with `dotnet` installed — `afterPack` then performs
  the original `MYRAA.exe` ↔ `MYRAA-runtime.exe` swap automatically.

## Notes / differences

- Frontend is a functional approximation; the original built JS is preserved in
  `recovered/` but not used at runtime.
- Screen/volume/brightness/Playwright tools degrade gracefully with explicit errors
  (original agent.log shows the same screen-grab failures in VMs).
- Fixed original `enable_auto_start` crash (`illegal newline value: \r\n`).
- Unsigned by default, like the original.
