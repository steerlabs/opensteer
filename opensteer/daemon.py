"""Opensteer local daemon and browser broker."""

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse
from collections import deque
from pathlib import Path

from cdp_use.client import CDPClient

from .env import load_env
from .errors import OpenSteerError, error_log_line, error_to_wire, normalize_exception
from .http_client import request_json
from .paths import broker_paths, get_name, session_paths, session_state_path


load_env()

NAME = get_name()
BROKER_MODE = os.environ.get("OPENSTEER_BROKER") == "1"
SOCK, PID, LOG = broker_paths() if BROKER_MODE else session_paths(NAME)
BUF = 500
CDP_COMMAND_TIMEOUT = 15
BROKER_REQUEST_TIMEOUT = 90
PROFILES = [
    Path.home() / "Library/Application Support/net.imput.helium",
    Path.home() / "Library/Application Support/Google/Chrome",
    Path.home() / "Library/Application Support/Microsoft Edge",
    Path.home() / "Library/Application Support/Microsoft Edge Beta",
    Path.home() / "Library/Application Support/Microsoft Edge Dev",
    Path.home() / "Library/Application Support/Microsoft Edge Canary",
    Path.home() / ".config/google-chrome",
    Path.home() / ".config/chromium",
    Path.home() / ".config/chromium-browser",
    Path.home() / ".config/microsoft-edge",
    Path.home() / ".config/microsoft-edge-beta",
    Path.home() / ".config/microsoft-edge-dev",
    Path.home() / ".var/app/org.chromium.Chromium/config/chromium",
    Path.home() / ".var/app/com.google.Chrome/config/google-chrome",
    Path.home() / ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    Path.home() / ".var/app/com.microsoft.Edge/config/microsoft-edge",
    Path.home() / "AppData/Local/Google/Chrome/User Data",
    Path.home() / "AppData/Local/Chromium/User Data",
    Path.home() / "AppData/Local/Microsoft/Edge/User Data",
    Path.home() / "AppData/Local/Microsoft/Edge Beta/User Data",
    Path.home() / "AppData/Local/Microsoft/Edge Dev/User Data",
    Path.home() / "AppData/Local/Microsoft/Edge SxS/User Data",
]
INTERNAL = ("chrome://", "chrome-untrusted://", "devtools://", "chrome-extension://", "about:")
MARK_TAB_JS = "if(!document.title.startsWith('\U0001f7e2'))document.title='\U0001f7e2 '+document.title"
OPENSTEER_API = (os.environ.get("OPENSTEER_API") or "https://api.opensteer.com").rstrip("/")
REMOTE_ID = os.environ.get("OPENSTEER_BROWSER_ID")
API_KEY = os.environ.get("OPENSTEER_API_KEY")


def log(msg):
    with open(LOG, "a") as fh:
        fh.write(f"{msg}\n")


def _tail(path):
    try:
        return Path(path).read_text().strip().splitlines()[-1]
    except (FileNotFoundError, IndexError):
        return None


def _redact_ws_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except Exception:
        return "<redacted>"


def _opensteer(path, method, body=None, timeout=15):
    return request_json(OPENSTEER_API, API_KEY or "", path, method, body, timeout=timeout)


def refresh_remote_cdp_ws_url():
    if not REMOTE_ID or not API_KEY:
        return None
    response = _opensteer(f"/v2/opensteer/sessions/{urllib.parse.quote(REMOTE_ID, safe='')}/cdp", "POST")
    url = response.get("cdpWsUrl") or response.get("webSocketDebuggerUrl")
    if not url:
        raise OpenSteerError(
            "OpenSteer did not return a fresh CDP grant.",
            code="CLOUD_CDP_GRANT_MISSING",
            source="opensteer-api",
        )
    os.environ["OPENSTEER_CDP_WS"] = url
    return url


def get_ws_url():
    if url := os.environ.get("OPENSTEER_CDP_WS"):
        return url
    if REMOTE_ID and API_KEY:
        refreshed = refresh_remote_cdp_ws_url()
        if refreshed:
            return refreshed
    for base in PROFILES:
        try:
            port, path = (base / "DevToolsActivePort").read_text().strip().split("\n", 1)
        except (FileNotFoundError, NotADirectoryError):
            continue
        deadline = time.time() + 30
        while True:
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe.settimeout(1)
            try:
                probe.connect(("127.0.0.1", int(port.strip())))
                break
            except OSError:
                if time.time() >= deadline:
                    raise OpenSteerError(
                        "Chrome's remote-debugging page is open, but DevTools is not live yet "
                        f"on 127.0.0.1:{port.strip()}.",
                        code="LOCAL_CDP_NOT_READY",
                        source="local-browser",
                        hint="If Chrome opened a profile picker, choose your normal profile, then click Allow.",
                        details={"port": port.strip()},
                    )
                time.sleep(1)
            finally:
                probe.close()
        return f"ws://127.0.0.1:{port.strip()}{path.strip()}"
    raise OpenSteerError(
        "Chrome remote debugging is not enabled for a local browser.",
        code="LOCAL_CDP_NOT_ENABLED",
        source="local-browser",
        details={"profilePaths": [str(p) for p in PROFILES]},
    )


