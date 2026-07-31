import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
from io import BytesIO
from unittest.mock import patch

import pytest

import opensteer.runtime as runtime
import opensteer.daemon as daemon
import opensteer.http_client as http_client
import opensteer.paths as paths
import opensteer.session_registry as session_registry
from opensteer.errors import OpenSteerError


@pytest.fixture(autouse=True)
def isolate_session_registry(tmp_path):
    """Tests must never inherit or mutate a user's real browser registry."""
    with patch.object(
        session_registry,
        "session_registry_path",
        return_value=str(tmp_path / "sessions.json"),
    ):
        yield


def test_get_name_uses_only_internal_relay_name():
    assert paths.get_name({"OPENSTEER_RELAY_NAME": "linkedin"}) == "linkedin"
    assert paths.get_name({}) == "default"


def test_session_paths_include_optional_cloud_agent_scope():
    scoped = paths.session_paths(
        env={
            "OPENSTEER_RELAY_NAME": "linkedin",
            "OPENSTEER_SESSION_SCOPE": "cag_agent_1",
        }
    )
    other_agent = paths.session_paths(
        env={
            "OPENSTEER_RELAY_NAME": "linkedin",
            "OPENSTEER_SESSION_SCOPE": "cag_agent_2",
        }
    )
    unscoped = paths.session_paths(env={"OPENSTEER_RELAY_NAME": "linkedin"})
    empty_scope = paths.session_paths(
        env={"OPENSTEER_RELAY_NAME": "linkedin", "OPENSTEER_SESSION_SCOPE": " "}
    )

    assert scoped != other_agent
    assert scoped != unscoped
    assert unscoped == (
        "/tmp/opensteer-linkedin.sock",
        "/tmp/opensteer-linkedin.pid",
        "/tmp/opensteer-linkedin.log",
    )
    assert empty_scope == unscoped
    assert scoped[0].endswith("-linkedin.sock")
    assert paths.session_state_path(
        env={
            "OPENSTEER_RELAY_NAME": "linkedin",
            "OPENSTEER_SESSION_SCOPE": "cag_agent_1",
        }
    ).endswith("-linkedin.state.json")


def test_session_registry_paths_isolate_scope_and_os_user():
    with patch.object(paths.os, "getuid", return_value=1001):
        first = paths.session_registry_path({"OPENSTEER_SESSION_SCOPE": "run-1"})
        other_scope = paths.session_registry_path({"OPENSTEER_SESSION_SCOPE": "run-2"})
    with patch.object(paths.os, "getuid", return_value=1002):
        other_user = paths.session_registry_path({"OPENSTEER_SESSION_SCOPE": "run-1"})

    assert first != other_scope
    assert first != other_user


def test_start_remote_daemon_uses_opensteer_api_cdp_grant():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
            "liveUrl": "https://cloud.test/browsers/session-1",
        }

    with (
        patch.dict(os.environ, clear=False),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
        patch("opensteer.runtime._show_live_url") as show_live_url,
    ):
        os.environ.pop("OPENSTEER_CLOUD_PROFILE_ID", None)
        browser = runtime.start_remote_daemon("work", proxyCountryCode="de")

    assert browser["id"] == "session-1"
    assert calls == [
        (
            "/v2/opensteer/sessions",
            "POST",
            {
                "proxyCountryCode": "de",
                "name": "work",
            },
        )
    ]
    ensure_daemon.assert_called_once()
    kwargs = ensure_daemon.call_args.kwargs
    assert kwargs["name"] == "work"
    assert kwargs["env"]["OPENSTEER_BROWSER_ID"] == "session-1"
    assert kwargs["env"]["OPENSTEER_CDP_WS"] == "wss://runtime.test/ws/cdp/session-1?token=secret"
    assert kwargs["env"]["OPENSTEER_CONTROLLER_EXIT_BEHAVIOR"] == "close"
    show_live_url.assert_called_once_with("https://cloud.test/browsers/session-1")


def test_start_remote_daemon_ignores_legacy_cloud_profile_id_env():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
        }

    with (
        patch.dict(os.environ, {"OPENSTEER_CLOUD_PROFILE_ID": " bp_default "}, clear=False),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon"),
        patch("opensteer.runtime._show_live_url"),
    ):
        runtime.start_remote_daemon("work")

    assert calls == [
        (
            "/v2/opensteer/sessions",
            "POST",
            {
                "name": "work",
            },
        )
    ]


def test_start_remote_daemon_passes_explicit_profile_id_through():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
        }

    with (
        patch.dict(os.environ, {"OPENSTEER_CLOUD_PROFILE_ID": "bp_default"}, clear=False),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon"),
        patch("opensteer.runtime._show_live_url"),
    ):
        runtime.start_remote_daemon("work", profileId="bp_explicit")

    assert calls == [
        (
            "/v2/opensteer/sessions",
            "POST",
            {
                "profileId": "bp_explicit",
                "name": "work",
            },
        )
    ]


def test_start_remote_daemon_passes_explicit_browser_location_through():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
        }

    with (
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon"),
        patch("opensteer.runtime._show_live_url"),
    ):
        runtime.start_remote_daemon("work", location="CLOUD")

    assert calls == [
        (
            "/v2/opensteer/sessions",
            "POST",
            {"location": "cloud", "name": "work"},
        )
    ]


def test_open_browser_requires_an_explicit_identity_choice():
    try:
        runtime.open_browser()
    except OpenSteerError as error:
        assert error.code == "OPENSTEER_INVALID_ARGUMENT"
        assert "exactly one browser identity" in error.message
    else:
        raise AssertionError("expected missing browser identity to fail")


