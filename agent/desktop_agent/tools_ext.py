# MYRAA extended desktop tools — REAL Windows control (mouse, keyboard, processes,
# network, system detail, screenshots, audio via pycaw, clipboard).
# Optional deps are probed; missing deps raise honest ToolError (never fake success).
from __future__ import annotations
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

from .tools import ToolError
from .safe_paths import resolve_safe, _alias_root

try:
    import psutil
except ImportError:
    psutil = None

def _opt(name: str):
    try:
        return __import__(name)
    except Exception:
        return None

_pyautogui = _opt('pyautogui')
_mss = _opt('mss')
_pyperclip = _opt('pyperclip')

VERSION = '1.1.0'

# ---- permission levels: 0 safe, 1 user-action, 2 sensitive, 3 critical ----
TOOL_PERMISSIONS: dict[str, int] = {
    # new tools
    'launch_application': 1, 'list_running_applications': 0, 'application_exists': 0,
    'restart_application': 1, 'write_file': 1, 'append_file': 1, 'copy_file': 1,
    'create_directory': 1, 'delete_directory': 2, 'list_directory': 0, 'get_file_info': 0,
    'move_mouse': 1, 'click': 1, 'double_click': 1, 'right_click': 1, 'middle_click': 1,
    'drag': 1, 'scroll': 1, 'press_key': 1, 'hotkey': 1, 'type_text': 1,
    'key_down': 1, 'key_up': 1, 'screenshot': 0, 'screenshot_region': 0,
    'screen_size': 0, 'monitor_list': 0, 'active_window': 0,
    'list_windows': 0, 'focus_window': 1, 'restore_window': 1, 'move_window': 1,
    'resize_window': 1, 'read_clipboard': 0, 'write_clipboard': 1,
    'cpu_info': 0, 'ram_info': 0, 'disk_info': 0, 'battery_status': 0,
    'host_info': 0, 'uptime': 0, 'list_processes': 0, 'find_process': 0,
    'process_info': 0, 'terminate_process': 2, 'process_cpu_usage': 0,
    'process_memory_usage': 0, 'network_status': 0, 'list_adapters': 0,
    'ping': 0, 'dns_lookup': 0, 'local_ip': 0, 'wifi_status': 0,
    'open_url': 1, 'get_volume': 0, 'set_volume': 1, 'volume_up': 1,
    'volume_down': 1, 'mute': 1, 'unmute': 1, 'get_brightness': 0,
    'set_brightness': 2, 'battery': 0, 'lock_pc': 2, 'sleep_pc': 2,
    'run_command': 2, 'stop': 0, 'audio_devices': 0,
    'resolve_path': 0, 'check_path_access': 0, 'desktop_access_test': 0,
    'write_file_verified': 1, 'open_file': 1, 'list_drives': 0, 'drive_info': 0,
    'find_windows_app': 0, 'search_windows_app': 0,
    'file_exists': 0, 'file_info': 0, 'find_file': 0, 'search_drive': 0,
    'findApplication': 0, 'listApplicationMatches': 0, 'refreshApplicationIndex': 0,
    'focusApplication': 1,
    # upgraded legacy tools
    'takeScreenshot': 0, 'saveScreenshot': 1, 'analyzeScreenshot': 0, 'readScreen': 0,
    'copySelected': 1, 'pasteClipboard': 1, 'getClipboard': 0,
    'setVolume': 1, 'muteToggle': 1,
    # legacy registry tools (same names as main.py REGISTRY)
    'openApplication': 1, 'closeApplication': 1, 'openWebsite': 1,
    'searchWeb': 1, 'searchYouTube': 1, 'searchGoogle': 1, 'searchGitHub': 1,
    'createFile': 1, 'readFile': 0, 'renameFile': 1, 'deleteFile': 2,
    'moveFile': 1, 'openFolder': 1, 'listFiles': 0, 'searchFiles': 0,
    'volumeUp': 1, 'volumeDown': 1, 'requestPowerAction': 3, 'executePowerAction': 3,
    'minimizeWindow': 1, 'maximizeWindow': 1, 'closeWindow': 1, 'switchApplication': 1,
    'clearClipboard': 1, 'desktopBrowserOpen': 1, 'desktopBrowserNavigate': 1,
    'desktopBrowserOpenTab': 1, 'desktopBrowserCloseTab': 1, 'desktopBrowserSearch': 1,
    'desktopBrowserClick': 1, 'desktopBrowserType': 1, 'desktopBrowserFillForm': 1,
    'desktopBrowserGoBack': 1, 'desktopBrowserGoForward': 1, 'desktopBrowserScroll': 1,
    'createPythonFile': 1, 'runPythonScript': 2, 'createProjectFolder': 1,
    'writeCodeFile': 1, 'systemInfo': 0, 'gpuInfo': 0, 'temperatureInfo': 0,
    'brightnessUp': 1, 'brightnessDown': 1, 'setBrightness': 1,
    'enableAutoStart': 2, 'disableAutoStart': 2, 'getAutoStartStatus': 0,
}

PROTECTED_PROCESSES = {
    'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
    'lsass.exe', 'winlogon.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
    'taskhostw.exe', 'sihost.exe', 'ctfmon.exe', 'memory compression',
}

BLOCKED_COMMAND_PATTERNS = [
    'rm -rf /', 'format ', 'diskpart', 'bcdedit', 'cipher /w',
    'takeown', 'icacls', 'net user', 'mimikatz', 'sekurlsa',
    'disable-defender', 'set-mppreference', 'add-mppreference',
    'vssadmin delete', 'wbadmin delete', 'bcedit',
]
DANGEROUS_COMMAND_PATTERNS = [
    'shutdown', 'restart', 'rmdir /s', 'del /f /s', 'remove-item -recurse',
    'reg delete', 'reg add', 'schtasks', 'sc delete', 'taskkill /f /im svchost',
]

def classify_command(cmd: str) -> str:
    low = (cmd or '').lower()
    for p in BLOCKED_COMMAND_PATTERNS:
        if p in low:
            return 'BLOCKED'
    for p in DANGEROUS_COMMAND_PATTERNS:
        if p in low:
            return 'DANGEROUS'
    if any(k in low for k in ['del ', 'remove-item', 'rmdir', 'taskkill', 'stop-process', 'reg ']):
        return 'CAUTION'
    return 'SAFE'

def _need(mod, name: str):
    if mod is None:
        raise ToolError(f'{name} unavailable: pip install {name} (see agent/requirements.txt).')

def _ok(tool: str, message: str, data=None) -> dict:
    return {'success': True, 'tool': tool, 'message': message, 'data': data or {}}

# ---- applications (layered launch: resolve → single launch → verify) ----
# Duplicate protection: one voice request = at most one launch. A per-app
# 15-second recent-launch guard collapses double triggers; the Start-search
# fallback presses Enter exactly once. Normal user permissions throughout —
# never auto-elevate; UAC handles genuine elevation via the launched app.
_RECENT_LAUNCHES: dict = {}

