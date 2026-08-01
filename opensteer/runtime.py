import json
import math
import os
import socket
import subprocess
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

from .env import load_env
from .errors import OpenSteerError, error_brief, error_from_log_line, error_from_wire
from .http_client import request_json
from .paths import get_name, session_paths
from .session_registry import (
    activate_session,
    bound_session,
    register_session,
    read_registry,
    registered_session_by_id,
    registered_session_for_route,
    remove_sessions_for_relay,
    session_operation_lock,
)


load_env()

NAME = get_name()
OPENSTEER_API = (os.environ.get("OPENSTEER_API") or "https://api.opensteer.com").rstrip("/")

SESSIONS_PATH = "/v2/opensteer/sessions"
BROWSER_PROFILES_PATH = "/browser-profiles"
LEGACY_PROFILES_PATH = "/v2/opensteer/profiles"


def _env_truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _auto_remote_enabled(env=None):
    value = (env or {}).get("OPENSTEER_AUTO_REMOTE", os.environ.get("OPENSTEER_AUTO_REMOTE"))
    return _env_truthy(value)


def _explicit_session_required(env=None):
    value = (env or {}).get(
        "OPENSTEER_REQUIRE_EXPLICIT_SESSION",
        os.environ.get("OPENSTEER_REQUIRE_EXPLICIT_SESSION"),
    )
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
    return error.status is not None or error.code.startswith("CLOUD_") or error.code.startswith("OPENSTEER_API_")


def _refresh_registered_session_access(record):
    """Return daemon environment for a fresh grant to one exact browser."""
    session_id = record.get("sessionId") or record.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise OpenSteerError(
            "Registered browser session has no valid session ID.",
            code="OPENSTEER_SESSION_INVALID",
            source="runtime",
            hint="Close this browser label and explicitly open it again.",
        )
    access = _opensteer(
        f"{SESSIONS_PATH}/{urllib.parse.quote(session_id, safe='')}/cdp",
        "POST",
    )
    cdp_ws_url = access.get("cdpWsUrl") or access.get("webSocketDebuggerUrl")
    if not cdp_ws_url:
        raise OpenSteerError(
            "OpenSteer did not return a fresh CDP grant.",
            code="CLOUD_CDP_GRANT_MISSING",
            source="opensteer-api",
        )
    return {
        "OPENSTEER_CDP_WS": cdp_ws_url,
        "OPENSTEER_BROWSER_ID": session_id,
        "OPENSTEER_API": OPENSTEER_API,
        "OPENSTEER_CONTROLLER_EXIT_BEHAVIOR": record.get("controllerExitBehavior", "close"),
    }


