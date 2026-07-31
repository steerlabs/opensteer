"""Opensteer browser-control runtime."""

__all__ = [
    "BrowserHandle",
    "__version__",
    "list_browsers",
    "open_browser",
    "use_browser",
]

try:
    from importlib.metadata import PackageNotFoundError, version

    try:
        __version__ = version("opensteer")
    except PackageNotFoundError:
        __version__ = "0.0.0"
except Exception:
    __version__ = "0.0.0"

from .runtime import BrowserHandle, list_browsers, open_browser, use_browser  # noqa: E402
