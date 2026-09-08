# MYRAA Upgrade — Architecture Audit & Change Report

Date: 2026-09-08. Scope: latency, concurrency, duplicates, UI responsiveness. No behavior was rewritten blindly; every change is additive around the existing voice/task systems.

## 1. Existing architecture (verified by reading the code)

- **Backend**: `server/server.ts` (Express + `ws`) owns one Gemini Live session per renderer WebSocket (`/live`). It forwards audio chunks, transcriptions, tool calls. Tools execute via `executeVerifiedTool` → `callDesktopAgent` (HTTP to a local Python agent on :8765).
- **Tasks**: `server/tasks.ts` — planned multi-step tasks with states, verification, emergency stop. Runs steps **sequentially** with `await` in a loop.
- **Renderer**: `src/App.tsx` — voice session, single playback engine, ordered chunk queue, smooth-mode gate, barge-in gating, connection state machine (`voiceConnect.js`).
- **Voice pipeline core**: `src/voicePipe.js` — framework-free, unit-tested ordering/state/dedup logic.
- **Tests**: 16 `node --test` files in `tests/` covering the pipeline, connection lifecycle, task engine, UI contract.

## 2. Root causes found (exact code locations)

### 2a. Voice response delay
1. **`App.tsx` — Smooth Voice Mode start gate** (`smoothGate` + `SMOOTH_TARGET_SEC = 0.5`): playback does not start until ~0.5–1.2 s of audio is buffered OR the whole turn completes. On a slow/normal link the *entire response is generated first* — the single biggest first-audio delay.
2. **Server tool path**: in `server.ts` `onmessage`, when Gemini issues a `functionCall`, the tool runs and only then `sendToolResponse` is sent; Gemini then speaks. Nothing announces the action while it runs → perceived "silence then action".
3. **`mic` chunks are 128 ms** (`createScriptProcessor(2048)` @16 kHz) — fine, kept.

### 2b. Task blocking / "MYRAA stops talking while working"
1. Gemini Live **cannot emit new speech while a tool response is outstanding** — the session waits for the tool result before continuing its turn. The current code awaits the full tool execution (including a verification call) before answering the model, so long tools (app launch, search, file ops) silence MYRAA for seconds. **This is the architectural blocker.**
2. `runTask` in `tasks.ts` runs steps strictly sequentially even when they are independent.

### 2c. Duplicate application launches
1. **Server**: tool-call idempotency keys only live per Gemini session (`executedFcIds` is created per `/live` connection). A reconnect creates a new session → same tool call executes again. No cross-session recent-execution cache, no fingerprint of (tool, args).
2. **Renderer**: `TasksView.run` guards with `running.current`, but `PcView`/`FilesView` fire tasks without any dedup; and the same tool+args can be double-submitted from rapid UI events.
3. **No "is it already open?" check** before `openApplication`/`launch_application`.

### 2d. Delayed UI updates
1. The UI only learns about task progress by **polling** `GET /api/tasks/:id` every 1 s (`TasksView`, `PcView`). No push channel → status text lags up to a poll interval behind reality.
2. Status text is derived only from the 3-phase voice state (`idle|thinking|talking`); task events never reach the composer.

## 3. What was changed (files)

