import base64
from io import BytesIO
import tempfile
from unittest.mock import patch

from PIL import Image

from opensteer import helpers


def _png(width, height):
    data = BytesIO()
    Image.new("RGB", (width, height), "white").save(data, format="PNG")
    return base64.b64encode(data.getvalue()).decode()


def _screenshot_size(width, height, **kwargs):
    def fake(method, **_):
        return {"data": _png(width, height)}

    with patch("opensteer.helpers.cdp", side_effect=fake), tempfile.TemporaryDirectory() as d:
        path = f"{d}/shot.png"
        helpers.capture_screenshot(path, **kwargs)
        return Image.open(path).size


def test_capture_screenshot_max_dim_downsizes_oversized_image():
    assert max(_screenshot_size(4592, 2286, max_dim=1800)) == 1800


def test_capture_screenshot_max_dim_skips_small_image():
    assert _screenshot_size(800, 400, max_dim=1800) == (800, 400)


def test_capture_screenshot_default_does_not_resize():
    assert _screenshot_size(4592, 2286) == (4592, 2286)
