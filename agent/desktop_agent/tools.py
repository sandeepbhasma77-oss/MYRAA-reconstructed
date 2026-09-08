# RECREATED — MYRAA desktop control tools (58-tool surface observed in agent.log).
# Each function returns a plain string result; errors raise ToolError.
# Windows-first, best-effort fallbacks elsewhere. Power actions are two-step gated.
from __future__ import annotations
import ctypes
import os
import secrets
import shutil
import subprocess
import time
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path

try:
    import psutil
except ImportError:
    psutil = None

from .safe_paths import resolve_safe, _alias_root

VERSION = '1.0.0'

class ToolError(Exception):
    pass

# ---- power-action gating ----
_pending_power: dict[str, datetime] = {}

# ---- helpers ----
def _win_ver() -> str:
    return f"{os.name}/{os.sys.platform}"

def open_application(name: str) -> str:
    # Never demand an exe path: discover via Start Menu / App Paths / PATH / StartApps.
    try:
        from . import tools_ext as _x
        found = _x.find_windows_app(name)
        data = found.get('data', {})
        method = data.get('method', '')
        if method == 'startapps' and data.get('appid'):
            os.startfile(f"shell:AppsFolder\\{data['appid']}")  # type: ignore[attr-defined]
            return f"Opened {data['name']}."
        target = data.get('target') or data.get('lnk') or name
        if target.endswith('.lnk') or (target.endswith(':')):
            os.startfile(target)  # type: ignore[attr-defined]
            return f"Opened {data.get('name', name)}."
        subprocess.Popen(target, shell=False)
        return f"Opened {data.get('name', name)}."
    except ToolError:
        pass  # fall through to legacy direct launch
    except Exception:
        pass
    targets = {'notepad': 'notepad.exe', 'calculator': 'calc.exe', 'explorer': 'explorer.exe',
               'cmd': 'cmd.exe', 'powershell': 'powershell.exe', 'settings': 'ms-settings:',
               'taskmanager': 'taskmgr.exe', 'task manager': 'taskmgr.exe',
               'chrome': 'chrome.exe', 'vscode': 'code.exe', 'code': 'code.exe'}
    key = (name or '').strip().lower()
    exe = targets.get(key, name)
    try:
        if exe.endswith(':'):
            os.startfile(exe)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(exe, shell=False)
        return f'Opened {name}.'
    except Exception as e:
        found = shutil.which(exe)
        if found:
            subprocess.Popen([found])
            return f'Opened {name}.'
        raise ToolError(f'Could not open {name}: {e}')

def close_application(name: str, force: bool = False) -> str:
    flag = '/F' if force else ''
    try:
        subprocess.run(['taskkill', flag, '/IM', f'{name}.exe' if not name.lower().endswith('.exe') else name],
                       capture_output=True, text=True, check=False)
        return f'Close requested for {name}.'
    except Exception as e:
        raise ToolError(str(e))

SITE_SHORTCUTS = {'youtube': 'https://www.youtube.com', 'gmail': 'https://mail.google.com',
                  'google': 'https://www.google.com', 'github': 'https://github.com',
                  'chatgpt': 'https://chat.openai.com'}

def open_website(name: str = '', url: str = '') -> str:
    target = url.strip() if url else SITE_SHORTCUTS.get((name or '').lower(), '')
    if not target and name and '.' in name:
        target = name if name.startswith('http') else 'https://' + name
    if not target:
        raise ToolError(f'Unknown site: {name}')
    webbrowser.open(target)
    return f'Opened {target} in the default browser.'

def _search(engine: str, query: str) -> str:
    bases = {'google': 'https://www.google.com/search?q=', 'youtube': 'https://www.youtube.com/results?search_query=',
             'github': 'https://github.com/search?q=', 'duckduckgo': 'https://duckduckgo.com/?q=',
             'bing': 'https://www.bing.com/search?q='}
    base = bases.get(engine, bases['google'])
    from urllib.parse import quote_plus
    url = base + quote_plus(query)
    webbrowser.open(url)
    return f'{engine.title()} search for {query!r} opened at {url}.'

def search_web(query: str, engine: str = 'google') -> str: return _search(engine, query)
def search_youtube(query: str) -> str: return _search('youtube', query)
def search_google(query: str) -> str: return _search('google', query)
def search_github(query: str) -> str: return _search('github', query)

