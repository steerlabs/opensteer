import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from .env import load_env
from .errors import OpenSteerError, error_brief, error_from_log_line, error_from_wire
from .http_client import request_json
from .paths import get_name, session_paths


load_env()

NAME = get_name()
OPENSTEER_API = (os.environ.get("OPENSTEER_API") or "https://api.opensteer.com").rstrip("/")
OPENSTEER_CLOUD_PROFILE_ID = "OPENSTEER_CLOUD_PROFILE_ID"

SESSIONS_PATH = "/v2/opensteer/sessions"
PROFILES_PATH = "/v2/opensteer/profiles"


def _env_truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _auto_remote_enabled(env=None):
    value = (env or {}).get("OPENSTEER_AUTO_REMOTE", os.environ.get("OPENSTEER_AUTO_REMOTE"))
    return _env_truthy(value)


def _paths(name):
    sock, pid, _ = session_paths(name or NAME)
    return sock, pid


def _log_tail(name):
    _, _, p = session_paths(name or NAME)
    try:
        return Path(p).read_text().strip().splitlines()[-1]
    except (FileNotFoundError, IndexError):
        return None


def daemon_alive(name=None):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(_paths(name)[0])
        s.close()
        return True
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
        return False


def _daemon_request(req, name=None, timeout=3):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(_paths(name)[0])
        s.sendall((json.dumps(req) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(1 << 16)
            if not chunk:
                break
            data += chunk
        return json.loads(data or b"{}")
    finally:
        s.close()


def _error_from_daemon_tail(name):
    return error_from_log_line(_log_tail(name))


def _needs_browser_setup(error, msg):
    code = error.code if isinstance(error, OpenSteerError) else ""
    return code in {"LOCAL_CDP_NOT_ENABLED", "LOCAL_CDP_NOT_READY", "CDP_WS_HANDSHAKE_FAILED"} or (
        "DevToolsActivePort not found" in msg
        or "not live yet" in msg
        or ("WS handshake failed" in msg and "403" in msg)
    )


def _should_surface_reconnect_error(error):
    return (
        error.status is not None
        or error.code.startswith("CLOUD_")
        or error.code.startswith("OPENSTEER_API_")
    )


def ensure_daemon(wait=60.0, name=None, env=None):
    """Start or reconnect the local session relay for a named browser session."""
    if daemon_alive(name):
        try:
            health = _daemon_request({"meta": "health"}, name, timeout=5)
            if health.get("ok"):
                return
            health_error = health.get("error")
            healed = _daemon_request(
                {"meta": "reconnect", "reason": error_brief(health_error) if health_error else "runtime health probe"},
                name,
                timeout=10,
            )
            if healed.get("ok"):
                return
            if healed.get("error"):
                healed_error = error_from_wire(healed["error"], source="daemon")
                if _should_surface_reconnect_error(healed_error):
                    raise healed_error
        except OpenSteerError:
            raise
        except Exception:
            pass
        restart_daemon(name)

    child_env = {
        **os.environ,
        **({"OPENSTEER_NAME": name} if name else {}),
        **(env or {}),
    }
    local = not child_env.get("OPENSTEER_CDP_WS")
    if local and _auto_remote_enabled(child_env):
        start_remote_daemon(name=child_env.get("OPENSTEER_NAME") or name or NAME)
        return

    for attempt in (0, 1):
        process = subprocess.Popen(
            [sys.executable, "-m", "opensteer.daemon"],
            env=child_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.time() + wait
        while time.time() < deadline:
            if daemon_alive(name):
                return
            if process.poll() is not None:
                break
            time.sleep(0.2)
        msg = _log_tail(name) or ""
        error = _error_from_daemon_tail(name)
        if local and attempt == 0 and _needs_browser_setup(error, msg):
            _open_chrome_inspect()
            print(
                "opensteer: click Allow on chrome://inspect (and tick the checkbox if shown)",
                file=sys.stderr,
            )
            restart_daemon(name)
            continue
        if error:
            raise error
        raise OpenSteerError(
            "OpenSteer daemon did not come up.",
            code="OPENSTEER_DAEMON_START_FAILED",
            source="daemon",
            details={"name": name or NAME, "log": session_paths(name or NAME)[2], "tail": msg},
        )


def stop_remote_daemon(name="remote"):
    """Stop a named relay and its backing Opensteer Cloud browser, if any."""
    restart_daemon(name, stop_broker=True)


def restart_daemon(name=None, stop_broker=False):
    """Best-effort daemon shutdown plus socket and pid cleanup."""
    import signal

    sock, pid_path = _paths(name)
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(sock)
        meta = "shutdown_all" if stop_broker else "shutdown"
        s.sendall((json.dumps({"meta": meta}) + "\n").encode())
        s.recv(1024)
        s.close()
    except Exception:
        pass
    try:
        pid = int(open(pid_path).read())
    except (FileNotFoundError, ValueError):
        pid = None
    if pid:
        for _ in range(75):
            try:
                os.kill(pid, 0)
                time.sleep(0.2)
            except ProcessLookupError:
                break
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for f in (sock, pid_path):
        try:
            os.unlink(f)
        except FileNotFoundError:
            pass


def _opensteer(path, method, body=None):
    key = os.environ.get("OPENSTEER_API_KEY")
    return request_json(OPENSTEER_API, key or "", path, method, body, timeout=60)


def _stop_cloud_session(session_id):
    try:
        session = urllib.parse.quote(session_id, safe="")
        _opensteer(f"{SESSIONS_PATH}/{session}", "DELETE")
    except Exception:
        pass


def _has_local_gui():
    import platform

    system = platform.system()
    if system in ("Darwin", "Windows"):
        return True
    if system == "Linux":
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return False


def _show_live_url(url):
    import webbrowser

    if not url:
        return
    print(url)
    if not _has_local_gui():
        print("(no local GUI; share the liveUrl with the user)", file=sys.stderr)
        return
    try:
        webbrowser.open(url, new=2)
        print("(opened liveUrl in your default browser)", file=sys.stderr)
    except Exception as e:
        print(f"(could not auto-open liveUrl: {e})", file=sys.stderr)


def list_cloud_profiles():
    """List cloud profiles available to the current API key."""
    out, cursor = [], None
    while True:
        suffix = f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else ""
        listing = _opensteer(f"{PROFILES_PATH}?limit=100{suffix}", "GET")
        items = (listing.get("items") or listing.get("profiles")) if isinstance(listing, dict) else listing
        if not items:
            break
        for profile in items:
            out.append(
                {
                    "id": profile.get("id") or profile.get("profileId"),
                    "name": profile.get("name"),
                    "userId": profile.get("userId"),
                    "cookieDomains": profile.get("cookieDomains") or [],
                    "cookieCount": profile.get("cookieCount") or 0,
                    "domainCount": profile.get("domainCount") or len(profile.get("cookieDomains") or []),
                    "lastUsedAt": profile.get("lastUsedAt"),
                }
            )
        cursor = listing.get("nextCursor") if isinstance(listing, dict) else None
        if not cursor:
            break
    return out


def _resolve_profile_name(profile_name):
    matches = [p for p in list_cloud_profiles() if p.get("name") == profile_name]
    if not matches:
        raise OpenSteerError(
            f"no cloud profile named {profile_name!r}",
            code="CLOUD_PROFILE_NOT_FOUND",
            source="opensteer-api",
            hint="Call list_cloud_profiles() or create/sync profiles with opensteer-cloud.",
        )
    if len(matches) > 1:
        raise OpenSteerError(
            f"{len(matches)} cloud profiles named {profile_name!r}",
            code="CLOUD_PROFILE_AMBIGUOUS",
            source="opensteer-api",
            hint="Pass profileId instead.",
        )
    return matches[0]["id"]


def _default_cloud_profile_id():
    value = os.environ.get(OPENSTEER_CLOUD_PROFILE_ID)
    if not value:
        return None
    value = value.strip()
    return value or None


def start_remote_daemon(name="remote", profileName=None, **create_kwargs):
    """Provision an Opensteer Cloud browser and attach a named local relay to it."""
    if daemon_alive(name):
        raise OpenSteerError(
            f"daemon {name!r} is already running",
            code="OPENSTEER_DAEMON_ALREADY_RUNNING",
            source="daemon",
            hint=f"Call restart_daemon({name!r}) first.",
        )
    if profileName:
        if "profileId" in create_kwargs:
            raise OpenSteerError(
                "pass profileName or profileId, not both",
                code="OPENSTEER_INVALID_ARGUMENT",
                source="runtime",
            )
        create_kwargs["profileId"] = _resolve_profile_name(profileName)
    elif "profileId" not in create_kwargs:
        default_profile_id = _default_cloud_profile_id()
        if default_profile_id:
            create_kwargs["profileId"] = default_profile_id
    create_kwargs.setdefault("name", name)
    browser = _opensteer(SESSIONS_PATH, "POST", create_kwargs)
    cdp_ws_url = browser.get("cdpWsUrl") or browser.get("webSocketDebuggerUrl")
    browser_id = browser.get("id") or browser.get("sessionId")
    if not cdp_ws_url or not browser_id:
        raise OpenSteerError(
            "OpenSteer did not return a remote browser CDP grant.",
            code="CLOUD_CDP_GRANT_MISSING",
            source="opensteer-api",
        )
    try:
        ensure_daemon(
            name=name,
            env={
                "OPENSTEER_CDP_WS": cdp_ws_url,
                "OPENSTEER_BROWSER_ID": browser_id,
                "OPENSTEER_API": OPENSTEER_API,
            },
        )
    except Exception:
        _stop_cloud_session(browser_id)
        raise
    _show_live_url(browser.get("liveUrl"))
    return browser


def _version():
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("opensteer")
        except PackageNotFoundError:
            return ""
    except Exception:
        return ""


def _chrome_running():
    """Cross-platform best-effort check for a running Chrome or Edge process."""
    import platform

    system = platform.system()
    try:
        if system == "Windows":
            out = subprocess.check_output(["tasklist"], text=True, timeout=5)
            names = ("chrome.exe", "msedge.exe")
        else:
            out = subprocess.check_output(["ps", "-A", "-o", "comm="], text=True, timeout=5)
            names = ("Google Chrome", "chrome", "chromium", "Microsoft Edge", "msedge")
        return any(n.lower() in out.lower() for n in names)
    except Exception:
        return False


def _open_chrome_inspect():
    """Open chrome://inspect/#remote-debugging so the user can allow CDP attach."""
    import platform
    import webbrowser

    url = "chrome://inspect/#remote-debugging"
    if platform.system() == "Darwin":
        try:
            subprocess.run(
                [
                    "osascript",
                    "-e",
                    'tell application "Google Chrome" to activate',
                    "-e",
                    f'tell application "Google Chrome" to open location "{url}"',
                ],
                timeout=5,
                check=False,
            )
            return
        except Exception:
            pass
    try:
        webbrowser.open(url, new=2)
    except Exception:
        pass


def run_setup():
    """Attach to the running browser, guiding the user through CDP setup if needed."""
    print("opensteer setup: attaching to your browser...")

    if daemon_alive():
        print("daemon already running; nothing to do.")
        return 0

    if not _chrome_running():
        print("no Chrome/Edge process detected. start your browser and rerun `opensteer --setup`.")
        return 1

    try:
        ensure_daemon(wait=20.0)
        print("daemon is up.")
        return 0
    except OpenSteerError as e:
        first_err = str(e)
        first_error = e

    needs_inspect = first_error.code in {"LOCAL_CDP_NOT_ENABLED", "LOCAL_CDP_NOT_READY"} or (
        "DevToolsActivePort not found" in first_err or "enable chrome://inspect" in first_err
    )
    if needs_inspect:
        print("browser remote debugging is not enabled on the current profile.")
        print("opening chrome://inspect/#remote-debugging. In the tab that opens:")
        print("  1. if a profile picker appears, pick your normal profile;")
        print("  2. tick Discover network targets and click Allow if prompted.")
        _open_chrome_inspect()
    else:
        print(f"attach failed: {first_err}")
        print("retrying for up to 60s; the browser may still be starting up...")

    deadline = time.time() + 60
    last = first_err
    while time.time() < deadline:
        try:
            ensure_daemon(wait=5.0)
            print("daemon is up.")
            return 0
        except OpenSteerError as e:
            last = str(e)
            time.sleep(2)

    print(f"setup failed: {last}", file=sys.stderr)
    print("run `opensteer --doctor` for diagnostics.", file=sys.stderr)
    return 1


def run_doctor():
    """Read-only diagnostics. Exit 0 when the local browser session is ready."""
    import platform

    version = _version() or "(unknown)"
    chrome = _chrome_running()
    daemon = daemon_alive()
    api_key = bool(os.environ.get("OPENSTEER_API_KEY"))
    auto_remote = _auto_remote_enabled()

    def row(label, ok, detail=""):
        mark = "ok  " if ok else "FAIL"
        print(f"  [{mark}] {label}{(' - ' + detail) if detail else ''}")

    print("opensteer doctor")
    print(f"  platform          {platform.system()} {platform.release()}")
    print(f"  python            {sys.version.split()[0]}")
    print(f"  version           {version}")
    row("chrome running", chrome, "" if chrome else "start chrome/edge and rerun `opensteer --setup`")
    row("daemon alive", daemon, "" if daemon else "run `opensteer --setup` to attach")
    row("OPENSTEER_API_KEY set", api_key, "" if api_key else "optional: needed only for cloud browsers")
    if auto_remote:
        row("cloud auto remote", api_key, "" if api_key else "set OPENSTEER_API_KEY to create cloud browsers")
    return 0 if (chrome and daemon) or (auto_remote and api_key) else 1