def launch_application(name: str, timeout: float = 12.0) -> dict:
    req = (name or '').strip()
    if not req:
        raise ToolError('application name required.')
    norm = normalize_app_name(req)
    _applog.info('APP_LAUNCH_REQUEST requested=%r normalized=%r', req, norm)
    now = time.time()
    if now - _RECENT_LAUNCHES.get(norm, 0) < 15:
        _applog.info('APP_LAUNCH_DEDUPED normalized=%r (duplicate request suppressed)', norm)
        return _ok('launch_application', f'Launching {req} (duplicate request suppressed).',
                   {'name': req, 'duplicateSuppressed': True})
    try:
        found = find_application(req)
    except ToolError:
        raise
    data = found['data']
    entry = data.get('entry') or {}
    disp = data['matchedApplication']
    diag = {'requestedName': req, 'normalizedName': data['normalizedName'],
            'aliasUsed': data.get('aliasUsed', ''), 'matchingStrategy': data['matchingStrategy'],
            'matchedApplication': disp, 'shortcutPath': data.get('shortcutPath', ''),
            'targetPath': data.get('targetPath', ''), 'launchMethod': '', 'verificationResult': ''}
    method = ''
    try:
        method = _launch_entry(entry)
    except ToolError:
        # Last resort only: controlled Start-search for the DISCOVERED name.
        try:
            method = _start_search_fallback(disp)
        except ToolError as e:
            raise ToolError(f'I found {disp}, but could not launch it: {e}')
    diag['launchMethod'] = method
    _RECENT_LAUNCHES[norm] = now
    _applog.info('APP_LAUNCH_STARTED matched=%r method=%s strategy=%s', disp, method, data['matchingStrategy'])
    deadline = time.time() + float(timeout)
    while time.time() < deadline:
        try:
            if application_exists(disp).get('data', {}).get('running'):
                diag['verificationResult'] = 'verified-running'
                _applog.info('APP_LAUNCH_VERIFIED app=%r method=%s', disp, method)
                return _ok('launch_application', f'Opened {disp}.', {**diag, 'name': disp})
        except Exception:
            pass
        time.sleep(0.5)
    diag['verificationResult'] = 'unconfirmed'
    _applog.info('APP_LAUNCH_UNCONFIRMED app=%r method=%s', disp, method)
    return _ok('launch_application', f'I found {disp}, but Windows did not confirm that it opened.',
               {**diag, 'name': disp, 'verified': False})

def list_running_applications(limit: int = 100) -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    names = sorted({p.info.get('name', '') for p in psutil.process_iter(['name']) if p.info.get('name')})[:limit]
    return _ok('list_running_applications', f'{len(names)} processes.', {'processes': names})

def application_exists(name: str) -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    # AppX/Store apps run under different process names (WhatsApp.exe -> WhatsApp.Root),
    # so match normalized stems both ways.
    key = normalize_app_name(name).replace('.exe', '')
    me = key.split('.')[0]
    found = False
    for p in psutil.process_iter(['name']):
        pn = (p.info.get('name', '') or '').lower().replace('.exe', '')
        if pn == key or key in pn or pn in key or (me and (me in pn or pn in me)):
            found = True
            break
    return _ok('application_exists', f"{name} {'is' if found else 'is not'} running.", {'running': found})

def restart_application(name: str) -> dict:
    from . import tools as _t
    _t.close_application(name)
    time.sleep(1.0)
    msg = _t.open_application(name)
    return _ok('restart_application', msg)

# ---- files ----
def write_file(path: str, content: str = '', overwrite: bool = True) -> dict:
    from . import tools as _t
    msg = _t.create_file(path, content, overwrite)
    return _ok('write_file', msg, {'path': path, 'chars': len(content)})

def append_file(path: str, content: str = '') -> dict:
    p = resolve_safe(path)
    with open(p, 'a', encoding='utf-8') as f:
        f.write(content)
    return _ok('append_file', f'Appended {len(content)} chars to {p}.')

def copy_file(path: str, destination: str) -> dict:
    src = resolve_safe(path)
    dest = resolve_safe(destination)
    if dest.is_dir():
        dest = dest / src.name
    shutil.copy2(str(src), str(dest))
    return _ok('copy_file', f'Copied to {dest}.')

def create_directory(path: str) -> dict:
    p = resolve_safe(path)
    p.mkdir(parents=True, exist_ok=True)
    return _ok('create_directory', f'Created {p}.')

def delete_directory(path: str) -> dict:
    p = resolve_safe(path)
    shutil.rmtree(p)
    return _ok('delete_directory', f'Deleted {p}.')

def list_directory(path: str = '', name: str = '', pattern: str = '*') -> dict:
    root = _alias_root(name) if name else resolve_safe(path or '.')
    items = sorted(p.name for p in Path(root).glob(pattern))
    return _ok('list_directory', f'{len(items)} entries in {root}.', {'entries': items[:200]})

def get_file_info(path: str) -> dict:
    p = resolve_safe(path)
    st = p.stat()
    return _ok('get_file_info', str(p), {'size': st.st_size, 'mtime': st.st_mtime, 'is_dir': p.is_dir()})

# ---- mouse ----
def _pg():
    _need(_pyautogui, 'pyautogui')
    _pyautogui.FAILSAFE = True
    return _pyautogui

def move_mouse(x: int, y: int) -> dict:
    _pg().moveTo(int(x), int(y), duration=0.2)
    return _ok('move_mouse', f'Mouse at ({x},{y}).', {'x': int(x), 'y': int(y)})

def click(x: int | None = None, y: int | None = None, button: str = 'left') -> dict:
    pg = _pg()
    if x is None:
        pg.click(button=button)
    else:
        pg.click(int(x), int(y), button=button)
    return _ok('click', f'{button} click at ({x},{y}).')

def double_click(x: int | None = None, y: int | None = None) -> dict:
    pg = _pg()
    if x is None:
        pg.doubleClick()
    else:
        pg.doubleClick(int(x), int(y))
    return _ok('double_click', f'Double-click at ({x},{y}).')

def right_click(x: int | None = None, y: int | None = None) -> dict:
    return click(x, y, 'right')

def middle_click(x: int | None = None, y: int | None = None) -> dict:
    return click(x, y, 'middle')

def drag(x1: int, y1: int, x2: int, y2: int) -> dict:
    pg = _pg()
    pg.moveTo(int(x1), int(y1), duration=0.2)
    pg.dragTo(int(x2), int(y2), duration=0.4, button='left')
    return _ok('drag', f'Dragged ({x1},{y1})->({x2},{y2}).')

def scroll(amount: int) -> dict:
    _pg().scroll(int(amount))
    return _ok('scroll', f'Scrolled {amount}.')

# ---- keyboard ----
def press_key(key: str) -> dict:
    _pg().press(key)
    return _ok('press_key', f'Pressed {key}.')

def hotkey(*keys) -> dict:
    # Accept a list (AI schema), a single string ("ctrl+shift+esc" / "ctrl shift esc"), or varargs.
    if len(keys) == 1 and isinstance(keys[0], list):
        keys = keys[0]
    elif len(keys) == 1 and isinstance(keys[0], str):
        import re as _re
        keys = [k for k in _re.split(r'[+\s,]+', keys[0]) if k]
    keys = [str(k) for k in keys]
    if not keys:
        raise ToolError('No keys given.')
    _pg().hotkey(*keys)
    return _ok('hotkey', f"Hotkey {'+'.join(keys)} sent.")

def type_text(text: str, interval: float = 0.02) -> dict:
    _pg().typewrite(str(text), interval=float(interval))
    return _ok('type_text', f'Typed {len(str(text))} chars.')

def key_down(key: str) -> dict:
    _pg().keyDown(key)
    return _ok('key_down', f'{key} down.')

def key_up(key: str) -> dict:
    _pg().keyUp(key)
    return _ok('key_up', f'{key} up.')

# ---- screen ----
def screenshot() -> dict:
    _need(_mss, 'mss')
    import mss as _mssmod
    with _mssmod.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        return _ok('screenshot', f"{shot.width}x{shot.height} captured.", {'width': shot.width, 'height': shot.height})

def screenshot_region(x: int, y: int, width: int, height: int) -> dict:
    _need(_mss, 'mss')
    import mss as _mssmod
    with _mssmod.mss() as sct:
        shot = sct.grab({'left': int(x), 'top': int(y), 'width': int(width), 'height': int(height)})
        return _ok('screenshot_region', f'{shot.width}x{shot.height} region captured.')

def screen_size() -> dict:
    _need(_mss, 'mss')
    import mss as _mssmod
    with _mssmod.mss() as sct:
        mon = sct.monitors[1]
        return _ok('screen_size', f"{mon['width']}x{mon['height']}.", {'width': mon['width'], 'height': mon['height']})

def monitor_list() -> dict:
    _need(_mss, 'mss')
    import mss as _mssmod
    with _mssmod.mss() as sct:
        mons = [{'index': i, 'left': m['left'], 'top': m['top'], 'width': m['width'], 'height': m['height']}
                for i, m in enumerate(sct.monitors[1:], start=1)]
        return _ok('monitor_list', f'{len(mons)} monitor(s).', {'monitors': mons})

