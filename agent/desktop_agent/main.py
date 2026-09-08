# RECREATED — FastAPI desktop agent entrypoint (observed: 127.0.0.1:8765, /health, /execute).
import logging
import os
from fastapi import FastAPI
from pydantic import BaseModel

from . import tools
from . import tools_ext
from . import tools_startup

logging.basicConfig(level=logging.INFO)
log = logging.getLogger('myraa.desktop')

app = FastAPI(title='MYRAA Desktop Control Agent', version='1.0.0')

class ExecuteRequest(BaseModel):
    tool: str
    args: dict = {}

REGISTRY = {
    'openApplication': lambda a: tools.open_application(a.get('name', '')),
    'closeApplication': lambda a: tools.close_application(a.get('name', ''), bool(a.get('force', False))),
    'openWebsite': lambda a: tools.open_website(a.get('name', ''), a.get('url', '')),
    'searchWeb': lambda a: tools.search_web(a.get('query', ''), a.get('engine', 'google')),
    'searchYouTube': lambda a: tools.search_youtube(a.get('query', '')),
    'searchGoogle': lambda a: tools.search_google(a.get('query', '')),
    'searchGitHub': lambda a: tools.search_github(a.get('query', '')),
    'createFile': lambda a: tools.create_file(a.get('path', ''), a.get('content', ''), bool(a.get('overwrite', False))),
    'readFile': lambda a: tools.read_file(a.get('path', ''), int(a.get('max_chars', 8000))),
    'renameFile': lambda a: tools.rename_file(a.get('path', ''), a.get('new_name', '')),
    'deleteFile': lambda a: tools.delete_file(a.get('path', ''), bool(a.get('permanent', False))),
    'moveFile': lambda a: tools.move_file(a.get('path', ''), a.get('destination', '')),
    'openFolder': lambda a: tools.open_folder(a.get('name', ''), a.get('path', '')),
    'listFiles': lambda a: tools.list_files(a.get('name', ''), a.get('path', ''), a.get('pattern', '*')),
    'searchFiles': lambda a: tools.search_files(a.get('name', ''), a.get('extension', ''), a.get('folder', ''), int(a.get('limit', 100))),
    'volumeUp': lambda a: tools.volume_up(float(a.get('amount', 0.1))),
    'volumeDown': lambda a: tools.volume_down(float(a.get('amount', 0.1))),
    'muteToggle': lambda a: tools.mute_toggle(),
    'setVolume': lambda a: tools.set_volume(float(a.get('percent', 50))),
    'requestPowerAction': lambda a: tools.request_power_action(a.get('action', '')),
    'executePowerAction': lambda a: tools.execute_power_action(a.get('action', ''), a.get('execute_token', '')),
    '_cancelPowerTimer': lambda a: tools.cancel_power_timer(),
    'minimizeWindow': lambda a: tools.minimize_window(a.get('title', '')),
    'maximizeWindow': lambda a: tools.maximize_window(a.get('title', '')),
    'closeWindow': lambda a: tools.close_window(a.get('title', '')),
    'switchApplication': lambda a: tools.switch_application(a.get('title', '')),
    'copySelected': lambda a: tools.copy_selected(float(a.get('wait', 0.35))),
    'pasteClipboard': lambda a: tools.paste_clipboard(a.get('text', '')),
    'getClipboard': lambda a: tools.get_clipboard(int(a.get('max_chars', 1000))),
    'clearClipboard': lambda a: tools.clear_clipboard(),
    'takeScreenshot': lambda a: tools.take_screenshot(bool(a.get('include_image', False)), int(a.get('max_dim', 1280))),
    'saveScreenshot': lambda a: tools.save_screenshot(a.get('name', 'screenshot')),
    'analyzeScreenshot': lambda a: tools.analyze_screenshot(int(a.get('max_chars', 1500))),
    'readScreen': lambda a: tools.read_screen(int(a.get('max_chars', 1500))),
    'desktopBrowserOpen': lambda a: tools.desktop_browser_open(),
    'desktopBrowserNavigate': lambda a: tools.desktop_browser_navigate(),
    'desktopBrowserOpenTab': lambda a: tools.desktop_browser_open_tab(),
    'desktopBrowserCloseTab': lambda a: tools.desktop_browser_close_tab(),
    'desktopBrowserSearch': lambda a: tools.desktop_browser_search(),
    'desktopBrowserClick': lambda a: tools.desktop_browser_click(),
    'desktopBrowserType': lambda a: tools.desktop_browser_type(),
    'desktopBrowserFillForm': lambda a: tools.desktop_browser_fill_form(),
    'desktopBrowserGoBack': lambda a: tools.desktop_browser_go_back(),
    'desktopBrowserGoForward': lambda a: tools.desktop_browser_go_forward(),
    'desktopBrowserScroll': lambda a: tools.desktop_browser_scroll(),
    'createPythonFile': lambda a: tools.create_python_file(a.get('path', ''), a.get('content', ''), bool(a.get('overwrite', False))),
    'runPythonScript': lambda a: tools.run_python_script(a.get('path', ''), a.get('args', []), int(a.get('timeout', 30))),
    'createProjectFolder': lambda a: tools.create_project_folder(a.get('path', ''), a.get('subfolders', []), bool(a.get('scaffold_standard', False)), a.get('files', {})),
    'writeCodeFile': lambda a: tools.write_code_file(a.get('path', ''), a.get('content', ''), a.get('language', 'text'), bool(a.get('overwrite', False))),
    'systemInfo': lambda a: tools.system_info(),
    'gpuInfo': lambda a: tools.gpu_info(),
    'temperatureInfo': lambda a: tools.temperature_info(),
    'brightnessUp': lambda a: tools.brightness_up(float(a.get('amount', 10))),
    'brightnessDown': lambda a: tools.brightness_down(float(a.get('amount', 10))),
    'setBrightness': lambda a: tools.set_brightness(float(a.get('percent', 50))),
    'enableAutoStart': lambda a: tools_startup.enable_auto_start(),
    'disableAutoStart': lambda a: tools_startup.disable_auto_start(),
    'getAutoStartStatus': lambda a: tools_startup.get_auto_start_status(),
    # --- extended real-control tools (tools_ext) ---
    'launch_application': lambda a: tools_ext.launch_application(a.get('name', '')),
    'list_running_applications': lambda a: tools_ext.list_running_applications(int(a.get('limit', 100))),
    'application_exists': lambda a: tools_ext.application_exists(a.get('name', '')),
    'restart_application': lambda a: tools_ext.restart_application(a.get('name', '')),
    'write_file': lambda a: tools_ext.write_file(a.get('path', ''), a.get('content', ''), bool(a.get('overwrite', True))),
    'append_file': lambda a: tools_ext.append_file(a.get('path', ''), a.get('content', '')),
    'copy_file': lambda a: tools_ext.copy_file(a.get('path', ''), a.get('destination', '')),
    'create_directory': lambda a: tools_ext.create_directory(a.get('path', '')),
    'delete_directory': lambda a: tools_ext.delete_directory(a.get('path', '')),
    'list_directory': lambda a: tools_ext.list_directory(a.get('path', ''), a.get('name', ''), a.get('pattern', '*')),
    'get_file_info': lambda a: tools_ext.get_file_info(a.get('path', '')),
    'move_mouse': lambda a: tools_ext.move_mouse(int(a.get('x', 0)), int(a.get('y', 0))),
    'click': lambda a: tools_ext.click(a.get('x'), a.get('y'), a.get('button', 'left')),
    'double_click': lambda a: tools_ext.double_click(a.get('x'), a.get('y')),
    'right_click': lambda a: tools_ext.right_click(a.get('x'), a.get('y')),
    'middle_click': lambda a: tools_ext.middle_click(a.get('x'), a.get('y')),
    'drag': lambda a: tools_ext.drag(int(a.get('x1', 0)), int(a.get('y1', 0)), int(a.get('x2', 0)), int(a.get('y2', 0))),
    'scroll': lambda a: tools_ext.scroll(int(a.get('amount', 100))),
    'press_key': lambda a: tools_ext.press_key(a.get('key', '')),
    'hotkey': lambda a: tools_ext.hotkey(a.get('keys', [])),
    'type_text': lambda a: tools_ext.type_text(a.get('text', ''), float(a.get('interval', 0.02))),
    'key_down': lambda a: tools_ext.key_down(a.get('key', '')),
    'key_up': lambda a: tools_ext.key_up(a.get('key', '')),
    'screenshot': lambda a: tools_ext.screenshot(),
    'screenshot_region': lambda a: tools_ext.screenshot_region(int(a.get('x', 0)), int(a.get('y', 0)), int(a.get('width', 400)), int(a.get('height', 300))),
    'screen_size': lambda a: tools_ext.screen_size(),
    'monitor_list': lambda a: tools_ext.monitor_list(),
    'active_window': lambda a: tools_ext.active_window(),
    'list_windows': lambda a: tools_ext.list_windows(int(a.get('limit', 100))),
    'focus_window': lambda a: tools_ext.focus_window(a.get('title', '')),
    'restore_window': lambda a: tools_ext.restore_window(a.get('title', '')),
    'move_window': lambda a: tools_ext.move_window(a.get('title', ''), int(a.get('x', 100)), int(a.get('y', 100))),
    'resize_window': lambda a: tools_ext.resize_window(a.get('title', ''), int(a.get('width', 800)), int(a.get('height', 600))),
    'read_clipboard': lambda a: tools_ext.read_clipboard(int(a.get('max_chars', 4000))),
    'write_clipboard': lambda a: tools_ext.write_clipboard(a.get('text', '')),
    'cpu_info': lambda a: tools_ext.cpu_info(),
    'ram_info': lambda a: tools_ext.ram_info(),
    'disk_info': lambda a: tools_ext.disk_info(),
    'battery_status': lambda a: tools_ext.battery_status(),
    'battery': lambda a: tools_ext.battery_status(),
    'host_info': lambda a: tools_ext.host_info(),
    'uptime': lambda a: tools_ext.uptime(),
    'list_processes': lambda a: tools_ext.list_processes(int(a.get('limit', 100)), a.get('sort_by', 'memory')),
    'find_process': lambda a: tools_ext.find_process(a.get('name', '')),
    'process_info': lambda a: tools_ext.process_info(int(a.get('pid', 0))),
    'terminate_process': lambda a: tools_ext.terminate_process(int(a.get('pid', 0)), a.get('name', '')),
    'process_cpu_usage': lambda a: tools_ext.process_info(int(a.get('pid', 0))),
    'process_memory_usage': lambda a: tools_ext.process_info(int(a.get('pid', 0))),
    'network_status': lambda a: tools_ext.network_status(),
    'list_adapters': lambda a: tools_ext.list_adapters(),
    'ping': lambda a: tools_ext.ping(a.get('host', ''), int(a.get('count', 2))),
    'dns_lookup': lambda a: tools_ext.dns_lookup(a.get('host', '')),
    'local_ip': lambda a: tools_ext.local_ip(),
    'wifi_status': lambda a: tools_ext.wifi_status(),
    'open_url': lambda a: tools_ext.open_url(a.get('url', '')),
    'get_volume': lambda a: tools_ext.get_volume(),
    'set_volume': lambda a: tools_ext.set_volume(float(a.get('percent', 50))),
    'mute': lambda a: tools_ext.mute(),
    'unmute': lambda a: tools_ext.unmute(),
    'get_brightness': lambda a: tools_ext.get_brightness(),
    'set_brightness': lambda a: tools_ext.set_brightness(float(a.get('percent', 50))),
    'lock_pc': lambda a: tools_ext.lock_pc(),
    'sleep_pc': lambda a: tools_ext.sleep_pc(),
    'run_command': lambda a: tools_ext.run_command(a.get('command', ''), a.get('confirm_token', ''), int(a.get('timeout', 30))),
    'stop': lambda a: tools_ext.stop(),
    'audio_devices': lambda a: tools_ext.audio_devices(),
    'resolve_path': lambda a: tools_ext.resolve_path(a.get('text', '')),
    'check_path_access': lambda a: tools_ext.check_path_access(a.get('path', '')),
    'desktop_access_test': lambda a: tools_ext.desktop_access_test(),
    'write_file_verified': lambda a: tools_ext.write_file_verified(a.get('path', ''), a.get('content', ''), bool(a.get('overwrite', True))),
    'open_file': lambda a: tools_ext.open_file(a.get('query', '')),
    'list_drives': lambda a: tools_ext.list_drives(),
    'drive_info': lambda a: tools_ext.drive_info(a.get('drive', '')),
    'find_windows_app': lambda a: tools_ext.find_windows_app(a.get('name', '')),
    'search_windows_app': lambda a: tools_ext.search_windows_app(a.get('query', '')),
    'findApplication': lambda a: tools_ext.find_application(a.get('name', '')),
    'listApplicationMatches': lambda a: tools_ext.list_application_matches(a.get('name', ''), int(a.get('limit', 5))),
    'refreshApplicationIndex': lambda a: tools_ext.refresh_application_index(),
    'focusApplication': lambda a: tools_ext.focus_application(a.get('name', '')),
    'file_exists': lambda a: tools_ext.file_exists(a.get('path', '')),
    'file_info': lambda a: tools_ext.file_info(a.get('path', '')),
    'find_file': lambda a: tools_ext.find_file(a.get('name', ''), a.get('folder', ''), int(a.get('limit', 50))),
    'search_drive': lambda a: tools_ext.search_drive(a.get('query', ''), a.get('drive', ''), int(a.get('limit', 50))),
}

