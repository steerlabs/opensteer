"""Small browser-control primitives built on Chrome DevTools Protocol."""

import base64
import json
import os
import socket
import time
import urllib.request

from .env import load_env
from .errors import OpenSteerError, error_from_wire
from .paths import get_name, session_paths


load_env()

NAME = get_name()
SOCK = session_paths(NAME)[0]
INTERNAL = ("chrome://", "chrome-untrusted://", "devtools://", "chrome-extension://", "about:")
MARK_TAB_JS = "if(!document.title.startsWith('\U0001f7e2'))document.title='\U0001f7e2 '+document.title"
UNMARK_TAB_JS = "if(document.title.startsWith('\U0001f7e2 '))document.title=document.title.slice(2)"


def _connect():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(SOCK)
    except OSError as exc:
        s.close()
        raise exc
    return s


def _send(req):
    s = None
    try:
        try:
            s = _connect()
        except (FileNotFoundError, ConnectionRefusedError):
            from .runtime import ensure_daemon

            ensure_daemon()
            s = _connect()
        s.sendall((json.dumps(req) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            data += chunk
    finally:
        if s:
            s.close()
    try:
        response = json.loads(data)
    except json.JSONDecodeError as exc:
        raise OpenSteerError(
            "OpenSteer daemon returned an invalid response.",
            code="OPENSTEER_DAEMON_BAD_RESPONSE",
            source="daemon",
            cause=exc,
        ) from exc
    if "error" in response:
        raise error_from_wire(response["error"], source="daemon")
    return response


def cdp(method, session_id=None, **params):
    """Raw CDP. cdp('Page.navigate', url='...'), cdp('DOM.getDocument', depth=-1)."""
    return _send({"method": method, "params": params, "session_id": session_id}).get("result", {})


def drain_events():
    return _send({"meta": "drain_events"})["events"]


# --- navigation / page ---
def goto_url(url):
    return cdp("Page.navigate", url=url)


def page_info():
    """{url, title, w, h, sx, sy, pw, ph} — viewport + scroll + page size.

    If a native dialog (alert/confirm/prompt/beforeunload) is open, returns
    {dialog: {type, message, ...}} instead — the page's JS thread is frozen
    until the dialog is handled (see interaction-skills/dialogs.md)."""
    dialog = _send({"meta": "pending_dialog"}).get("dialog")
    if dialog:
        return {"dialog": dialog}
    r = cdp(
        "Runtime.evaluate",
        expression="JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})",
        returnByValue=True,
    )
    return json.loads(r["result"]["value"])


# --- input ---
_debug_click_counter = 0


def click_at_xy(x, y, button="left", clicks=1):
    if os.environ.get("OPENSTEER_DEBUG_CLICKS"):
        global _debug_click_counter
        try:
            from PIL import Image, ImageDraw

            dpr = js("window.devicePixelRatio") or 1
            path = capture_screenshot(f"/tmp/debug_click_{_debug_click_counter}.png")
            img = Image.open(path)
            draw = ImageDraw.Draw(img)
            px, py = int(x * dpr), int(y * dpr)
            r = int(15 * dpr)
            draw.ellipse([px - r, py - r, px + r, py + r], outline="red", width=int(3 * dpr))
            draw.line([px - r - int(5 * dpr), py, px + r + int(5 * dpr), py], fill="red", width=int(2 * dpr))
            draw.line([px, py - r - int(5 * dpr), px, py + r + int(5 * dpr)], fill="red", width=int(2 * dpr))
            img.save(path)
            print(f"[debug_click] saved {path} (x={x}, y={y}, dpr={dpr})")
        except Exception as e:
            print(f"[debug_click] overlay failed: {e}")
        _debug_click_counter += 1
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button=button, clickCount=clicks)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button=button, clickCount=clicks)


def type_text(text):
    cdp("Input.insertText", text=text)


_KEYS = {  # key → (windowsVirtualKeyCode, code, text)
    "Enter": (13, "Enter", "\r"),
    "Tab": (9, "Tab", "\t"),
    "Backspace": (8, "Backspace", ""),
    "Escape": (27, "Escape", ""),
    "Delete": (46, "Delete", ""),
    " ": (32, "Space", " "),
    "ArrowLeft": (37, "ArrowLeft", ""),
    "ArrowUp": (38, "ArrowUp", ""),
    "ArrowRight": (39, "ArrowRight", ""),
    "ArrowDown": (40, "ArrowDown", ""),
    "Home": (36, "Home", ""),
    "End": (35, "End", ""),
    "PageUp": (33, "PageUp", ""),
    "PageDown": (34, "PageDown", ""),
}