def active_window() -> dict:
    try:
        import win32gui  # type: ignore
        hwnd = win32gui.GetForegroundWindow()
        return _ok('active_window', win32gui.GetWindowText(hwnd), {'hwnd': int(hwnd)})
    except Exception as e:
        raise ToolError(str(e))

# ---- windows ----
def list_windows(limit: int = 100) -> dict:
    try:
        import win32gui  # type: ignore
        out = []
        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                t = win32gui.GetWindowText(hwnd)
                if t:
                    out.append(t)
        win32gui.EnumWindows(cb, None)
        return _ok('list_windows', f'{len(out)} windows.', {'windows': out[:limit]})
    except Exception as e:
        raise ToolError(str(e))

def focus_window(title: str, timeout: float = 15.0) -> dict:
    from . import tools as _t
    # Windows need a moment to appear after launch — poll before giving up.
    deadline = time.time() + float(timeout)
    last = ''
    while time.time() < deadline:
        try:
            return _ok('focus_window', _t.switch_application(title))
        except Exception as e:
            last = str(e)
            time.sleep(0.5)
    raise ToolError(last or f"No window matching '{title}'.")

def restore_window(title: str = '') -> dict:
    try:
        import win32gui, win32con  # type: ignore
        from .tools import _find_window
        hwnd = _find_window(title) if title else win32gui.GetForegroundWindow()
        if not hwnd:
            raise ToolError(f"No window matching '{title}'.")
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        return _ok('restore_window', 'Restored.')
    except Exception as e:
        raise ToolError(str(e))

def move_window(title: str, x: int, y: int) -> dict:
    try:
        import win32gui  # type: ignore
        from .tools import _find_window
        hwnd = _find_window(title)
        if not hwnd:
            raise ToolError(f"No window matching '{title}'.")
        rect = win32gui.GetWindowRect(hwnd)
        win32gui.MoveWindow(hwnd, int(x), int(y), rect[2] - rect[0], rect[3] - rect[1], True)
        return _ok('move_window', f'Moved {title} to ({x},{y}).')
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(str(e))

def resize_window(title: str, width: int, height: int) -> dict:
    try:
        import win32gui  # type: ignore
        from .tools import _find_window
        hwnd = _find_window(title)
        if not hwnd:
            raise ToolError(f"No window matching '{title}'.")
        rect = win32gui.GetWindowRect(hwnd)
        win32gui.MoveWindow(hwnd, rect[0], rect[1], int(width), int(height), True)
        return _ok('resize_window', f'Resized {title} to {width}x{height}.')
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(str(e))

# ---- clipboard ----
def read_clipboard(max_chars: int = 4000) -> dict:
    if _pyperclip is not None:
        try:
            return _ok('read_clipboard', 'Clipboard read.', {'text': str(_pyperclip.paste())[:max_chars]})
        except Exception:
            pass
    from . import tools as _t
    return _ok('read_clipboard', 'Clipboard read.', {'text': _t.get_clipboard(max_chars)})

def write_clipboard(text: str) -> dict:
    if _pyperclip is not None:
        try:
            _pyperclip.copy(str(text))
            return _ok('write_clipboard', f'Wrote {len(str(text))} chars.')
        except Exception:
            pass
    from . import tools as _t
    _t.clear_clipboard()
    # win32 path: put text via win32clipboard
    try:
        import win32clipboard  # type: ignore
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(str(text))
        win32clipboard.CloseClipboard()
        return _ok('write_clipboard', f'Wrote {len(str(text))} chars.')
    except Exception as e:
        raise ToolError(str(e))

# ---- system ----
def _mem() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    m = psutil.virtual_memory()
    return {'percent': m.percent, 'used_gb': round(m.used / 1e9, 2), 'total_gb': round(m.total / 1e9, 2)}

def cpu_info() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    import platform
    return _ok('cpu_info', 'CPU sampled.', {
        'percent': psutil.cpu_percent(interval=0.5),
        'cores': psutil.cpu_count(),
        'freq_mhz': getattr(psutil.cpu_freq(), 'current', None),
        'processor': platform.processor(),
    })

def ram_info() -> dict:
    return _ok('ram_info', 'RAM sampled.', _mem())

def disk_info() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    out = []
    for p in psutil.disk_partitions():
        try:
            u = psutil.disk_usage(p.mountpoint)
            out.append({'mount': p.mountpoint, 'percent': u.percent,
                        'used_gb': round(u.used / 1e9, 2), 'total_gb': round(u.total / 1e9, 2)})
        except Exception:
            continue
    return _ok('disk_info', f'{len(out)} volume(s).', {'volumes': out})

def battery_status() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    b = psutil.sensors_battery()
    if b is None:
        return _ok('battery_status', 'No battery (desktop).', {'present': False})
    return _ok('battery_status', f"{b.percent}%{', charging' if b.power_plugged else ''}.",
               {'present': True, 'percent': b.percent, 'charging': bool(b.power_plugged)})

battery = battery_status

def host_info() -> dict:
    import platform
    return _ok('host_info', 'Host identified.', {
        'hostname': socket.gethostname(), 'username': os.environ.get('USERNAME', ''),
        'windows': f'{platform.system()} {platform.release()} {platform.version()}',
    })

def uptime() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    import datetime as _dt
    secs = int(time.time() - psutil.boot_time())
    return _ok('uptime', str(_dt.timedelta(seconds=secs)), {'seconds': secs})

# ---- processes ----
def list_processes(limit: int = 100, sort_by: str = 'memory') -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    procs = []
    for p in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info']):
        try:
            mi = p.info.get('memory_info')
            procs.append({'pid': p.info['pid'], 'name': p.info.get('name', ''),
                          'cpu': p.info.get('cpu_percent') or 0,
                          'rss_mb': round((mi.rss if mi else 0) / 1e6, 1)})
        except Exception:
            continue
    key = {'memory': 'rss_mb', 'cpu': 'cpu'}.get(sort_by, 'rss_mb')
    procs.sort(key=lambda d: d[key], reverse=True)
    return _ok('list_processes', f'{len(procs)} processes.', {'processes': procs[:limit]})

def find_process(name: str) -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    key = (name or '').lower()
    found = [{'pid': p.pid, 'name': p.info.get('name', '')}
             for p in psutil.process_iter(['name'])
             if key in (p.info.get('name', '') or '').lower()]
    return _ok('find_process', f'{len(found)} match(es).', {'matches': found[:50]})

def process_info(pid: int) -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    p = psutil.Process(int(pid))
    with p.oneshot():
        return _ok('process_info', p.name(), {
            'pid': p.pid, 'name': p.name(), 'status': p.status(),
            'cpu_percent': p.cpu_percent(interval=0.3),
            'rss_mb': round(p.memory_info().rss / 1e6, 1),
            'cmdline': ' '.join(p.cmdline()[:4]),
        })

def terminate_process(pid: int = 0, name: str = '') -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    targets = []
    if pid:
        targets = [psutil.Process(int(pid))]
    elif name:
        key = name.lower()
        targets = [p for p in psutil.process_iter(['name'])
                   if (p.info.get('name', '') or '').lower() == key]
        if not targets:
            raise ToolError(f'No running process named {name}.')
    else:
        raise ToolError('pid or name required.')
    killed = []
    for p in targets:
        try:
            nm = (p.name() if pid else p.info.get('name', '')).lower()
        except Exception:
            nm = ''
        if nm in PROTECTED_PROCESSES:
            raise ToolError(f'Refused: {nm} is a protected system process.')
        try:
            p.terminate()
            killed.append(p.pid if pid else nm)
        except Exception as e:
            raise ToolError(f'terminate failed: {e}')
    return _ok('terminate_process', f'Terminated {killed}.', {'killed': killed})

# ---- network ----
def network_status() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    stats = psutil.net_if_stats()
    up = [k for k, v in stats.items() if v.isup]
    io = psutil.net_io_counters()
    return _ok('network_status', f'{len(up)} interface(s) up.',
               {'up': up, 'bytes_sent_mb': round(io.bytes_sent / 1e6, 1),
                'bytes_recv_mb': round(io.bytes_recv / 1e6, 1)})

