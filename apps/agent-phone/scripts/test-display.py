#!/usr/bin/env python3
"""Dedicated, read-only emulator acceptance; never selects an attached physical device."""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import signal
import struct
import threading
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--api', choices=['30', '33', '36'], required=True)
parser.add_argument('--artifacts', type=Path, required=True)
parser.add_argument('--verify-only', action='store_true')
parser.add_argument('--gpu', default='swiftshader_indirect', help='Emulator GPU backend; use host for hardware rendering')
parser.add_argument('--modes', nargs='+', default=['permission', 'basic', 'flow', 'rotation', 'power', 'secure', 'protection', 'runtime', 'death', 'restart'])
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
sdk = Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk')))
out = args.artifacts.resolve() / args.api
out.mkdir(parents=True, exist_ok=True)
def interrupted(signum, frame):
    raise TimeoutError('Display acceptance interrupted')

signal.signal(signal.SIGTERM, interrupted)
serial = 'emulator-5580'
pkg = 'com.opensteer.agentphone'

def run(command, timeout=30, check=True):
    result = subprocess.run([str(x) for x in command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stdout.decode(errors='replace'))
    return result.stdout

def adb(*command, **kw):
    return run([sdk / 'platform-tools/adb', '-s', serial, *command], **kw)

def ready(stage, process):
    until = time.monotonic() + 45
    while time.monotonic() < until:
        value = adb('shell', 'run-as', pkg, 'cat', 'files/display-acceptance/ready', check=False, timeout=5)
        if value.strip() == stage.encode():
            return
        if process.poll() is not None:
            break
        time.sleep(.1)
    raise RuntimeError('Missing stage ' + stage)

def swipe(landscape=False):
    coords = ['1800', '800', '500', '800'] if landscape else ['500', '1800', '500', '500']
    adb('shell', 'input', 'swipe', *coords, '250')

class MediaPeer(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *unused):
        pass
    def do_GET(self):
        if self.path == '/close':
            for connection in list(self.server.media_connections):
                try:
                    body = struct.pack('!H', 1001) + b'going away'
                    connection.sendall(bytes([136, len(body)]) + body)
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
            return
        if self.path != '/internal/v1/computer-use/display' or self.headers.get('Authorization') != 'Bearer ' + 't' * 64:
            self.send_error(403); return
        key = self.headers['Sec-WebSocket-Key']
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101); self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept); self.end_headers()
        self.close_connection = True
        self.server.media_connections.append(self.connection)
        self.connection.settimeout(20)
        lock = threading.Lock()
        pending = [-1]
        released = threading.Event()
        def ack(sequence):
            body = json.dumps({'type': 'display.ack', 'sequence': sequence}).encode()
            self.connection.sendall(bytes([129, len(body)]) + body)
        def drain():
            time.sleep(.8)
            with lock:
                released.set()
                if pending[0] >= 0:
                    try: ack(pending[0])
                    except OSError: pass
        threading.Thread(target=drain, daemon=True).start()
        last = -1
        fragments = bytearray()
        try:
            with (out / 'socket-frames.jsonl').open('a') as trace:
                while True:
                    start = self.rfile.read(2)
                    if len(start) != 2 or start[0] & 15 == 8: break
                    opcode = start[0] & 15
                    length = start[1] & 127
                    if length == 126: length = struct.unpack('!H', self.rfile.read(2))[0]
                    elif length == 127: length = struct.unpack('!Q', self.rfile.read(8))[0]
                    if length > 5 * 1024 * 1024: raise ValueError('Oversized frame')
                    mask = self.rfile.read(4) if start[1] & 128 else bytes(4)
                    raw = self.rfile.read(length)
                    if len(raw) != length: break
                    part = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
                    if opcode not in [0, 2]: continue
                    if opcode == 2: fragments.clear()
                    fragments.extend(part)
                    if not start[0] & 128: continue
                    body = bytes(fragments)
                    header_size = struct.unpack('!I', body[:4])[0]
                    header = json.loads(body[4:4+header_size])
                    if header['sequence'] <= last: raise ValueError('Sequence regressed')
                    if header['key'] != ('codec' in header): raise ValueError('Invalid key codec')
                    last = header['sequence']
                    trace.write(json.dumps({**header, 'bytes': len(body), 'payloadSha256': hashlib.sha256(body[4+header_size:]).hexdigest()}) + '\n'); trace.flush()
                    with lock:
                        pending[0] = last
                        if released.is_set(): ack(last)
        except (OSError, ValueError, KeyError) as error:
            if not isinstance(error, OSError): (out / 'socket-error.txt').write_text(str(error))
        finally:
            self.server.media_connections.remove(self.connection)

