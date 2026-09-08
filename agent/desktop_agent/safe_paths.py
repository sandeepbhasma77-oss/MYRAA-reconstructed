# MYRAA safe path layer — dynamic Windows known folders, friendly phrases,
# writability diagnostics, drive awareness. Never assumes C:\Users\<name>\Desktop.
import os
import string
from pathlib import Path

SAFE_ROOTS = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos', 'home', 'temp', 'myraa']

def _reg_shell_folder(value: str) -> Path | None:
    try:
        import winreg  # type: ignore
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r'Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders') as k:
            v, _ = winreg.QueryValueEx(k, value)
            if v and Path(v).exists():
                return Path(v)
    except Exception:
        pass
    return None

def _alias_root(name: str) -> Path | None:
    home = Path.home()
    one = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer')
    mapping = {
        # Registry first (handles redirection, OneDrive, localized names).
        'desktop': _reg_shell_folder('Desktop') or (Path(one) / 'Desktop' if one and (Path(one) / 'Desktop').exists() else None) or home / 'Desktop',
        'documents': _reg_shell_folder('Personal') or (Path(one) / 'Documents' if one and (Path(one) / 'Documents').exists() else None) or home / 'Documents',
        'downloads': _reg_shell_folder('{374DE290-123F-4565-9164-39C4925E467B}') or home / 'Downloads',
        'pictures': _reg_shell_folder('My Pictures') or home / 'Pictures',
        'music': _reg_shell_folder('My Music') or home / 'Music',
        'videos': _reg_shell_folder('My Video') or home / 'Videos',
        'home': home,
        'temp': Path(os.environ.get('TEMP', str(home / 'AppData' / 'Local' / 'Temp'))),
    }
    return mapping.get((name or '').lower())

FRIENDLY_FOLDERS = {
    'my desktop': 'desktop', 'the desktop': 'desktop', 'desktop': 'desktop',
    'my documents': 'documents', 'documents': 'documents', 'my files': 'documents',
    'my downloads': 'downloads', 'downloads': 'downloads',
    'my pictures': 'pictures', 'pictures': 'pictures',
    'my music': 'music', 'music': 'music',
    'my videos': 'videos', 'videos': 'videos',
    'my home': 'home', 'home folder': 'home',
    'onedrive': 'onedrive', 'my onedrive': 'onedrive',
}

def resolve_friendly(text: str) -> Path | None:
    """Map phrases like 'my desktop' to the real folder. Returns None if unknown."""
    t = (text or '').lower()
    for phrase, alias in FRIENDLY_FOLDERS.items():
        if phrase in t:
            if alias == 'onedrive':
                one = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer')
                return Path(one) if one and Path(one).exists() else None
            return _alias_root(alias)
    return None

def resolve_safe(path: str, alias: str = '') -> Path:
    """Resolve a user path, constraining writes to safe roots."""
    if alias:
        root = _alias_root(alias)
        if root is None:
            raise ValueError(f'Unknown folder alias: {alias}')
        return root
    p = Path(path).expanduser()
    if not p.is_absolute():
        base = _alias_root('documents') or Path.home()
        p = base / p
    blocked = [Path(r'C:\Windows'), Path(r'C:\Program Files'), Path(r'C:\Program Files (x86)')]
    for b in blocked:
        try:
            if p.resolve().is_relative_to(b):
                raise ValueError(f'Refusing to touch system path: {p}')
        except Exception as e:
            if 'Refusing' in str(e):
                raise
    return p