def list_adapters() -> dict:
    if psutil is None:
        raise ToolError('psutil not installed.')
    out = []
    for name, addrs in psutil.net_if_addrs().items():
        ips = [a.address for a in addrs if a.family == socket.AF_INET]
        out.append({'name': name, 'ipv4': ips})
    return _ok('list_adapters', f'{len(out)} adapter(s).', {'adapters': out})

def ping(host: str, count: int = 2) -> dict:
    if not host:
        raise ToolError('host required.')
    flag = '-n' if os.name == 'nt' else '-c'
    try:
        r = subprocess.run(['ping', flag, str(count), host],
                           capture_output=True, text=True, timeout=15)
        return _ok('ping', f'ping {host} exit={r.returncode}.',
                   {'exit': r.returncode, 'output': (r.stdout or '')[:1500]})
    except Exception as e:
        raise ToolError(f'ping failed: {e}')

def dns_lookup(host: str) -> dict:
    if not host:
        raise ToolError('host required.')
    try:
        _, _, ips = socket.gethostbyname_ex(host)
        return _ok('dns_lookup', f'{host} -> {", ".join(ips)}.', {'ips': ips})
    except Exception as e:
        raise ToolError(f'DNS failed for {host}: {e}')

def local_ip() -> dict:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return _ok('local_ip', ip, {'ip': ip})
    except Exception as e:
        raise ToolError(f'local IP failed: {e}')

def wifi_status() -> dict:
    try:
        r = subprocess.run(['netsh', 'wlan', 'show', 'interfaces'],
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0 or 'There is no wireless interface' in (r.stdout or ''):
            return _ok('wifi_status', 'No Wi-Fi interface.', {'connected': False})
        ssid = ''
        for line in (r.stdout or '').splitlines():
            if 'SSID' in line and ':' in line and 'BSSID' not in line:
                ssid = line.split(':', 1)[1].strip()
                break
        return _ok('wifi_status', f'Connected to {ssid}.' if ssid else 'Interface present.',
                   {'connected': bool(ssid), 'ssid': ssid})
    except Exception as e:
        raise ToolError(f'Wi-Fi query failed: {e}')

# ---- browser / url ----
def open_url(url: str) -> dict:
    import webbrowser
    u = (url or '').strip()
    if not u:
        raise ToolError('url required.')
    if not u.startswith(('http://', 'https://')):
        u = 'https://' + u
    webbrowser.open(u)
    return _ok('open_url', f'Opened {u}.', {'url': u})

# ---- audio (pycaw, real) ----
def _endpoint():
    try:
        from comtypes import CLSCTX_ALL  # type: ignore
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume  # type: ignore
        from ctypes import cast, POINTER
        dev = AudioUtilities.GetSpeakers()
        raw = dev.Activate if hasattr(dev, 'Activate') else dev._dev.Activate
        return cast(raw(IAudioEndpointVolume._iid_, CLSCTX_ALL, None),
                    POINTER(IAudioEndpointVolume))
    except Exception as e:
        raise ToolError(f'Audio backend unavailable: {e}')

def get_volume() -> dict:
    v = _endpoint()
    pct = round(float(v.GetMasterVolumeLevelScalar()) * 100, 1)
    return _ok('get_volume', f'{pct}%.', {'percent': pct, 'muted': bool(v.GetMute())})

def set_volume(percent: float) -> dict:
    _endpoint().SetMasterVolumeLevelScalar(max(0.0, min(1.0, float(percent) / 100)), None)
    return _ok('set_volume', f'Volume -> {percent}%.', {'percent': float(percent)})

def volume_up(amount: float = 10) -> dict:
    v = _endpoint()
    cur = float(v.GetMasterVolumeLevelScalar()) * 100
    return set_volume(cur + float(amount))

def volume_down(amount: float = 10) -> dict:
    v = _endpoint()
    cur = float(v.GetMasterVolumeLevelScalar()) * 100
    return set_volume(cur - float(amount))

def mute() -> dict:
    _endpoint().SetMute(1, None)
    return _ok('mute', 'Muted.')

def unmute() -> dict:
    _endpoint().SetMute(0, None)
    return _ok('unmute', 'Unmuted.')

# ---- display brightness (WMI best-effort, honest when absent) ----
def get_brightness() -> dict:
    try:
        import wmi  # type: ignore
        b = wmi.WMI(namespace='wmi').WmiMonitorBrightness()[0]
        return _ok('get_brightness', f"{b.CurrentBrightness}%.",
                   {'percent': int(b.CurrentBrightness)})
    except Exception:
        raise ToolError('Brightness control unavailable (no WMI monitor interface on this machine).')

def set_brightness(percent: float) -> dict:
    try:
        import wmi  # type: ignore
        w = wmi.WMI(namespace='wmi')
        w.WmiMonitorBrightnessMethods()[0].WmiSetBrightness(int(percent), 0)
        return _ok('set_brightness', f'Brightness -> {percent}%.')
    except Exception:
        raise ToolError('Brightness control unavailable (no WMI monitor interface on this machine).')

# ---- power (immediate, sensitive) ----
def lock_pc() -> dict:
    import ctypes as _c
    _c.windll.user32.LockWorkStation()
    return _ok('lock_pc', 'Workstation locked.')

def sleep_pc() -> dict:
    subprocess.Popen(['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'])
    return _ok('sleep_pc', 'Sleep initiated.')

# ---- terminal with classification + confirmation gate ----
_pending_dangerous: dict[str, str] = {}

def run_command(command: str, confirm_token: str = '', timeout: int = 30) -> dict:
    cmd = (command or '').strip()
    if not cmd:
        raise ToolError('command required.')
    level = classify_command(cmd)
    if level == 'BLOCKED':
        raise ToolError(f'BLOCKED command refused: {cmd[:120]}')
    if level == 'DANGEROUS':
        import secrets as _s
        if not confirm_token or _pending_dangerous.get(confirm_token) != cmd:
            tok = _s.token_hex(8)
            _pending_dangerous[tok] = cmd
            raise ToolError(f'DANGEROUS command needs confirmation. Re-call with confirm_token={tok}.')
        del _pending_dangerous[confirm_token]
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=int(timeout), cwd=str(Path.home()))
        return _ok('run_command', f'exit={r.returncode} [{level}].',
                   {'exit': r.returncode, 'level': level,
                    'stdout': (r.stdout or '')[:4000], 'stderr': (r.stderr or '')[:2000]})
    except subprocess.TimeoutExpired:
        raise ToolError(f'Command timed out after {timeout}s.')
    except Exception as e:
        raise ToolError(f'run_command failed: {e}')

def stop() -> dict:
    return _ok('stop', 'Stop acknowledged (agent is stateless; Node cancels queued tasks).')

# ---- user file access (friendly paths, verified writes, diagnostics) ----
def _filename_from_text(text: str) -> str:
    """Pull an explicit filename (e.g. 'hello.txt') out of a 'save X on my desktop'
    style sentence. Returns '' when the text names only a folder."""
    import re as _re
    toks = _re.findall(r'"([^"]+)"|(\S+)', text or '')
    words = [a or b for a, b in toks]
    for w in reversed(words):
        w = w.strip('.,;:!?()[]')
        base = w.split('\\').pop().split('/').pop()
        if '.' in base and _re.fullmatch(r'[\w][\w.\- ]*\.\w{1,5}', base or ''):
            return base.strip()
    return ''

