from contextlib import nullcontext

import pytest

from opensteer import runtime


def _browser_response(label=None):
    return {
        "id": "browser-session-1",
        "sessionId": "browser-session-1",
        "browserRef": "browser-session-1",
        "cdpWsUrl": "ws://127.0.0.1/devtools/browser/1",
        "location": "cloud",
        "status": "active",
        "createdAt": 1,
        "creationMode": "reused_existing",
        "controllerExitBehavior": "detach",
        **({"label": label} if label else {}),
    }


def _install_open_stubs(monkeypatch, responses):
    requests = []
    registrations = []
    relays = []

    def opensteer(_path, _method, body):
        requests.append(dict(body))
        response = responses.pop(0)
        return response

    monkeypatch.setattr(runtime, "_opensteer", opensteer)
    monkeypatch.setattr(runtime, "session_operation_lock", lambda _key: nullcontext())
    monkeypatch.setattr(runtime, "registered_session_by_id", lambda _session_id: None)
    monkeypatch.setattr(
        runtime,
        "ensure_daemon",
        lambda name, env=None: relays.append((name, env)),
    )
    monkeypatch.setattr(
        runtime,
        "register_session",
        lambda name, descriptor, relay_name=None: registrations.append((name, descriptor, relay_name)),
    )
    monkeypatch.setattr(runtime, "_show_live_url", lambda _url: None)
    return requests, registrations, relays


def test_reuse_identity_ignores_optional_label_and_routes_relay_by_session_id(monkeypatch):
    requests, registrations, relays = _install_open_stubs(
        monkeypatch,
        [_browser_response()],
    )

    browser = runtime.open_browser(profile="fresh", location="cloud")

    assert requests == [
        {
            "profileMode": "fresh",
            "sessionMode": "reuse",
            "sessionKey": "primary",
            "location": "cloud",
        }
    ]
    assert registrations[0][0] == "browser-session-1"
    assert registrations[0][2] == "session-browser-session-1"
    assert relays[0][0] == "session-browser-session-1"
    assert browser.name == "browser-session-1"


def test_reuse_label_changes_keep_the_same_platform_identity(monkeypatch):
    requests, _, _ = _install_open_stubs(
        monkeypatch,
        [_browser_response("sales"), _browser_response("outreach")],
    )

    first = runtime.open_browser(label="sales", profile="fresh")
    second = runtime.open_browser(label="outreach", profile="fresh")

    assert [request["sessionKey"] for request in requests] == ["primary", "primary"]
    assert [request["label"] for request in requests] == ["sales", "outreach"]
    assert all("name" not in request for request in requests)
    assert first.session_id == second.session_id == "browser-session-1"


def test_new_mode_uses_distinct_slots_even_when_labels_repeat(monkeypatch):
    requests, _, _ = _install_open_stubs(
        monkeypatch,
        [_browser_response("research"), _browser_response("research")],
    )

    runtime.open_browser(label="research", profile="fresh", mode="new")
    runtime.open_browser(label="research", profile="fresh", mode="new")

    keys = [request["sessionKey"] for request in requests]
    assert all(key.startswith("new-") for key in keys)
    assert keys[0] != keys[1]


def test_explicit_close_destroys_detached_persistent_browser(monkeypatch):
    events = []
    monkeypatch.setattr(runtime, "_close_cloud_session", lambda session_id: events.append(("close", session_id)))
    monkeypatch.setattr(runtime, "stop_remote_daemon", lambda name: events.append(("relay", name)))
    browser = runtime.BrowserHandle(
        {
            "sessionId": "browser-session-1",
            "controllerExitBehavior": "detach",
        },
        "browser-session-1",
    )

    browser.close()

    assert events == [
        ("close", "browser-session-1"),
        ("relay", "browser-session-1"),
    ]


def test_explicit_close_still_detaches_the_relay_when_cloud_close_fails(monkeypatch):
    events = []

    def fail_close(_session_id):
        raise runtime.OpenSteerError("close failed")

    monkeypatch.setattr(runtime, "_close_cloud_session", fail_close)
    monkeypatch.setattr(runtime, "stop_remote_daemon", lambda name: events.append(("relay", name)))
    browser = runtime.BrowserHandle(
        {
            "sessionId": "browser-session-1",
            "controllerExitBehavior": "detach",
        },
        "browser-session-1",
    )

    with pytest.raises(runtime.OpenSteerError, match="close failed"):
        browser.close()

    assert events == [("relay", "browser-session-1")]