def check_path_access(path: str) -> dict:
    """Diagnose a path without touching security settings. Read-only probe + write probe file."""
    p = Path(path).expanduser()
    out = {'path': str(p), 'exists': False, 'readable': False, 'writable': False,
           'is_directory': False, 'requires_elevation': False, 'reason': ''}
    try:
        out['exists'] = p.exists()
        target = p if p.exists() else p.parent
        out['is_directory'] = p.is_dir() if p.exists() else False
        # Read probe.
        try:
            if p.is_dir():
                next(p.iterdir(), None)
            elif p.is_file():
                with open(p, 'rb') as f:
                    f.read(1)
            out['readable'] = True
        except PermissionError:
            out['reason'] = 'Windows denied read access (ACL/UAC/antivirus).'
        except FileNotFoundError:
            out['reason'] = 'Path does not exist (parent may need creating).'
        except Exception as e:
            out['reason'] = f'Read probe: {e}'
        # Write probe: temp file in target dir, removed afterwards.
        probe = (p if p.is_dir() else p.parent) / '.myraa_write_probe'
        try:
            probe.touch(exist_ok=False)
            probe.unlink(missing_ok=True)
            out['writable'] = True
        except PermissionError:
            out['requires_elevation'] = _looks_protected(p)
            if not out['reason']:
                out['reason'] = ('UAC-protected or ACL-restricted location. '
                                 'Run the action from an elevated MYRAA only with explicit user approval.' if out['requires_elevation']
                                 else 'Windows denied write access (ACL/antivirus/OneDrive lock).')
        except FileNotFoundError:
            out['reason'] = 'Parent directory does not exist.'
        except Exception as e:
            if not out['reason']:
                out['reason'] = f'Write probe: {e}'
    except Exception as e:
        out['reason'] = f'Probe failed: {e}'
    return out

def _looks_protected(p: Path) -> bool:
    try:
        rp = p.resolve()
        for prefix in (Path(os.environ.get('SystemRoot', r'C:\Windows')),
                       Path(r'C:\Program Files'), Path(r'C:\Program Files (x86)')):
            try:
                if rp.is_relative_to(prefix):
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False

def diagnose_write_error(path: str, exc: Exception) -> str:
    msg = str(exc)
    low = msg.lower()
    p = str(path)
    # Classify so the assistant can explain instead of bare "Permission denied".
    if isinstance(exc, FileNotFoundError) or 'no such file' in low or 'not exist' in low:
        # Missing directory vs bad path: check the parent.
        try:
            parent = Path(p).expanduser().parent
            if not parent.exists():
                return (f"That folder does not exist ({parent}). "
                        f"Ask me to create '{parent}' first, then I will save '{Path(p).name}' there.")
        except Exception:
            pass
        return f'That path does not exist ({p}). Tell me the right folder or ask me to create it first.'
    if 'read-only' in low or 'readonly' in low or 'read only' in low:
        return (f"I couldn't write to that location because the file or disk is read-only ({p}). "
                'Copy it to Desktop/Documents first, or clear the read-only flag.')
    if 'locked' in low or 'being used by another process' in low or 'sharing violation' in low:
        return (f"I couldn't write to that location because the file is locked by another program ({p}). "
                'Close the program using it (or save under a new name) and try again.')
    if 'onedrive' in low or 'sync' in low or 'cloud' in low:
        return (f"I couldn't write to that location because OneDrive sync is holding it ({p}). "
                'Wait for sync to finish, or save to the local Desktop/Documents copy instead.')
    if 'antivirus' in low or 'ransomware' in low or 'controlled folder' in low or 'threat' in low:
        return (f"I couldn't write to that location because Windows security/antivirus blocked it ({p}). "
                'Check Controlled Folder Access / antivirus history — I will not disable security.')
    if 'uac' in low or 'elevation' in low or 'require elevation' in low or _looks_protected(Path(p).expanduser()):
        return (f"I couldn't write to that location because Windows denied access ({p}). "
                'It is a UAC-protected/system location — I will not bypass security. '
                'Tell me a user folder (Desktop/Documents/Downloads) and I will save there instead.')
    if isinstance(exc, PermissionError) or 'denied' in low or 'access' in low:
        return (f"I couldn't write to that location because Windows denied access ({p}). "
                'This is usually an ACL/UAC/antivirus/OneDrive lock, not a MYRAA bug. '
                'Tell me a user folder (Desktop/Documents/Downloads) and I will save there instead.')
    if 'invalid' in low or 'syntax' in low or 'characters' in low:
        return (f'That path looks invalid ({p}): {msg} Tell me the exact folder name.')
    return f'Write failed ({p}): {msg}'

def list_drives() -> list[dict]:
    out = []
    for letter in string.ascii_uppercase:
        root = Path(f'{letter}:\\')
        try:
            if not root.exists():
                continue
            import shutil as _sh
            total, used, free = _sh.disk_usage(str(root))
            out.append({'drive': f'{letter}:', 'total_gb': round(total / 1e9, 1),
                        'free_gb': round(free / 1e9, 1)})
        except Exception:
            continue
    return out
