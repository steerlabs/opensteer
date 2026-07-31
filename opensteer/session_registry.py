"""Durable, scope-local routing for explicitly opened browser sessions."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import tempfile
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from .paths import session_registry_path


_BOUND_SESSION_NAME: ContextVar[str | None] = ContextVar("opensteer_bound_session_name", default=None)


def _empty_registry():
    return {"active": None, "sessions": {}}


def read_registry(env=None):
    try:
        data = json.loads(Path(session_registry_path(env)).read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError):
        return _empty_registry()
    sessions = data.get("sessions")
    active = data.get("active")
    if not isinstance(sessions, dict):
        sessions = {}
    clean = {}
    for name, record in sessions.items():
        if not isinstance(name, str) or not name or not isinstance(record, dict):
            continue
        relay_name = record.get("relayName")
        clean[name] = {
            **record,
            "name": name,
            "relayName": relay_name if isinstance(relay_name, str) and relay_name else name,
        }
    return {
        "active": active if isinstance(active, str) and active in clean else None,
        "sessions": clean,
    }


def _write_registry(registry, env=None):
    path = Path(session_registry_path(env))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(registry, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


@contextmanager
def _exclusive_file_lock(handle):
    try:
        import fcntl
    except ImportError:
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write("\0")
            handle.flush()
        handle.seek(0)
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EDEADLK}:
                    raise
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def _registry_lock(env=None):
    path = Path(f"{session_registry_path(env)}.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        with _exclusive_file_lock(handle):
            yield


@contextmanager
def session_operation_lock(key, env=None):
    """Serialize an open/attach operation within one execution scope."""
    digest = hashlib.sha256(str(key).encode()).hexdigest()[:16]
    path = Path(f"{session_registry_path(env)}.{digest}.operation.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        with _exclusive_file_lock(handle):
            yield


def register_session(name, descriptor, env=None, relay_name=None):
    with _registry_lock(env):
        registry = read_registry(env)
        sessions = dict(registry["sessions"])
        sessions[name] = {
            "name": name,
            "relayName": relay_name or name,
            "sessionId": descriptor.get("id") or descriptor.get("sessionId"),
            "browserRef": descriptor.get("browserRef")
            or descriptor.get("id")
            or descriptor.get("sessionId"),
            "profileId": descriptor.get("profileId") or descriptor.get("browserProfileId"),
            "controllerExitBehavior": descriptor.get("controllerExitBehavior", "close"),
            "location": descriptor.get("location"),
            "liveUrl": descriptor.get("liveUrl"),
        }
        next_registry = {"active": name, "sessions": sessions}
        _write_registry(next_registry, env)
        return sessions[name]


def activate_session(name, env=None):
    with _registry_lock(env):
        registry = read_registry(env)
        if name not in registry["sessions"]:
            return None
        registry["active"] = name
        _write_registry(registry, env)
        return registry["sessions"][name]


def registered_session(name, env=None):
    return read_registry(env)["sessions"].get(name)


def registered_session_for_route(name, env=None):
    sessions = read_registry(env)["sessions"]
    direct = sessions.get(name)
    if direct:
        return direct
    return next(
        (record for record in sessions.values() if record.get("relayName") == name),
        None,
    )


def registered_session_by_id(session_id, env=None):
    return next(
        (
            record
            for record in read_registry(env)["sessions"].values()
            if record.get("sessionId") == session_id
        ),
        None,
    )


def remove_sessions_for_relay(relay_name, env=None):
    with _registry_lock(env):
        registry = read_registry(env)
        sessions = {
            name: record
            for name, record in registry["sessions"].items()
            if record.get("relayName") != relay_name
        }
        active = registry["active"]
        if active not in sessions:
            active = next(reversed(sessions), None) if sessions else None
        _write_registry({"active": active, "sessions": sessions}, env)


def active_session(env=None):
    registry = read_registry(env)
    name = registry["active"]
    return registry["sessions"].get(name) if name else None


def resolve_session_name(env=None):
    env = env or os.environ
    bound = _BOUND_SESSION_NAME.get()
    if bound:
        return bound
    active = active_session(env)
    if active:
        return active.get("relayName") or active["name"]
    if _truthy(env.get("OPENSTEER_REQUIRE_EXPLICIT_SESSION")):
        return None
    return "default"


@contextmanager
def bound_session(name):
    token = _BOUND_SESSION_NAME.set(name)
    try:
        yield
    finally:
        _BOUND_SESSION_NAME.reset(token)


def _truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}