def ensure_daemon(wait=60.0, name=None, env=None):
    """Start or reconnect the local session relay for a named browser session."""
    effective_env = {**os.environ, **(env or {})}
    requested_name = name or effective_env.get("OPENSTEER_RELAY_NAME") or NAME
    route_record = registered_session_for_route(requested_name, effective_env)
    route_name = route_record.get("relayName", requested_name) if route_record else requested_name
    if daemon_alive(route_name):
        try:
            health = _daemon_request({"meta": "health"}, route_name, timeout=5)
            if health.get("ok"):
                return
            health_error = health.get("error")
            healed = _daemon_request(
                {"meta": "reconnect", "reason": error_brief(health_error) if health_error else "runtime health probe"},
                route_name,
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
        restart_daemon(route_name)

    child_env = {
        **effective_env,
        "OPENSTEER_RELAY_NAME": route_name,
    }
    local = not child_env.get("OPENSTEER_CDP_WS")
    if local and route_record:
        ensure_daemon(
            wait=wait,
            name=route_name,
            env={
                **child_env,
                **_refresh_registered_session_access(route_record),
            },
        )
        return
    if local and _explicit_session_required(child_env):
        raise OpenSteerError(
            f"No explicitly opened browser session is registered for {requested_name!r}.",
            code="OPENSTEER_SESSION_REQUIRED",
            source="runtime",
            hint="Call open_browser(profile='fresh') or pass profileId for a saved profile.",
        )
    if local and _auto_remote_enabled(child_env):
        start_remote_daemon(name=route_name)
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
            if daemon_alive(route_name):
                return
            if process.poll() is not None:
                break
            time.sleep(0.2)
        msg = _log_tail(route_name) or ""
        error = _error_from_daemon_tail(route_name)
        if local and attempt == 0 and _needs_browser_setup(error, msg):
            _open_chrome_inspect()
            print(
                "opensteer: click Allow on chrome://inspect (and tick the checkbox if shown)",
                file=sys.stderr,
            )
            restart_daemon(route_name)
            continue
        if error:
            raise error
        raise OpenSteerError(
            "OpenSteer daemon did not come up.",
            code="OPENSTEER_DAEMON_START_FAILED",
            source="daemon",
            details={"name": route_name, "log": session_paths(route_name)[2], "tail": msg},
        )


def stop_remote_daemon(name="remote"):
    """Stop a named relay and its backing Opensteer Cloud browser, if any."""
    record = registered_session_for_route(name)
    relay_name = record.get("relayName", name) if record else name
    restart_daemon(relay_name, stop_broker=True)
    remove_sessions_for_relay(relay_name)


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


def _close_cloud_session(session_id):
    session = urllib.parse.quote(session_id, safe="")
    return _opensteer(f"{SESSIONS_PATH}/{session}", "DELETE")


def _stop_cloud_session(session_id):
    """Best-effort rollback for a session whose local relay failed to start."""
    try:
        _close_cloud_session(session_id)
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


def _profile_summary(profile, granted=None):
    summary = {
        "id": profile.get("id") or profile.get("profileId"),
        "name": profile.get("name"),
        "userId": profile.get("userId"),
        "cookieDomains": profile.get("cookieDomains") or [],
        "cookieCount": profile.get("cookieCount") or 0,
        "domainCount": profile.get("domainCount") or len(profile.get("cookieDomains") or []),
        "lastUsedAt": profile.get("lastUsedAt"),
    }
    if granted is not None:
        summary["granted"] = granted
    return summary


def list_cloud_profiles():
    """List cloud profiles, with a `granted` flag when the server reports per-agent grants."""
    try:
        listing = _opensteer(BROWSER_PROFILES_PATH, "GET")
    except OpenSteerError as error:
        if error.status != 404:
            raise
        return _list_legacy_cloud_profiles()
    profiles = (listing.get("profiles") or []) if isinstance(listing, dict) else (listing or [])
    return [_profile_summary(profile, granted=bool(profile.get("granted"))) for profile in profiles]


def list_browsers():
    """List live browsers controllable by the current agent execution."""
    registry = read_registry()
    active_name = registry.get("active")
    active_record = registry["sessions"].get(active_name) if active_name else None
    active_session_id = active_record.get("sessionId") if active_record else None

    if _explicit_session_required():
        listing = _opensteer(SESSIONS_PATH, "GET")
        sessions = listing.get("sessions") if isinstance(listing, dict) else None
        if not isinstance(sessions, list):
            raise OpenSteerError(
                "OpenSteer returned an invalid browser session list.",
                code="OPENSTEER_API_BAD_RESPONSE",
                source="opensteer-api",
            )
        result = []
        for session in sessions:
            descriptor = _decode_browser_descriptor(session)
            session_id = descriptor["sessionId"]
            result.append(
                {
                    **descriptor,
                    "active": session_id == active_session_id,
                }
            )
        return result

    return [
        {
            "id": record.get("sessionId"),
            "browserRef": record.get("browserRef") or record.get("sessionId"),
            "sessionId": record.get("sessionId"),
            "label": name,
            "profileId": record.get("profileId"),
            "active": name == active_name,
        }
        for name, record in registry["sessions"].items()
    ]


def _decode_browser_descriptor(session):
    if not isinstance(session, dict):
        raise OpenSteerError(
            "OpenSteer returned an invalid browser session descriptor.",
            code="OPENSTEER_API_BAD_RESPONSE",
            source="opensteer-api",
        )

    def required_string(field):
        value = session.get(field)
        if not isinstance(value, str) or not value.strip():
            raise OpenSteerError(
                f"OpenSteer returned a browser session with an invalid {field}.",
                code="OPENSTEER_API_BAD_RESPONSE",
                source="opensteer-api",
            )
        return value

    status = required_string("status")
    if status not in {"provisioning", "active"}:
        raise OpenSteerError(
            "OpenSteer returned a browser session with an invalid status.",
            code="OPENSTEER_API_BAD_RESPONSE",
            source="opensteer-api",
        )
    location = required_string("location")
    if location not in {"inapp", "local", "cloud"}:
        raise OpenSteerError(
            "OpenSteer returned a browser session with an invalid location.",
            code="OPENSTEER_API_BAD_RESPONSE",
            source="opensteer-api",
        )
    created_at = session.get("createdAt")
    if isinstance(created_at, bool) or not isinstance(created_at, (int, float)) or not math.isfinite(created_at):
        raise OpenSteerError(
            "OpenSteer returned a browser session with an invalid createdAt.",
            code="OPENSTEER_API_BAD_RESPONSE",
            source="opensteer-api",
        )

    descriptor = {
        "id": required_string("id"),
        "browserRef": required_string("browserRef"),
        "sessionId": required_string("sessionId"),
        "location": location,
        "status": status,
        "createdAt": created_at,
    }
    label = session.get("label")
    if label is not None:
        if not isinstance(label, str) or not label.strip():
            raise OpenSteerError(
                "OpenSteer returned a browser session with an invalid label.",
                code="OPENSTEER_API_BAD_RESPONSE",
                source="opensteer-api",
            )
        descriptor["label"] = label
    profile_id = session.get("profileId")
    if profile_id is not None:
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise OpenSteerError(
                "OpenSteer returned a browser session with an invalid profileId.",
                code="OPENSTEER_API_BAD_RESPONSE",
                source="opensteer-api",
            )
        descriptor["profileId"] = profile_id
    exit_behavior = session.get("controllerExitBehavior")
    if exit_behavior is not None:
        if exit_behavior not in {"close", "detach"}:
            raise OpenSteerError(
                "OpenSteer returned a browser session with an invalid controllerExitBehavior.",
                code="OPENSTEER_API_BAD_RESPONSE",
                source="opensteer-api",
            )
        descriptor["controllerExitBehavior"] = exit_behavior
    return descriptor


def _list_legacy_cloud_profiles():
    out, cursor = [], None
    while True:
        suffix = f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else ""
        listing = _opensteer(f"{LEGACY_PROFILES_PATH}?limit=100{suffix}", "GET")
        items = (listing.get("items") or listing.get("profiles")) if isinstance(listing, dict) else listing
        if not items:
            break
        out.extend(_profile_summary(profile) for profile in items)
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
        # Grants disambiguate: when exactly one of the same-named profiles is
        # granted to this agent, it is the only one the server would accept.
        granted = [p for p in matches if p.get("granted")]
        if len(granted) == 1:
            return granted[0]["id"]
        raise OpenSteerError(
            f"{len(matches)} cloud profiles named {profile_name!r}",
            code="CLOUD_PROFILE_AMBIGUOUS",
            source="opensteer-api",
            hint="Pass profileId instead.",
        )
    return matches[0]["id"]


class BrowserHandle(dict):
    """Dictionary-compatible descriptor with helpers bound to one session."""

    def __init__(self, descriptor, name, relay_name=None):
        super().__init__(descriptor)
        self.name = name
        self.relay_name = relay_name or descriptor.get("relayName") or name

    @property
    def session_id(self):
        return self.get("id") or self.get("sessionId")

    @property
    def browser_ref(self):
        """Opaque exact reference for platform actions such as profile save."""
        return self.get("browserRef") or self.session_id

    def activate(self):
        if not activate_session(self.name):
            raise OpenSteerError(
                f"Browser session {self.name!r} is not registered.",
                code="OPENSTEER_SESSION_NOT_FOUND",
                source="runtime",
            )
        return self

    def close(self):
        # Persistent browsers outlive controller relays. An explicit handle
        # close is the destructive user/agent intent, so close the browser
        # first; ordinary process/run shutdown only stops the relay (detach).
        try:
            if self.session_id and self.get("controllerExitBehavior") == "detach":
                _close_cloud_session(self.session_id)
        finally:
            stop_remote_daemon(self.name)

    def __getattr__(self, attribute):
        from . import helpers

        helper = getattr(helpers, attribute, None)
        if not callable(helper) or attribute.startswith("_"):
            raise AttributeError(attribute)

        def call_bound(*args, **kwargs):
            with bound_session(self.relay_name):
                return helper(*args, **kwargs)

        return call_bound


def use_browser(name):
    """Select and attach to one explicitly identified browser."""
    identifier = str(name or "").strip()
    if not identifier:
        raise OpenSteerError(
            "Browser label or id must be a non-empty string.",
            code="OPENSTEER_INVALID_ARGUMENT",
            source="runtime",
        )
    selected_name = identifier
    record = activate_session(identifier)
    if not record:
        existing = registered_session_by_id(identifier)
        if existing:
            selected_name = existing["name"]
            record = activate_session(existing["name"])
    if not record and _explicit_session_required():
        browsers = list_browsers()
        exact_matches = [
            browser
            for browser in browsers
            if identifier
            in (
                browser.get("label"),
                browser.get("id"),
                browser.get("sessionId"),
                browser.get("browserRef"),
            )
        ]
        identity_matches = [
            browser
            for browser in exact_matches
            if identifier
            in {
                browser.get("id"),
                browser.get("sessionId"),
                browser.get("browserRef"),
            }
        ]
        if len(identity_matches) == 1:
            return _attach_browser(identifier, identity_matches[0])
        label_matches = [browser for browser in exact_matches if browser.get("label") == identifier]
        if len(label_matches) > 1:
            raise OpenSteerError(
                f"More than one browser is labeled {identifier!r}.",
                code="OPENSTEER_SESSION_AMBIGUOUS",
                source="runtime",
                hint="Call list_browsers() and select one by sessionId.",
            )
        if len(label_matches) == 1:
            return _attach_browser(identifier, label_matches[0])
    if not record:
        raise OpenSteerError(
            f"Browser session {identifier!r} is not available in this execution scope.",
            code="OPENSTEER_SESSION_NOT_FOUND",
            source="runtime",
            hint="Call list_browsers() or open it first with open_browser(...).",
        )
    return BrowserHandle(
        {
            "id": record.get("sessionId"),
            "browserRef": record.get("browserRef") or record.get("sessionId"),
            **record,
        },
        selected_name,
        record.get("relayName"),
    )


def _attach_browser(name, descriptor):
    """Attach a local relay to an exact browser selected by label or id."""
    session_id = descriptor["sessionId"]
    with session_operation_lock(f"session:{session_id}"):
        existing = registered_session_by_id(session_id)
        if existing:
            return use_browser(existing["name"])
        relay_name = f"session-{session_id}"
        ensure_daemon(
            name=relay_name,
            env=_refresh_registered_session_access(descriptor),
        )
        record = register_session(name, descriptor, relay_name=relay_name)
    return BrowserHandle({**descriptor, **record}, name, relay_name)


def _assert_browser_identity_matches(name, existing, create_kwargs):
    existing_profile_id = existing.get("profileId")
    requested_profile_id = create_kwargs.get("profileId")
    requested_fresh = create_kwargs.get("profileMode") == "fresh"
    if requested_profile_id and existing_profile_id != requested_profile_id:
        raise OpenSteerError(
            f"Browser label {name!r} is already using a different profile.",
            code="OPENSTEER_SESSION_IDENTITY_MISMATCH",
            source="runtime",
            hint="Choose another label, or close this browser before changing profiles.",
        )
    if requested_fresh and existing_profile_id:
        raise OpenSteerError(
            f"Browser label {name!r} is already using a saved profile.",
            code="OPENSTEER_SESSION_IDENTITY_MISMATCH",
            source="runtime",
            hint="Choose another label for a fresh browser, or close this browser first.",
        )


def open_browser(
    label=None,
    *,
    profile=None,
    profileId=None,
    profileName=None,
    mode="reuse",
    location=None,
    **create_kwargs,
):
    """Explicitly open and select a cloud browser.

    ``profile`` must be ``"fresh"`` or ``"auto"`` unless ``profileId`` or
    ``profileName`` selects a saved identity. ``mode="reuse"`` returns the
    agent/location/profile primary session; ``mode="new"`` intentionally
    creates another logical session and remains idempotent for transport
    retries. ``label`` is optional display metadata, never identity.
    """
    explicit_label = str(label).strip() if label is not None else ""
    if label is not None and not explicit_label:
        raise OpenSteerError(
            "label must be a non-empty string when provided",
            code="OPENSTEER_INVALID_ARGUMENT",
            source="runtime",
        )
    # Relay aliases are run-local controller routing only. They are never sent
    # as persistent browser identity when the display label is omitted.
    name = explicit_label or "browser"
    normalized_mode = mode.strip().lower() if isinstance(mode, str) else ""
    if normalized_mode not in {"reuse", "new"}:
        raise OpenSteerError(
            "mode must be one of: reuse, new",
            code="OPENSTEER_INVALID_ARGUMENT",
            source="runtime",
        )
    selected = [profile is not None, profileId is not None, profileName is not None]
    if sum(selected) != 1:
        raise OpenSteerError(
            "Choose exactly one browser identity: profile='fresh', profile='auto', profileId, or profileName.",
            code="OPENSTEER_INVALID_ARGUMENT",
            source="runtime",
        )
    if profile is not None:
        normalized_profile = profile.strip().lower() if isinstance(profile, str) else ""
        if normalized_profile not in {"fresh", "auto"}:
            raise OpenSteerError(
                "profile must be one of: fresh, auto",
                code="OPENSTEER_INVALID_ARGUMENT",
                source="runtime",
            )
        create_kwargs["profileMode"] = normalized_profile
    elif profileId is not None:
        value = str(profileId).strip()
        if not value:
            raise OpenSteerError(
                "profileId must be a non-empty string",
                code="OPENSTEER_INVALID_ARGUMENT",
                source="runtime",
            )
        create_kwargs["profileId"] = value
    else:
        value = str(profileName).strip()
        if not value:
            raise OpenSteerError(
                "profileName must be a non-empty string",
                code="OPENSTEER_INVALID_ARGUMENT",
                source="runtime",
            )
        create_kwargs["profileId"] = _resolve_profile_name(value)
        profileName = None

    browser_session_key = "primary" if normalized_mode == "reuse" else f"new-{uuid.uuid4()}"
    identity_lock = "|".join(
        [
            "browser",
            str(create_kwargs.get("profileId") or create_kwargs.get("profileMode") or ""),
            str(location or "auto"),
            browser_session_key,
        ]
    )
    with session_operation_lock(identity_lock):
        create_kwargs["sessionMode"] = normalized_mode
        create_kwargs["sessionKey"] = browser_session_key
        if explicit_label:
            create_kwargs["label"] = explicit_label
        return start_remote_daemon(
            name,
            profileName=profileName,
            location=location,
            **create_kwargs,
        )


def start_remote_daemon(name="remote", profileName=None, location=None, **create_kwargs):
    """Provision an Opensteer browser and attach a named local relay to it.

    Without profileId/profileName the server resolves the profile: exactly one
    granted profile auto-attaches, none selects an unprofiled browser, and
    several is rejected with an error naming the choice to make. ``location``
    selects the browser transport independently of where the agent itself is
    executing.
    """
    modern_session = "sessionMode" in create_kwargs
    existing_route = None if modern_session else registered_session_for_route(name)
    relay_name = existing_route.get("relayName", name) if existing_route else name
    if not modern_session and daemon_alive(relay_name):
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
    if location is not None:
        normalized_location = location.strip().lower() if isinstance(location, str) else ""
        if normalized_location not in {"auto", "inapp", "local", "cloud"}:
            raise OpenSteerError(
                "location must be one of: auto, inapp, local, cloud",
                code="OPENSTEER_INVALID_ARGUMENT",
                source="runtime",
            )
        create_kwargs["location"] = normalized_location
    if existing_route:
        _assert_browser_identity_matches(name, existing_route, create_kwargs)
        ensure_daemon(name=relay_name)
        return use_browser(existing_route["name"])
    # Legacy direct callers still use `name` as their remote session name.
    # Modern open_browser calls carry sessionMode/sessionKey and an optional
    # display-only `label`, so the local relay alias must stay off the wire.
    if "sessionMode" not in create_kwargs:
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
    descriptor = dict(browser)
    if not descriptor.get("profileId") and create_kwargs.get("profileId"):
        descriptor["profileId"] = create_kwargs["profileId"]

    with session_operation_lock(f"session:{browser_id}"):
        matching = registered_session_by_id(browser_id)
        registry_name = browser_id if modern_session else name
        relay_name = (
            matching.get("relayName", registry_name)
            if matching
            else f"session-{browser_id}"
            if modern_session
            else name
        )
        created_here = browser.get("creationMode") != "reused_existing" and not matching
        try:
            ensure_daemon(
                name=relay_name,
                env={
                    "OPENSTEER_CDP_WS": cdp_ws_url,
                    "OPENSTEER_BROWSER_ID": browser_id,
                    "OPENSTEER_API": OPENSTEER_API,
                    "OPENSTEER_CONTROLLER_EXIT_BEHAVIOR": browser.get("controllerExitBehavior", "close"),
                },
            )
            register_session(registry_name, descriptor, relay_name=relay_name)
        except Exception:
            restart_daemon(relay_name)
            if created_here:
                _stop_cloud_session(browser_id)
            raise
    if browser.get("creationMode") != "reused_existing":
        _show_live_url(browser.get("liveUrl"))
    return BrowserHandle(descriptor, registry_name, relay_name)


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
