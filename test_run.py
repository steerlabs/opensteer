import sys
import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import opensteer.run as run
import opensteer.runtime as runtime


def test_c_flag_executes_code():
    stdout = StringIO()
    with (
        patch.object(sys, "argv", ["opensteer", "-c", "print('hello from -c')"]),
        patch("opensteer.run.ensure_daemon"),
        patch("sys.stdout", stdout),
    ):
        assert run.main() == 0
    assert stdout.getvalue().strip() == "hello from -c"


def test_c_flag_does_not_read_stdin():
    stdin_read = []
    fake_stdin = StringIO("should not be read")
    fake_stdin.read = lambda: stdin_read.append(True) or ""

    with (
        patch.object(sys, "argv", ["opensteer", "-c", "x = 1"]),
        patch("opensteer.run.ensure_daemon"),
        patch("sys.stdin", fake_stdin),
    ):
        assert run.main() == 0

    assert not stdin_read, "stdin should not be read when -c is passed"


def test_c_flag_renders_opensteer_errors_without_traceback():
    stderr = StringIO()
    code = (
        "from opensteer.errors import OpenSteerError; "
        "raise OpenSteerError('Session is no longer active.', code='CLOUD_SESSION_CLOSED', status=409, "
        "source='opensteer-api')"
    )

    with (
        patch.object(sys, "argv", ["opensteer", "-c", code]),
        patch("sys.stderr", stderr),
    ):
        assert run.main() == 1

    assert stderr.getvalue().strip() == (
        "OpenSteer API 409 CLOUD_SESSION_CLOSED: Session is no longer active."
    )


def test_c_flag_preserves_user_code_tracebacks():
    with patch.object(sys, "argv", ["opensteer", "-c", "1 / 0"]):
        try:
            run.main()
        except ZeroDivisionError:
            pass
        else:
            raise AssertionError("expected user code exception to propagate")


def test_c_flag_does_not_eagerly_start_default_daemon_for_admin_snippets():
    with (
        patch.object(sys, "argv", ["opensteer", "-c", "start_remote_daemon('work')"]),
        patch("opensteer.run.ensure_daemon") as ensure_daemon,
        patch("opensteer.run.start_remote_daemon") as start_remote,
    ):
        assert run.main() == 0

    ensure_daemon.assert_not_called()
    start_remote.assert_called_once_with("work")


def test_c_flag_uses_harness_local_helpers_module():
    stdout = StringIO()
    with tempfile.TemporaryDirectory() as d:
        actions = Path(d) / "actions"
        actions.mkdir()
        (actions / "helpers.py").write_text("MARKER = 'local'\n")
        code = f"import sys; sys.path.insert(0, {str(actions)!r}); from helpers import MARKER; print(MARKER)"

        with patch.object(sys, "argv", ["opensteer", "-c", code]), patch("sys.stdout", stdout):
            assert run.main() == 0

    assert stdout.getvalue().strip() == "local"


def test_skills_install_command():
    with (
        patch.object(sys, "argv", ["opensteer", "skills", "install"]),
        patch("opensteer.run.install_skills") as install,
    ):
        assert run.main() == 0

    install.assert_called_once_with()


def test_doctor_accepts_cloud_auto_remote_environment():
    stdout = StringIO()
    with (
        patch.dict("os.environ", {"OPENSTEER_AUTO_REMOTE": "1", "OPENSTEER_API_KEY": "osk_test"}, clear=False),
        patch.object(runtime, "_chrome_running", return_value=False),
        patch.object(runtime, "daemon_alive", return_value=False),
        patch("sys.stdout", stdout),
    ):
        assert runtime.run_doctor() == 0

    output = stdout.getvalue()
    assert "cloud auto remote" in output