def test_open_browser_uses_primary_scope_key_for_reuse_and_forces_fresh_identity():
    with (
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        runtime.open_browser(label="meeting-summary", profile="fresh")

    start_remote.assert_called_once_with(
        "meeting-summary",
        profileName=None,
        location=None,
        profileMode="fresh",
        sessionMode="reuse",
        sessionKey="primary",
    )


def test_open_browser_new_mode_uses_a_unique_idempotency_key():
    with (
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        runtime.open_browser(label="secondary", profileId="bp_1", mode="new")

    kwargs = start_remote.call_args.kwargs
    assert start_remote.call_args.args == ("secondary",)
    assert kwargs["profileId"] == "bp_1"
    assert kwargs["sessionMode"] == "new"
    assert kwargs["sessionKey"].startswith("new-")


def test_explicit_session_open_surfaces_transport_loss_without_retrying():
    unavailable = OpenSteerError(
        "OpenSteer API is unreachable.",
        code="OPENSTEER_API_UNREACHABLE",
        source="opensteer-api",
    )
    with (
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=unavailable) as request,
        patch("opensteer.runtime.ensure_daemon"),
        patch("opensteer.runtime.register_session"),
        patch("opensteer.runtime._show_live_url"),
    ):
        try:
            runtime.start_remote_daemon(
                "secondary",
                profileMode="fresh",
                sessionMode="new",
                sessionKey="new-stable-key",
            )
        except OpenSteerError as error:
            assert error is unavailable
        else:
            raise AssertionError("expected transport loss to be surfaced")

    request.assert_called_once_with(
        "/v2/opensteer/sessions",
        "POST",
        {
            "profileMode": "fresh",
            "sessionMode": "new",
            "sessionKey": "new-stable-key",
            "name": "secondary",
        },
    )


def test_browser_handle_binds_helpers_to_its_session_without_mutating_environment():
    handle = runtime.BrowserHandle({"id": "session-1"}, "meeting-summary")
    with (
        patch(
            "opensteer.helpers.page_info",
            side_effect=lambda: {"name": session_registry.resolve_session_name()},
        ),
    ):
        assert handle.page_info() == {"name": "meeting-summary"}


def test_browser_handle_and_registry_preserve_the_exact_browser_reference(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with patch.object(session_registry, "session_registry_path", return_value=str(registry_path)):
        exact = runtime.BrowserHandle(
            {"id": "session-1", "browserRef": "browser-exact-1"},
            "work",
        )
        fallback = runtime.BrowserHandle({"id": "session-legacy"}, "legacy")
        assert exact.browser_ref == "browser-exact-1"
        assert fallback.browser_ref == "session-legacy"

        session_registry.register_session("work", exact)
        restored = runtime.use_browser("work")
        assert restored.browser_ref == "browser-exact-1"


def test_strict_cloud_routing_uses_the_explicitly_opened_session_and_never_creates_on_alias_miss(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
                "OPENSTEER_SESSION_SCOPE": "scope-1",
            },
            clear=False,
        ),
    ):
        session_registry.register_session(
            "meeting-summary",
            {"id": "session-1", "profileId": "bp_1"},
        )
        assert session_registry.resolve_session_name() == "meeting-summary"

        with (
            patch("opensteer.runtime.daemon_alive", return_value=False),
            patch("opensteer.runtime._opensteer") as request,
        ):
            try:
                runtime.ensure_daemon(name="thread-default")
            except OpenSteerError as error:
                assert error.code == "OPENSTEER_SESSION_REQUIRED"
            else:
                raise AssertionError("expected an unknown alias to fail closed")
        request.assert_not_called()


def test_open_browser_never_reuses_a_label_with_the_wrong_profile(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        session_registry.register_session(
            "work",
            {"id": "session-1", "profileId": "bp_old"},
        )
        try:
            runtime.open_browser(label="work", profileId="bp_new")
        except OpenSteerError as error:
            assert error.code == "OPENSTEER_SESSION_IDENTITY_MISMATCH"
        else:
            raise AssertionError("expected profile mismatch to fail")
        start_remote.assert_not_called()


def test_open_browser_surfaces_an_unhealthy_registered_relay_without_replacing_it(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=True),
        patch(
            "opensteer.runtime._daemon_request",
            return_value={
                "ok": False,
                "error": {
                    "code": "CDP_RECEIVER_STOPPED",
                    "message": "CDP receiver stopped.",
                },
            },
        ),
        patch("opensteer.runtime.restart_daemon") as restart_daemon,
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        session_registry.register_session("work", {"id": "session-1"})
        try:
            runtime.open_browser(label="work", profile="fresh")
        except OpenSteerError as error:
            assert error.code == "CDP_RECEIVER_STOPPED"
        else:
            raise AssertionError("expected unhealthy relay state to be surfaced")

    restart_daemon.assert_not_called()
    start_remote.assert_not_called()


def test_reused_cloud_session_uses_one_relay_across_display_labels(tmp_path):
    registry_path = tmp_path / "sessions.json"
    created = {
        "id": "session-1",
        "profileId": "bp_1",
        "creationMode": "created",
        "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=first",
    }
    reused = {
        **created,
        "creationMode": "reused_existing",
        "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=second",
    }
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=[created, reused]),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
        patch("opensteer.runtime._show_live_url") as show_live_url,
    ):
        first = runtime.start_remote_daemon("first", profileId="bp_1")
        second = runtime.start_remote_daemon("renamed", profileId="bp_1")
        assert first.relay_name == "first"
        assert second.name == "renamed"
        assert second.relay_name == "first"
        assert ensure_daemon.call_args_list[1].kwargs["name"] == "first"
        assert session_registry.read_registry()["active"] == "renamed"
        assert session_registry.resolve_session_name() == "first"
        show_live_url.assert_called_once()


def test_new_mode_rejects_a_registered_label_even_when_its_relay_is_down(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        session_registry.register_session("secondary", {"id": "session-1"})
        try:
            runtime.open_browser(label="secondary", profile="fresh", mode="new")
        except OpenSteerError as error:
            assert error.code == "OPENSTEER_DAEMON_ALREADY_RUNNING"
        else:
            raise AssertionError("expected a duplicate label to fail")
        start_remote.assert_not_called()


def test_closing_an_alias_stops_one_relay_and_removes_all_aliases(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.restart_daemon") as restart_daemon,
    ):
        descriptor = {"id": "session-1", "profileId": "bp_1"}
        session_registry.register_session("first", descriptor)
        session_registry.register_session("renamed", descriptor, relay_name="first")

        runtime.stop_remote_daemon("renamed")

        restart_daemon.assert_called_once_with("first", stop_broker=True)
        assert session_registry.read_registry() == {"active": None, "sessions": {}}


def test_session_operation_lock_serializes_concurrent_opens(tmp_path):
    registry_path = tmp_path / "sessions.json"
    first_entered = threading.Event()
    second_started = threading.Event()
    second_entered = threading.Event()
    release_first = threading.Event()

    def first_worker():
        with session_registry.session_operation_lock("same-session"):
            first_entered.set()
            release_first.wait(2)

    def second_worker():
        assert first_entered.wait(2)
        second_started.set()
        with session_registry.session_operation_lock("same-session"):
            second_entered.set()

    with patch.object(
        session_registry,
        "session_registry_path",
        return_value=str(registry_path),
    ):
        first = threading.Thread(target=first_worker)
        second = threading.Thread(target=second_worker)
        first.start()
        second.start()
        try:
            assert first_entered.wait(2)
            assert second_started.wait(2)
            assert not second_entered.wait(0.05)
        finally:
            release_first.set()
        assert second_entered.wait(2)
        first.join(2)
        second.join(2)
        assert not first.is_alive()
        assert not second.is_alive()


def test_strict_daemon_reconnect_refreshes_the_exact_registered_session(tmp_path):
    registry_path = tmp_path / "sessions.json"
    popen_calls = []

    class FakeProcess:
        def poll(self):
            return None

    def fake_popen(*args, **kwargs):
        popen_calls.append((args, kwargs))
        return FakeProcess()

    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
                "OPENSTEER_SESSION_SCOPE": "scope-1",
            },
            clear=False,
        ),
        patch("opensteer.runtime.daemon_alive", side_effect=[False, False, True]),
        patch(
            "opensteer.runtime._opensteer",
            return_value={"cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=fresh"},
        ) as request,
        patch("opensteer.runtime.subprocess.Popen", side_effect=fake_popen),
    ):
        session_registry.register_session("work", {"id": "session-1"})
        runtime.ensure_daemon(name="work", wait=1)

    request.assert_called_once_with("/v2/opensteer/sessions/session-1/cdp", "POST")
    child_env = popen_calls[0][1]["env"]
    assert child_env["OPENSTEER_BROWSER_ID"] == "session-1"
    assert child_env["OPENSTEER_RELAY_NAME"] == "work"


