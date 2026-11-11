"""Smoke-test the toolbar popup in a disposable Firefox profile using Marionette.

Run `npm run build` first. Set FIREFOX_BIN for a nonstandard Firefox installation;
FFARC_HEADLESS=1 suppresses the test window. No regular user profile is opened.
The harness never targets or focuses the popup input. If Marionette cannot enter
Firefox's remote popup browser, chrome-level checks run and content checks report
SKIP. Physical shortcut-and-typing acceptance remains a separate desktop check.
Only localhost fixtures are used; no external web search is submitted.
"""
import contextlib
import json
import os
import platform
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ.get('FFARC_PROJECT_ROOT', Path.cwd())).resolve()
FIREFOX = (os.environ.get('FIREFOX_BIN') or shutil.which('firefox')
           or '/Applications/Firefox.app/Contents/MacOS/firefox')
EXTENSION = Path(os.environ.get('FFARC_EXTENSION_DIR', ROOT / 'dist/extension')).resolve()
MODIFIER = '\ue03d' if platform.system() == 'Darwin' else '\ue009'
SHIFT, ENTER, ESCAPE, DOWN = '\ue008', '\ue007', '\ue00c', '\ue015'


class PopupRoutingUnavailable(RuntimeError):
    pass


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/work/project'):
            title = 'Project Atlas'
        elif self.path.startswith('/work/reference'):
            title = 'Atlas Reference'
        else:
            title = 'Navigation destination'
        body = f'<!doctype html><title>{title}</title><h1>{title}</h1>'.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


sock = process = server = log = profile = None
request_id = 0
ACTIVE_POPUP_PANEL = None


def receive():
    size = b''
    while True:
        ch = sock.recv(1)
        if not ch:
            raise RuntimeError('Marionette socket closed')
        if ch == b':':
            break
        size += ch
    data = b''
    while len(data) < int(size):
        chunk = sock.recv(int(size) - len(data))
        if not chunk:
            raise RuntimeError('Marionette socket closed while reading response')
        data += chunk
    return json.loads(data)


def call(name, **params):
    global request_id
    request_id += 1
    message = json.dumps([0, request_id, name, params], separators=(',', ':')).encode()
    sock.sendall(str(len(message)).encode() + b':' + message)
    result = receive()
    if result[2]:
        raise RuntimeError(f'{name}: {result[2]}')
    value = result[3]
    return value.get('value') if isinstance(value, dict) and set(value) == {'value'} else value


def context(value):
    call('Marionette:SetContext', value=value)


def script(source, *args):
    return call('WebDriver:ExecuteScript', script=source, args=list(args),
                newSandbox=True, filename='firefox-smoke.py', line=1)


def handles(scope='content'):
    context(scope)
    return set(call('WebDriver:GetWindowHandles'))


def select(handle, focus=False, scope='content'):
    context(scope)
    call('WebDriver:SwitchToWindow', handle=handle, focus=focus)


def parent_state(parent):
    # A chrome-window handle preserves the tab genuinely selected by the product.
    select(parent, scope='chrome')
    return script('return {url:gBrowser.selectedBrowser.currentURI.spec, tabCount:gBrowser.tabs.length};')


def popup_state(parent):
    select(parent, scope='chrome')
    return script('''const browser = [...document.querySelectorAll('browser.webextension-popup-browser')]
      .find(item => item.closest('panel')?.state === 'open');
      return {open:Boolean(browser), url:browser?.currentURI?.spec,
        panelId:browser?.closest('panel')?.id,
        chromeFocus:document.activeElement?.id};''')


def popup_fully_closed(parent):
    select(parent, scope='chrome')
    return script('''const panel = arguments[0] && document.getElementById(arguments[0]);
      return !panel || panel.state === 'closed';''', ACTIVE_POPUP_PANEL)