def resolve_path(text: str) -> dict:
    from .safe_paths import resolve_friendly, _alias_root
    t = (text or '').strip()
    if not t:
        raise ToolError('path text required.')
    friendly = resolve_friendly(t)
    if friendly is not None:
        # "Save hello.txt to my desktop" -> Desktop\hello.txt, not bare Desktop.
        fname = _filename_from_text(t)
        if fname:
            full = friendly / fname
            return _ok('resolve_path', str(full), {'path': str(full), 'via': 'friendly+filename'})
        return _ok('resolve_path', str(friendly), {'path': str(friendly), 'via': 'friendly'})
    p = Path(t).expanduser()
    if not p.is_absolute():
        # 'save X on my desktop' style: trailing folder phrase wins.
        base = resolve_friendly(t) or (_alias_root('documents') or Path.home())
        name = Path(t).name
        return _ok('resolve_path', str(base / name), {'path': str(base / name), 'via': 'relative'})
    return _ok('resolve_path', str(p), {'path': str(p), 'via': 'absolute'})

def check_path_access(path: str) -> dict:
    from .safe_paths import check_path_access as _cpa
    r = _cpa(path)
    return _ok('check_path_access', r.get('reason') or 'Access checked.', r)

def desktop_access_test() -> dict:
    # create -> write -> read -> delete in Desktop/Documents/Downloads. Nothing left behind.
    from .safe_paths import _alias_root
    import secrets as _s
    results = {}
    for alias in ('desktop', 'documents', 'downloads'):
        root = _alias_root(alias)
        if root is None or not root.exists():
            results[alias] = {'ok': False, 'error': 'folder not found'}
            continue
        probe = root / f'.myraa_access_test_{_s.token_hex(4)}.txt'
        try:
            probe.write_text('myraa-access-test', encoding='utf-8')
            ok = probe.read_text(encoding='utf-8') == 'myraa-access-test'
            probe.unlink(missing_ok=True)
            results[alias] = {'ok': ok, 'path': str(root)}
        except Exception as e:
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
            from .safe_paths import diagnose_write_error
            results[alias] = {'ok': False, 'error': diagnose_write_error(str(root), e)}
    all_ok = all(v.get('ok') for v in results.values())
    return _ok('desktop_access_test', 'All user folders writable.' if all_ok else 'Some folders failed (see detail).',
               {**results, 'all_ok': all_ok})

def write_file_verified(path: str, content: str = '', overwrite: bool = True) -> dict:
    from . import tools as _t
    from .safe_paths import diagnose_write_error, resolve_safe, check_path_access
    # Pre‑check write permissions before attempting creation (keep the real reason).
    access = check_path_access(path)
    if not access.get('writable'):
        why = access.get('reason') or 'Not writable'
        raise ToolError(f"I couldn't write to that location ({path}): {why} "
                        'Tell me a user folder (Desktop/Documents/Downloads) and I will save there instead.')
    try:
        msg = _t.create_file(path, content, overwrite)
    except Exception as e:
        raise ToolError(diagnose_write_error(path, e))
    # Verify: exists + size + content round‑trip.
    try:
        p = resolve_safe(path)
        back = p.read_text(encoding='utf-8')
        if back != content:
            raise ToolError(f'Verify failed: read‑back differs ({len(back)} vs {len(content)} chars).')
        return _ok('write_file', f'{msg} Verified {len(content)} chars at {p}.',
                    {'path': str(p), 'chars': len(content)})
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(f'Written but verify failed for {path}: {e}')

def open_file(query: str) -> dict:
    from .safe_paths import _alias_root
    q = (query or '').strip().lower()
    if not q:
        raise ToolError('file name required.')
    roots = [r for r in (_alias_root(a) for a in ('desktop', 'documents', 'downloads')) if r and r.exists()]
    one = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer')
    if one and Path(one).exists():
        roots.append(Path(one))
    scored = []
    for root in roots:
        try:
            for p in root.rglob('*'):
                if not p.is_file() or len(str(p)) > 400:
                    continue
                n = p.name.lower()
                if n == q or n == q + '.pdf' or n == q + '.docx':
                    scored.append((0, p))
                elif n.startswith(q):
                    scored.append((1, p))
                elif q in n:
                    scored.append((2, p))
                if len(scored) > 60:
                    break
        except Exception:
            continue
    if not scored:
        raise ToolError(f'No file matching {query!r} on Desktop/Documents/Downloads/OneDrive.')
    scored.sort(key=lambda t: (t[0], len(t[1].name)))
    if len(scored) > 1 and scored[0][0] == scored[1][0] == 2:
        cands = [str(p) for _, p in scored[:5]]
        raise ToolError(f"Multiple matches for {query!r}: {'; '.join(cands)}. Tell me which one.")
    best = scored[0][1]
    os.startfile(str(best))  # type: ignore[attr-defined]
    return _ok('open_file', f'Opened {best} with its default app.', {'path': str(best)})

def list_drives() -> dict:
    from .safe_paths import list_drives as _ld
    drives = _ld()
    return _ok('list_drives', f"{len(drives)} drive(s).", {'drives': drives})

def drive_info(drive: str) -> dict:
    from .safe_paths import list_drives as _ld
    key = (drive or '').strip().upper().rstrip(':')
    for d in _ld():
        if d['drive'] == f'{key}:':
            return _ok('drive_info', f"{d['drive']} {d['free_gb']}GB free of {d['total_gb']}GB.", d)
    raise ToolError(f'Drive not available: {drive}')

def file_exists(path: str) -> dict:
    p = resolve_safe(path)
    return _ok('file_exists', f"{p} {'exists' if p.exists() else 'does not exist'}.",
               {'path': str(p), 'exists': p.exists(), 'is_dir': p.is_dir() if p.exists() else False})

def file_info(path: str) -> dict:
    return get_file_info(path)

def find_file(name: str, folder: str = '', limit: int = 50) -> dict:
    """Targeted file search: likely user locations first, never a blind full-drive scan."""
    from .safe_paths import _alias_root
    q = (name or '').strip().lower()
    if not q:
        raise ToolError('file name required.')
    roots = []
    if folder:
        try:
            roots.append(resolve_safe(folder))
        except Exception as e:
            raise ToolError(str(e))
    else:
        for a in ('desktop', 'documents', 'downloads'):
            r = _alias_root(a)
            if r and r.exists():
                roots.append(r)
        one = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer')
        if one and Path(one).exists():
            roots.append(Path(one))
    scored = []
    for root in roots:
        try:
            for p in root.rglob('*'):
                if not p.is_file() or len(str(p)) > 400:
                    continue
                n = p.name.lower()
                if n == q:
                    scored.append((0, p))
                elif n.startswith(q):
                    scored.append((1, p))
                elif q in n:
                    scored.append((2, p))
                if len(scored) >= limit * 3:
                    break
        except Exception:
            continue
    scored.sort(key=lambda t: (t[0], len(t[1].name)))
    top = [str(p) for _, p in scored[:limit]]
    return _ok('find_file', f'{len(top)} match(es) for {name!r}.', {'matches': top})

def search_drive(query: str, drive: str = '', limit: int = 50) -> dict:
    """Targeted drive search: one explicit drive, name match only. No automatic full-PC scan."""
    from .safe_paths import list_drives as _ld
    q = (query or '').strip().lower()
    if not q:
        raise ToolError('query required.')
    key = (drive or '').strip().upper().rstrip(':')
    avail = {d['drive'] for d in _ld()}
    if key and f'{key}:' not in avail:
        raise ToolError(f'Drive not available: {drive}. Available: {sorted(avail)}.')
    root = Path(f'{key}:\\') if key else Path.home()
    out = []
    try:
        for p in root.rglob(f'*{q}*'):
            if len(out) >= limit:
                break
            try:
                if p.is_file() or p.is_dir():
                    out.append(str(p))
            except Exception:
                continue
    except Exception as e:
        raise ToolError(f'Drive search failed on {root}: {e}')
    return _ok('search_drive', f'{len(out)} match(es) on {root}.', {'matches': out, 'root': str(root)})

# ---- Windows application discovery + launch (layered, indexed, verified) ----
# Priority: aliases → system apps → Start Menu → Desktop → App Paths/PATH →
# registered (Uninstall) → StartApps → controlled Start-search fallback.
# Never ask the user for an exe path. Never blind-scan C:.
# One voice request produces at most one launch (recent-launch guard + single Enter).
import difflib as _difflib
import json as _json
import logging as _logging
import re as _re

_applog = _logging.getLogger('myraa.desktop')

