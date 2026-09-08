# MYRAA Capability Matrix (verified 2026-09-06, Windows 11, agent v1.1.0, 123 tools)

Legend: REAL = executed on this machine today. DEGRADED = works partially, honest limits.
STUB = present but raises an honest "not available" error (never fake success).
BLOCKED = refused by safety layer.

## Applications / Windows / Processes — REAL
launch_application, openApplication, close_application, restart_application,
findApplication, listApplicationMatches, refreshApplicationIndex, focusApplication,
list_running_applications, application_exists, list_processes, find_process,
process_info, process_cpu_usage, process_memory_usage, list_windows, active_window,
focus_window (8s retry), restore_window, move_window, resize_window,
minimizeWindow, maximizeWindow, closeWindow, switchApplication. terminate_process REAL
but refuses protected system processes (system, svchost.exe, explorer.exe, ...).

## Files — REAL
createFile/readFile/renameFile/deleteFile/moveFile, write_file, append_file, copy_file,
create_directory/delete_directory, list_directory/listFiles, search_files, get_file_info,
createPythonFile, writeCodeFile, createProjectFolder, openFolder.

## Mouse / Keyboard — REAL (pyautogui)
move_mouse, click, double_click, right_click, middle_click, drag, scroll,
press_key, hotkey (e.g. ctrl+shift+esc), type_text, key_down, key_up,
copySelected, pasteClipboard.

## Screen — REAL capture, DEGRADED OCR
screenshot, screenshot_region, screen_size (1920x1080 here), monitor_list,
takeScreenshot, saveScreenshot (to ~/Pictures). analyzeScreenshot/readScreen capture
successfully but report that OCR is not bundled.

## Clipboard — REAL
read_clipboard, write_clipboard (round-trip verified), getClipboard, clearClipboard.

## System / Network — REAL
systemInfo, cpu_info, ram_info, disk_info, host_info, uptime, battery_status
(reports "no battery" on desktops), network_status, list_adapters, ping,
dns_lookup, local_ip, wifi_status. gpuInfo/temperatureInfo: STUB (honest
"not bundled/unavailable" messages).

## Audio — REAL (pycaw)
get_volume, set_volume, volume_up, volume_down, mute, unmute, muteToggle, setVolume.

## Display — DEGRADED
get_brightness/set_brightness raise honest errors on machines without a WMI
monitor interface (desktops). Laptops with WMI monitors: REAL.

## Power — REAL, gated
lock_pc/sleep_pc (L2, confirm first). requestPowerAction/executePowerAction
two-step token gate (L3). shutdown/restart ALWAYS require explicit confirmation.

## Terminal — REAL, classified
run_command + runPythonScript. run_command classifies SAFE/CAUTION/DANGEROUS/BLOCKED:
SAFE executes, DANGEROUS needs a confirm_token round-trip, BLOCKED (disk wipes,
credential theft, AV disabling) is always refused. Verified: `python --version`
exit=0; `format C:` refused.

## Browser
open_url/openWebsite/searchWeb/searchYouTube/searchGoogle/searchGitHub: REAL
(opens default browser). desktopBrowser*: STUB — raise honest "Playwright browser
not bundled" errors. In-app Web Console proxy works for simple sites; youtube.com
homepage cannot be framed (Google X-Frame-Options) — use embeds.

## Execution engine (Node server/tasks.ts)
POST /api/tasks {steps:[{tool,args,verify?}]} → MYRAA-TASK-000001… states
PENDING→RUNNING→SUCCESS/FAILED/CANCELLED/WAITING_CONFIRMATION.
L3 tools need args.confirmed=true. Agent token gates surface as
WAITING_CONFIRMATION. POST /api/tasks/:id/cancel, POST /api/stop (emergency stop),
GET /api/doctor (PASS/FAIL/DEGRADED/MISSING per check). Every step logged to
logs/tasks.log with secrets redacted. /live AI tool calls execute through the
same verified path with auto-verification (launch→application_exists,
create→read-back) and the AI only reports success after tool success.

## Acceptance (this machine, real actions)
1 Open Notepad ✅ · 2 Type "Hello MYRAA" ✅ (focused Notepad, 11 chars) ·
3 Create MYRAA_TEST ✅ · 4 test.txt "MYRAA works" ✅ · 5 Read ✅ · 6 Delete ✅ ·
7 CPU/RAM ✅ · 8 Chrome+YouTube ✅ · 9 Screenshot 1920x1080 ✅ ·
10 Running processes ✅ (248) · 11 STOP ✅ (all tasks cancelled).