def wait_for(predicate, message, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError(message)


def press(*keys, scope='content'):
    context(scope)
    actions = [{'type': 'keyDown', 'value': key} for key in keys]
    actions += [{'type': 'keyUp', 'value': key} for key in reversed(keys)]
    call('WebDriver:PerformActions', actions=[{'type': 'key', 'id': 'keyboard', 'actions': actions}])


def type_text(value):
    context('content')
    actions = []
    for char in value:
        actions.extend([{'type': 'keyDown', 'value': char}, {'type': 'keyUp', 'value': char}])
    call('WebDriver:PerformActions', actions=[{'type': 'key', 'id': 'keyboard', 'actions': actions}])


def shortcut_keys(manifest):
    suggested = manifest['commands']['_execute_action']['suggested_key']
    system = 'mac' if platform.system() == 'Darwin' else 'linux' if platform.system() == 'Linux' else 'windows'
    shortcut = suggested.get(system, suggested.get('default'))
    modifiers = {'Command': '\ue03d', 'Ctrl': MODIFIER, 'MacCtrl': '\ue009',
                 'Shift': SHIFT, 'Alt': '\ue00a', 'Space': ' '}
    return [modifiers.get(part, part.lower()) for part in shortcut.split('+')]


def popup_diagnostics(parent):
    select(parent, scope='chrome')
    return script('''return {
      selectedURL:gBrowser.selectedBrowser.currentURI.spec,
      windowFocused:document.hasFocus(), activeElement:document.activeElement?.localName,
      activeElementId:document.activeElement?.id,
      focusedWindow:Services.focus.focusedWindow?.location?.href,
      focusedElement:Services.focus.focusedElement?.localName,
      panels:[...document.querySelectorAll('panel')].filter(panel=>panel.state!=='closed')
        .map(panel=>({id:panel.id,state:panel.state})),
      browsers:[...document.querySelectorAll('browser.webextension-popup-browser')]
        .map(browser=>({url:browser.currentURI?.spec,
          panel:browser.closest('panel')?.id,state:browser.closest('panel')?.state,
          connected:browser.isConnected,rect:browser.getBoundingClientRect().toJSON()})),
      keys:JSON.parse(document.documentElement.getAttribute('data-native-smoke-chrome-keys') || '[]')
    };''')


def open_popup(parent, expected_tabs, expected_windows):
    global ACTIVE_POPUP_PANEL
    wait_for(lambda: popup_fully_closed(parent), 'The previous popup closing animation did not finish.')
    assert not popup_state(parent)['open'], 'The previous popup did not close.'
    press(*SHORTCUT, scope='chrome')
    def loaded_popup():
        state = popup_state(parent)
        return state if state['open'] and '/popup.html' in (state.get('url') or '') else None
    try:
        state = wait_for(loaded_popup, 'The native _execute_action shortcut did not load the popup.')
    except AssertionError:
        print('POPUP_DIAGNOSTICS', json.dumps(popup_diagnostics(parent)), flush=True)
        raise
    ACTIVE_POPUP_PANEL = state['panelId']
    assert handles() == expected_tabs, 'Opening the popup changed browser tabs.'
    assert handles('chrome') == expected_windows, 'Opening the popup created a window.'
    print('PASS native shortcut opens toolbar popup without tabs or windows', flush=True)


def enter_popup(parent):
    select(parent, scope='chrome')
    browser = script('''return [...document.querySelectorAll('browser.webextension-popup-browser')]
      .find(item => item.closest('panel')?.state === 'open');''')
    if not browser:
        raise PopupRoutingUnavailable('The popup browser is not exposed in the chrome document.')
    try:
        # Context selection alone does not focus the popup or any input.
        call('WebDriver:SwitchToFrame', element=browser)
    except RuntimeError as error:
        raise PopupRoutingUnavailable('Marionette cannot enter the remote popup browser as a child frame.') from error
    context('content')
    wait_for(lambda: content_state()['ready'] == 'false', 'The popup content did not become ready.')
    initial = content_state()
    assert '/popup.html' in initial['url'], initial
    assert initial['activeElement'] == 'query', initial
    assert not initial['error'], initial
    # Passive observation; no .focus(), input targeting, or value assignment.
    script('''const events=[];
      const record=event=>{events.push({type:event.type,trusted:event.isTrusted,
        target:event.target?.id,activeElement:document.activeElement?.id,
        hasFocus:document.hasFocus()});
        document.documentElement.setAttribute('data-native-smoke-events',JSON.stringify(events));};
      document.addEventListener('keydown',record,true);
      document.addEventListener('input',record,true);
      return true;''')
    return initial


def content_state():
    context('content')
    return script('''return {url:location.href,activeElement:document.activeElement?.id,
      hasFocus:document.hasFocus(),value:document.querySelector('#query')?.value,
      ready:document.querySelector('#results')?.getAttribute('aria-busy'),
      selected:document.querySelector('[role="option"][aria-selected="true"]')?.textContent,
      results:document.querySelector('#results')?.textContent || '',
      error:document.querySelector('#error')?.textContent || '',
      events:JSON.parse(document.documentElement.getAttribute('data-native-smoke-events') || '[]')};''')


def close_key(parent, key=ESCAPE, scope='content'):
    try:
        press(key, scope=scope)
    except RuntimeError:
        # Successful dismissal can destroy the actor before keyUp replies.
        if popup_state(parent)['open']:
            raise
    # !open is also true during state=hiding. Wait for the native panel to
    # finish closing so the next shortcut cannot target its stale document.
    wait_for(lambda: popup_fully_closed(parent), 'The popup did not finish closing after the action.')


def add_fixture(url):
    context('content')
    created = call('WebDriver:NewWindow', type='tab', focus=True)
    select(created['handle'], focus=True)
    call('WebDriver:Navigate', url=url)
    return created['handle']


try:
    if not (EXTENSION / 'manifest.json').is_file():
        raise RuntimeError('Build first with npm run build, or set FFARC_EXTENSION_DIR.')
    manifest = json.loads((EXTENSION / 'manifest.json').read_text())
    assert manifest.get('action', {}).get('default_popup') == 'popup.html'
    assert '_execute_action' in manifest.get('commands', {})
    assert not manifest.get('background'), 'The toolbar popup does not need a background page.'
    assert 'sidebar_action' not in manifest and 'chrome_url_overrides' not in manifest
    SHORTCUT = shortcut_keys(manifest)

    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    profile = Path(tempfile.mkdtemp(prefix='ffarc-native-'))
    log = (profile / 'firefox.log').open('w')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    prefs = {
        'marionette.port': port,
        'browser.shell.checkDefaultBrowser': False,
        'browser.startup.homepage_override.mstone': 'ignore',
        'browser.startup.page': 0,
        'startup.homepage_welcome_url': 'about:blank',
        'startup.homepage_welcome_url.additional': '',
        'browser.newtabpage.activity-stream.feeds.system.topstories': False,
        'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons': False,
        'browser.tabs.warnOnClose': False,
    }
    (profile / 'user.js').write_text('\n'.join(
        f'user_pref({json.dumps(key)}, {json.dumps(value)});' for key, value in prefs.items()))
    env = dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS='1', MOZ_CRASHREPORTER_DISABLE='1')
    command = [FIREFOX, '-no-remote', '-profile', str(profile), '-marionette']
    if os.environ.get('FFARC_HEADLESS') == '1':
        command.append('-headless')
    elif platform.system() == 'Darwin':
        command.append('-foreground')
    process = subprocess.Popen(command + ['about:blank'], env=env, stdout=log, stderr=log)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            sock = socket.create_connection(('127.0.0.1', port), timeout=1)
            sock.settimeout(30)
            break
        except OSError:
            if process.poll() is not None:
                raise RuntimeError('Firefox exited: ' + Path(log.name).read_text()[-2000:])
            time.sleep(.1)
    if not sock:
        raise RuntimeError('Timed out connecting to Marionette.')
    print('HANDSHAKE', json.dumps(receive()), flush=True)
    session = call('WebDriver:NewSession', acceptInsecureCerts=True)
    print('FIREFOX_VERSION', session['capabilities']['browserVersion'], flush=True)
    print('INSTALLED', call('Addon:Install', path=str(EXTENSION), temporary=True), flush=True)

    context('content')
    original_tab = call('WebDriver:GetWindowHandle')
    fixture_url = origin + '/work/project?token=private-secret#private-fragment'
    add_fixture(fixture_url)
    add_fixture(origin + '/work/reference')
    select(original_tab, focus=True)
    context('chrome')
    parent = call('WebDriver:GetWindowHandle')
    parent_tabs, parent_windows = handles(), handles('chrome')
    parent_count = parent_state(parent)['tabCount']
    script('''const events=[];document.addEventListener('keydown',event=>{
      events.push({key:event.key,meta:event.metaKey,ctrl:event.ctrlKey,shift:event.shiftKey,
        target:event.target?.localName,id:event.target?.id,trusted:event.isTrusted});
      document.documentElement.setAttribute('data-native-smoke-chrome-keys',JSON.stringify(events));
    },true);return true;''')
    open_popup(parent, parent_tabs, parent_windows)
    try:
        enter_popup(parent)
    except PopupRoutingUnavailable as error:
        print('MARIONETTE_FRAME_LIMITATION', str(error), flush=True)
        close_key(parent, scope='chrome')
        assert handles() == parent_tabs and handles('chrome') == parent_windows
        print('PASS Escape dismisses toolbar popup without changing tabs or windows', flush=True)
        select(original_tab, focus=True)
        context('content')
        call('WebDriver:Navigate', url='about:addons')
        open_popup(parent, parent_tabs, parent_windows)
        assert parent_state(parent)['url'] == 'about:addons'
        close_key(parent, scope='chrome')
        print('PASS toolbar popup opens beside protected about:addons', flush=True)
        print('SKIP popup content typing, switching, and URL checks: remote frame '
              'is unavailable to Marionette. Verify physical shortcut-and-typing separately.', flush=True)
        raise SystemExit(0)

    type_text('ffarcprobe')
    report = content_state()
    if report['value'] != 'ffarcprobe':
        raise RuntimeError('Untargeted Marionette typing did not reach the popup; '
                           'physical keyboard focus requires desktop verification. '
                           f'Popup state: {report}')
    assert any(event['type'] == 'input' and event['trusted'] and event['target'] == 'query'
               for event in report['events']), report
    assert all(event['trusted'] for event in report['events']), report
    print('PASS popup receives untargeted trusted typing without harness input focus', flush=True)
    close_key(parent)
    assert handles() == parent_tabs and handles('chrome') == parent_windows

    open_popup(parent, parent_tabs, parent_windows)
    enter_popup(parent)
    type_text('Atlas')
    press(DOWN)
    report = content_state()
    assert 'Project Atlas' in (report.get('selected') or ''), report
    assert 'private-secret' not in report['results'] and 'private-fragment' not in report['results']
    close_key(parent, ENTER)
    assert parent_state(parent)['url'] == fixture_url
    assert handles() == parent_tabs and handles('chrome') == parent_windows
    print('PASS ArrowDown and Enter activate the existing tab and close the popup', flush=True)

    open_popup(parent, parent_tabs, parent_windows)
    enter_popup(parent)
    destination = origin + '/destination'
    type_text(destination)
    close_key(parent, ENTER)
    after = handles()
    assert parent_tabs < after and len(after - parent_tabs) == 1, (parent_tabs, after)
    selected = parent_state(parent)
    assert selected['url'] == destination and selected['tabCount'] == parent_count + 1, selected
    assert handles('chrome') == parent_windows, 'The destination appeared in another window.'
    context('content')
    wait_for(lambda: call('WebDriver:GetTitle') == 'Navigation destination', 'The destination did not load.')
    print('PASS URL Enter creates exactly one tab in the original window and closes the popup', flush=True)
    print('PASS toolbar-popup smoke test; no external search was submitted', flush=True)
finally:
    if sock:
        with contextlib.suppress(Exception):
            call('Marionette:Quit', flags=['eForceQuit'])
        sock.close()
    if process and process.poll() is None:
        process.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    if log:
        log.close()
    if server:
        server.shutdown()
        server.server_close()
    if profile:
        shutil.rmtree(profile, ignore_errors=True)