APP_ALIASES = {
    'whatsapp': ['whatsapp', 'whats app', 'whatsapp desktop'],
    'chrome': ['chrome', 'google chrome'],
    'edge': ['edge', 'microsoft edge'],
    'firefox': ['firefox', 'mozilla firefox'],
    'discord': ['discord'],
    'telegram': ['telegram'],
    'spotify': ['spotify'],
    'notepad': ['notepad'],
    'calculator': ['calculator', 'calc'],
    'explorer': ['explorer', 'file explorer'],
    'settings': ['settings', 'windows settings'],
    'task manager': ['task manager', 'taskmanager'],
    'vscode': ['vscode', 'visual studio code', 'vs code', 'code'],
    'terminal': ['terminal', 'windows terminal'],
    'powershell': ['powershell'],
    'cmd': ['cmd', 'command prompt'],
    'paint': ['paint', 'mspaint'],
    'word': ['word', 'microsoft word', 'winword'],
    'excel': ['excel', 'microsoft excel'],
    'powerpoint': ['powerpoint', 'microsoft powerpoint'],
    'steam': ['steam'],
    'obs': ['obs', 'obs studio'],
    'photoshop': ['photoshop', 'adobe photoshop'],
    'wordpad': ['wordpad'],
    'snipping tool': ['snipping tool', 'snip', 'snippingtool'],
    'control panel': ['control panel', 'control'],
}

# Safe Windows system targets (Layer 2). Launched via PATH lookup or shell URI —
# never a hardcoded C:\ path, never elevation.
_SYSTEM_APPS = {
    'notepad': 'notepad.exe',
    'calculator': 'calc.exe',
    'paint': 'mspaint.exe',
    'explorer': 'explorer.exe',
    'cmd': 'cmd.exe',
    'powershell': 'powershell.exe',
    'task manager': 'taskmgr.exe',
    'wordpad': 'write.exe',
    'snipping tool': 'snippingtool.exe',
    'control panel': 'control.exe',
    'terminal': 'wt.exe',
    'settings': 'ms-settings:',
}

def _norm_app_text(text: str) -> str:
    t = (text or '').lower()
    t = _re.sub(r'[^a-z0-9\s]', ' ', t)
    return _re.sub(r'\s+', ' ', t).strip()

def normalize_app_name(text: str) -> str:
    t = _norm_app_text(text)
    for verb in ('open ', 'start ', 'launch ', 'run ', 'please ', 'myraa '):
        if t.startswith(verb):
            t = t[len(verb):].strip()
    if t.endswith(' exe'):
        t = t[:-4].strip()
    for canon, variants in APP_ALIASES.items():
        if t == canon or t in {_norm_app_text(v) for v in variants}:
            return canon
    return t

def alias_used_for(text: str) -> str:
    """Canonical alias key when the request matched an alias variant, else ''."""
    t = _norm_app_text(text)
    for verb in ('open ', 'start ', 'launch ', 'run ', 'please ', 'myraa '):
        if t.startswith(verb):
            t = t[len(verb):].strip()
    for canon, variants in APP_ALIASES.items():
        norms = {_norm_app_text(v) for v in variants}
        if t in norms and t != canon:
            return canon
    return ''

def _lnk_target(lnk: str) -> str:
    from win32com.client import Dispatch  # type: ignore
    sc = Dispatch('WScript.Shell').CreateShortcut(lnk)
    return str(sc.TargetPath or '')

def _url_target(url_file: str) -> str:
    try:
        for line in Path(url_file).read_text(encoding='utf-8', errors='replace').splitlines():
            if line.strip().lower().startswith('url='):
                return line.strip()[4:].strip()
    except Exception:
        pass
    return ''