def test_unmanaged_daemon_reconnects_the_exact_registered_session_before_auto_remote(tmp_path):
    registry_path = tmp_path / "sessions.json"
    popen_calls = []

    class FakeProcess:
        def poll(self):
            return None

    def fake_popen(*args, **kwargs):
        popen_calls.append((args, kwargs))
        return FakeProcess()

    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "1"}, clear=True),
        patch("opensteer.runtime.daemon_alive", side_effect=[False, False, True]),
        patch(
            "opensteer.runtime._opensteer",
            return_value={"cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=fresh"},
        ) as request,
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
        patch("opensteer.runtime.subprocess.Popen", side_effect=fake_popen),
    ):
        session_registry.register_session(
            "work",
            {
                "id": "session-1",
                "location": "cloud",
                "controllerExitBehavior": "detach",
            },
        )
        runtime.ensure_daemon(name="work", wait=1)

    request.assert_called_once_with("/v2/opensteer/sessions/session-1/cdp", "POST")
    start_remote.assert_not_called()
    child_env = popen_calls[0][1]["env"]
    assert child_env["OPENSTEER_BROWSER_ID"] == "session-1"
    assert child_env["OPENSTEER_RELAY_NAME"] == "work"
    assert child_env["OPENSTEER_CONTROLLER_EXIT_BEHAVIOR"] == "detach"


def test_registered_session_refresh_failure_never_substitutes_another_browser(tmp_path):
    registry_path = tmp_path / "sessions.json"
    closed = OpenSteerError(
        "Session is no longer active.",
        code="CLOUD_SESSION_CLOSED",
        source="opensteer-api",
        status=409,
    )

    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "1"}, clear=True),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=closed),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
        patch("opensteer.runtime.subprocess.Popen") as popen,
    ):
        session_registry.register_session("work", {"id": "session-1"})
        try:
            runtime.ensure_daemon(name="work")
        except OpenSteerError as error:
            assert error is closed
        else:
            raise AssertionError("expected the exact-session refresh failure")

    start_remote.assert_not_called()
    popen.assert_not_called()


def test_registered_session_without_an_exact_id_fails_closed(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "1"}, clear=True),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
        patch("opensteer.runtime.subprocess.Popen") as popen,
    ):
        session_registry.register_session("work", {})
        try:
            runtime.ensure_daemon(name="work")
        except OpenSteerError as error:
            assert error.code == "OPENSTEER_SESSION_INVALID"
        else:
            raise AssertionError("expected an invalid registered session to fail closed")

    start_remote.assert_not_called()
    popen.assert_not_called()


def test_open_browser_reconnects_a_registered_label_without_creating(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
    ):
        session_registry.register_session("work", {"id": "session-1"})
        browser = runtime.open_browser(label="work", profile="fresh")

    assert browser.session_id == "session-1"
    ensure_daemon.assert_called_once_with(name="work")
    start_remote.assert_not_called()


def test_start_remote_daemon_reconnects_a_registered_label_without_creating(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
        patch("opensteer.runtime._opensteer") as request,
    ):
        session_registry.register_session("work", {"id": "session-1"})
        browser = runtime.start_remote_daemon("work")

    assert browser.session_id == "session-1"
    ensure_daemon.assert_called_once_with(name="work")
    request.assert_not_called()


def test_start_remote_daemon_rejects_invalid_browser_location():
    try:
        with patch("opensteer.runtime.daemon_alive", return_value=False):
            runtime.start_remote_daemon("work", location="remote")
    except OpenSteerError as error:
        assert error.code == "OPENSTEER_INVALID_ARGUMENT"
    else:
        raise AssertionError("expected invalid location to fail")


def test_list_browsers_is_read_only_and_marks_the_active_exact_session(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
            },
            clear=False,
        ),
        patch(
            "opensteer.runtime._opensteer",
            return_value={
                "sessions": [
                    {
                        "id": "session-1",
                        "browserRef": "session-1",
                        "sessionId": "session-1",
                        "label": "sales",
                        "location": "inapp",
                        "status": "active",
                        "controllerExitBehavior": "detach",
                        "createdAt": 123,
                        "cdpWsUrl": "wss://runtime.test/secret",
                    },
                    {
                        "id": "session-2",
                        "browserRef": "session-2",
                        "sessionId": "session-2",
                        "label": "research",
                        "location": "cloud",
                        "status": "active",
                        "createdAt": 456,
                    },
                ]
            },
        ) as request,
    ):
        session_registry.register_session("sales", {"id": "session-1"})
        before = registry_path.read_text()
        browsers = runtime.list_browsers()
        after = registry_path.read_text()

    assert before == after
    assert [browser["active"] for browser in browsers] == [True, False]
    assert browsers[0]["browserRef"] == "session-1"
    assert "cdpWsUrl" not in browsers[0]
    request.assert_called_once_with("/v2/opensteer/sessions", "GET")


def test_unmanaged_list_browsers_uses_only_the_scope_local_registry(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(os.environ, {"OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch("opensteer.runtime._explicit_session_required", return_value=False),
        patch("opensteer.runtime._opensteer") as request,
    ):
        session_registry.register_session(
            "sales",
            {
                "sessionId": "session-1",
                "browserRef": "browser-1",
                "profileId": "bp-1",
            },
        )
        browsers = runtime.list_browsers()

    assert browsers == [
        {
            "id": "session-1",
            "browserRef": "browser-1",
            "sessionId": "session-1",
            "label": "sales",
            "profileId": "bp-1",
            "active": True,
        }
    ]
    request.assert_not_called()


def test_registered_session_preserves_controller_lifecycle_and_location(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with patch.object(session_registry, "session_registry_path", return_value=str(registry_path)):
        session_registry.register_session(
            "sales",
            {
                "sessionId": "session-1",
                "location": "inapp",
                "controllerExitBehavior": "detach",
            },
        )

        record = session_registry.registered_session("sales")

    assert record["location"] == "inapp"
    assert record["controllerExitBehavior"] == "detach"


def test_use_browser_resolves_a_registered_exact_session_id_without_network(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
            },
            clear=False,
        ),
        patch("opensteer.runtime._opensteer") as request,
    ):
        session_registry.register_session("sales", {"sessionId": "session-1"})

        browser = runtime.use_browser("session-1")

    assert browser.name == "sales"
    assert browser.session_id == "session-1"
    request.assert_not_called()


def test_use_browser_attaches_an_exact_listed_session(tmp_path):
    registry_path = tmp_path / "sessions.json"
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        if method == "GET":
            return {
                "sessions": [
                    {
                        "id": "session-1",
                        "browserRef": "session-1",
                        "sessionId": "session-1",
                        "label": "sales",
                        "location": "inapp",
                        "status": "active",
                        "controllerExitBehavior": "detach",
                        "createdAt": 123,
                    }
                ]
            }
        return {"cdpWsUrl": "ws://127.0.0.1/devtools/browser/session-1?token=secret"}

    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
            },
            clear=False,
        ),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
    ):
        browser = runtime.use_browser("sales")

    assert browser.session_id == "session-1"
    assert calls == [
        ("/v2/opensteer/sessions", "GET", None),
        ("/v2/opensteer/sessions/session-1/cdp", "POST", None),
    ]
    assert ensure_daemon.call_args.kwargs["name"] == "session-session-1"
    assert (
        ensure_daemon.call_args.kwargs["env"]["OPENSTEER_CONTROLLER_EXIT_BEHAVIOR"]
        == "detach"
    )


