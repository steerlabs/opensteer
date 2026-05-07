import sys

from . import runtime as _runtime
from .errors import OpenSteerError
from .helpers import *  # noqa: F401,F403 - exported into `opensteer -c` snippets.
from .skill_installer import install_skills

_version = _runtime._version
daemon_alive = _runtime.daemon_alive
ensure_daemon = _runtime.ensure_daemon
list_cloud_profiles = _runtime.list_cloud_profiles
restart_daemon = _runtime.restart_daemon
run_doctor = _runtime.run_doctor
run_setup = _runtime.run_setup
start_remote_daemon = _runtime.start_remote_daemon
stop_remote_daemon = _runtime.stop_remote_daemon


HELP = """Opensteer

Global browser control via Chrome DevTools Protocol.

Usage:
  opensteer -c "print(page_info())"
  opensteer --setup
  opensteer --doctor
  opensteer skills install

Python snippets run with browser helpers pre-imported. The daemon starts on demand.
"""


def _run_skills(args):
    if args == ["install"]:
        install_skills()
        return 0
    raise SystemExit("Usage: opensteer skills install")


def main():
    args = sys.argv[1:]
    if args and args[0] in {"-h", "--help"}:
        print(HELP)
        return 0
    if args and args[0] == "--version":
        print(_version() or "unknown")
        return 0
    if args and args[0] == "--doctor":
        return run_doctor()
    if args and args[0] == "--setup":
        return run_setup()
    if args and args[0] == "skills":
        return _run_skills(args[1:])
    if not args or args[0] != "-c" or len(args) < 2:
        raise SystemExit('Usage: opensteer -c "print(page_info())"')
    try:
        exec(args[1], globals())
    except OpenSteerError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
