"""Shared filesystem paths for Opensteer's local browser sessions."""

import hashlib
import os
import urllib.parse


def get_name(env=None):
    env = env or os.environ
    return env.get("OPENSTEER_NAME") or "default"


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _ws_identity(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except Exception:
        return url


def broker_key(env=None):
    env = env or os.environ
    if browser_id := env.get("OPENSTEER_BROWSER_ID"):
        return f"remote-{_digest(browser_id)}"
    if ws_url := env.get("OPENSTEER_CDP_WS"):
        return f"ws-{_digest(_ws_identity(ws_url))}"
    return "local"


def broker_paths(env=None):
    key = broker_key(env)
    return (
        f"/tmp/opensteer-browser-{key}.sock",
        f"/tmp/opensteer-browser-{key}.pid",
        f"/tmp/opensteer-browser-{key}.log",
    )


def _session_key(name):
    return urllib.parse.quote(name or "default", safe="-_.@")


def session_paths(name=None, env=None):
    n = _session_key(name or get_name(env))
    return f"/tmp/opensteer-{n}.sock", f"/tmp/opensteer-{n}.pid", f"/tmp/opensteer-{n}.log"


def session_state_path(name=None, env=None):
    n = _session_key(name or get_name(env))
    return f"/tmp/opensteer-{n}.state.json"