def test_use_browser_exact_id_wins_over_a_colliding_label(tmp_path):
    registry_path = tmp_path / "sessions.json"
    with (
        patch.object(session_registry, "session_registry_path", return_value=str(registry_path)),
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
            },
            clear=False,
        ),
        patch(
            "opensteer.runtime._opensteer",
            side_effect=[
                {
                    "sessions": [
                        {
                            "id": "session-1",
                            "browserRef": "session-1",
                            "sessionId": "session-1",
                            "label": "session-2",
                            "location": "cloud",
                            "status": "active",
                            "createdAt": 1,
                        },
                        {
                            "id": "session-2",
                            "browserRef": "session-2",
                            "sessionId": "session-2",
                            "label": "research",
                            "location": "cloud",
                            "status": "active",
                            "createdAt": 2,
                        },
                    ]
                },
                {"cdpWsUrl": "ws://127.0.0.1/devtools/browser/session-2?token=secret"},
            ],
        ),
        patch("opensteer.runtime.ensure_daemon"),
    ):
        browser = runtime.use_browser("session-2")

    assert browser.session_id == "session-2"


def test_use_browser_rejects_duplicate_labels_before_attaching():
    with (
        patch.dict(
            os.environ,
            {
                "OPENSTEER_API_KEY": "osk_test",
                "OPENSTEER_REQUIRE_EXPLICIT_SESSION": "1",
            },
            clear=False,
        ),
        patch(
            "opensteer.runtime._opensteer",
            return_value={
                "sessions": [
                    {
                        "id": "session-1",
                        "browserRef": "session-1",
                        "sessionId": "session-1",
                        "label": "sales",
                        "location": "cloud",
                        "status": "active",
                        "createdAt": 1,
                    },
                    {
                        "id": "session-2",
                        "browserRef": "session-2",
                        "sessionId": "session-2",
                        "label": "sales",
                        "location": "cloud",
                        "status": "active",
                        "createdAt": 2,
                    },
                ]
            },
        ) as request,
    ):
        try:
            runtime.use_browser("sales")
        except OpenSteerError as error:
            assert error.code == "OPENSTEER_SESSION_AMBIGUOUS"
        else:
            raise AssertionError("expected an ambiguous browser label to fail")

    request.assert_called_once_with("/v2/opensteer/sessions", "GET")


def test_list_cloud_profiles_prefers_grants_listing_and_includes_granted_flag():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "profiles": [
                {
                    "id": "bp_1",
                    "profileId": "bp_1",
                    "name": "work",
                    "userId": "user-1",
                    "status": "ready",
                    "cookieDomains": ["example.com"],
                    "cookieCount": 4,
                    "domainCount": 1,
                    "lastUsedAt": 1700000000000,
                    "granted": True,
                },
                {
                    "id": "bp_2",
                    "profileId": "bp_2",
                    "name": "personal",
                    "userId": "user-2",
                    "status": "ready",
                    "cookieDomains": [],
                    "granted": False,
                },
            ]
        }

    with patch("opensteer.runtime._opensteer", side_effect=fake_opensteer):
        profiles = runtime.list_cloud_profiles()

    assert calls == [("/browser-profiles", "GET", None)]
    assert [(p["id"], p["granted"]) for p in profiles] == [("bp_1", True), ("bp_2", False)]
    assert profiles[0]["cookieDomains"] == ["example.com"]


def test_list_cloud_profiles_falls_back_to_legacy_listing_on_404():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        if path == "/browser-profiles":
            raise OpenSteerError(
                "Not found.",
                code="OPENSTEER_API_ERROR",
                source="opensteer-api",
                status=404,
            )
        return {
            "items": [{"id": "bp_1", "name": "work", "userId": "user-1"}],
            "nextCursor": None,
        }

    with patch("opensteer.runtime._opensteer", side_effect=fake_opensteer):
        profiles = runtime.list_cloud_profiles()

    assert calls == [
        ("/browser-profiles", "GET", None),
        ("/v2/opensteer/profiles?limit=100", "GET", None),
    ]
    assert [p["id"] for p in profiles] == ["bp_1"]
    assert "granted" not in profiles[0]


def test_list_cloud_profiles_reraises_non_404_errors_without_legacy_fallback():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        raise OpenSteerError(
            "Forbidden.",
            code="OPENSTEER_API_ERROR",
            source="opensteer-api",
            status=403,
        )

    with patch("opensteer.runtime._opensteer", side_effect=fake_opensteer):
        try:
            runtime.list_cloud_profiles()
        except OpenSteerError as error:
            assert error.status == 403
        else:
            raise AssertionError("expected 403 to re-raise")

    # No fallback request: only route-missing 404s mean "older cloud".
    assert calls == [("/browser-profiles", "GET", None)]


def test_list_cloud_profiles_reraises_network_errors_without_legacy_fallback():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        # Network failures carry no HTTP status (status=None) and must
        # surface rather than silently degrade to the legacy listing.
        raise OpenSteerError(
            "OpenSteer API is unreachable.",
            code="OPENSTEER_API_UNREACHABLE",
            source="opensteer-api",
        )

    with patch("opensteer.runtime._opensteer", side_effect=fake_opensteer):
        try:
            runtime.list_cloud_profiles()
        except OpenSteerError as error:
            assert error.code == "OPENSTEER_API_UNREACHABLE"
            assert error.status is None
        else:
            raise AssertionError("expected network error to re-raise")

    assert calls == [("/browser-profiles", "GET", None)]


def test_resolve_profile_name_prefers_single_granted_match():
    profiles = [
        {"id": "bp_granted", "name": "work", "granted": True},
        {"id": "bp_other", "name": "work", "granted": False},
    ]

    with patch("opensteer.runtime.list_cloud_profiles", return_value=profiles):
        assert runtime._resolve_profile_name("work") == "bp_granted"


def test_resolve_profile_name_keeps_ambiguity_error_for_multiple_granted_matches():
    profiles = [
        {"id": "bp_a", "name": "work", "granted": True},
        {"id": "bp_b", "name": "work", "granted": True},
    ]

    with patch("opensteer.runtime.list_cloud_profiles", return_value=profiles):
        try:
            runtime._resolve_profile_name("work")
        except OpenSteerError as error:
            assert error.code == "CLOUD_PROFILE_AMBIGUOUS"
        else:
            raise AssertionError("expected ambiguity error")


def test_start_remote_daemon_closes_cloud_session_if_daemon_launch_fails():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        if method == "POST":
            return {
                "id": "session/with spaces",
                "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
                "liveUrl": "https://cloud.test/browsers/session-1",
            }
        return {}

    with (
        patch.dict(os.environ, {"OPENSTEER_CLOUD_PROFILE_ID": ""}, clear=False),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon", side_effect=RuntimeError("daemon failed")),
        patch("opensteer.runtime._show_live_url") as show_live_url,
    ):
        try:
            runtime.start_remote_daemon("work")
        except RuntimeError as error:
            assert str(error) == "daemon failed"
        else:
            raise AssertionError("expected daemon launch failure")

    assert calls == [
        (
            "/v2/opensteer/sessions",
            "POST",
            {
                "name": "work",
            },
        ),
        ("/v2/opensteer/sessions/session%2Fwith%20spaces", "DELETE", None),
    ]
    show_live_url.assert_not_called()