def stop_remote():
    if not REMOTE_ID or not API_KEY:
        return
    try:
        _opensteer(f"/v2/opensteer/sessions/{urllib.parse.quote(REMOTE_ID, safe='')}", "DELETE")
        log(f"stopped remote browser {REMOTE_ID}")
    except Exception as e:
        log(f"stop_remote failed ({REMOTE_ID}): {e}")


def is_real_page(t):
    return t["type"] == "page" and not t.get("url", "").startswith(INTERNAL)


def parse_surface_target_id(value):
    if not isinstance(value, str) or not value:
        return None
    return value.removeprefix("target:")


def _socket_alive(path):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(path)
        s.close()
        return True
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
        return False


def _request_socket(path, req, timeout=BROKER_REQUEST_TIMEOUT):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path)
        s.sendall((json.dumps(req) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            data += chunk
        return json.loads(data or b"{}")
    finally:
        s.close()


class BrowserSession:
    def __init__(self, broker, name):
        self.broker = broker
        self.name = name or "default"
        self.session = None
        self.target_id = None
        self.owned_target_ids = []
        self.opener_by_target_id = {}
        self.focus_stack = []
        self.events = deque(maxlen=BUF)
        self.dialog = None
        self._mark_task = None
        self._lock = asyncio.Lock()
        self._load_state()

    @property
    def state_path(self):
        return session_state_path(self.name)

    def _log(self, msg):
        log(f"[{self.name}] {msg}")

    def _load_state(self):
        try:
            data = json.loads(Path(self.state_path).read_text())
        except Exception:
            return
        owned = data.get("owned_target_ids") or []
        self.owned_target_ids = [t for t in owned if isinstance(t, str)]
        openers = data.get("opener_by_target_id") or {}
        if isinstance(openers, dict):
            self.opener_by_target_id = {k: v for k, v in openers.items() if isinstance(k, str) and isinstance(v, str)}
        focus_stack = data.get("focus_stack") or []
        self.focus_stack = [t for t in focus_stack if isinstance(t, str)]
        target_id = data.get("active_target_id")
        if isinstance(target_id, str):
            self.target_id = target_id
            if target_id not in self.owned_target_ids:
                self.owned_target_ids.append(target_id)

    def _save_state(self):
        data = {
            "active_target_id": self.target_id,
            "owned_target_ids": self.owned_target_ids,
            "opener_by_target_id": self.opener_by_target_id,
            "focus_stack": self.focus_stack,
        }
        try:
            Path(self.state_path).write_text(json.dumps(data, sort_keys=True))
        except Exception as e:
            self._log(f"state save: {e}")

    def _claim_target_local(self, target_id, active=True):
        if not target_id:
            return
        if target_id not in self.owned_target_ids:
            self.owned_target_ids.append(target_id)
        if active:
            if self.target_id and self.target_id != target_id:
                self.clear_session()
            self.target_id = target_id
            self.focus_stack = [target_id] + [t for t in self.focus_stack if t != target_id]
        self._save_state()

    def claim_target(self, target_id, active=True, opener_target_id=None):
        if target_id and opener_target_id:
            self.opener_by_target_id[target_id] = opener_target_id
        self.broker.claim_target(self, target_id, active=active)

    def _forget_target_local(self, target_id):
        if not target_id:
            return
        active = self.target_id == target_id
        opener = self.opener_by_target_id.get(target_id)
        self.owned_target_ids = [t for t in self.owned_target_ids if t != target_id]
        self.focus_stack = [t for t in self.focus_stack if t != target_id]
        self.opener_by_target_id.pop(target_id, None)
        if active:
            if opener in self.owned_target_ids:
                self.target_id = opener
            else:
                self.target_id = next((t for t in self.focus_stack if t in self.owned_target_ids), None)
                if not self.target_id:
                    self.target_id = self.owned_target_ids[-1] if self.owned_target_ids else None
            self.clear_session()
        self._save_state()

    def forget_target(self, target_id):
        self._forget_target_local(target_id)

    def clear_session(self):
        if self.session:
            self.broker.session_by_id.pop(self.session, None)
        self.session = None

    def set_session(self, session_id, target_id=None):
        self.clear_session()
        self.session = session_id
        if session_id:
            self.broker.session_by_id[session_id] = self
        if target_id:
            self.claim_target(target_id, active=True)

    def record_target_result(self, method, params, result):
        if method == "Target.createTarget":
            self.claim_target(result.get("targetId"), active=False)
        elif method == "Target.closeTarget":
            self.forget_target(params.get("targetId"))
        elif method == "Target.activateTarget":
            self.claim_target(params.get("targetId"), active=True)
        elif method == "Target.attachToTarget":
            if sid := result.get("sessionId"):
                self.broker.session_by_id[sid] = self
        elif method == "Target.detachFromTarget":
            if sid := params.get("sessionId"):
                self.broker.session_by_id.pop(sid, None)

    def _choose_target(self, targets):
        pages = [t for t in targets if t.get("type") == "page"]
        by_id = {t["targetId"]: t for t in pages if t.get("targetId")}
        if self.target_id in by_id:
            return by_id[self.target_id]
        for target_id in self.owned_target_ids:
            if target_id in by_id:
                return by_id[target_id]
        taken = self.broker.owned_target_ids(excluding=self)
        for target in pages:
            if target.get("targetId") not in taken and is_real_page(target):
                return target
        return None

    async def attach_target(self, target):
        target_id = target["targetId"]
        sid = (await self.broker.send_cdp("Target.attachToTarget", {"targetId": target_id, "flatten": True}))[
            "sessionId"
        ]
        self.set_session(sid, target_id)
        self._log(f"attached {target_id} ({target.get('url', '')[:80]}) session={self.session}")
        for d in ("Page", "DOM", "Runtime", "Network"):
            try:
                await self.broker.send_cdp(f"{d}.enable", session_id=self.session, timeout=5)
            except Exception as e:
                self._log(f"enable {d}: {e}")
        self._schedule_mark_tab()
        return target

    async def attach_first_page(self):
        async with self.broker.target_lock:
            targets = (await self.broker.send_cdp("Target.getTargets"))["targetInfos"]
            target = self._choose_target(targets)
            if not target:
                tid = (await self.broker.send_cdp("Target.createTarget", {"url": "about:blank"}))["targetId"]
                self._log(f"no unowned real pages found, created about:blank ({tid})")
                target = {"targetId": tid, "url": "about:blank", "type": "page"}
            return await self.attach_target(target)

    def on_event(self, method, params, session_id=None):
        self.events.append({"method": method, "params": params, "session_id": session_id})
        if method == "Page.javascriptDialogOpening":
            self.dialog = params
        elif method == "Page.javascriptDialogClosed":
            self.dialog = None
        elif method in ("Page.loadEventFired", "Page.domContentEventFired"):
            self._schedule_mark_tab()
        elif method in ("Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget"):
            target_info = params.get("targetInfo") or {}
            target_id = target_info.get("targetId")
            opener_id = target_info.get("openerId")
            if target_info.get("type") == "page" and target_id and opener_id in self.owned_target_ids:
                self.claim_target(target_id, active=True, opener_target_id=opener_id)

    def _schedule_mark_tab(self):
        if self._mark_task and not self._mark_task.done():
            return
        self._mark_task = asyncio.create_task(self._mark_tab())

    async def _mark_tab(self):
        session = self.session
        if not self.broker.cdp or not session:
            return
        try:
            await self.broker.send_cdp(
                "Runtime.evaluate",
                {"expression": MARK_TAB_JS},
                session_id=session,
                timeout=2,
            )
        except Exception:
            pass

    async def cancel_tasks(self):
        if self._mark_task and not self._mark_task.done():
            self._mark_task.cancel()
            try:
                await self._mark_task
            except asyncio.CancelledError:
                pass
        self._mark_task = None

    async def health(self):
        if not self.broker.cdp:
            error = OpenSteerError("CDP client not connected.", code="CDP_CLIENT_NOT_CONNECTED", source="cdp")
            return {"ok": False, "error": error.to_wire()}
        if not self.broker.reader_alive():
            error = OpenSteerError("CDP receiver task is not running.", code="CDP_RECEIVER_STOPPED", source="cdp")
            return {"ok": False, "error": error.to_wire()}
        try:
            await self.broker.send_cdp("Target.getTargets", timeout=3)
            return {"ok": True, "session_id": self.session, "target_id": self.target_id}
        except Exception as e:
            return {"ok": False, "error": error_to_wire(e, source="cdp")}

    async def handle(self, req):
        meta = req.get("meta")
        if meta == "drain_events":
            out = list(self.events)
            self.events.clear()
            return {"events": out}
        if meta == "session":
            return {"session_id": self.session, "target_id": self.target_id}
        if meta == "claim_target":
            self.claim_target(req.get("target_id"), active=req.get("active", True))
            return {"target_id": self.target_id, "owned_target_ids": self.owned_target_ids}
        if meta == "health":
            return await self.health()
        if meta == "reconnect":
            try:
                return await self.broker.reconnect(req.get("reason") or "meta:reconnect")
            except Exception as e:
                return {"error": error_to_wire(e, source="daemon")}
        if meta == "set_session":
            self.set_session(req.get("session_id"), req.get("target_id"))
            try:
                await self.broker.send_cdp("Page.enable", session_id=self.session, timeout=3)
                await self.broker.send_cdp(
                    "Runtime.evaluate",
                    {"expression": MARK_TAB_JS},
                    session_id=self.session,
                    timeout=2,
                )
            except Exception:
                pass
            return {"session_id": self.session, "target_id": self.target_id}
        if meta == "pending_dialog":
            return {"dialog": self.dialog}
        if meta == "list_surfaces":
            return await self.list_surfaces()
        if meta == "current_surface":
            surfaces = await self.list_surfaces()
            active = next((s for s in surfaces["surfaces"] if s.get("active")), None)
            return {"surface": active}
        if meta == "switch_surface":
            return await self.switch_surface(req.get("surface_id") or req.get("target_id"))

        async with self._lock:
            method = req["method"]
            params = dict(req.get("params") or {})
            if method == "Target.getTargetInfo" and not params.get("targetId") and self.target_id:
                params["targetId"] = self.target_id
            sid = None if method.startswith("Target.") else (req.get("session_id") or self.session)
            try:
                if not self.broker.reader_alive():
                    await self.broker.reconnect("receiver task not running")
                    sid = None if method.startswith("Target.") else (req.get("session_id") or self.session)
                if not method.startswith("Target.") and not sid:
                    await self.attach_first_page()
                    sid = req.get("session_id") or self.session
                result = await self.broker.send_cdp(method, params, session_id=sid)
                self.record_target_result(method, params, result)
                return {"result": result}
            except Exception as e:
                msg = str(e)
                if self.broker.transport_error(msg):
                    try:
                        await self.broker.reconnect(msg)
                        sid = None if method.startswith("Target.") else (req.get("session_id") or self.session)
                        if not method.startswith("Target.") and not sid:
                            await self.attach_first_page()
                            sid = req.get("session_id") or self.session
                        result = await self.broker.send_cdp(method, params, session_id=sid)
                        self.record_target_result(method, params, result)
                        return {"result": result}
                    except Exception as re:
                        return {"error": error_to_wire(re, source="daemon")}
                if "Session with given id not found" in msg and sid == self.session and sid:
                    self._log(f"stale session {sid}, re-attaching")
                    if await self.attach_first_page():
                        result = await self.broker.send_cdp(method, params, session_id=self.session)
                        self.record_target_result(method, params, result)
                        return {"result": result}
                return {"error": error_to_wire(e, source="cdp")}

    async def list_surfaces(self):
        targets = (await self.broker.send_cdp("Target.getTargets"))["targetInfos"]
        by_id = {t.get("targetId"): t for t in targets if t.get("type") == "page" and t.get("targetId")}
        surfaces = []
        for index, target_id in enumerate(self.owned_target_ids):
            target = by_id.get(target_id, {})
            opener_id = self.opener_by_target_id.get(target_id) or target.get("openerId")
            if opener_id:
                self.opener_by_target_id[target_id] = opener_id
            surfaces.append(
                {
                    "surfaceId": f"target:{target_id}",
                    "kind": "popup" if opener_id else "tab",
                    "targetId": target_id,
                    "openerSurfaceId": f"target:{opener_id}" if opener_id else None,
                    "active": target_id == self.target_id,
                    "blocking": False,
                    "url": target.get("url", ""),
                    "title": target.get("title", ""),
                    "createdAt": index,
                }
            )
        focus_stack = [f"target:{t}" for t in self.focus_stack if t in self.owned_target_ids]
        return {
            "surfaces": surfaces,
            "activeSurfaceId": f"target:{self.target_id}" if self.target_id else None,
            "focusStack": focus_stack,
        }

    async def switch_surface(self, surface_id):
        target_id = parse_surface_target_id(surface_id)
        if not target_id or target_id not in self.owned_target_ids:
            raise OpenSteerError(
                "Surface does not belong to this OpenSteer session.",
                code="SURFACE_NOT_OWNED",
                source="daemon",
                details={"surfaceId": surface_id},
            )
        await self.broker.send_cdp("Target.activateTarget", {"targetId": target_id})
        sid = (
            await self.broker.send_cdp("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        )["sessionId"]
        self.set_session(sid, target_id)
        return {"session_id": self.session, "target_id": self.target_id, "surface_id": f"target:{target_id}"}


class BrowserBroker:
    def __init__(self):
        self.cdp = None
        self.sessions = {}
        self.session_by_id = {}
        self.stop = None
        self._reconnect_lock = asyncio.Lock()
        self.target_lock = asyncio.Lock()

    def get_session(self, name):
        name = name or "default"
        if name not in self.sessions:
            self.sessions[name] = BrowserSession(self, name)
        return self.sessions[name]

    def owned_target_ids(self, excluding=None):
        out = set()
        for session in self.sessions.values():
            if session is excluding:
                continue
            out.update(session.owned_target_ids)
        return out

    def claim_target(self, owner, target_id, active=True):
        if not target_id:
            return
        for session in self.sessions.values():
            if session is not owner and target_id in session.owned_target_ids:
                session._forget_target_local(target_id)
        owner._claim_target_local(target_id, active=active)

    def reader_alive(self):
        task = getattr(self.cdp, "_message_handler_task", None) if self.cdp else None
        return bool(task and not task.done())

    async def send_cdp(self, method, params=None, session_id=None, timeout=CDP_COMMAND_TIMEOUT):
        try:
            return await asyncio.wait_for(
                self.cdp.send_raw(method, params, session_id=session_id),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise OpenSteerError(
                f"CDP command timed out: {method}",
                code="CDP_COMMAND_TIMEOUT",
                source="cdp",
                details={"method": method},
            )

    def _install_event_tap(self):
        orig = self.cdp._event_registry.handle_event

        async def tap(method, params, session_id=None):
            try:
                if session_id and session_id in self.session_by_id:
                    self.session_by_id[session_id].on_event(method, params, session_id)
                elif not session_id:
                    for session in self.sessions.values():
                        session.on_event(method, params, session_id)
            except Exception as e:
                log(f"event tap: {e}")
            try:
                return await orig(method, params, session_id)
            except Exception as e:
                log(f"event handler: {e}")
                return False

        self.cdp._event_registry.handle_event = tap

    async def _connect_cdp(self, url=None):
        url = url or get_ws_url()
        for attempt in (0, 1):
            log(f"connecting to {_redact_ws_url(url)}")
            self.cdp = CDPClient(url)
            try:
                await self.cdp.start()
                break
            except Exception as e:
                if attempt == 0 and REMOTE_ID and API_KEY:
                    log("CDP WS handshake failed; refreshing remote CDP grant")
                    url = refresh_remote_cdp_ws_url()
                    continue
                hint = (
                    "refresh the remote session grant and retry"
                    if REMOTE_ID
                    else "click Allow in Chrome if prompted, then retry"
                )
                raise OpenSteerError(
                    "CDP WebSocket handshake failed.",
                    code="CDP_WS_HANDSHAKE_FAILED",
                    source="cdp",
                    hint=hint,
                    details={"cause": str(e), "remote": bool(REMOTE_ID)},
                    cause=e,
                )
        self._install_event_tap()

    async def start(self):
        self.stop = asyncio.Event()
        await self._connect_cdp()

    async def reconnect(self, reason="requested"):
        async with self._reconnect_lock:
            log(f"reconnecting CDP ({reason})")
            old = self.cdp
            for session in list(self.sessions.values()):
                await session.cancel_tasks()
                session.clear_session()
            self.cdp = None
            if old:
                try:
                    await asyncio.wait_for(old.stop(), timeout=3)
                except Exception as e:
                    log(f"old CDP stop: {e}")
            url = refresh_remote_cdp_ws_url() if REMOTE_ID and API_KEY else None
            await self._connect_cdp(url)
            for session in list(self.sessions.values()):
                if session.target_id or session.owned_target_ids:
                    try:
                        await session.attach_first_page()
                    except Exception as e:
                        session._log(f"re-attach after reconnect: {e}")
            return {"ok": True}

    def transport_error(self, msg):
        needles = (
            "WebSocket connection closed",
            "Client is not started",
            "ConnectionClosed",
            "received 100",
            "sent 100",
            "no close frame",
            "keepalive ping timeout",
        )
        return any(n in msg for n in needles) or not self.reader_alive()

    async def handle(self, req):
        meta = req.get("meta")
        if meta == "shutdown_broker":
            self.stop.set()
            return {"ok": True}
        session = self.get_session(req.get("name") or NAME)
        return await session.handle(req)


class SessionRelay:
    def __init__(self, name):
        self.name = name or "default"
        self.stop = None
        self.broker_sock, self.broker_pid, self.broker_log = broker_paths()

    def broker_alive(self):
        return _socket_alive(self.broker_sock)

    def _broker_request(self, req, timeout=BROKER_REQUEST_TIMEOUT):
        return _request_socket(self.broker_sock, req, timeout=timeout)

    def ensure_broker(self, wait=60.0):
        if self.broker_alive():
            return
        import fcntl

        with open(f"{self.broker_sock}.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.broker_alive():
                return
            env = {**os.environ, "OPENSTEER_BROKER": "1"}
            p = subprocess.Popen(
                [sys.executable, "-m", "opensteer.daemon"],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            deadline = time.time() + wait
            while time.time() < deadline:
                if self.broker_alive():
                    return
                if p.poll() is not None:
                    break
                time.sleep(0.2)
            msg = _tail(self.broker_log) or f"browser broker didn't come up -- check {self.broker_log}"
            log(msg)
            raise OpenSteerError(
                "OpenSteer browser broker did not come up.",
                code="OPENSTEER_BROKER_START_FAILED",
                source="daemon",
                details={"log": self.broker_log, "tail": msg},
            )

    async def start(self):
        self.stop = asyncio.Event()
        self.ensure_broker()

    async def handle(self, req):
        if req.get("meta") in ("shutdown", "shutdown_all"):
            try:
                if req.get("meta") == "shutdown_all" and self.broker_alive():
                    self._broker_request({"meta": "shutdown_broker"}, timeout=5)
            except Exception as e:
                log(f"broker shutdown: {e}")
            self.stop.set()
            return {"ok": True}

        forwarded = {**req, "name": req.get("name") or self.name}
        try:
            return self._broker_request(forwarded)
        except Exception as first:
            log(f"broker request failed: {first}")
            try:
                self.ensure_broker()
                return self._broker_request(forwarded)
            except Exception as second:
                return {"error": error_to_wire(second, source="daemon")}


async def serve(app):
    if os.path.exists(SOCK):
        if _socket_alive(SOCK):
            raise OpenSteerError(
                f"daemon already running on {SOCK}",
                code="OPENSTEER_DAEMON_ALREADY_RUNNING",
                source="daemon",
            )
        os.unlink(SOCK)

    async def handler(reader, writer):
        try:
            line = await reader.readline()
            if not line:
                return
            resp = await app.handle(json.loads(line))
            writer.write((json.dumps(resp, default=str) + "\n").encode())
            await writer.drain()
        except Exception as e:
            log(f"conn: {e}")
            try:
                writer.write((json.dumps({"error": error_to_wire(e, source="daemon")}) + "\n").encode())
                await writer.drain()
            except Exception:
                pass
        finally:
            writer.close()

    server = await asyncio.start_unix_server(handler, path=SOCK)
    os.chmod(SOCK, 0o600)
    role = "broker" if BROKER_MODE else f"session name={NAME}"
    log(f"listening on {SOCK} ({role}, remote={REMOTE_ID or 'local'})")
    async with server:
        await app.stop.wait()


async def main():
    app = BrowserBroker() if BROKER_MODE else SessionRelay(NAME)
    await app.start()
    await serve(app)


def already_running():
    return _socket_alive(SOCK)


if __name__ == "__main__":
    if already_running():
        print(f"daemon already running on {SOCK}", file=sys.stderr)
        sys.exit(0)
    open(LOG, "w").close()
    open(PID, "w").write(str(os.getpid()))
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log(error_log_line(normalize_exception(e, source="daemon"), source="daemon"))
        sys.exit(1)
    finally:
        if BROKER_MODE:
            stop_remote()
        try:
            os.unlink(PID)
        except FileNotFoundError:
            pass