def press_key(key, modifiers=0):
    """Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift.
    Special keys (Enter, Tab, Arrow*, Backspace, etc.) carry their virtual key codes
    so listeners checking e.keyCode / e.key all fire."""
    vk, code, text = _KEYS.get(key, (ord(key[0]) if len(key) == 1 else 0, key, key if len(key) == 1 else ""))
    base = {"key": key, "code": code, "modifiers": modifiers, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
    cdp("Input.dispatchKeyEvent", type="keyDown", **base, **({"text": text} if text else {}))
    if text and len(text) == 1:
        cdp("Input.dispatchKeyEvent", type="char", text=text, **{k: v for k, v in base.items() if k != "text"})
    cdp("Input.dispatchKeyEvent", type="keyUp", **base)


def scroll(x, y, dy=-300, dx=0):
    cdp("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y, deltaX=dx, deltaY=dy)


# --- visual ---
def capture_screenshot(path="/tmp/shot.png", full=False, max_dim=None):
    """Save a PNG of the current viewport.

    Set max_dim=1800 on high-DPI displays to keep screenshots below image size
    limits while preserving aspect ratio.
    """
    r = cdp("Page.captureScreenshot", format="png", captureBeyondViewport=full)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(r["data"]))
    if max_dim:
        from PIL import Image

        with Image.open(path) as img:
            if max(img.size) > max_dim:
                img.thumbnail((max_dim, max_dim))
                img.save(path)
    return path


# --- tabs ---
def list_tabs(include_chrome=True):
    out = []
    for t in cdp("Target.getTargets")["targetInfos"]:
        if t["type"] != "page":
            continue
        url = t.get("url", "")
        if not include_chrome and url.startswith(INTERNAL):
            continue
        out.append({"targetId": t["targetId"], "title": t.get("title", ""), "url": url})
    return out


def current_tab():
    t = cdp("Target.getTargetInfo").get("targetInfo", {})
    return {"targetId": t.get("targetId"), "url": t.get("url", ""), "title": t.get("title", "")}


def _mark_tab():
    """Prepend 🟢 to tab title so the user can see which tab the agent controls."""
    try:
        cdp("Runtime.evaluate", expression=MARK_TAB_JS)
    except Exception:
        pass


def switch_tab(target_id):
    # Unmark old tab
    try:
        cdp("Runtime.evaluate", expression=UNMARK_TAB_JS)
    except Exception:
        pass
    cdp("Target.activateTarget", targetId=target_id)
    sid = cdp("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]
    _send({"meta": "set_session", "session_id": sid, "target_id": target_id})
    _mark_tab()
    return sid


def list_surfaces():
    """Return browser surfaces owned by this OpenSteer session.

    Surfaces include normal tabs and popup windows opened by those tabs. Popup
    surfaces become current automatically when CDP reports their opener.
    """
    return _send({"meta": "list_surfaces"})


def current_surface():
    return _send({"meta": "current_surface"}).get("surface")


def switch_surface(surface_id):
    return _send({"meta": "switch_surface", "surface_id": surface_id})


def wait_for_surface(kind=None, opener_surface_id=None, timeout=10.0, poll=0.1):
    deadline = time.time() + timeout
    seen = set()
    while time.time() <= deadline:
        surfaces = list_surfaces().get("surfaces", [])
        for surface in surfaces:
            surface_id = surface.get("surfaceId")
            if surface_id in seen:
                continue
            if kind is not None and surface.get("kind") != kind:
                continue
            if opener_surface_id is not None and surface.get("openerSurfaceId") != opener_surface_id:
                continue
            return surface
        seen.update(surface.get("surfaceId") for surface in surfaces)
        time.sleep(poll)
    raise OpenSteerError(
        "Timed out waiting for browser surface.",
        code="SURFACE_WAIT_TIMEOUT",
        source="daemon",
        details={"kind": kind, "openerSurfaceId": opener_surface_id, "timeout": timeout},
    )


def new_tab(url="about:blank"):
    # Always create blank, then goto: passing url to createTarget races with
    # attach, so the brief about:blank is "complete" by the time the caller
    # polls and wait_for_load() returns before navigation actually starts.
    tid = cdp("Target.createTarget", url="about:blank")["targetId"]
    switch_tab(tid)
    if url != "about:blank":
        goto_url(url)
    return tid


def ensure_real_tab():
    """Switch to a real user tab if current is chrome:// / internal / stale."""
    tabs = list_tabs(include_chrome=False)
    if not tabs:
        return None
    try:
        cur = current_tab()
        if cur["url"] and not cur["url"].startswith(INTERNAL):
            return cur
    except Exception:
        pass
    switch_tab(tabs[0]["targetId"])
    return tabs[0]


def iframe_target(url_substr):
    """First iframe target whose URL contains `url_substr`. Use with js(..., target_id=...)."""
    for t in cdp("Target.getTargets")["targetInfos"]:
        if t["type"] == "iframe" and url_substr in t.get("url", ""):
            return t["targetId"]
    return None


# --- utility ---
def wait(seconds=1.0):
    time.sleep(seconds)


def wait_for_load(timeout=15.0):
    """Poll document.readyState == 'complete' or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if js("document.readyState") == "complete":
            return True
        time.sleep(0.3)
    return False


def js(expression, target_id=None):
    """Run JS in the attached tab (default) or inside an iframe target (via iframe_target()).

    Expressions with top-level `return` are automatically wrapped in an IIFE, so both
    `document.title` and `const x = 1; return x` are valid inputs.
    """
    sid = cdp("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"] if target_id else None
    if "return " in expression and not expression.strip().startswith("("):
        expression = f"(function(){{{expression}}})()"
    try:
        result = cdp("Runtime.evaluate", session_id=sid, expression=expression, returnByValue=True, awaitPromise=True)
        return result.get("result", {}).get("value")
    finally:
        if sid:
            try:
                cdp("Target.detachFromTarget", sessionId=sid)
            except Exception:
                pass


_KC = {
    "Enter": 13,
    "Tab": 9,
    "Escape": 27,
    "Backspace": 8,
    " ": 32,
    "ArrowLeft": 37,
    "ArrowUp": 38,
    "ArrowRight": 39,
    "ArrowDown": 40,
}


def dispatch_key(selector, key="Enter", event="keypress"):
    """Dispatch a DOM KeyboardEvent on the matched element.

    Use this when a site reacts to synthetic DOM key events on an element more reliably
    than to raw CDP input events.
    """
    kc = _KC.get(key, ord(key) if len(key) == 1 else 0)
    selector_json = json.dumps(selector)
    event_json = json.dumps(event)
    init_json = json.dumps(
        {
            "key": key,
            "code": key,
            "keyCode": kc,
            "which": kc,
            "bubbles": True,
        }
    )
    js(
        "(()=>{"
        f"const e=document.querySelector({selector_json});"
        f"if(e){{e.focus();e.dispatchEvent(new KeyboardEvent({event_json},{init_json}));}}"
        "})()"
    )


def upload_file(selector, path):
    """Set files on a file input via CDP DOM.setFileInputFiles."""
    doc = cdp("DOM.getDocument", depth=-1)
    nid = cdp("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector=selector)["nodeId"]
    if not nid:
        raise OpenSteerError(
            f"no element for {selector}",
            code="DOM_ELEMENT_NOT_FOUND",
            source="cdp",
            details={"selector": selector},
        )
    cdp("DOM.setFileInputFiles", files=[path] if isinstance(path, str) else list(path), nodeId=nid)


def http_get(url, headers=None, timeout=20.0):
    """Pure HTTP — no browser. Use for static pages / APIs. Wrap in ThreadPoolExecutor for bulk.

    When OPENSTEER_API_KEY is set, routes through the fetch-use proxy (handles bot
    detection, residential proxies, retries). Falls back to local urllib otherwise."""
    if os.environ.get("OPENSTEER_API_KEY"):
        try:
            from fetch_use import fetch_sync

            return fetch_sync(url, headers=headers, timeout_ms=int(timeout * 1000)).text
        except ImportError:
            pass
    import gzip

    h = {"User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip"}
    if headers:
        h.update(headers)
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data.decode()