def test_runtime_opensteer_uses_bearer_api_key():
    requests = []

    class Response:
        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(req, timeout=60):
        requests.append((req, timeout))
        return Response()

    with (
        patch.dict(os.environ, {"OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch.object(runtime, "OPENSTEER_API", "https://api.test"),
        patch("urllib.request.urlopen", side_effect=fake_urlopen),
    ):
        assert runtime._opensteer("/v2/opensteer/profiles", "GET") == {"ok": True}

    req, timeout = requests[0]
    assert req.full_url == "https://api.test/v2/opensteer/profiles"
    assert req.get_method() == "GET"
    assert req.get_header("Authorization") == "Bearer osk_test"
    assert req.get_header("Content-type") == "application/json"
    assert timeout == 60


def test_runtime_opensteer_surfaces_structured_http_error():
    def fake_urlopen(req, timeout=60):
        body = b'{"code":"CLOUD_SESSION_CLOSED","error":"Session is no longer active.","details":{"status":"closed"}}'
        raise urllib.error.HTTPError(req.full_url, 409, "Conflict", {}, BytesIO(body))

    with (
        patch.dict(os.environ, {"OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch.object(runtime, "OPENSTEER_API", "https://api.test"),
        patch("urllib.request.urlopen", side_effect=fake_urlopen),
    ):
        try:
            runtime._opensteer("/v2/opensteer/sessions/session-1/cdp", "POST")
        except OpenSteerError as error:
            assert error.code == "CLOUD_SESSION_CLOSED"
            assert error.status == 409
            assert str(error) == "OpenSteer API 409 CLOUD_SESSION_CLOSED: Session is no longer active."
        else:
            raise AssertionError("expected structured OpenSteerError")


def test_opensteer_api_is_the_only_base_url_override():
    code = "import opensteer.runtime as r; print(r.OPENSTEER_API)"
    env = {
        **os.environ,
        "OPENSTEER_BASE_URL": "https://legacy.example",
        "OPENSTEER_API": "https://api.test/",
    }

    result = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )

    assert result.stdout.strip() == "https://api.test"


def test_ensure_daemon_sets_internal_relay_name_for_child():
    popen_calls = []

    class FakeProcess:
        def poll(self):
            return None

    def fake_popen(*args, **kwargs):
        popen_calls.append((args, kwargs))
        return FakeProcess()

    with (
        patch("opensteer.runtime.registered_session_for_route", return_value=None),
        patch("opensteer.runtime.daemon_alive", side_effect=[False, True]),
        patch("subprocess.Popen", side_effect=fake_popen),
    ):
        runtime.ensure_daemon(name="work")

    env = popen_calls[0][1]["env"]
    assert env["OPENSTEER_RELAY_NAME"] == "work"
    assert popen_calls[0][0][0][:3] == [sys.executable, "-m", "opensteer.daemon"]


def test_ensure_daemon_auto_starts_remote_browser_when_configured():
    with (
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "1", "OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch("opensteer.runtime.registered_session_for_route", return_value=None),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
        patch("subprocess.Popen") as popen,
    ):
        runtime.ensure_daemon(name="work")

    start_remote.assert_called_once_with(name="work")
    popen.assert_not_called()


def test_ensure_daemon_auto_remote_uses_default_session_name():
    with (
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "true", "OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch("opensteer.runtime.registered_session_for_route", return_value=None),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime.start_remote_daemon") as start_remote,
        patch("subprocess.Popen") as popen,
    ):
        runtime.ensure_daemon()

    start_remote.assert_called_once_with(name="default")
    popen.assert_not_called()


def test_daemon_redacts_remote_cdp_token_from_logs():
    assert (
        daemon._redact_ws_url("wss://runtime.test/ws/cdp/session-1?token=secret")
        == "wss://runtime.test/ws/cdp/session-1"
    )


def test_daemon_refreshes_remote_cdp_grant():
    calls = []

    def fake_opensteer(path, method, body=None, timeout=15):
        calls.append((path, method, body, timeout))
        return {
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=fresh",
        }

    with (
        patch.object(daemon, "REMOTE_ID", "session-1"),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "_opensteer", side_effect=fake_opensteer),
    ):
        assert daemon.refresh_remote_cdp_ws_url() == "wss://runtime.test/ws/cdp/session-1?token=fresh"

    assert calls == [
        ("/v2/opensteer/sessions/session-1/cdp", "POST", None, 15),
    ]


def test_daemon_stop_remote_deletes_opensteer_session():
    calls = []

    def fake_opensteer(path, method, body=None, timeout=15):
        calls.append((path, method, body, timeout))
        return {}

    with (
        patch.object(daemon, "REMOTE_ID", "session/with spaces"),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "_opensteer", side_effect=fake_opensteer),
        patch.object(daemon, "log"),
    ):
        daemon.stop_remote()

    assert calls == [
        ("/v2/opensteer/sessions/session%2Fwith%20spaces", "DELETE", None, 15),
    ]


def test_daemon_stop_remote_detaches_durable_session_unless_close_is_explicit():
    calls = []

    with (
        patch.object(daemon, "REMOTE_ID", "osi-durable"),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "CONTROLLER_EXIT_BEHAVIOR", "detach"),
        patch.object(daemon, "_opensteer", side_effect=lambda *args: calls.append(args)),
        patch.object(daemon, "log"),
    ):
        daemon.stop_remote()
        assert calls == []
        daemon.stop_remote(force=True)

    assert calls == [("/v2/opensteer/sessions/osi-durable", "DELETE")]


def test_daemon_stage_remote_upload_returns_browser_remote_path():
    calls = []

    def fake_upload(api_base, api_key, path, file_path, **kwargs):
        calls.append((api_base, api_key, path, file_path, kwargs))
        return {
            "remotePath": "/tmp/opensteer-browser-uploads/session/upl/report.csv",
        }

    with (
        patch.object(daemon, "REMOTE_ID", "session/with spaces"),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "OPENSTEER_API", "https://api.test"),
        patch.object(daemon, "request_file_upload", side_effect=fake_upload),
    ):
        assert daemon.stage_remote_upload("/workspace/report.csv") == {
            "path": "/tmp/opensteer-browser-uploads/session/upl/report.csv",
            "staged": True,
            "upload": {
                "remotePath": "/tmp/opensteer-browser-uploads/session/upl/report.csv",
            },
        }

    assert calls == [
        (
            "https://api.test",
            "osk_test",
            "/v2/opensteer/sessions/session%2Fwith%20spaces/uploads",
            "/workspace/report.csv",
            {
                "filename": "report.csv",
                "timeout": 120,
            },
        ),
    ]


