import AppKit
import XCTest

@testable import ComputerUseCore

@MainActor
final class AgentCursorOrientationTests: XCTestCase {
  func testHostedCursorKeepsTopLeftGeometryAfterAppKitLayout() {
    _ = NSApplication.shared
    let view = AgentCursorView()
    let window = NSWindow(
      contentRect: view.bounds, styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    defer { window.close() }

    let target = CGPoint(x: 200, y: 200)
    let primaryHeight = ScreenGeometry.primaryHeight
    window.setFrame(
      OverlayGeometry.pointerPanelFrame(tip: target, primaryHeight: primaryHeight),
      display: false)

    // A hosted layer can initially keep its explicit flip, then AppKit resets
    // it to match NSView.isFlipped when the window displays its content.
    window.displayIfNeeded()

    XCTAssertTrue(view.isFlipped)
    XCTAssertTrue(view.root.isGeometryFlipped)

    let tip = OverlayStyle.pointerTip
    func screenPoint(_ local: CGPoint) -> CGPoint {
      let appKit = window.convertPoint(toScreen: view.convert(local, to: nil))
      return CGPoint(x: appKit.x, y: primaryHeight - appKit.y)
    }
    let actualTip = screenPoint(tip)
    XCTAssertEqual(actualTip.x, target.x, accuracy: 0.01)
    XCTAssertEqual(actualTip.y, target.y, accuracy: 0.01)

    let arrowBox = view.arrow.shadowPath?.boundingBoxOfPath
    XCTAssertNotNil(arrowBox)
    if let arrowBox {
      XCTAssertEqual(arrowBox.minX, tip.x, accuracy: 2)
      XCTAssertEqual(arrowBox.minY, tip.y, accuracy: 2)
      XCTAssertGreaterThan(arrowBox.maxY, tip.y + 10)
      XCTAssertGreaterThan(screenPoint(CGPoint(x: arrowBox.midX, y: arrowBox.maxY)).y, target.y)
    }
  }
}