def verify_media():
    if 'secure' not in args.modes:
        return
    media = out / 'files/display-acceptance'
    codec = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=width,height,profile,level,has_b_frames', '-of', 'json', media / 'secure.h264']))['streams'][0]
    if codec['profile'] not in ['Constrained Baseline', 'Baseline'] or codec['has_b_frames'] != 0:
        raise RuntimeError('Encoder profile or B-frame regression: ' + str(codec))
    crop_bytes = (codec['width'] // 2) * (codec['height'] // 2) * 3
    if max(codec['width'], codec['height']) > 1280:
        raise RuntimeError('Encoder exceeded requested long side')
    pixels = run(['ffmpeg', '-v', 'error', '-i', media / 'secure.h264', '-vf',
        'format=rgb24,crop=iw/2:ih/2:iw/4:ih/4:exact=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    final = pixels[-crop_bytes:]
    maxima = [max(final[i::3], default=255) for i in range(3)]
    if len(final) != crop_bytes or max(maxima) >= 8:
        raise RuntimeError('MainActivity secure pixels were not all black: ' + str(maxima))
    baseline = run(['ffmpeg', '-v', 'error', '-i', media / 'secure-initial.h264', '-vf',
        'crop=iw/2:ih/2:iw/4:ih/4,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    if len(baseline) < 3 or max(baseline[-3:]) < 8:
        raise RuntimeError('Secure-window baseline was already black')
    (out / 'pixels.json').write_text(json.dumps({'passed': True, 'secureFinalCentralMaxRGB': maxima,
        'baselineCentralMeanRGB': list(baseline[-3:]), 'codec': codec}) + '\n')

def write_hashes():
    (out / 'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest() + '  ' + str(f.relative_to(out)) + '\n'
        for f in sorted(out.rglob('*')) if f.is_file() and f.name not in ['emulator.log', 'SHA256SUMS']))

if args.verify_only:
    verify_media()
    write_hashes()
    raise SystemExit(0)

peer = None
if 'runtime' in args.modes:
    peer = ThreadingHTTPServer(('127.0.0.1', 18765), MediaPeer)
    peer.media_connections = []
    peer.daemon_threads = True
    threading.Thread(target=peer.serve_forever, daemon=True).start()

# Refuse an existing emulator on the reserved port instead of accidentally sharing it.
attached = run([sdk / 'platform-tools/adb', 'devices']).decode()
if serial in attached:
    raise RuntimeError(serial + ' is already in use')
log = (out / 'emulator.log').open('wb')
emulator = subprocess.Popen([str(sdk / 'emulator/emulator'), '-avd', 'opensteer-agent-phone-' + args.api,
    '-port', '5580', '-memory', '4096', '-no-window', '-no-audio', '-no-snapshot-save', '-no-boot-anim', '-read-only', '-gpu', args.gpu], stdout=log, stderr=subprocess.STDOUT)
active = None
try:
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        if emulator.poll() is not None:
            raise RuntimeError('Emulator exited; see emulator.log')
        if adb('shell', 'getprop', 'sys.boot_completed', check=False, timeout=5).strip() == b'1':
            break
        time.sleep(2)
    else:
        raise RuntimeError('Boot timeout')
    adb('shell', 'input', 'keyevent', '82')
    apk_hashes = {}
    for apk in ['app/build/outputs/apk/debug/app-debug.apk', 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk', 'fixture/build/outputs/apk/debug/fixture-debug.apk']:
        apk_file = root / 'apps/agent-phone' / apk
        apk_hashes[apk] = hashlib.sha256(apk_file.read_bytes()).hexdigest()
        adb('install', '-r', apk_file, timeout=90)
    (out / 'apks.json').write_text(json.dumps(apk_hashes, indent=2) + '\n')
    adb('shell', 'pm', 'clear', pkg)
    adb('shell', 'settings', 'delete', 'secure', 'enabled_accessibility_services')
    adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0')
    adb('shell', 'pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS', check=False)
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
    for key in ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']:
        adb('shell', 'settings', 'put', 'global', key, '0')
    # Let first-boot package optimization settle before measuring cold codec startup.
    time.sleep(60)
    (out / 'device.txt').write_bytes(adb('shell', 'getprop'))
    (out / 'device-memory.txt').write_bytes(adb('shell', 'cat', '/proc/meminfo'))
    wm_help = adb('shell', 'wm', 'help', check=False)
    (out / 'wm-help.txt').write_bytes(wm_help)
    wm_commands = {line.strip().split()[0] for line in wm_help.decode().splitlines() if line.strip()}
    rotation_command = next((name for name in ['user-rotation', 'set-user-rotation'] if name in wm_commands), None)
    fixed_command = next((name for name in ['fixed-to-user-rotation', 'set-fix-to-user-rotation'] if name in wm_commands), None)
    if peer is not None:
        adb('reverse', 'tcp:18765', 'tcp:18765')
    for mode in args.modes:
        adb('shell', 'input', 'keyevent', '224')
        adb('shell', 'wm', 'dismiss-keyguard')
        adb('shell', 'input', 'keyevent', '3')
        if mode in ['flow', 'rotation', 'protection']:
            adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
        # HOME suppresses app switches for five seconds on API 30; measure capture after that shell-side throttle.
        time.sleep(6)
        if mode == 'runtime':
            adb('shell', 'settings', 'delete', 'secure', 'enabled_accessibility_services')
            adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0')
            adb('shell', 'am', 'start', '-n', pkg + '.fixture/.FixtureActivity')
            adb('shell', 'content', 'delete', '--uri', 'content://com.opensteer.agentphone.fixture.receipts/receipts')
        # Setup grants the UID mode; a package-mode deny cannot override an old UID grant.
        projection_mode = 'deny' if mode == 'permission' else 'allow'
        adb('shell', 'appops', 'set', '--uid', pkg, 'PROJECT_MEDIA', projection_mode)
        adb('shell', 'appops', 'set', pkg, 'PROJECT_MEDIA', projection_mode)
        (out / (mode + '-appop.txt')).write_bytes(adb('shell', 'appops', 'get', pkg, 'PROJECT_MEDIA'))
        if mode == 'basic':
            (out / 'appop.txt').write_bytes(adb('shell', 'appops', 'get', pkg, 'PROJECT_MEDIA'))
        adb('shell', 'run-as', pkg, 'rm', '-f', 'files/display-acceptance/ready', check=False)
        cmd = [sdk / 'platform-tools/adb', '-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'mode', mode,
            pkg + '.test/' + pkg + '.display.DisplayInstrumentation']
        active = subprocess.Popen([str(x) for x in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if mode == 'flow':
            ready('flow', active)
            for _ in range(9):
                swipe()
                adb('shell', 'input', 'swipe', '500', '500', '500', '1800', '250')
        elif mode == 'rotation':
            ready('rotation', active)
            if fixed_command: adb('shell', 'wm', fixed_command, 'enabled')
            if rotation_command: adb('shell', 'wm', rotation_command, 'lock', '1')
            else: adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
            ready('rotated', active)
            swipe(True)
        elif mode == 'power':
            ready('power', active)
            adb('shell', 'input', 'keyevent', '223')
            time.sleep(2)
            adb('shell', 'input', 'keyevent', '224')
            adb('shell', 'wm', 'dismiss-keyguard')
            ready('awake', active)
            adb('shell', 'input', 'keyevent', '3')
        elif mode == 'protection':
            ready('protection', active)
            swipe()
        elif mode == 'runtime':
            ready('runtime-bind', active)
            # am instrument force-stops the target. Clear any crashed-service
            # record after that stop, before asking Android to bind this run.
            adb('shell', 'settings', 'delete', 'secure', 'enabled_accessibility_services')
            adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0')
            deadline = time.monotonic() + 5
            while True:
                state = adb('shell', 'dumpsys', 'accessibility')
                if b'Crashed services:{{com.opensteer.agentphone/' not in state: break
                if time.monotonic() > deadline: raise RuntimeError('Previous accessibility crash was not cleared')
                time.sleep(.1)
            adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', pkg + '/' + pkg + '.control.AgentPhoneAccessibilityService')
            adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
            (out / 'runtime-bind.txt').write_bytes(adb('shell', 'dumpsys', 'accessibility'))
            ready('runtime-power', active)
            adb('shell', 'input', 'keyevent', '223'); time.sleep(2)
            adb('shell', 'input', 'keyevent', '224'); adb('shell', 'wm', 'dismiss-keyguard')
            ready('runtime-lift', active)
            adb('shell', 'am', 'start', '-n', pkg + '.fixture/.FixtureActivity')
            for _ in range(3): swipe()
            ready('runtime-encoder', active)
            for _ in range(3): swipe()
        elif mode == 'death':
            ready('death', active)
            (out / 'before-death.txt').write_bytes(adb('shell', 'dumpsys', 'media_projection'))
            pid = adb('shell', 'pidof', pkg).strip()
            (out / 'pid-before.txt').write_bytes(pid + b'\n')
            adb('shell', 'run-as', pkg, 'touch', 'files/display-acceptance/kill')
            deadline = time.monotonic() + 5
            while True:
                after = adb('shell', 'dumpsys', 'media_projection', timeout=5)
                if b'Media Projection:' in after and after.split(b'Media Projection:', 1)[1].strip().startswith(b'null'): break
                if time.monotonic() >= deadline: raise RuntimeError('Projection survived SIGKILL')
                time.sleep(.1)
            (out / 'native-death-pid.txt').write_bytes(adb('shell', 'run-as', pkg, 'cat', 'files/display-acceptance/death-pid'))
            (out / 'after-death.txt').write_bytes(after)
            if b'Media Projection:' not in after or not after.split(b'Media Projection:', 1)[1].strip().startswith(b'null'):
                raise RuntimeError('Projection survived process death')
        result = active.communicate(timeout=35)[0]
        (out / (mode + '.txt')).write_bytes(result)
        print(args.api, mode, result.decode(errors='replace'), flush=True)
        if mode != 'death' and b'INSTRUMENTATION_CODE: -1' not in result:
            raise RuntimeError('Instrumentation failed: ' + mode)
        if mode == 'restart':
            metrics = json.loads(result.decode().split('result=', 1)[1].splitlines()[0])
            (out / 'pid-after.txt').write_text(str(metrics['pid']) + '\n')
            if str(metrics['pid']) == (out / 'pid-before.txt').read_text().strip(): raise RuntimeError('Process did not restart')
        if mode == 'rotation':
            if rotation_command: adb('shell', 'wm', rotation_command, 'lock', '0')
            else: adb('shell', 'settings', 'put', 'system', 'user_rotation', '0')
        if mode == 'runtime':
            receipts = adb('shell', 'content', 'query', '--uri', 'content://com.opensteer.agentphone.fixture.receipts/receipts')
            (out / 'runtime-receipts.txt').write_bytes(receipts)
            if not all(kind in receipts for kind in [b'kind=button_tap', b'kind=drag_start', b'kind=drop, detail=target', b'kind=set_text, detail=owner', b'kind=submit']):
                raise RuntimeError('Missing owner tap or agent drag receipt: ' + receipts.decode())
            if (out / 'socket-error.txt').exists(): raise RuntimeError('Invalid media envelope')
            adb('shell', 'settings', 'delete', 'secure', 'enabled_accessibility_services')
            adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0')
        active = None
    (out / 'logcat.txt').write_bytes(adb('logcat', '-d', '-t', '3000'))
    if 'runtime' in args.modes:
        diagnostics = (out / 'logcat.txt').read_text()
        for expected in ['State ', 'Data socket closed: code=1001 reason=going away', 'Data socket failed: HTTP 403']:
            if expected not in diagnostics: raise RuntimeError('Missing display diagnostic: ' + expected)
        if 't' * 64 in diagnostics or 'u' * 64 in diagnostics:
            raise RuntimeError('Data ticket leaked into display diagnostics')
    (out / 'artifacts.tar').write_bytes(adb('exec-out', 'run-as', pkg, 'tar', '-c', 'files/display-acceptance'))
    run(['tar', '-xf', out / 'artifacts.tar', '-C', out])
    media = out / 'files/display-acceptance'
    verify_media()
    write_hashes()
except Exception:
    if active is not None:
        active.terminate()
        try:
            output = active.communicate(timeout=5)[0]
            (out / 'interrupted.txt').write_bytes(output)
        except subprocess.TimeoutExpired:
            active.kill(); active.communicate(timeout=5)
    (out / 'runtime-receipts-failure.txt').write_bytes(adb('shell', 'content', 'query', '--uri', 'content://com.opensteer.agentphone.fixture.receipts/receipts', check=False, timeout=15))
    (out / 'accessibility-failure.txt').write_bytes(adb('shell', 'dumpsys', 'accessibility', check=False, timeout=15))
    (out / 'services-failure.txt').write_bytes(adb('shell', 'dumpsys', 'activity', 'services', pkg, check=False, timeout=15))
    (out / 'partial-artifacts.tar').write_bytes(adb('exec-out', 'run-as', pkg, 'tar', '-c', 'files/display-acceptance', check=False, timeout=15))
    (out / 'failure-logcat.txt').write_bytes(adb('logcat', '-d', '-t', '3000', check=False, timeout=15))
    raise
finally:
    adb('shell', 'sync', check=False, timeout=15)
    adb('emu', 'kill', check=False, timeout=10)
    try:
        emulator.wait(timeout=15)
    except subprocess.TimeoutExpired:
        emulator.terminate(); emulator.wait(timeout=5)
    detached_by = time.monotonic() + 10
    while time.monotonic() < detached_by:
        if serial not in run([sdk / 'platform-tools/adb', 'devices'], timeout=5).decode(): break
        time.sleep(.2)
    else:
        raise RuntimeError('Stopped emulator did not detach from ADB')
    log.close()
    if peer is not None:
        peer.shutdown(); peer.server_close()
