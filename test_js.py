from unittest.mock import patch

import opensteer.helpers as helpers
from opensteer.errors import OpenSteerError


def _capture_cdp():
    captured = []

    def fake_cdp(method, **kwargs):
        captured.append((method, kwargs))
        return {"result": {"value": None}}

    return fake_cdp, captured


def _evaluated_expression(captured):
    return next(kw["expression"] for m, kw in captured if m == "Runtime.evaluate")


def test_simple_expression_passes_through():
    fake_cdp, captured = _capture_cdp()
    with patch("opensteer.helpers.cdp", side_effect=fake_cdp):
        helpers.js("document.title")
    assert _evaluated_expression(captured) == "document.title"


def test_return_statement_gets_wrapped():
    fake_cdp, captured = _capture_cdp()
    with patch("opensteer.helpers.cdp", side_effect=fake_cdp):
        helpers.js("const x = 1; return x")
    assert _evaluated_expression(captured) == "(function(){const x = 1; return x})()"


def test_iife_with_internal_return_is_not_double_wrapped():
    fake_cdp, captured = _capture_cdp()
    with patch("opensteer.helpers.cdp", side_effect=fake_cdp):
        helpers.js("(function(){ return document.title; })()")
    assert _evaluated_expression(captured) == "(function(){ return document.title; })()"


def test_target_expression_detaches_after_evaluation():
    captured = []

    def fake_cdp(method, **kwargs):
        captured.append((method, kwargs))
        if method == "Target.attachToTarget":
            return {"sessionId": "session-1"}
        return {"result": {"value": "ok"}}

    with patch("opensteer.helpers.cdp", side_effect=fake_cdp):
        assert helpers.js("document.title", target_id="iframe-1") == "ok"

    assert captured == [
        ("Target.attachToTarget", {"targetId": "iframe-1", "flatten": True}),
        (
            "Runtime.evaluate",
            {
                "session_id": "session-1",
                "expression": "document.title",
                "returnByValue": True,
                "awaitPromise": True,
            },
        ),
        ("Target.detachFromTarget", {"sessionId": "session-1"}),
    ]


def test_cdp_lazily_starts_daemon_when_socket_is_missing():
    class FakeSocket:
        def __init__(self):
            self.sent = b""
            self.closed = False

        def sendall(self, data):
            self.sent += data

        def recv(self, size):
            return b'{"result": {"ok": true}}\n'

        def close(self):
            self.closed = True

    fake_socket = FakeSocket()
    with (
        patch("opensteer.helpers._connect", side_effect=[FileNotFoundError, fake_socket]),
        patch("opensteer.runtime.ensure_daemon") as ensure_daemon,
    ):
        assert helpers.cdp("Runtime.evaluate", expression="1") == {"ok": True}

    ensure_daemon.assert_called_once_with()
    assert fake_socket.closed


def test_cdp_surfaces_structured_daemon_error():
    class FakeSocket:
        def __init__(self):
            self.closed = False

        def sendall(self, data):
            pass

        def recv(self, size):
            return (
                b'{"error":{"code":"LOCAL_CDP_NOT_ENABLED",'
                b'"message":"Chrome remote debugging is not enabled for a local browser.",'
                b'"source":"local-browser"}}\n'
            )

        def close(self):
            self.closed = True

    fake_socket = FakeSocket()
    with patch("opensteer.helpers._connect", return_value=fake_socket):
        try:
            helpers.cdp("Runtime.evaluate", expression="1")
        except OpenSteerError as error:
            assert error.code == "LOCAL_CDP_NOT_ENABLED"
            assert "Run `opensteer --setup`" in str(error)
        else:
            raise AssertionError("expected structured OpenSteerError")

    assert fake_socket.closed
