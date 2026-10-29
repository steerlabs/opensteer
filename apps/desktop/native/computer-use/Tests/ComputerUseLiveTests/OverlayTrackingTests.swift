import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore

/// The overlay's cost over a whole session, and what it leaves behind: the
/// window tracker places each frame once and orders a panel only when it has
/// to, the slow breath asks for a low frame rate, and nothing a session drew
/// outlives it or lands after something newer.
///
/// The pointer tests order a real panel over a made-up window placed far off
/// every display, so nothing is visible and nothing is captured.
@MainActor
final class OverlayTrackingTests: XCTestCase {
  override func setUp() async throws {
    _ = NSApplication.shared
  }

  // MARK: - Ordering

  // MARK: - Breath

  // MARK: - Pointer

  private let offscreen = TrackedWindow(
    id: 999_991, frame: CGRect(x: -40_000, y: -40_000, width: 400, height: 300), level: 0,
    onScreen: true)

  private var snapshot: WindowSnapshot {
    WindowSnapshot(windows: [offscreen], stacking: { [] }, own: { [] })
  }

  private func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: offscreen.frame.minX + x, y: offscreen.frame.minY + y)
  }

  private func shown(at start: CGPoint) -> AgentCursor {
    let cursor = AgentCursor()
    _ = cursor.move(
      OverlayModel.PointerMove(kind: .appear, from: nil, to: start, duration: 0),
      window: offscreen.id, keyWindow: offscreen.id, in: snapshot)
    XCTAssertTrue(cursor.isDrawn)
    return cursor
  }

  private func wait(_ seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  func testACrossfadeReleasedAndReclaimedDoesNotLandOnItsOldDestination() async throws {
    let cursor = shown(at: point(10, 10))
    defer { cursor.hide() }
    _ = cursor.move(
      OverlayModel.PointerMove(
        kind: .crossfade, from: point(10, 10), to: point(200, 200), duration: 0),
      window: offscreen.id, keyWindow: offscreen.id, in: snapshot)
    cursor.hide()
    _ = cursor.move(
      OverlayModel.PointerMove(kind: .appear, from: nil, to: point(50, 60), duration: 0),
      window: offscreen.id, keyWindow: offscreen.id, in: snapshot)
    try await wait(OverlayModel.crossfadeDuration + 0.1)
    XCTAssertEqual(cursor.tip, point(50, 60))
  }

  func testAMoveSupersedesACrossfadeOnItsWay() async throws {
    let cursor = shown(at: point(10, 10))
    defer { cursor.hide() }
    _ = cursor.move(
      OverlayModel.PointerMove(
        kind: .crossfade, from: point(10, 10), to: point(200, 200), duration: 0),
      window: offscreen.id, keyWindow: offscreen.id, in: snapshot)
    _ = cursor.move(
      OverlayModel.PointerMove(kind: .crossfade, from: nil, to: point(80, 90), duration: 0),
      window: offscreen.id, keyWindow: offscreen.id, in: snapshot)
    try await wait(OverlayModel.crossfadeDuration + 0.1)
    XCTAssertEqual(cursor.tip, point(80, 90))
  }

  func testARippleDoesNotOutliveTheSession() {
    let cursor = shown(at: point(10, 10))
    cursor.click()
    XCTAssertEqual(cursor.liveRippleCount, 1)
    cursor.hide()
    XCTAssertEqual(cursor.liveRippleCount, 0)
  }

  func testAReduceMotionChangeReappliesTheBreath() throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    let cursor = shown(at: point(10, 10))
    defer { cursor.hide() }
    cursor.setActivity(.thinking)
    XCTAssertTrue(cursor.view.glow.animationKeys()?.contains("breathe.opacity") == true)
    cursor.view.glow.removeAllAnimations()
    cursor.motionChanged()
    XCTAssertTrue(cursor.view.glow.animationKeys()?.contains("breathe.opacity") == true)

  }
}