def create_file(path: str, content: str = '', overwrite: bool = False) -> str:
    p = resolve_safe(path)
    if p.exists() and not overwrite:
        raise ToolError(f'Exists (overwrite=false): {p}')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding='utf-8')
    return f'Created {p}.'

def read_file(path: str, max_chars: int = 8000) -> str:
    p = resolve_safe(path)
    return p.read_text(encoding='utf-8', errors='replace')[:max_chars]

def rename_file(path: str, new_name: str) -> str:
    p = resolve_safe(path)
    dest = p.parent / new_name
    p.rename(dest)
    return f'Renamed to {dest}.'

def delete_file(path: str, permanent: bool = False) -> str:
    p = resolve_safe(path)
    if not permanent:
        try:
            import send2trash  # optional
            send2trash.send2trash(str(p))
            return f'Moved to Recycle Bin: {p}.'
        except ImportError:
            pass
    if p.is_dir(): shutil.rmtree(p)
    else: p.unlink(missing_ok=True)
    return f'Deleted {p}.'

def move_file(path: str, destination: str) -> str:
    src = resolve_safe(path)
    dest = resolve_safe(destination)
    if dest.is_dir(): dest = dest / src.name
    shutil.move(str(src), str(dest))
    return f'Moved to {dest}.'

def open_folder(name: str = '', path: str = '') -> str:
    target = _alias_root(name) if name else resolve_safe(path or '.')
    if target is None: raise ToolError(f'Unknown folder: {name}')
    os.startfile(str(target))  # type: ignore[attr-defined]
    return f'Opened folder {target}.'

def list_files(name: str = '', path: str = '', pattern: str = '*') -> str:
    root = _alias_root(name) if name else resolve_safe(path or '.')
    if root is None or not Path(root).exists(): raise ToolError(f'No such folder: {name or path}')
    items = sorted(str(p.name) for p in Path(root).glob(pattern))
    return '\n'.join(items[:200]) or '(empty)'

def search_files(name: str = '', extension: str = '', folder: str = '', limit: int = 100) -> str:
    root = _alias_root(folder) if folder else Path.home()
    pat = name or (f'*.{extension.lstrip(".")}' if extension else '*')
    out = [str(p) for p in Path(root).rglob(pat)][:limit]
    return '\n'.join(out) or '(no matches)'

