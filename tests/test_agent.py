"""Reconstruction smoke tests — no Windows-only APIs touched."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

def test_required_files_exist():
    for rel in [
        'package.json', 'server/server.ts', 'src/App.tsx',
        'agent/desktop_agent/main.py', 'agent/desktop_agent/tools_startup.py',
        'electron/main.cjs', 'build/icon.ico', 'assets/idle.mp4',
    ]:
        assert (ROOT / rel).exists(), rel

def test_startup_newline_fix():
    # Original crashed with illegal newline value in the open() call itself.
    # Comments may mention the bug; only the actual call matters.
    lines = (ROOT / 'agent' / 'desktop_agent' / 'tools_startup.py').read_text(encoding='utf-8').splitlines()
    calls = [l for l in lines if 'open(' in l and 'newline' in l and not l.strip().startswith('#')]
    assert calls, 'expected an open() call with newline handling'
    for l in calls:
        assert "newline='\\r\\n'" not in l and 'newline="\\r\\n"' not in l

def test_tool_registry_count():
    src = (ROOT / 'agent' / 'desktop_agent' / 'main.py').read_text(encoding='utf-8')
    # 58-tool surface (57 user + 1 internal) observed in agent.log
    assert src.count(': lambda a:') >= 55
