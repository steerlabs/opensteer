import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.error
from io import BytesIO
from unittest.mock import patch

import opensteer.runtime as runtime
import opensteer.daemon as daemon
import opensteer.paths as paths
from opensteer.errors import OpenSteerError


def test_get_name_uses_only_opensteer_name():
    assert paths.get_name({"OPENSTEER_NAME": "linkedin"}) == "linkedin"
    assert paths.get_name({}) == "default"


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
        patch.dict(os.environ, {runtime.OPENSTEER_CLOUD_PROFILE_ID: ""}, clear=False),
        patch("opensteer.runtime.daemon_alive", return_value=False),
        patch("opensteer.runtime._opensteer", side_effect=fake_opensteer),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
        patch("opensteer.runtime._show_live_url") as show_live_url,
    ):
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
    show_live_url.assert_called_once_with("https://cloud.test/browsers/session-1")


def test_start_remote_daemon_uses_default_cloud_profile_id_env():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
        }

    with (
        patch.dict(os.environ, {runtime.OPENSTEER_CLOUD_PROFILE_ID: " bp_default "}, clear=False),
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
                "profileId": "bp_default",
                "name": "work",
            },
        )
    ]


def test_start_remote_daemon_explicit_profile_id_overrides_default_env():
    calls = []

    def fake_opensteer(path, method, body=None):
        calls.append((path, method, body))
        return {
            "id": "session-1",
            "cdpWsUrl": "wss://runtime.test/ws/cdp/session-1?token=secret",
        }

    with (
        patch.dict(os.environ, {runtime.OPENSTEER_CLOUD_PROFILE_ID: "bp_default"}, clear=False),
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
        patch.dict(os.environ, {runtime.OPENSTEER_CLOUD_PROFILE_ID: ""}, clear=False),
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


def test_ensure_daemon_sets_opensteer_name_for_child():
    popen_calls = []

    class FakeProcess:
        def poll(self):
            return None

    def fake_popen(*args, **kwargs):
        popen_calls.append((args, kwargs))
        return FakeProcess()

    with (
        patch("opensteer.runtime.daemon_alive", side_effect=[False, True]),
        patch("subprocess.Popen", side_effect=fake_popen),
    ):
        runtime.ensure_daemon(name="work")

    env = popen_calls[0][1]["env"]
    assert env["OPENSTEER_NAME"] == "work"
    assert popen_calls[0][0][0][:3] == [sys.executable, "-m", "opensteer.daemon"]


def test_ensure_daemon_auto_starts_remote_browser_when_configured():
    with (
        patch.dict(os.environ, {"OPENSTEER_AUTO_REMOTE": "1", "OPENSTEER_API_KEY": "osk_test"}, clear=False),
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


def test_session_falls_back_when_saved_target_is_gone(tmp_path):
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
                        {"targetId": "target-1", "type": "page", "url": "https://fallback.test"},
                    ]
                }
            if method == "Target.attachToTarget":
                return {"sessionId": "fallback-session"}
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

    assert session.target_id == "target-1"
    assert session.session == "fallback-session"
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) in calls


def test_broker_keeps_second_name_off_first_names_owned_tab(tmp_path):
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

    assert first.target_id == "target-1"
    assert second.target_id == "created-1"
    assert created == ["created-1"]
    assert (
        "Target.attachToTarget",
        {"targetId": "target-1", "flatten": True},
        None,
    ) in calls
    assert (
        "Target.attachToTarget",
        {"targetId": "created-1", "flatten": True},
        None,
    ) in calls


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

    assert first.target_id == "target-1"
    assert second.target_id == "created-1"
    assert created == ["created-1"]


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
