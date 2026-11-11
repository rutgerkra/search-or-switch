"""Verify discovery through Firefox's real isolated content-script API.

Uses only localhost fixtures, a temporary extension, and a disposable profile.
No regular Firefox profile is opened. The test extension receives HTTP(S) access
only within that disposable profile; the shipped optional permissions are intact.
Set FIREFOX_BIN for another binary or FFARC_HEADLESS=0 to show the test window.
"""
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
FIREFOX = (os.environ.get('FIREFOX_BIN') or shutil.which('firefox')
           or '/Applications/Firefox.app/Contents/MacOS/firefox')
MARKER = 'DO_NOT_SAVE_NATIVE_QUERY'
reports = []
reported = threading.Event()


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/opensearch.xml':
            body = ('''<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>Native Fixture</ShortName><InputEncoding>UTF-8</InputEncoding>
<Url type="text/html" method="GET" template="'''
                    + self.server.origin + '''/results?q={searchTerms}"/>
</OpenSearchDescription>''').encode()
            content_type = 'application/opensearchdescription+xml; charset=utf-8'
        else:
            body = ('''<!doctype html><meta charset="utf-8"><title>Native Fixture</title>
<link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml">
<form role="search" action="/results" method="get">
<input type="search" name="q" value="''' + MARKER + '''">
<input type="hidden" name="title" value="Special:Search"><button>Search</button>
</form>''').encode()
            content_type = 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        reports.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(200)
        self.end_headers()
        reported.set()

    def log_message(self, *args):
        pass


sock = process = server = log = profile = None
request_id = 0


def receive():
    size = b''
    while True:
        char = sock.recv(1)
        if not char:
            raise RuntimeError('Marionette socket closed')
        if char == b':':
            break
        size += char
    data = b''
    while len(data) < int(size):
        chunk = sock.recv(int(size) - len(data))
        if not chunk:
            raise RuntimeError('Marionette socket closed while reading a response')
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


try:
    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    server.origin = f'http://127.0.0.1:{server.server_port}'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = Path(tempfile.mkdtemp(prefix='ffarc-discovery-smoke-'))
    extension = profile / 'extension'
    extension.mkdir()
    for name in ['site-discovery.js', 'site-discovery-service.js', 'site-search.js']:
        shutil.copyfile(ROOT / name, extension / name)
    manifest = {
        'manifest_version': 3, 'name': 'Disposable site-discovery test', 'version': '1.0',
        'permissions': ['tabs', 'scripting', 'storage'],
        'host_permissions': ['http://*/*', 'https://*/*'],
        'background': {'scripts': ['probe.js'], 'type': 'module'},
        'browser_specific_settings': {'gecko': {'id': 'site-discovery-test@ffarc.local',
                                              'data_collection_permissions': {'required': ['none']}}},
        'content_security_policy': {'extension_pages': "script-src 'self'; connect-src http: https:"},
    }
    (extension / 'manifest.json').write_text(json.dumps(manifest))
    probe = '''import {createSiteSearchService} from './site-discovery-service.js';
const report = {};
try {
  report.permitted = await browser.permissions.contains({origins:['http://*/*','https://*/*']});
  const tab = (await browser.tabs.query({})).find(tab => tab.url.startsWith(ORIGIN));
  report.extracted = (await browser.scripting.executeScript({target:{tabId:tab.id},files:['site-discovery.js']}))
    .map(item => ({frameId:item.frameId,result:item.result,error:item.error ? String(item.error) : null}));
  const service = createSiteSearchService(browser);
  await service.start();
  report.catalog = await service.setEnabled(true);
  report.saved = await browser.storage.local.get('siteSearchDiscoveryV1');
  service.dispose();
} catch (error) { report.error = String(error); }
await fetch(ORIGIN+'/report', {method:'POST',body:JSON.stringify(report)});
'''.replace('ORIGIN', json.dumps(server.origin))
    (extension / 'probe.js').write_text(probe)
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    (profile / 'user.js').write_text('\n'.join([
        f'user_pref("marionette.port", {port});',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("browser.startup.firstrunSkipsHomepage", true);',
    ]))
    log = (profile / 'firefox.log').open('w')
    command = [FIREFOX, '-no-remote', '-profile', str(profile), '-marionette']
    if os.environ.get('FFARC_HEADLESS', '1') != '0':
        command.append('-headless')
    process = subprocess.Popen(command + ['about:blank'], stdout=log, stderr=log,
                               env=dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS='1', MOZ_CRASHREPORTER_DISABLE='1'))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            sock = socket.create_connection(('127.0.0.1', port), timeout=1)
            sock.settimeout(20)
            break
        except OSError:
            if process.poll() is not None:
                raise RuntimeError('Firefox exited: ' + Path(log.name).read_text()[-2000:])
            time.sleep(.1)
    if not sock:
        raise RuntimeError('Timed out connecting to disposable Firefox')
    receive()
    session = call('WebDriver:NewSession', acceptInsecureCerts=True)
    print('FIREFOX_VERSION', session['capabilities']['browserVersion'], flush=True)
    call('Marionette:SetContext', value='content')
    call('WebDriver:Navigate', url=server.origin + '/?private=' + MARKER)
    call('Addon:Install', path=str(extension), temporary=True)
    assert reported.wait(15), 'The temporary extension did not report discovery results'
    report = reports[0]
    assert not report.get('error'), report.get('error')
    assert report['permitted'] is True, 'Temporary extension lacks its test host grant'
    extracted = report['extracted']
    assert len(extracted) == 1 and extracted[0]['frameId'] == 0 and not extracted[0]['error'], extracted
    payload = extracted[0]['result']
    expected_form = server.origin + '/results?q={searchTerms}&title=Special%3ASearch'
    assert payload == {'openSearch': [server.origin + '/opensearch.xml'], 'forms': [{'template': expected_form}]}, payload
    expected_site = {'id': 'learned:' + server.origin, 'name': 'Native Fixture', 'keyword': '127.0.0.1',
                     'origin': server.origin, 'template': server.origin + '/results?q={searchTerms}'}
    assert report['catalog'] == {'enabled': True, 'permitted': True, 'learned': [expected_site]}, report['catalog']
    assert MARKER not in json.dumps(payload) + json.dumps(report['saved']), 'Entered or visited query was saved'
    print('PASS actual Firefox content-script extraction and learned catalog; no query values saved', flush=True)
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
