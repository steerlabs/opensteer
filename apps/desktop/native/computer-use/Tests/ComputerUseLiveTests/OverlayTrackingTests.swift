import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore

/// A real chip panel on its window: it hides the moment the window moves and
/// returns once it settles, leaves with its session, opens before its `Stop`
/// counts, and keeps breathing through a Reduce Motion change.
///
/// The chip is ordered over a made-up window placed far off every display, so
/// nothing is visible and nothing is captured.
@MainActor
final class OverlayTrackingTests: XCTestCase {
  override func setUp() async throws {
    _ = NSApplication.shared
  }

  private let offscreen = TrackedWindow(
    id: 999_991, frame: CGRect(x: -40_000, y: -40_000, width: 400, height: 300), level: 0,
    onScreen: true)

  private func snapshot(_ window: TrackedWindow) -> WindowSnapshot {
    WindowSnapshot(windows: [window], stacking: { [] }, own: { [] })
  }

  private let agent = OverlayModel.Chip(
    app: OverlayModel.App(key: "com.apple.safari", name: "Safari"),
    look: .agents(dots: [.working], more: 0))

  private func wait(_ seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  func testTheChipHidesWhileItsWindowMovesAndReturnsAtTheNewPlace() {
    let chip = WindowChip()
    defer { chip.hide() }
    var time: CFTimeInterval = 100
    chip.now = { time }
    chip.mouseButtonsDown = { false }
    chip.show(agent, on: offscreen.id, in: snapshot(offscreen))
    XCTAssertTrue(chip.isShowing)
    let moved = TrackedWindow(
      id: offscreen.id, frame: offscreen.frame.offsetBy(dx: 120, dy: 40), level: 0, onScreen: true)
    time += 0.016
    XCTAssertTrue(chip.place(in: snapshot(moved), .ifChanged))
    XCTAssertFalse(chip.isShowing, "Gone the moment the window moves.")
    XCTAssertTrue(chip.isDrawn, "Its window's events are still followed.")
    time += 0.05
    chip.place(in: snapshot(moved), .ifChanged)
    XCTAssertFalse(chip.isShowing)
    time += OverlayStyle.settleDelay
    chip.place(in: snapshot(moved), .ifChanged)
    XCTAssertTrue(chip.isShowing)
    XCTAssertEqual(chip.placedFor, moved.frame)
    let panel = OverlayGeometry.appKitRect(
      fromCoreGraphics: chip.frame, primaryHeight: ScreenGeometry.primaryHeight)
    XCTAssertEqual(panel.midX, moved.frame.midX, accuracy: 0.5)
  }

  func testAWindowOutOfSightTakesTheChipAndAReleaseRemovesIt() {
    let chip = WindowChip()
    chip.show(agent, on: offscreen.id, in: snapshot(offscreen))
    let hidden = TrackedWindow(id: offscreen.id, frame: offscreen.frame, level: 0, onScreen: false)
    chip.place(in: snapshot(hidden), .ifChanged)
    XCTAssertFalse(chip.isShowing)
    XCTAssertFalse(chip.isDrawn)
    chip.place(in: snapshot(offscreen), .ifChanged)
    XCTAssertTrue(chip.isShowing, "Back at once when its window is.")
    chip.hide()
    XCTAssertFalse(chip.isShowing)
    XCTAssertNil(chip.trackedWindowID)
  }

  func testAClickOpensTheChipAndOnlyAnOpenArmedStopStops() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    let chip = WindowChip()
    defer { chip.hide() }
    var stops = 0
    chip.onAction = { stops += 1 }
    chip.show(agent, on: offscreen.id, in: snapshot(offscreen))
    let rest = chip.frame.width
    chip.view.onClick?()
    XCTAssertEqual(stops, 0, "A click on the closed chip only opens it.")
    try await wait(OverlayStyle.expandDuration + 0.1)
    XCTAssertGreaterThan(chip.frame.width, rest)
    chip.view.onClick?()
    XCTAssertEqual(stops, 0, "Not yet armed.")
    try await wait(OverlayStyle.stopArmDelay)
    chip.view.onClick?()
    XCTAssertEqual(stops, 1)
    chip.view.onHover?(false)
    try await wait(OverlayStyle.expandDuration + 0.1)
    XCTAssertEqual(chip.frame.width, rest)
  }

  func testAReduceMotionChangeReappliesTheBreath() throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    let chip = WindowChip()
    defer { chip.hide() }
    chip.show(agent, on: offscreen.id, in: snapshot(offscreen))
    XCTAssertNotNil(chip.view.dots.first?.animation(forKey: "breath"))
    chip.view.dots.first?.removeAllAnimations()
    chip.motionChanged()
    XCTAssertNotNil(chip.view.dots.first?.animation(forKey: "breath"))
  }
}
