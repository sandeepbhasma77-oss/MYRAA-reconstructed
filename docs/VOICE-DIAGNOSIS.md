# MYRAA Voice Quality Diagnosis (radio/walkie-talkie sound)

No audio-path code was changed for this diagnosis. These procedures isolate
SOURCE vs PLAYBACK vs DEVICE. Do one full MYRAA voice turn per capture.

## 0. Arm capture (both sides)

1. Backend: start server with `MYRAA_VOICE_DUMP=1`
   (`$env:MYRAA_VOICE_DUMP="1"; node dist/server.cjs`).
2. UI: chat tab → **Diag: ON** button (stores `myraa_dump=1`).
3. Connect + Start mic, get ONE complete MYRAA spoken reply, wait for turn end.

## TEST A — raw Gemini audio

Server writes (unmodified concatenation of Gemini base64 chunks):

* `debug/raw-gemini-response.pcm` — raw LE PCM16 mono
* `debug/raw-gemini-response.json` — mime, sampleRate, channels, bitDepth,
  byteLength, durationSec, sha256

Play it directly (TEST F) with a known-good player at the declared rate, e.g.
`ffplay -f s16le -ar 24000 -ac 1 debug/raw-gemini-response.pcm`
(or Audacity: Import Raw, Signed 16-bit PCM, 1 channel, rate from the .json).

## TEST B — playback audio

Browser POSTs the exact PCM16 bytes handed to the AudioContext:

* `debug/playback-response.pcm` + `debug/playback-response.json`
  (also records `playbackSampleRate` = device context rate).

## TEST C — resampling check

`GET /api/voice-diag` returns:

* `SOURCE_SAMPLE_RATE`, `PLAYBACK_SAMPLE_RATE`, `BUFFER_RATE`
* `RESAMPLING_REQUIRED`, `RESAMPLING_METHOD`
* `BYTE_IDENTICAL` (true = MYRAA playback is bit-identical to Gemini bytes)

## TEST D — Windows device check

Run the `audio_devices` tool (tasks tab) or
`POST /api/tasks {"steps":[{"tool":"audio_devices","args":{}}]}`.
It lists active render devices and flags Bluetooth Hands-Free/HFP profiles
(~8 kHz narrow-band — the classic "radio" cause). Then manually verify:

* Settings > Sound > output device Properties > Audio Enhancements **OFF**
* Spatial Audio **OFF**
* `mmsys.cpl` > Communications tab > **Do nothing**
* No Dolby/DTS/Realtek/Waves processing on the test device

## TEST E — headphones comparison

Same voice prompt on: (1) laptop speakers, (2) wired headphones,
(3) Bluetooth if available (note Stereo vs Hands-Free device name).
Record per device: radio effect present/absent.

## TEST F — direct file verdict

| Observation | Verdict |
|---|---|
| Raw file already radio-like in ffplay/Audacity | **SOURCE_AUDIO** |
| Raw clear, MYRAA live playback radio-like | **PLAYBACK_PIPELINE** |
| Both good, one Windows device/profile radio-like | **WINDOWS_DEVICE** |
| No hardware/quota to run A–F | **UNKNOWN** |

## Current status (2026-09-07)

Static path verified bit-perfect by `tests/audio-format.test.cjs`
(lossless PCM round-trip, correct 24 kHz default, no gain/encoder,
known-signal 440Hz analysis, edge-ramps).
Per-turn WAV dumps now written beside PCM (`raw-gemini-response.wav`,
`playback-response.wav`, correct 24 kHz mono headers) plus a numbered
archive under `diagnostics/audio/` (`gemini_raw_001.pcm/.wav/.json`,
`playback_001.*`) when `MYRAA_VOICE_DUMP=1`.
`GET /api/voice-diag` now reports per-side A/B stats (samples, bytes,
RMS, peak, clipping %, zero-crossings) with deltas and a MODIFIED_BY
verdict (bit-identical = source path clean; differs = MYRAA stage).
Live playback uses exactly one pipeline per voice session
(`voice_session_id` + `playback_session_id` in every AUDIO log) with a
~120 ms jitter buffer, 350 ms gap-wait/skip, and underflow counting.
Per-test status:

```text
TEST A (raw Gemini dump): ARMED — needs MYRAA_VOICE_DUMP=1 + 1 voice turn
TEST B (playback dump):   ARMED — needs UI Diag:ON + 1 voice turn
TEST C (A/B compare):     LOGIC TESTED (synthetic dumps, incl. RMS/peak stats) — live data pending
TEST D (device check):    PASS — audio_devices live (render + capture formats, no HFP assumed; verify on hardware)
TEST E (headphones):      BLOCKED — no hardware access here
TEST F (direct file):     BLOCKED — no dump captured yet (quota 429 + no mic)
```

