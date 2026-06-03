import base64
from io import BytesIO
import tempfile
from unittest.mock import patch

from PIL import Image

from opensteer import helpers
from opensteer.errors import OpenSteerError


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


def test_upload_file_stages_paths_before_setting_input_files():
    cdp_calls = []

    def fake_cdp(method, **params):
        cdp_calls.append((method, params))
        if method == "DOM.getDocument":
            return {"root": {"nodeId": 1}}
        if method == "DOM.querySelector":
            return {"nodeId": 2}
        return {}

    def fake_send(req):
        assert req == {"meta": "stage_upload", "path": "/workspace/report.csv"}
        return {"path": "/tmp/opensteer-browser-uploads/session/upl/report.csv"}

    with patch("opensteer.helpers.cdp", side_effect=fake_cdp), patch(
        "opensteer.helpers._send", side_effect=fake_send
    ):
        helpers.upload_file("input[type=file]", "/workspace/report.csv")

    assert cdp_calls[-1] == (
        "DOM.setFileInputFiles",
        {
            "files": ["/tmp/opensteer-browser-uploads/session/upl/report.csv"],
            "nodeId": 2,
        },
    )


def test_upload_file_falls_back_to_original_path_for_old_local_daemons():
    cdp_calls = []

    def fake_cdp(method, **params):
        cdp_calls.append((method, params))
        if method == "DOM.getDocument":
            return {"root": {"nodeId": 1}}
        if method == "DOM.querySelector":
            return {"nodeId": 2}
        return {}

    def fake_send(_req):
        raise OpenSteerError("'method'", code="OPENSTEER_ERROR", source="daemon")

    with patch("opensteer.helpers.cdp", side_effect=fake_cdp), patch(
        "opensteer.helpers._send", side_effect=fake_send
    ):
        helpers.upload_file("input[type=file]", "/workspace/report.csv")

    assert cdp_calls[-1] == (
        "DOM.setFileInputFiles",
        {
            "files": ["/workspace/report.csv"],
            "nodeId": 2,
        },
    )


def test_upload_file_propagates_staging_failures():
    def fake_cdp(method, **_params):
        if method == "DOM.getDocument":
            return {"root": {"nodeId": 1}}
        if method == "DOM.querySelector":
            return {"nodeId": 2}
        return {}

    def fake_send(_req):
        raise OpenSteerError("No such file", code="OPENSTEER_ERROR", source="daemon")

    with patch("opensteer.helpers.cdp", side_effect=fake_cdp), patch(
        "opensteer.helpers._send", side_effect=fake_send
    ):
        try:
            helpers.upload_file("input[type=file]", "/workspace/missing.csv")
        except OpenSteerError as error:
            assert error.message == "No such file"
        else:
            raise AssertionError("expected staging failure")