def test_request_file_upload_uses_binary_transport_with_media_type_metadata(tmp_path):
    uploaded = tmp_path / "data.json"
    uploaded.write_text('{"ok":true}')
    captured = {}

    class Response:
        def read(self):
            return b'{"remotePath":"/tmp/opensteer-browser-uploads/session/upl/data.json"}'

        def close(self):
            captured["closed"] = True

    def fake_urlopen(req, timeout=60):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["timeout"] = timeout
        captured["headers"] = {name.lower(): value for name, value in req.header_items()}
        captured["body"] = req.data.read()
        return Response()

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        assert http_client.request_file_upload(
            "https://api.test/",
            "osk_test",
            "/v2/opensteer/sessions/session-1/uploads",
            str(uploaded),
            timeout=12,
        ) == {
            "remotePath": "/tmp/opensteer-browser-uploads/session/upl/data.json",
        }

    assert captured == {
        "url": "https://api.test/v2/opensteer/sessions/session-1/uploads",
        "method": "POST",
        "timeout": 12,
        "headers": {
            "authorization": "Bearer osk_test",
            "content-type": "application/octet-stream",
            "content-length": "11",
            "x-opensteer-filename": "data.json",
            "x-opensteer-media-type": "application/json",
        },
        "body": b'{"ok":true}',
        "closed": True,
    }


def test_daemon_stage_remote_upload_returns_original_path_for_local_browser():
    with (
        patch.object(daemon, "REMOTE_ID", None),
        patch.object(daemon, "API_KEY", ""),
    ):
        assert daemon.stage_remote_upload("/workspace/report.csv") == {
            "path": "/workspace/report.csv",
            "staged": False,
        }


def test_daemon_stage_remote_upload_skips_network_with_api_key_without_remote_browser():
    def fail_upload(*_args, **_kwargs):
        raise AssertionError("local browser uploads must not call the remote upload API")

    with (
        patch.object(daemon, "REMOTE_ID", None),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "request_file_upload", side_effect=fail_upload),
    ):
        assert daemon.stage_remote_upload("/workspace/report.csv") == {
            "path": "/workspace/report.csv",
            "staged": False,
        }


def test_start_remote_daemon_surfaces_server_profile_steering_text():
    steering = (
        "Multiple browser profiles are granted to this agent. Pass profileId "
        "(or profileName in the opensteer CLI) to choose one, or explicitly "
        "launch an unprofiled browser."
    )

    def fake_urlopen(req, timeout=60):
        body = json.dumps({"error": steering, "code": "CLOUD_INVALID_REQUEST"}).encode()
        raise urllib.error.HTTPError(req.full_url, 409, "Conflict", {}, BytesIO(body))

    with (
        patch.dict(os.environ, {"OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch.object(runtime, "OPENSTEER_API", "https://api.test"),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("urllib.request.urlopen", side_effect=fake_urlopen),
    ):
        try:
            runtime.start_remote_daemon("work")
        except OpenSteerError as error:
            assert error.status == 409
            assert error.message == steering
            assert steering in str(error)
        else:
            raise AssertionError("expected steering error")


def test_stop_remote_daemon_stops_shared_broker():
    with patch("opensteer.runtime.restart_daemon") as restart:
        runtime.stop_remote_daemon("remote")

    restart.assert_called_once_with("remote", stop_broker=True)


def test_broker_start_refreshes_expired_remote_grant_and_session_attaches_page(tmp_path):
    urls = []
    calls = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self.url = url
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()
            urls.append(url)

        async def start(self):
            if "expired" in self.url:
                raise RuntimeError("403 forbidden")

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {
                            "targetId": "target-1",
                            "type": "page",
                            "url": "https://example.test",
                        }
                    ]
                }
            if method == "Target.createTarget":
                return {"targetId": "target-blank"}
            if method == "Target.attachToTarget":
                return {"sessionId": "cdp-session-1"}
            return {}

    with (
        patch.object(daemon, "REMOTE_ID", "session-1"),
        patch.object(daemon, "API_KEY", "osk_test"),
        patch.object(daemon, "get_ws_url", return_value="wss://runtime.test/ws/cdp/session-1?token=expired"),
        patch.object(
            daemon,
            "refresh_remote_cdp_ws_url",
            return_value="wss://runtime.test/ws/cdp/session-1?token=fresh",
        ) as refresh,
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")),
        patch.object(daemon, "log"),
    ):
        broker = daemon.BrowserBroker()
        asyncio.run(broker.start())
        session = broker.get_session("work")
        asyncio.run(
            session.handle(
                {
                    "method": "Runtime.evaluate",
                    "params": {"expression": "1"},
                }
            )
        )

    assert urls == [
        "wss://runtime.test/ws/cdp/session-1?token=expired",
        "wss://runtime.test/ws/cdp/session-1?token=fresh",
    ]
    refresh.assert_called_once_with()
    assert session.session == "cdp-session-1"
    assert session.target_id == "target-1"
    assert ("Target.getTargets", None, None) in calls
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) in calls
    assert (
        "Target.createTarget",
        {"url": "about:blank"},
        None,
    ) not in calls
    assert ("Page.enable", None, "cdp-session-1") in calls
    assert ("DOM.enable", None, "cdp-session-1") in calls
    assert ("Runtime.enable", None, "cdp-session-1") in calls
    assert ("Network.enable", None, "cdp-session-1") in calls
    assert (
        "Runtime.evaluate",
        {"expression": "1"},
        "cdp-session-1",
    ) in calls


def test_session_prefers_saved_active_target_on_attach(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "active_target_id": "target-2",
                "owned_target_ids": ["target-2"],
            }
        )
    )
    calls = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {"targetId": "target-1", "type": "page", "url": "https://one.test"},
                        {"targetId": "target-2", "type": "page", "url": "https://two.test"},
                    ]
                }
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    with (
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", return_value=str(state)),
        patch.object(daemon, "log"),
    ):
        broker = daemon.BrowserBroker()
        asyncio.run(broker.start())
        session = broker.get_session("work")
        asyncio.run(session.attach_first_page())

    assert session.target_id == "target-2"
    assert session.session == "session-for-target-2"
    assert (
        "Target.attachToTarget",
        {"targetId": "target-2", "flatten": True},
        None,
    ) in calls


def test_session_creates_blank_when_saved_targets_are_gone(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "active_target_id": "closed-target",
                "owned_target_ids": ["closed-target"],
            }
        )
    )
    calls = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {"targetId": "target-1", "type": "page", "url": "https://existing.test"},
                    ]
                }
            if method == "Target.createTarget":
                return {"targetId": "created-1"}
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    with (
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", return_value=str(state)),
        patch.object(daemon, "log"),
    ):
        broker = daemon.BrowserBroker()
        asyncio.run(broker.start())
        session = broker.get_session("work")
        asyncio.run(session.attach_first_page())

    assert session.target_id == "created-1"
    assert session.session == "session-for-created-1"
    assert (
        "Target.attachToTarget",
        {"targetId": "created-1", "flatten": True},
        None,
    ) in calls
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) not in calls
    assert json.loads(state.read_text())["owned_target_ids"] == ["created-1"]