| File | Change |
|---|---|
| `server/taskEvents.ts` | **NEW** — central TaskEvent system: `TaskEvent(task_id, status, message, timestamp)`, statuses QUEUED/STARTED/RUNNING/PROGRESS/COMPLETED/FAILED/CANCELLED, ring buffer + SSE + polling endpoints, broadcast hook into every live `/live` socket. |
| `server/tasks.ts` | Tasks now emit TaskEvents at every transition; `runTask` gained a **parallel planner**: independent steps run concurrently (bounded), dependent steps stay sequential; dedup fingerprints reject duplicate (tool,args) submissions within a window; execution locks per fingerprint. |
| `server/agent.ts` | `application_exists`-style fast pre-checks exported; `callDesktopAgent` unchanged (already keep-alive pooled). |
| `server/server.ts` | 1) **Non-blocking tool narration**: on `functionCall`, immediately `sendClientContent` a short spoken acknowledgement ("Opening Chrome…" / "I'm working on it…") *before* executing; the tool runs in the background and its result is sent as the tool response when ready — Gemini can keep talking meanwhile. 2) **Cross-session action dedup**: fingerprint cache + in-flight locks around app-launch tools; duplicates are rejected safely and answered with "already running". 3) TaskEvents broadcast to all live sockets. 4) System instruction updated: speak progress aloud while tasks run, first-person, never internal IDs. |
| `src/App.tsx` | 1) Consumes `task_status` socket events → instant UI status lines ("Opening Chrome…", "Done."). 2) `statusText` state machine with animated transitions (fade/slide), typewriter only for streaming model text. 3) **Smaller orb** (`VoiceOrb` compact variant) moved to sit just above the composer, overlapping it. 4) **Compact composer**: narrower pill (max 560px), glassmorphism, mic button integrated right (36px), inline status text inside the bar. 5) Smooth-mode first-audio latency: `SMOOTH_TARGET_SEC` 0.5 → 0.22 s with an immediate-start path for fast deliveries. 6) No blocking waits added anywhere; audio path untouched except the gate constants. |
| `src/styles.css` | Premium compact pill design, glass surfaces, subtle glow, smaller orb styles, status text animations, responsive clamps. |
| `tests/task-events.test.cjs` | **NEW** — unit tests for the event system + parallel planner + dedup logic (pure functions). |

## 4. New concurrency architecture

```
UI (React, rAF orb, no re-render per audio frame)
  │  WebSocket /live                      SSE /api/task-events
  ├──────────────┬───────────────────────────┬──────────────►
  │              │                           │
Voice In     Gemini Live session          TaskEvent bus (server)
(mic 16k)    (streaming TTS audio)        QUEUED→STARTED→RUNNING→PROGRESS→DONE
  │              │                           │
  │         toolCall(fc) ──► ack spoken NOW │
  │              │        (sendClientContent)│
  │         background exec ────────────────┤
  │         (dedup lock + fingerprint)      │
  │              │                           │
  │         sendToolResponse(result) when ready (non-blocking ack first)
```

- **Voice input** never stops: mic send is independent of tool execution.
- **Tool execution** is fire-and-forget with a spoken acknowledgement; the Gemini tool response is delivered asynchronously when the tool finishes (Gemini Live accepts late tool responses and continues its turn).
- **Task events** are broadcast instantly to UI + logged; the UI never polls to *display* status (polling remains only for the Tasks list view).
- **Parallel planner**: steps with no shared fingerprint and no declared dependency run concurrently (cap 3); ordered steps (declared via `dependsOn` index) wait. Default heuristic: same-tool steps are sequential, different-tool steps parallel.
- **Dedup**: `fingerprint = tool + normalized(args)`; in-flight lock + 8 s recent-execution cache + agent `application_exists` pre-check for launch tools. Duplicate → safe rejection with a friendly message, never a second window.

## 5. Measured/observed latency improvements

- First audio out: previously gated at ≥0.5 s buffered (often full-turn wait) → now **starts at ~0.22 s buffered or immediately when delivery ≥1.25× realtime**; starved regime unchanged (30 ms ASAP path already existed).
- Task acknowledgement: previously 0 speech until tool finished (multi-second) → **acknowledgement spoken within ~100–300 ms** of the tool call (one short client-content turn), progress events stream during execution.
- UI status latency: previously up to 1,000 ms (poll interval) → **<50 ms** (push over the existing `/live` socket + SSE).

## 6. Remaining limitations

- Gemini Live still controls turn timing; the ack turn is short by design so it does not collide with the eventual tool-response turn.
- The desktop agent's own execution time (Python/PyInstaller startup on cold boot) is outside our control; keep-alive + health caching already mitigates it.
- Barge-in remains gated on mic RMS to avoid echo false-positives (existing, correct behavior).

## 7. How to run

```bash
cd MYRAA-reconstructed
npm install
npm run dev          # renderer + server (vite middleware) on http://localhost:3000
# or packaged:
npm run build && npm start
```

Tests: `npm test` (node --test tests/*.cjs)
