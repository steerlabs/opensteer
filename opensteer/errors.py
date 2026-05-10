"""Structured OpenSteer errors shared across transports."""

from __future__ import annotations

import json
from typing import Any


ERROR_LOG_PREFIX = "OPENSTEER_ERROR "
SENSITIVE_KEY_PARTS = (
    "authorization",
    "apikey",
    "api_key",
    "cookie",
    "password",
    "secret",
    "token",
    "websocketdebuggerurl",
    "cdpwsurl",
)


class OpenSteerError(RuntimeError):
    """Operational OpenSteer failure with concise human/agent rendering."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "OPENSTEER_ERROR",
        source: str | None = None,
        status: int | None = None,
        hint: str | None = None,
        details: Any = None,
        cause: BaseException | None = None,
    ):
        self.message = str(message or "OpenSteer operation failed.")
        self.code = code or "OPENSTEER_ERROR"
        self.source = source
        self.status = status
        self.details = redact(details)
        self.hint = hint or hint_for(self.code)
        super().__init__(self.message)
        if cause is not None:
            self.__cause__ = cause

    def __str__(self) -> str:
        return format_error(self)

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
        }
        if self.source:
            out["source"] = self.source
        if self.status is not None:
            out["status"] = self.status
        if self.hint:
            out["hint"] = self.hint
        if self.details not in (None, {}, []):
            out["details"] = self.details
        return out


def hint_for(code: str | None) -> str | None:
    hints = {
        "OPENSTEER_API_KEY_MISSING": "Set OPENSTEER_API_KEY for cloud browsers, or use local browser mode.",
        "OPENSTEER_API_UNREACHABLE": "Check OPENSTEER_API and network connectivity.",
        "OPENSTEER_DAEMON_START_FAILED": "Run `opensteer --doctor` for diagnostics.",
        "OPENSTEER_BROKER_START_FAILED": "Run `opensteer --doctor` for diagnostics.",
        "OPENSTEER_DAEMON_UNREACHABLE": "Restart the OpenSteer daemon with `opensteer --setup`.",
        "LOCAL_CDP_NOT_ENABLED": "Run `opensteer --setup`, then allow remote debugging in chrome://inspect.",
        "LOCAL_CDP_NOT_READY": "Choose a Chrome profile if prompted, then click Allow if shown.",
        "CDP_WS_HANDSHAKE_FAILED": "Retry after allowing browser remote debugging.",
        "CDP_COMMAND_TIMEOUT": "The page may be hung or waiting on a dialog.",
        "CDP_RECEIVER_STOPPED": "Retry the command so OpenSteer can reconnect.",
    }
    return hints.get(code or "")


def format_error(error: OpenSteerError) -> str:
    prefix = "OpenSteer"
    if error.source == "opensteer-api" and error.status is not None:
        prefix += f" API {error.status}"
    elif error.status is not None:
        prefix += f" HTTP {error.status}"
    if error.code:
        prefix += f" {error.code}"
    text = f"{prefix}: {error.message}"
    if error.hint:
        text += f" Hint: {error.hint}"
    return text


def normalize_exception(
    exc: BaseException,
    *,
    source: str | None = None,
    code: str | None = None,
    message: str | None = None,
) -> OpenSteerError:
    if isinstance(exc, OpenSteerError):
        return exc
    msg = message or str(exc) or exc.__class__.__name__
    return OpenSteerError(msg, code=code or classify_message(msg), source=source, cause=exc)


def classify_message(message: str) -> str:
    lower = message.lower()
    if "opensteer_api_key missing" in lower:
        return "OPENSTEER_API_KEY_MISSING"
    if "devtoolsactiveport not found" in lower or "remote debugging is not enabled" in lower:
        return "LOCAL_CDP_NOT_ENABLED"
    if "not live yet" in lower:
        return "LOCAL_CDP_NOT_READY"
    if "cdp ws handshake failed" in lower:
        return "CDP_WS_HANDSHAKE_FAILED"
    if "cdp command timed out" in lower:
        return "CDP_COMMAND_TIMEOUT"
    if "cdp receiver task is not running" in lower:
        return "CDP_RECEIVER_STOPPED"
    if "cdp client not connected" in lower:
        return "CDP_CLIENT_NOT_CONNECTED"
    if "session with given id not found" in lower:
        return "CDP_SESSION_NOT_FOUND"
    if "browser broker didn't come up" in lower:
        return "OPENSTEER_BROKER_START_FAILED"
    return "OPENSTEER_ERROR"


def error_to_wire(exc: BaseException, *, source: str | None = None, code: str | None = None) -> dict[str, Any]:
    return normalize_exception(exc, source=source, code=code).to_wire()


def error_from_wire(value: Any, *, source: str | None = None) -> OpenSteerError:
    if isinstance(value, OpenSteerError):
        return value
    if isinstance(value, str):
        return OpenSteerError(value, code=classify_message(value), source=source)
    if isinstance(value, dict):
        nested = value.get("error")
        if nested is not None and "message" not in value and "code" not in value:
            return error_from_wire(nested, source=source)
        message = value.get("message") or value.get("error") or "OpenSteer operation failed."
        if isinstance(message, dict):
            message = message.get("message") or message.get("code") or "OpenSteer operation failed."
        return OpenSteerError(
            str(message),
            code=str(value.get("code") or classify_message(str(message))),
            source=str(value.get("source") or source or "") or None,
            status=_int_or_none(value.get("status")),
            hint=value.get("hint"),
            details=value.get("details"),
        )
    return OpenSteerError(str(value), source=source)


def error_brief(value: Any) -> str:
    return error_from_wire(value).message


def error_log_line(exc: BaseException, *, source: str | None = None) -> str:
    return ERROR_LOG_PREFIX + json.dumps(error_to_wire(exc, source=source), sort_keys=True)


def error_from_log_line(line: str | None) -> OpenSteerError | None:
    if not line or not line.startswith(ERROR_LOG_PREFIX):
        return None
    try:
        return error_from_wire(json.loads(line[len(ERROR_LOG_PREFIX) :]))
    except Exception:
        return None


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            clean_key = str(key)
            if _is_sensitive_key(clean_key):
                out[clean_key] = "<redacted>"
            else:
                out[clean_key] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return [redact(item) for item in value]
    return value


def _is_sensitive_key(key: str) -> bool:
    compact = key.lower().replace("-", "").replace("_", "")
    return any(part in compact for part in SENSITIVE_KEY_PARTS)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