@app.get('/caps')
def caps():
    import importlib.util as _ilu
    def has(m: str) -> bool:
        return _ilu.find_spec(m) is not None
    return {
        'ok': True,
        'version': tools_ext.VERSION,
        'tool_count': len(REGISTRY),
        'permissions': tools_ext.TOOL_PERMISSIONS,
        'libs': {m: has(m) for m in ['pyautogui', 'pyperclip', 'mss', 'pycaw', 'comtypes', 'playwright', 'psutil', 'win32gui']},
    }

@app.get('/health')
def health():
    return {'ok': True, 'tool_count': len(REGISTRY), 'version': tools.VERSION}


@app.on_event('startup')
def _warm_caches():
    """Pre-build the app index in background so the first 'open X' is instant.

    The slow pole (powershell Get-StartApps) runs here once at boot instead of
    blocking the first voice command. Daemon thread: never delays readiness.
    """
    try:
        import threading as _th

        def _run():
            try:
                tools_ext.build_application_index()
            except Exception:
                pass
        _th.Thread(target=_run, name='myraa-index-warm', daemon=True).start()
    except Exception:
        pass

@app.post('/execute')
def execute(req: ExecuteRequest):
    log.info('EXEC tool=%s args=%s', req.tool, req.args)
    fn = REGISTRY.get(req.tool)
    if fn is None:
        return {'ok': False, 'error': f'Unknown tool: {req.tool}'}
    try:
        result = fn(req.args or {})
        log.info('DONE tool=%s', req.tool)
        return {'ok': True, 'result': result}
    except tools.ToolError as e:
        log.warning('ToolError in %s: %s', req.tool, e)
        return {'ok': False, 'error': str(e)}
    except Exception as e:
        log.exception('Unhandled error in %s', req.tool)
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}

if __name__ == '__main__':
    import uvicorn
    host = os.environ.get('MYRAA_AGENT_HOST', '127.0.0.1')
    port = int(os.environ.get('MYRAA_AGENT_PORT', '8765'))
    log.info('Starting MYRAA agent on %s:%s', host, port)
    uvicorn.run(app, host=host, port=port)
