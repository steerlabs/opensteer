import XCTest
@testable import PhoneBrowserCore

final class GeometryFingerprintTests: XCTestCase {
  private func geometry(scrollY: Double = 0, offsetY: Double = 0, height: Double = 700, scale: Double = 1,
    insetBottom: Double = 0) -> [String: Any] {
    ["viewport": ["width": 390.0, "height": height], "nativeViewport": ["width": 390.0, "height": height],
      "scale": scale, "offset": ["x": 0.0, "y": offsetY], "scroll": ["x": 0.0, "y": scrollY], "pixelRatio": 3.0,
      "inset": ["top": 0.0, "left": 0.0, "bottom": insetBottom, "right": 0.0],
      "keyboard": ["x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0]]
  }

  func testScrollingAloneKeepsTheRevisionWhileLayoutChangesAdvanceIt() {
    let resting = GeometryFingerprint.of(geometry())
    XCTAssertEqual(resting, GeometryFingerprint.of(geometry(scrollY: 1200)))
    // WebKit's visual viewport slides by a few points while a page scrolls and bounces.
    XCTAssertEqual(resting, GeometryFingerprint.of(geometry(scrollY: -40, offsetY: -7)))
    XCTAssertNotEqual(resting, GeometryFingerprint.of(geometry(height: 640)))
    XCTAssertNotEqual(resting, GeometryFingerprint.of(geometry(scale: 2)))
    XCTAssertNotEqual(resting, GeometryFingerprint.of(geometry(insetBottom: 90)))
  }
}