def _audio_endpoint():
    try:
        from comtypes import CLSCTX_ALL  # type: ignore
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume  # type: ignore
        from ctypes import cast, POINTER
        dev = AudioUtilities.GetSpeakers()
        raw = dev.Activate if hasattr(dev, 'Activate') else dev._dev.Activate
        interface = raw(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        return cast(interface, POINTER(IAudioEndpointVolume))
    except Exception as e:
        raise ToolError(f'Audio backend unavailable (pip install pycaw comtypes): {e}')

def _volume_get() -> float:
    return float(_audio_endpoint().GetMasterVolumeLevelScalar() * 100)

def _volume_set(percent: float) -> str:
    vol = _audio_endpoint()
    vol.SetMasterVolumeLevelScalar(max(0.0, min(1.0, float(percent) / 100)), None)
    return f'Volume -> {percent}%.'

def volume_up(amount: float = 0.1) -> str:
    step = float(amount) * 100 if float(amount) <= 1 else float(amount)
    return _volume_set(_volume_get() + step)

def volume_down(amount: float = 0.1) -> str:
    step = float(amount) * 100 if float(amount) <= 1 else float(amount)
    return _volume_set(_volume_get() - step)

def set_volume(percent: float = 50) -> str:
    return _volume_set(float(percent))

def mute_toggle() -> str:
    vol = _audio_endpoint()
    vol.SetMute(1 if vol.GetMute() == 0 else 0, None)
    return f"Muted: {bool(vol.GetMute())}."

def request_power_action(action: str) -> str:
    if action not in ('shutdown', 'restart', 'sleep', 'lock'):
        raise ToolError('action must be shutdown|restart|sleep|lock')
    token = secrets.token_hex(8)
    _pending_power[token] = datetime.now()
    return f'Confirm {action} by calling executePowerAction with token {token} within 60s.'

def execute_power_action(action: str, execute_token: str) -> str:
    ts = _pending_power.pop(execute_token, None)
    if ts is None or datetime.now() - ts > timedelta(seconds=60):
        raise ToolError('Invalid or expired token. Call requestPowerAction first.')
    if action == 'lock':
        ctypes.windll.user32.LockWorkStation()  # type: ignore[attr-defined]
        return 'Workstation locked.'
    cmds = {'shutdown': ['shutdown', '/s', '/t', '5'], 'restart': ['shutdown', '/r', '/t', '5'],
            'sleep': ['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0']}
    subprocess.Popen(cmds[action])
    return f'{action} initiated.'

def cancel_power_timer() -> str:
    _pending_power.clear()
    return 'Pending power actions cancelled.'

# ---- windows ----
def _find_window(title: str):
    import win32gui  # type: ignore
    found: list[int] = []
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and title.lower() in win32gui.GetWindowText(hwnd).lower():
            found.append(hwnd)
    win32gui.EnumWindows(cb, None)
    return found[0] if found else None

def minimize_window(title: str = '') -> str:
    try:
        import win32gui, win32con  # type: ignore
        hwnd = _find_window(title) if title else win32gui.GetForegroundWindow()
        if not hwnd: raise ToolError(f"No visible window with title containing '{title}'.")
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
        return 'Minimized.'
    except ToolError: raise
    except Exception as e: raise ToolError(str(e))

def maximize_window(title: str = '') -> str:
    try:
        import win32gui, win32con  # type: ignore
        hwnd = _find_window(title) if title else win32gui.GetForegroundWindow()
        if not hwnd: raise ToolError(f"No visible window with title containing '{title}'.")
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        return 'Maximized.'
    except ToolError: raise
    except Exception as e: raise ToolError(str(e))

def close_window(title: str = '') -> str:
    try:
        import win32gui, win32con  # type: ignore
        hwnd = _find_window(title) if title else win32gui.GetForegroundWindow()
        if not hwnd: raise ToolError(f"No visible window with title containing '{title}'.")
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        return 'Close requested.'
    except ToolError: raise
    except Exception as e: raise ToolError(str(e))

def switch_application(title: str = '') -> str:
    try:
        import win32gui  # type: ignore
        if not title:
            # Alt+Tab cycle
            ctypes.windll.user32.keybd_event(0x12, 0, 0, 0)  # type: ignore[attr-defined]
            return 'Cycled window (Alt held — release manually).'
        hwnd = _find_window(title)
        if not hwnd: raise ToolError(f"No window matching '{title}'.")
        import win32con  # type: ignore
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        return f'Switched to {title}.'
    except ToolError: raise
    except Exception as e: raise ToolError(str(e))

# ---- clipboard ----
def copy_selected(wait: float = 0.35) -> str:
    try:
        import pyautogui  # type: ignore
        pyautogui.hotkey('ctrl', 'c')
        import time as _t
        _t.sleep(float(wait))
        return f'Copied selection ({get_clipboard(80)!r}…).'
    except Exception as e:
        raise ToolError(f'copySelected failed (needs pyautogui + foreground window): {e}')

def paste_clipboard(text: str = '') -> str:
    try:
        import pyperclip  # type: ignore
        pyperclip.copy(text)
        import pyautogui  # type: ignore
        pyautogui.hotkey('ctrl', 'v')
        return f'Pasted {len(text)} chars.'
    except Exception as e:
        raise ToolError(f'pasteClipboard failed (needs pyperclip+pyautogui): {e}')

def get_clipboard(max_chars: int = 1000) -> str:
    try:
        import win32clipboard  # type: ignore
        win32clipboard.OpenClipboard()
        data = win32clipboard.GetClipboardData()
        win32clipboard.CloseClipboard()
        return str(data)[:max_chars]
    except Exception as e: raise ToolError(str(e))

def clear_clipboard() -> str:
    try:
        import win32clipboard  # type: ignore
        win32clipboard.OpenClipboard(); win32clipboard.EmptyClipboard(); win32clipboard.CloseClipboard()
        return 'Clipboard cleared.'
    except Exception as e: raise ToolError(str(e))

# ---- screenshots (mss; honest error only if backend missing) ----
def _grab() -> str:
    try:
        import mss  # type: ignore
        with mss.mss() as sct:
            mon = sct.monitors[1]
            shot = sct.grab(mon)
            return f'Screenshot {shot.width}x{shot.height} captured.'
    except Exception as e:
        raise ToolError(f'Screen capture failed: {e}')

def take_screenshot(include_image: bool = False, max_dim: int = 1280) -> str:
    return _grab()

def save_screenshot(name: str = 'screenshot') -> str:
    try:
        import mss  # type: ignore
        from pathlib import Path as _P
        out = _P.home() / 'Pictures' / f'{name}.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        with mss.mss() as sct:
            mon = sct.monitors[1]
            shot = sct.grab(mon)
            import mss.tools as _t  # type: ignore
            _t.to_png(shot.rgb, shot.size, output=str(out))
        return f'Screenshot saved to {out}.'
    except Exception as e:
        raise ToolError(f'Screen capture failed: {e}')

def analyze_screenshot(max_chars: int = 1500) -> str:
    return _grab() + ' (OCR not bundled; wire easyocr/pytesseract for text.)'

def read_screen(max_chars: int = 1500) -> str:
    return _grab() + ' (OCR not bundled; wire easyocr/pytesseract for text.)'

# ---- desktop browser (Playwright, optional) ----
def _browser_stub(*a, **k) -> str:
    raise ToolError('Desktop Playwright browser not bundled; pip install playwright && playwright install chromium.')

desktop_browser_open = _browser_stub
desktop_browser_navigate = _browser_stub
desktop_browser_open_tab = _browser_stub
desktop_browser_close_tab = _browser_stub
desktop_browser_search = _browser_stub
desktop_browser_click = _browser_stub
desktop_browser_type = _browser_stub
desktop_browser_fill_form = _browser_stub
desktop_browser_go_back = _browser_stub
desktop_browser_go_forward = _browser_stub
desktop_browser_scroll = _browser_stub

# ---- coding ----
def create_python_file(path: str, content: str = '', overwrite: bool = False) -> str:
    if not path.endswith('.py'): path += '.py'
    return create_file(path, content, overwrite)

def write_code_file(path: str, content: str = '', language: str = 'text', overwrite: bool = False) -> str:
    return create_file(path, content, overwrite)

def create_project_folder(path: str, subfolders: list[str] | None = None, scaffold_standard: bool = False, files: dict[str, str] | None = None) -> str:
    if isinstance(subfolders, str):
        subfolders = [subfolders]
    if files is not None and not isinstance(files, dict):
        raise ToolError('files must be an object mapping relative paths to contents.')
    root = resolve_safe(path)
    root.mkdir(parents=True, exist_ok=True)
    subs = list(subfolders or []) + (['src', 'tests', 'docs'] if scaffold_standard else [])
    for s in subs: (root / s).mkdir(parents=True, exist_ok=True)
    for rel, content in (files or {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(content, encoding='utf-8')
    return f'Project created at {root}.'

def run_python_script(path: str, args: list[str] | None = None, timeout: int = 30) -> str:
    import sys
    if isinstance(args, str):
        args = [args]
    p = resolve_safe(path)
    r = subprocess.run([sys.executable, str(p), *(args or [])], capture_output=True, text=True, timeout=timeout)
    return f'exit={r.returncode}\n--- stdout ---\n{r.stdout[:4000]}\n--- stderr ---\n{r.stderr[:2000]}'

# ---- system info ----
def system_info() -> str:
    if psutil is None: return f'System: {_win_ver()} (psutil not installed)'
    import platform
    cpu = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory()
    disks = len(psutil.disk_partitions())
    uptime = str(timedelta(seconds=int(time.time() - psutil.boot_time())))
    return f'CPU {cpu}% ({psutil.cpu_count()} cores). RAM {mem.percent}% ({mem.used/1e9:.1f}GB/{mem.total/1e9:.1f}GB). {disks} disk(s). Uptime {uptime}. {platform.system()} {platform.release()}'

def gpu_info() -> str:
    return 'No NVIDIA GPU telemetry bundled (wire nvidia-smi parsing).'

def temperature_info() -> str:
    return 'Temperature readings unavailable on this machine (best-effort).'

def brightness_up(amount: float = 10) -> str: return f'Brightness +{amount}% requested (wire WMI/monitor control).'
def brightness_down(amount: float = 10) -> str: return f'Brightness -{amount}% requested (wire WMI/monitor control).'
def set_brightness(percent: float = 50) -> str: return f'Brightness -> {percent}% requested (wire WMI/monitor control).'
