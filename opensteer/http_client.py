"""Small JSON HTTP client for OpenSteer services."""

from __future__ import annotations

import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .errors import OpenSteerError, redact


def request_json(
    api_base: str,
    api_key: str,
    path: str,
    method: str,
    body: Any = None,
    *,
    timeout: float = 60,
    source: str = "opensteer-api",
) -> Any:
    if not api_key:
        raise OpenSteerError("OPENSTEER_API_KEY missing", code="OPENSTEER_API_KEY_MISSING", source=source)

    req = urllib.request.Request(
        f"{api_base.rstrip('/')}{path}",
        method=method,
        data=(json.dumps(body).encode() if body is not None else None),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
        try:
            return _decode_json(response.read(), source=source, method=method, path=path)
        finally:
            close = getattr(response, "close", None)
            if close:
                close()
    except urllib.error.HTTPError as exc:
        raise _http_error(exc, method=method, path=path, source=source) from exc
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", None) or exc)
        raise OpenSteerError(
            "OpenSteer API is unreachable.",
            code="OPENSTEER_API_UNREACHABLE",
            source=source,
            details={"method": method, "path": path, "reason": reason},
            cause=exc,
        ) from exc


def request_file_upload(
    api_base: str,
    api_key: str,
    path: str,
    file_path: str,
    *,
    filename: str | None = None,
    timeout: float = 60,
    source: str = "opensteer-api",
) -> Any:
    if not api_key:
        raise OpenSteerError("OPENSTEER_API_KEY missing", code="OPENSTEER_API_KEY_MISSING", source=source)

    display_name = filename or os.path.basename(file_path) or "upload.bin"
    media_type = mimetypes.guess_type(display_name)[0] or "application/octet-stream"
    size = os.path.getsize(file_path)

    with open(file_path, "rb") as fh:
        req = urllib.request.Request(
            f"{api_base.rstrip('/')}{path}",
            method="POST",
            data=fh,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
                "X-OpenSteer-Filename": urllib.parse.quote(display_name, safe=""),
                "X-OpenSteer-Media-Type": media_type,
            },
        )
        try:
            response = urllib.request.urlopen(req, timeout=timeout)
            try:
                return _decode_json(response.read(), source=source, method="POST", path=path)
            finally:
                close = getattr(response, "close", None)
                if close:
                    close()
        except urllib.error.HTTPError as exc:
            raise _http_error(exc, method="POST", path=path, source=source) from exc
        except urllib.error.URLError as exc:
            reason = str(getattr(exc, "reason", None) or exc)
            raise OpenSteerError(
                "OpenSteer API is unreachable.",
                code="OPENSTEER_API_UNREACHABLE",
                source=source,
                details={"method": "POST", "path": path, "reason": reason},
                cause=exc,
            ) from exc


def _decode_json(raw: bytes, *, source: str, method: str, path: str) -> Any:
    try:
        return json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise OpenSteerError(
            "OpenSteer API returned invalid JSON.",
            code="OPENSTEER_API_BAD_RESPONSE",
            source=source,
            details={"method": method, "path": path},
            cause=exc,
        ) from exc


def _http_error(exc: urllib.error.HTTPError, *, method: str, path: str, source: str) -> OpenSteerError:
    raw = exc.read()
    text = raw.decode("utf-8", "replace").strip()
    payload: Any = None
    if text:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None

    code = None
    message = None
    hint = None
    response_details = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message") or error.get("error")
            hint = error.get("hint")
            response_details = error.get("details")
        elif isinstance(error, str):
            message = error
        code = payload.get("code") or code
        message = payload.get("message") or message
        hint = payload.get("hint") or hint
        response_details = payload.get("details") or response_details

    if not message:
        message = text[:300] if text else getattr(exc, "reason", None) or "OpenSteer API request failed."

    details = {
        "method": method,
        "path": path,
        "response": response_details,
    }
    return OpenSteerError(
        str(message),
        code=str(code or "OPENSTEER_API_ERROR"),
        source=source,
        status=exc.code,
        hint=hint,
        details=redact(details),
        cause=exc,
    )