def _start_menu_bases() -> list:
    return [Path(os.environ.get('APPDATA', '')) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs',
            Path(os.environ.get('PROGRAMDATA', r'C:\ProgramData')) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs']

def _scan_system() -> list:
    out = []
    for name, target in _SYSTEM_APPS.items():
        if target.endswith(':') or shutil.which(target):
            out.append({'displayName': name.title() if name != 'cmd' else 'cmd',
                        'normalizedName': _norm_app_text(name),
                        'shortcutPath': '', 'targetPath': target, 'source': 'system'})
    return out

def _scan_shortcut_dir(base, source: str, recursive: bool) -> list:
    out = []
    try:
        if not base.exists():
            return out
        pats = ('*.lnk', '*.url', '*.application-ref')
        files = []
        for pat in pats:
            files += list(base.rglob(pat) if recursive else base.glob(pat))
        for f in files:
            try:
                stem = f.stem
                target = ''
                if f.suffix.lower() == '.lnk':
                    try:
                        target = _lnk_target(str(f))
                    except Exception:
                        target = ''
                elif f.suffix.lower() == '.url':
                    target = _url_target(str(f))
                out.append({'displayName': stem, 'normalizedName': _norm_app_text(stem),
                            'shortcutPath': str(f), 'targetPath': target, 'source': source})
            except Exception:
                continue
    except Exception:
        pass
    return out

def _scan_app_paths() -> list:
    out = []
    try:
        import winreg  # type: ignore
        for hive, flag in ((winreg.HKEY_CURRENT_USER, 0),
                           (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
                           (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY)):
            try:
                with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\App Paths', 0, winreg.KEY_READ | flag) as root:
                    for i in range(winreg.QueryInfoKey(root)[0]):
                        try:
                            sub = winreg.EnumKey(root, i)
                        except Exception:
                            continue
                        try:
                            with winreg.OpenKey(root, sub) as k:
                                exe, _ = winreg.QueryValueEx(k, '')
                            disp = sub[:-4] if sub.lower().endswith('.exe') else sub
                            out.append({'displayName': disp, 'normalizedName': _norm_app_text(disp),
                                        'shortcutPath': '', 'targetPath': str(exe), 'source': 'apppaths'})
                        except Exception:
                            continue
            except Exception:
                continue
    except Exception:
        pass
    return out

def _scan_uninstall() -> list:
    out = []
    try:
        import winreg  # type: ignore
        for hive, flag in ((winreg.HKEY_CURRENT_USER, 0),
                           (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
                           (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY)):
            for sub in (r'Software\Microsoft\Windows\CurrentVersion\Uninstall',
                        r'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'):
                try:
                    with winreg.OpenKey(hive, sub, 0, winreg.KEY_READ | flag) as root:
                        for i in range(winreg.QueryInfoKey(root)[0]):
                            try:
                                sk = winreg.EnumKey(root, i)
                            except Exception:
                                continue
                            try:
                                with winreg.OpenKey(root, sk) as k:
                                    try:
                                        disp, _ = winreg.QueryValueEx(k, 'DisplayName')
                                    except Exception:
                                        continue
                                    if not disp:
                                        continue
                                    try:
                                        loc, _ = winreg.QueryValueEx(k, 'InstallLocation')
                                    except Exception:
                                        loc = ''
                                    try:
                                        icon, _ = winreg.QueryValueEx(k, 'DisplayIcon')
                                    except Exception:
                                        icon = ''
                                    target = str(icon).split(',')[0].strip().strip('"') or str(loc or '')
                                    out.append({'displayName': str(disp), 'normalizedName': _norm_app_text(str(disp)),
                                                'shortcutPath': '', 'targetPath': target,
                                                'location': str(loc or ''), 'source': 'uninstall'})
                            except Exception:
                                continue
                except Exception:
                    continue
    except Exception:
        pass
    return out

def _scan_startapps() -> list:
    out = []
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-StartApps | ConvertTo-Json'],
                           capture_output=True, text=True, timeout=25)
        apps = _json.loads(r.stdout or '[]')
        if isinstance(apps, dict):
            apps = [apps]
        for a in apps:
            nm = str(a.get('Name', ''))
            if not nm:
                continue
            out.append({'displayName': nm, 'normalizedName': _norm_app_text(nm),
                        'shortcutPath': '', 'targetPath': '', 'appid': a.get('AppID'),
                        'source': 'startapps'})
    except Exception:
        pass
    return out

# ---- application index cache: built once, refreshed on start/refresh/TTL ----
_APP_INDEX: dict | None = None
_APP_INDEX_TTL_SEC = 900  # 15 minutes; voice commands never rescan per call

def build_application_index(force: bool = False) -> dict:
    global _APP_INDEX
    now = time.time()
    if not force and _APP_INDEX is not None and now - _APP_INDEX.get('built_at', 0) < _APP_INDEX_TTL_SEC:
        return _APP_INDEX
    apps: list = []
    counts: dict = {}
    for source, entries in (('system', _scan_system()),
                            ('startmenu', [e for b in _start_menu_bases() for e in _scan_shortcut_dir(b, 'startmenu', True)]),
                            ('desktop', _scan_shortcut_dir(Path.home() / 'Desktop', 'desktop', False)),
                            ('apppaths', _scan_app_paths()),
                            ('uninstall', _scan_uninstall()),
                            ('startapps', _scan_startapps())):
        counts[source] = len(entries)
        apps.extend(entries)
    # De-duplicate identical (source, normalizedName) pairs.
    seen = set()
    uniq = []
    for e in apps:
        key = (e['source'], e['normalizedName'])
        if key in seen or not e['normalizedName']:
            continue
        seen.add(key)
        uniq.append(e)
    _APP_INDEX = {'built_at': now, 'apps': uniq, 'counts': counts}
    _applog.info('APP_INDEX built=%d counts=%s', len(uniq), counts)
    return _APP_INDEX

def refresh_application_index() -> dict:
    idx = build_application_index(force=True)
    return _ok('refreshApplicationIndex', f"Application index rebuilt: {len(idx['apps'])} entries.",
               {'count': len(idx['apps']), 'counts': idx['counts']})

def _match_score(qnorm: str, alias_canon: str, entry: dict) -> tuple:
    """(score 0-100, strategy). Exact > alias > prefix > contains > fuzzy."""
    en = entry.get('normalizedName', '')
    if not qnorm or not en:
        return (0, 'none')
    if qnorm == en:
        return (100, 'exact')
    # The alias canon naming an entry exactly (chrome→chrome.exe) wins outright.
    if alias_canon and alias_canon == en:
        return (100, 'alias')
    if alias_canon and (alias_canon in en or en in alias_canon):
        return (95, 'alias')
    if en.startswith(qnorm) or qnorm.startswith(en):
        return (80, 'prefix')
    if qnorm in en:
        return (70, 'contains')
    if en in qnorm:
        return (65, 'contains')
    r = _difflib.SequenceMatcher(None, qnorm, en).ratio()
    if r >= 0.6:
        return (max(15, int(r * 100) - 45), 'fuzzy')
    return (0, 'none')

# Source preference when the SAME application appears in several layers:
# faithful shortcuts first, direct exes next, store last.
_SOURCE_PREFERENCE = ('startmenu', 'system', 'desktop', 'apppaths', 'path', 'uninstall', 'startapps')

def list_application_matches(name: str, limit: int = 5) -> dict:
    """Ranked candidates for a (partial) application name. Never launches.
    Same-app duplicates across layers collapse to one candidate (best source),
    so 'Notepad' never ambiguates against itself."""
    req = (name or '').strip()
    if not req:
        raise ToolError('application name required.')
    qnorm = normalize_app_name(req)
    canon = alias_used_for(req) or (qnorm if qnorm in APP_ALIASES else '')
    idx = build_application_index()
    best_by_name: dict = {}
    for e in idx['apps']:
        score, strategy = _match_score(qnorm, canon, e)
        if score >= 15:
            key = e['normalizedName']
            prev = best_by_name.get(key)
            if prev is None or (score, -_SOURCE_PREFERENCE.index(e['source'])) > \
                    (prev[0], -_SOURCE_PREFERENCE.index(prev[2]['source'])):
                best_by_name[key] = (score, strategy, e)
    scored = sorted(best_by_name.values(), key=lambda t: (-t[0], len(t[2]['displayName'])))
    top = [{**e, 'score': s, 'strategy': st} for s, st, e in scored[:max(1, int(limit or 5))]]
    return _ok('listApplicationMatches', f'{len(top)} candidate(s) for {req!r}.',
               {'requestedName': req, 'normalizedName': qnorm, 'aliasUsed': canon,
                'matches': [{'displayName': m['displayName'], 'score': m['score'],
                             'strategy': m['strategy'], 'source': m['source'],
                             'shortcutPath': m.get('shortcutPath', ''),
                             'targetPath': m.get('targetPath', '')} for m in top]})

def find_application(name: str) -> dict:
    """Best installed match or an honest ask/disambiguation. Never launches."""
    req = (name or '').strip()
    if not req:
        raise ToolError('application name required.')
    res = list_application_matches(req, limit=5)
    matches = res['data']['matches']
    if not matches or matches[0]['score'] < 40:
        # Match-time PATH layer (not indexed — PATH dirs are too broad to enumerate).
        for cand in (res['data']['normalizedName'], req.strip()):
            exe = shutil.which(cand) or shutil.which(cand + '.exe')
            if exe:
                entry = {'displayName': cand, 'normalizedName': _norm_app_text(cand),
                         'shortcutPath': '', 'targetPath': exe, 'source': 'path'}
                data = {'requestedName': req, 'normalizedName': res['data']['normalizedName'],
                        'aliasUsed': res['data']['aliasUsed'], 'matchingStrategy': 'path',
                        'matchedApplication': cand, 'score': 75,
                        'shortcutPath': '', 'targetPath': exe,
                        'launchMethod': '', 'verificationResult': 'not-launched', 'entry': entry}
                _applog.info('APP_MATCH_FOUND requested=%r matched=%r strategy=path', req, cand)
                return _ok('findApplication', f'Found {cand} (PATH).', data)
        raise ToolError(f'Could not discover an installed app matching {req!r}. '
                        'Tell me the exact name as shown in Start Menu, or say "refresh applications".')
    best = matches[0]
    # A 100-point match (exact name or alias-canon hit) launches outright —
    # never ask "chrome or Google Chrome" when the user said chrome.
    # Ambiguity is only real between distinct, closely-scored names below that.
    if best['score'] < 100 and len(matches) > 1 and matches[1]['score'] >= 60 and best['score'] - matches[1]['score'] <= 8:
        cands = '; '.join(m['displayName'] for m in matches[:3])
        raise ToolError(f"I found two matches: {best['displayName']} and {matches[1]['displayName']}. "
                        f'Which one should I open? (candidates: {cands})')
    idx = build_application_index()
    entry = next((e for e in idx['apps']
                  if e['normalizedName'] == _norm_app_text(best['displayName'])
                  and e['source'] == best['source']), None)
    data = {'requestedName': req, 'normalizedName': res['data']['normalizedName'],
            'aliasUsed': res['data']['aliasUsed'], 'matchingStrategy': best['strategy'],
            'matchedApplication': best['displayName'], 'score': best['score'],
            'shortcutPath': best.get('shortcutPath', ''), 'targetPath': best.get('targetPath', ''),
            'launchMethod': '', 'verificationResult': 'not-launched',
            'entry': entry or best}
    _applog.info('APP_MATCH_FOUND requested=%r matched=%r strategy=%s score=%d source=%s',
                 req, best['displayName'], best['strategy'], best['score'], best['source'])
    return _ok('findApplication', f"Found {best['displayName']} ({best['strategy']}).", data)

def find_windows_app(name: str) -> dict:
    # Legacy entry point (tools.open_application + older clients). Delegates to
    # the indexed resolver; keeps the historical method/target/lnk/appid shape.
    found = find_application(name)
    d = found['data']
    entry = d.get('entry', {})
    method = entry.get('source', 'startmenu')
    out = {'name': d['matchedApplication'], 'method': method,
           'target': d.get('targetPath', '') or entry.get('targetPath', ''),
           'shortcutPath': d.get('shortcutPath', ''), 'targetPath': d.get('targetPath', ''),
           'strategy': d.get('matchingStrategy', ''), 'score': d.get('score', 0)}
    if entry.get('shortcutPath'):
        out['lnk'] = entry['shortcutPath']
    if entry.get('appid'):
        out['appid'] = entry['appid']
    if entry.get('location'):
        out['location'] = entry['location']
    return _ok('find_windows_app', found['message'], out)

def search_windows_app(query: str) -> dict:
    # API-first ranked listing across the cached index (no UI touched).
    res = list_application_matches(query, limit=10)
    names = [m['displayName'] for m in res['data']['matches']]
    return _ok('search_windows_app', f'{len(names)} candidate(s).', {'candidates': names})

def _launch_entry(entry: dict) -> str:
    """One shell launch for a resolved entry. Returns the launch method used."""
    source = entry.get('source', '')
    shortcut = entry.get('shortcutPath', '')
    target = entry.get('targetPath', '')
    if source in ('startmenu', 'desktop') and shortcut:
        os.startfile(shortcut)  # type: ignore[attr-defined]
        return f'shell-shortcut:{source}'
    if source == 'startapps' and entry.get('appid'):
        os.startfile(f"shell:AppsFolder\\{entry['appid']}")  # type: ignore[attr-defined]
        return 'shell:AppsFolder'
    if target:
        if target.endswith(':') or target.lower().startswith(('http://', 'https://', 'ms-settings:')):
            os.startfile(target)  # type: ignore[attr-defined]
            return 'shell-uri'
        exe = target if os.path.isfile(target) else (shutil.which(target) or '')
        if exe:
            subprocess.Popen([exe], shell=False)
            return 'direct-exe'
    if shortcut:
        os.startfile(shortcut)  # type: ignore[attr-defined]
        return 'shell-shortcut:fallback'
    raise ToolError(f"Found {entry.get('displayName', '?')} but it has no launchable target.")

def _start_search_fallback(display_name: str) -> str:
    """Last-resort equivalent of Win key → type name → Enter, exactly once.
    Input is the DISCOVERED display name (never raw voice text): strict allowlist,
    length-capped, one Enter press. No shell commands, no injection surface."""
    q = _re.sub(r'[^A-Za-z0-9 .+_()/-]', '', display_name or '').strip()[:60]
    if not q:
        raise ToolError('Start-search fallback refused: nothing safe to type.')
    pg = _pg()
    pg.press('win')
    time.sleep(0.8)
    pg.typewrite(q, interval=0.03)
    time.sleep(1.2)
    pg.press('enter')  # exactly once — never double-Enter
    return 'start-search-fallback'

def focus_application(name: str) -> dict:
    """Resolve via the index, then bring its window forward (polls for appearance)."""
    found = find_application(name)
    disp = found['data']['matchedApplication']
    try:
        msg = focus_window(disp, timeout=15.0)
        method = msg.get('message', '')
    except ToolError:
        method = focus_window((name or '').strip(), timeout=8.0).get('message', '')
    return _ok('focusApplication', f'{disp}: {method}',
               {**{k: v for k, v in found['data'].items() if k != 'entry'},
                'launchMethod': 'focus-window', 'verificationResult': method})

def _mix_format(imm_device) -> dict:
    # Read-only WASAPI shared-mode format (WAVEFORMATEX). Never modifies settings.
    from comtypes import CLSCTX_ALL
    from pycaw.api.audioclient import IAudioClient
    from ctypes import cast, POINTER
    raw = imm_device.Activate(IAudioClient._iid_, CLSCTX_ALL, None)
    client = cast(raw, POINTER(IAudioClient))
    fmt = client.GetMixFormat()
    w = fmt.contents
    tag = {1: 'PCM', 3: 'IEEE_FLOAT', 65534: 'EXTENSIBLE'}.get(w.wFormatTag, f'tag:{w.wFormatTag}')
    return {'encoding': tag, 'sampleRate': int(w.nSamplesPerSec),
            'channels': int(w.nChannels), 'bitDepth': int(w.wBitsPerSample)}

# ---- audio device diagnostics (TEST D: hands-free / enhancement detection) ----
def audio_devices() -> dict:
    info: dict = {'render': [], 'default': None, 'warnings': []}
    try:
        import pythoncom  # type: ignore  # COM must init per calling thread (uvicorn workers)
        pythoncom.CoInitialize()
    except Exception:
        pass
    try:
        from comtypes import CLSCTX_ALL, COMError  # type: ignore
        from pycaw.pycaw import AudioUtilities  # type: ignore
        from pycaw.constants import EDataFlow, ERole, DEVICE_STATE  # type: ignore
        devices = AudioUtilities.GetAllDevices()
        try:
            active_val = int(DEVICE_STATE.ACTIVE.value)
        except Exception:
            active_val = 1
        capture_words = ('microphone', 'mic ', 'line in', 'stereo mix', 'what u hear', 'input')
        for d in devices:
            try:
                try:
                    active = int(d.state) == active_val
                except Exception:
                    active = 'unplug' not in str(getattr(d, 'state', '')).lower()
                if not active:
                    continue
                name = d.FriendlyName
                if any(k in name.lower() for k in capture_words):
                    continue  # capture endpoint, not render
                info['render'].append({'name': name, 'id': d.id})
                low = name.lower()
                if any(k in low for k in ['hands-free', 'headset', 'hfp', 'handsfree']):
                    info['warnings'].append(
                        f'BLUETOOTH HANDS-FREE profile in use: "{name}". '
                        'HFP is narrow-band (~8kHz, radio-like). Switch Windows output to '
                        '"Stereo / Headphones (High Quality)" for full-band audio.')
            except Exception:
                continue
        try:
            info['default'] = AudioUtilities.GetSpeakers().FriendlyName
        except Exception:
            pass
        # Capture devices from the same enumerated wrappers used for render
        # (GetMicrophone() returns a raw IMMDevice with no FriendlyName/_dev).
        capture_words = ('microphone', 'mic ', 'line in', 'stereo mix', 'what u hear', 'input')
        captures = []
        for d in AudioUtilities.GetAllDevices():
            try:
                nm = d.FriendlyName
            except Exception:
                continue
            if any(k in nm.lower() for k in capture_words):
                try:
                    st = 'ACTIVE' if int(d.state) == active_val else str(d.state)
                except Exception:
                    st = str(getattr(d, 'state', 'unknown'))
                captures.append({'name': nm, 'id': d.id, 'state': st})
        info['capture_devices'] = captures
        try:
            # Proper default: MMDeviceEnumerator, matched by endpoint ID.
            enum = AudioUtilities.GetDeviceEnumerator()
            default_cap_id = enum.GetDefaultAudioEndpoint(1, 0).GetId()
            match = next((c for c in captures if c['id'] == default_cap_id), None)
            info['default_capture'] = match or {'name': None, 'id': None, 'state': 'UNAVAILABLE'}
        except Exception:
            info['default_capture'] = captures[0] if captures else {'name': None, 'id': None, 'state': 'UNAVAILABLE'}
        # Shared-mode (WASAPI mix) formats — actual Windows settings, read-only.
        # NOTE: GetSpeakers() is an AudioDevice wrapper (._dev); GetMicrophone()
        # is a raw IMMDevice — pass each through accordingly. Never touch settings.
        try:
            info['render_format'] = _mix_format(AudioUtilities.GetSpeakers()._dev)
        except Exception as e:
            info['render_format'] = {'error': str(e), 'available': False}
        try:
            info['capture_format'] = _mix_format(AudioUtilities.GetMicrophone())
        except Exception as e:
            info['capture_format'] = {'error': str(e), 'available': False}
    except Exception as e:
        raise ToolError(f'Device enumeration failed: {e}')
    info['warnings'].append(
        'Also check manually: Windows Settings > Sound > device Properties > '
        'Audio Enhancements OFF for testing; Spatial Audio OFF; '
        'Sound Control Panel (mmsys.cpl) > Communications tab = "Do nothing"; '
        'manufacturer DSP apps (Dolby/DTS/Realtek/Waves) can narrow or color the voice.')
    return _ok('audio_devices', f"{len(info['render'])} active output device(s).", info)