Live capture pending: Gemini free-tier quota 429-exhausted + no mic/speaker
in this environment. Diagnosis: **UNKNOWN** until TEST A–F run on user hardware.
Do NOT claim the radio-like sound is fixed until A/B/C + E/F prove it.
Do NOT tune jitter further until the A/B evidence below exists.

## CRITICAL A/B PROTOCOL (2026-09-08) — source vs pipeline vs device

Jitter tuning is frozen: the user reports adaptive jitter sounds "essentially
the same", so it is NOT the primary audible problem. Run this instead.

### 0. Arm capture (one voice response)

1. DevTools console:
   `localStorage.setItem('myraa_dump','1')` (Diag toggle does the same).
2. Optional experiment flags (DevTools, then reconnect/talk):
   * Minimal pipeline: `localStorage.setItem('myraa_plain_pipeline','1')`
     (fixed jitter, no smoothing, no tone, barge-in ignored, STOP still works).
     Remove the key (or set `'0'`) to return to full pipeline.
   * Resample experiment: `localStorage.setItem('myraa_ab_mode','B')`
     (manual 24k→48k resample, buffer @48kHz). Default `'A'` = native 24kHz
     buffer (browser resamples). Same raw PCM both modes.
3. Connect + mic, get ONE complete spoken reply, wait for turn end.

### 1. Files produced (debug/)

* `raw-gemini-24k.pcm` / `.wav` — ordered received PCM, pre-queue, unmodified
  (signed 16-bit LE, mono, 24000 Hz).
* `post-pipeline-24k.pcm` / `.wav` — exact scheduled samples, pre-playback.
* `pipeline-compare.json` — sample/byte counts, RMS, peak, discontinuity
  counts, bit-identical verdict, A/B + pipeline modes, latencies.
* Console `AUDIO_SESSION_SUMMARY` carries `pipelineMode`, `abMode`, `bufRate`,
  `srcCreated/Started/Ended/StoppedEarly/Overlaps`, `outputLatency/baseLatency`.

### 2. Mandatory offline comparison (Step 5)

Play `debug/raw-gemini-24k.wav` in a normal media player (Groove/VLC/ffplay),
then play the same reply live in MYRAA:

| Observation | Verdict |
|---|---|
| Raw WAV already robotic/choppy | **SOURCE_AUDIO** (Gemini output — not MYRAA) |
| Raw natural, MYRAA live robotic | **PLAYBACK_PIPELINE** (decode/schedule/output) |
| Both natural on headphones, robotic on speakers/BT | **WINDOWS_DEVICE** (enhancements/spatial/HFP — see TEST D) |

### 3. A/B resample verdict (Step 7)

Same prompt twice: once `myraa_ab_mode='A'`, once `'B'`. Compare
`pipeline-compare.json` + human listening. Keep only the winner's mode;
the flag is an experiment, not a permanent fork.

### 4. Source-lifetime proof (Step 4)

`srcStoppedEarly` and `srcOverlaps` must be 0 for a clean turn;
`srcCreated == srcStarted == srcEnded`. Any early stop/overlap is logged
with node id + reason in `voice.log` (`AUDIO_STOP`).

### 5. Smooth Voice Mode (default)

Proven by voice.log telemetry (underflow on ~every chunk, queue never ahead):
audio routinely arrives slower than real time, so per-chunk immediate playback
restarts from behind every time. Smooth mode buffers each turn in sequence and
starts playback only when measured delivery is safely faster than real time
(>=1.25x) with `SMOOTH_TARGET_SEC` (1.0 s, override `myraa_smooth_ms`
400–2,000 ms) queued — otherwise it waits for turn completion and plays the
whole turn continuously. A bare byte count never starts a slow turn: that only
postpones the underflow. During playback, if the buffer falls below 700 ms
while the turn is still arriving, scheduling pauses and resumes from the exact
next unplayed chunk (never replay, never drop) at turn end or buffer recovery.

* Opt-out streaming (experiment only): `myraa_live_stream='1'`.
* `SMOOTH_START` log: buffered seconds, measured rate, early-stream flag.
* `SMOOTH_PAUSE` / `SMOOTH_RESUME` trace reserve holds.
* Summary carries `playMode=`, `bufBeforePlay=`, `waitedComplete=`,
  `turnAudioSec=`, `scheduledSec=`, `arrivalRate=`, `earlyStreamingAllowed=`.
* Safety: turns buffering past 30 s start anyway; barge-in/STOP discards the
  turn buffer with the queue; retired sessions drain ungated (never mixed).