def test_cloud_session_attaches_single_initial_target_without_extra_blank(tmp_path):
    calls = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {"targetId": "cloud-root", "type": "page", "url": "about:blank"},
                    ]
                }
            if method == "Target.createTarget":
                raise AssertionError("cloud session already has one controller-owned target")
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    with (
        patch.dict(os.environ, {"OPENSTEER_PROVIDER": "cloud"}, clear=False),
        patch.object(daemon, "REMOTE_ID", None),
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")),
        patch.object(daemon, "log"),
    ):
        broker = daemon.BrowserBroker()
        asyncio.run(broker.start())
        session = broker.get_session("work")
        asyncio.run(session.attach_first_page())

    assert session.target_id == "cloud-root"
    assert session.session == "session-for-cloud-root"
    assert (
        "Target.attachToTarget",
        {"targetId": "cloud-root", "flatten": True},
        None,
    ) in calls


def test_cloud_session_creates_blank_instead_of_stealing_owned_initial_target(tmp_path):
    calls = []
    created = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {"targetId": "cloud-root", "type": "page", "url": "about:blank"},
                    ]
                }
            if method == "Target.createTarget":
                target_id = f"created-{len(created) + 1}"
                created.append(target_id)
                return {"targetId": target_id}
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    def state_for(name=None, env=None):
        return str(tmp_path / f"{name or 'default'}.json")

    async def run():
        broker = daemon.BrowserBroker()
        await broker.start()
        first = broker.get_session("first")
        second = broker.get_session("second")
        await first.attach_first_page()
        await second.attach_first_page()
        return first, second

    with (
        patch.dict(os.environ, {"OPENSTEER_PROVIDER": "cloud"}, clear=False),
        patch.object(daemon, "REMOTE_ID", None),
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", side_effect=state_for),
        patch.object(daemon, "log"),
    ):
        first, second = asyncio.run(run())

    assert first.target_id == "cloud-root"
    assert first.session == "session-for-cloud-root"
    assert first.owned_target_ids == ["cloud-root"]
    assert second.target_id == "created-1"
    assert second.session == "session-for-created-1"
    assert second.owned_target_ids == ["created-1"]
    assert created == ["created-1"]
    assert (
        calls.count(
            (
                "Target.attachToTarget",
                {"targetId": "cloud-root", "flatten": True},
                None,
            )
        )
        == 1
    )
    assert (
        "Target.attachToTarget",
        {"targetId": "created-1", "flatten": True},
        None,
    ) in calls


def test_session_prefers_saved_owned_target_when_active_target_is_gone(tmp_path):
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "active_target_id": "closed-target",
                "owned_target_ids": ["closed-target", "target-2"],
                "focus_stack": ["target-2", "closed-target"],
            }
        )
    )
    calls = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                return {
                    "targetInfos": [
                        {"targetId": "target-1", "type": "page", "url": "https://existing.test"},
                        {"targetId": "target-2", "type": "page", "url": "https://owned.test"},
                    ]
                }
            if method == "Target.createTarget":
                raise AssertionError("should not create a new tab when a saved owned target is live")
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    with (
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", return_value=str(state)),
        patch.object(daemon, "log"),
    ):
        broker = daemon.BrowserBroker()
        asyncio.run(broker.start())
        session = broker.get_session("work")
        asyncio.run(session.attach_first_page())

    assert session.target_id == "target-2"
    assert session.session == "session-for-target-2"
    assert (
        "Target.attachToTarget",
        {"targetId": "target-2", "flatten": True},
        None,
    ) in calls
    assert json.loads(state.read_text())["owned_target_ids"] == ["target-2"]


def test_broker_creates_new_tabs_for_new_names(tmp_path):
    calls = []
    created = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                infos = [
                    {"targetId": "target-1", "type": "page", "url": "https://owned.test"},
                ]
                infos.extend({"targetId": target_id, "type": "page", "url": "about:blank"} for target_id in created)
                return {"targetInfos": infos}
            if method == "Target.createTarget":
                target_id = f"created-{len(created) + 1}"
                created.append(target_id)
                return {"targetId": target_id}
            if method == "Target.attachToTarget":
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    def state_for(name=None, env=None):
        return str(tmp_path / f"{name or 'default'}.json")

    async def run():
        broker = daemon.BrowserBroker()
        await broker.start()
        first = broker.get_session("first")
        second = broker.get_session("second")
        await first.handle({"method": "Runtime.evaluate", "params": {"expression": "1"}})
        await second.handle({"method": "Runtime.evaluate", "params": {"expression": "2"}})
        return first, second

    with (
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", side_effect=state_for),
        patch.object(daemon, "log"),
    ):
        first, second = asyncio.run(run())

    assert first.target_id == "created-1"
    assert second.target_id == "created-2"
    assert created == ["created-1", "created-2"]
    assert (
        "Target.attachToTarget",
        {"targetId": "created-1", "flatten": True},
        None,
    ) in calls
    assert (
        "Target.attachToTarget",
        {"targetId": "created-2", "flatten": True},
        None,
    ) in calls
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) not in calls


def test_broker_serializes_parallel_first_attach_target_ownership(tmp_path):
    calls = []
    created = []

    class NeverDoneTask:
        def done(self):
            return False

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            return None

    class FakeCDPClient:
        def __init__(self, url):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def start(self):
            pass

        async def send_raw(self, method, params=None, session_id=None):
            calls.append((method, params, session_id))
            if method == "Target.getTargets":
                infos = [
                    {"targetId": "target-1", "type": "page", "url": "https://shared.test"},
                ]
                infos.extend({"targetId": target_id, "type": "page", "url": "about:blank"} for target_id in created)
                return {"targetInfos": infos}
            if method == "Target.createTarget":
                target_id = f"created-{len(created) + 1}"
                created.append(target_id)
                return {"targetId": target_id}
            if method == "Target.attachToTarget":
                await asyncio.sleep(0.01)
                return {"sessionId": f"session-for-{params['targetId']}"}
            return {}

    def state_for(name=None, env=None):
        return str(tmp_path / f"{name or 'default'}.json")

    async def run():
        broker = daemon.BrowserBroker()
        await broker.start()
        first = broker.get_session("first")
        second = broker.get_session("second")
        await asyncio.gather(
            first.handle({"method": "Runtime.evaluate", "params": {"expression": "1"}}),
            second.handle({"method": "Runtime.evaluate", "params": {"expression": "2"}}),
        )
        return first, second

    with (
        patch.object(daemon, "get_ws_url", return_value="ws://test"),
        patch.object(daemon, "CDPClient", FakeCDPClient),
        patch.object(daemon, "session_state_path", side_effect=state_for),
        patch.object(daemon, "log"),
    ):
        first, second = asyncio.run(run())

    assert {first.target_id, second.target_id} == {"created-1", "created-2"}
    assert created == ["created-1", "created-2"]
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) not in calls


def test_relay_shutdown_does_not_stop_shared_broker():
    calls = []

    async def run():
        relay = daemon.SessionRelay("work")
        relay.stop = asyncio.Event()
        relay.broker_alive = lambda: True

        def broker_request(req, timeout=daemon.BROKER_REQUEST_TIMEOUT):
            calls.append((req, timeout))
            return {"ok": True}

        relay._broker_request = broker_request
        response = await relay.handle({"meta": "shutdown"})
        return response, relay.stop.is_set()

    response, stopped = asyncio.run(run())

    assert response == {"ok": True}
    assert stopped
    assert calls == []


