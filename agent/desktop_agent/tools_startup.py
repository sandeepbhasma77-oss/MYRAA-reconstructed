# RECREATED — Windows auto-start management.
# Original bug observed in agent.log: `ValueError: illegal newline value: \r\n`
# (open(..., newline='\r\n') is invalid). Fixed here with newline=None handling.
import os
import sys
import winreg
from pathlib import Path

APP_NAME = 'MYRAA'
RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'

def _launcher_target() -> str:
    # Prefer frozen launcher next to agent, else current interpreter note.
    here = Path(__file__).resolve()
    for cand in [here.parents[2] / 'MYRAA.exe', here.parents[2] / 'MYRAA-runtime.exe']:
        if cand.exists():
            return f'"{cand}" --silent'
    return f'"{sys.executable}" "{here.parents[1] / "start-myraa-silent.py"}"'

def _ensure_launcher_exists() -> Path:
    # FIX: never pass newline='\r\n'. Use default newline handling.
    p = Path.home() / 'AppData' / 'Roaming' / 'MYRAA' / 'start-myraa-silent.bat'
    p.parent.mkdir(parents=True, exist_ok=True)
    content = f'@echo off\r\nstart "" "{_launcher_target()}"\r\n'
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    return p

def enable_auto_start() -> str:
    launcher = _ensure_launcher_exists()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, f'"{launcher}"')
    return 'Auto-start enabled.'

def disable_auto_start() -> str:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, APP_NAME)
        return 'Auto-start disabled.'
    except FileNotFoundError:
        return 'Auto-start was already disabled.'

def get_auto_start_status() -> str:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as k:
            winreg.QueryValueEx(k, APP_NAME)
        return 'Auto-start is enabled.'
    except FileNotFoundError:
        return 'Auto-start is disabled.'