def test_relay_shutdown_all_stops_shared_broker():
    calls = []

    async def run():
        relay = daemon.SessionRelay("work")
        relay.stop = asyncio.Event()
        relay.broker_alive = lambda: True

        def broker_request(req, timeout=daemon.BROKER_REQUEST_TIMEOUT):
            calls.append((req, timeout))
            return {"ok": True}

        relay._broker_request = broker_request
        response = await relay.handle({"meta": "shutdown_all"})
        return response, relay.stop.is_set()

    response, stopped = asyncio.run(run())

    assert response == {"ok": True}
    assert stopped
    assert calls == [({"meta": "shutdown_broker"}, 5)]


def test_set_session_claims_active_target(tmp_path):
    class NeverDoneTask:
        def done(self):
            return False

    class FakeCDP:
        _message_handler_task = NeverDoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            return {}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        return session, await session.handle(
            {
                "meta": "set_session",
                "session_id": "session-1",
                "target_id": "target-1",
            }
        )

    with patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")):
        session, response = asyncio.run(run())

    assert response == {"session_id": "session-1", "target_id": "target-1"}
    assert session.target_id == "target-1"
    assert session.owned_target_ids == ["target-1"]


def test_set_session_keeps_new_session_when_active_target_changes(tmp_path):
    class NeverDoneTask:
        def done(self):
            return False

    class FakeCDP:
        _message_handler_task = NeverDoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            return {}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        session.target_id = "old-target"
        session.owned_target_ids = ["old-target"]
        return session, await session.handle(
            {
                "meta": "set_session",
                "session_id": "session-1",
                "target_id": "target-1",
            }
        )

    with patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")):
        session, response = asyncio.run(run())

    assert response == {"session_id": "session-1", "target_id": "target-1"}
    assert session.session == "session-1"
    assert session.target_id == "target-1"
    assert session.owned_target_ids == ["old-target", "target-1"]


def test_target_create_claims_without_changing_active_target(tmp_path):
    class NeverDoneTask:
        def done(self):
            return False

    class FakeCDP:
        _message_handler_task = NeverDoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            if method == "Target.createTarget":
                return {"targetId": "new-target"}
            return {}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        session.target_id = "old-target"
        session.owned_target_ids = ["old-target"]
        response = await session.handle(
            {
                "method": "Target.createTarget",
                "params": {"url": "about:blank"},
            }
        )
        return session, response

    with patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")):
        session, response = asyncio.run(run())

    assert response == {"result": {"targetId": "new-target"}}
    assert session.target_id == "old-target"
    assert session.owned_target_ids == ["old-target", "new-target"]


def test_target_close_forgets_active_target_and_session(tmp_path):
    class NeverDoneTask:
        def done(self):
            return False

    class FakeCDP:
        _message_handler_task = NeverDoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            return {"success": True}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        session.session = "session-1"
        broker.session_by_id["session-1"] = session
        session.target_id = "target-1"
        session.owned_target_ids = ["target-1", "target-2"]
        response = await session.handle(
            {
                "method": "Target.closeTarget",
                "params": {"targetId": "target-1"},
            }
        )
        return session, response

    with patch.object(daemon, "session_state_path", return_value=str(tmp_path / "state.json")):
        session, response = asyncio.run(run())

    assert response == {"result": {"success": True}}
    assert session.session is None
    assert session.target_id == "target-2"
    assert session.owned_target_ids == ["target-2"]


def test_daemon_event_tap_does_not_block_cdp_receiver_on_marking():
    calls = []

    class EventRegistry:
        async def handle_event(self, method, params, session_id=None):
            calls.append(("orig", method, session_id))
            return False

    class NeverDoneTask:
        def done(self):
            return False

    class FakeCDP:
        def __init__(self):
            self._event_registry = EventRegistry()
            self._message_handler_task = NeverDoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            calls.append(("send", method, session_id))
            if method == "Runtime.evaluate":
                await asyncio.sleep(60)
            return {}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        session.session = "session-1"
        broker.session_by_id["session-1"] = session
        broker._install_event_tap()
        started = time.monotonic()
        await asyncio.wait_for(
            broker.cdp._event_registry.handle_event("Page.loadEventFired", {}, "session-1"),
            timeout=0.1,
        )
        elapsed = time.monotonic() - started
        if session._mark_task:
            session._mark_task.cancel()
            try:
                await session._mark_task
            except asyncio.CancelledError:
                pass
        return elapsed

    elapsed = asyncio.run(run())

    assert elapsed < 0.1
    assert ("orig", "Page.loadEventFired", "session-1") in calls


def test_daemon_health_reports_dead_receiver_without_sending_cdp():
    calls = []

    class DoneTask:
        def done(self):
            return True

    class FakeCDP:
        _message_handler_task = DoneTask()

        async def send_raw(self, method, params=None, session_id=None):
            calls.append(method)
            return {}

    async def run():
        broker = daemon.BrowserBroker()
        broker.cdp = FakeCDP()
        session = broker.get_session("work")
        return await session.health()

    health = asyncio.run(run())

    assert health["ok"] is False
    assert health["error"]["code"] == "CDP_RECEIVER_STOPPED"
    assert health["error"]["message"] == "CDP receiver task is not running."
    assert calls == []


def test_ensure_daemon_reconnects_stale_daemon_before_restart():
    requests = []

    def fake_daemon_request(req, name=None, timeout=3):
        requests.append((req, name, timeout))
        if req["meta"] == "health":
            return {"ok": False, "error": "WebSocket connection closed"}
        if req["meta"] == "reconnect":
            return {"ok": True, "session_id": "session-2"}
        raise AssertionError(req)

    with (
        patch("opensteer.runtime.daemon_alive", return_value=True),
        patch("opensteer.runtime._daemon_request", side_effect=fake_daemon_request),
        patch("opensteer.runtime.restart_daemon") as restart,
    ):
        runtime.ensure_daemon(name="work")

    restart.assert_not_called()
    assert requests == [
        ({"meta": "health"}, "work", 5),
        (
            {"meta": "reconnect", "reason": "WebSocket connection closed"},
            "work",
            10,
        ),
    ]


def test_ensure_daemon_surfaces_remote_reconnect_error_without_local_restart():
    def fake_daemon_request(req, name=None, timeout=3):
        if req["meta"] == "health":
            return {"ok": False, "error": {"code": "CDP_RECEIVER_STOPPED", "message": "CDP receiver stopped."}}
        if req["meta"] == "reconnect":
            return {
                "error": {
                    "code": "CLOUD_SESSION_CLOSED",
                    "message": "Session is no longer active.",
                    "source": "opensteer-api",
                    "status": 409,
                }
            }
        raise AssertionError(req)

    with (
        patch("opensteer.runtime.daemon_alive", return_value=True),
        patch("opensteer.runtime._daemon_request", side_effect=fake_daemon_request),
        patch("opensteer.runtime.restart_daemon") as restart,
    ):
        try:
            runtime.ensure_daemon(name="work")
        except OpenSteerError as error:
            assert error.code == "CLOUD_SESSION_CLOSED"
            assert error.status == 409
        else:
            raise AssertionError("expected remote reconnect error")

    restart.assert_not_called()
