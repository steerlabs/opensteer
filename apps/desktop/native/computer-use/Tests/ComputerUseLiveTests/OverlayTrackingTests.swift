import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore

/// A real chip panel on its window: it hides the moment the window moves and
/// returns once it settles, leaves with its session, takes a press only as
/// the press began, and keeps breathing through a Reduce Motion change.
///
/// The chip is ordered over a made-up window placed far off every display,
/// with a made-up screen around it, so nothing is visible and nothing is
/// captured.
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
    app: OverlayModel.App(key: "com.apple.safari", name: "Safari"), look: .agent(.working))

  private func chip(_ look: OverlayModel.Chip.Look? = nil) -> WindowChip {
    let chip = WindowChip()
    chip.usableAreas = { [CGRect(x: -41_000, y: -41_000, width: 3_000, height: 3_000)] }
    chip.mouseButtonsDown = { false }
    chip.show(
      look.map { OverlayModel.Chip(app: agent.app, look: $0) } ?? agent, on: offscreen.id,
      in: snapshot(offscreen))
    return chip
  }

  private func wait(_ seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  private func click(_ chip: WindowChip) {
    chip.view.onMouse?(.down, true)
    chip.view.onMouse?(.up, true)
  }

  func testTheChipHidesWhileItsWindowMovesAndReturnsAtTheNewPlace() {
    var time: CFTimeInterval = 100
    let chip = chip()
    defer { chip.hide() }
    chip.now = { time }
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
    XCTAssertEqual(chip.frame.midX, moved.frame.midX, accuracy: 0.5)
    XCTAssertEqual(chip.frame.size, CGSize(width: 28, height: 22), "The panel is exactly the chip.")
  }

  func testAWindowOutOfSightTakesTheChipAndAReleaseRemovesIt() {
    let chip = chip()
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

  func testAPressThatBeginsAsTheChipAppearsOnlyOpensIt() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    var actions: [ChipAction] = []
    let chip = chip()
    defer { chip.hide() }
    chip.onAction = { actions.append($0) }
    let rest = chip.frame.width
    chip.view.onMouse?(.down, true)
    chip.view.onHover?(true)
    try await wait(OverlayStyle.expandDuration + 0.1)
    chip.view.onMouse?(.up, true)
    XCTAssertEqual(actions, [], "Stop showed during the press, but the press began before it.")
    XCTAssertGreaterThan(chip.frame.width, rest)
  }

  func testACleanClickOnTheShownStopStopsOnceAndADoubleClickToo() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    var actions: [ChipAction] = []
    let chip = chip()
    defer { chip.hide() }
    chip.onAction = { actions.append($0) }
    chip.view.onHover?(true)
    try await wait(OverlayStyle.expandDuration + 0.1)
    click(chip)
    XCTAssertEqual(actions, [.stop], "At once: no arming delay.")
    click(chip)
    XCTAssertEqual(actions, [.stop], "A double click stops once.")
  }

  func testADragThatEndsInsideStopsNothing() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    var actions: [ChipAction] = []
    let chip = chip()
    defer { chip.hide() }
    chip.onAction = { actions.append($0) }
    chip.view.onHover?(true)
    try await wait(OverlayStyle.expandDuration + 0.1)
    chip.view.onMouse?(.down, true)
    chip.view.onMouse?(.dragged, false)
    chip.view.onMouse?(.dragged, true)
    chip.view.onMouse?(.up, true)
    XCTAssertEqual(actions, [])
  }

  func testAPressTheChipLosesBeforeItsReleaseStopsNothing() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    var actions: [ChipAction] = []
    var time: CFTimeInterval = 100
    let chip = chip()
    defer { chip.hide() }
    chip.now = { time }
    chip.onAction = { actions.append($0) }
    chip.view.onHover?(true)
    try await wait(OverlayStyle.expandDuration + 0.1)
    chip.view.onMouse?(.down, true)
    let moved = TrackedWindow(
      id: offscreen.id, frame: offscreen.frame.offsetBy(dx: 10, dy: 0), level: 0, onScreen: true)
    time += 0.016
    chip.place(in: snapshot(moved), .ifChanged)
    chip.view.onMouse?(.up, true)
    XCTAssertEqual(actions, [], "The window moved and the chip went mid-press.")
  }

  func testOneClickDismissesTheNotice() {
    var actions: [ChipAction] = []
    let chip = chip(.connectionLost)
    defer { chip.hide() }
    chip.onAction = { actions.append($0) }
    click(chip)
    click(chip)
    XCTAssertEqual(actions, [.dismiss], "At rest, once.")
  }

  func testTheNotchOpensOnlyAfterThePointerRestsOnIt() async throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    let chip = WindowChip()
    defer { chip.hide() }
    // The window's top sits under the made-up screen's menu bar: a notch.
    let top = offscreen.frame.minY
    chip.usableAreas = { [CGRect(x: -41_000, y: top, width: 3_000, height: 3_000)] }
    chip.show(agent, on: offscreen.id, in: snapshot(offscreen))
    XCTAssertEqual(chip.view.placement, .notch)
    let rest = chip.frame
    chip.view.onHover?(true)
    try await wait(0.1)
    chip.view.onHover?(false)
    try await wait(OverlayStyle.notchDwell + OverlayStyle.expandDuration)
    XCTAssertEqual(chip.frame, rest, "Passing over it opens nothing.")
    chip.view.onHover?(true)
    try await wait(OverlayStyle.notchDwell + OverlayStyle.expandDuration + 0.1)
    XCTAssertEqual(chip.frame.height, OverlayStyle.notchOpenHeight)
    XCTAssertEqual(chip.frame.maxY, rest.maxY, "It grows down from the edge it hangs on.")
  }

  func testAReduceMotionChangeReappliesTheBreath() throws {
    try XCTSkipIf(OverlayMotion.reduced, "This Mac has Reduce Motion on.")
    let chip = chip()
    defer { chip.hide() }
    XCTAssertNotNil(chip.view.dot.animation(forKey: "breath"))
    chip.view.dot.removeAllAnimations()
    chip.motionChanged()
    XCTAssertNotNil(chip.view.dot.animation(forKey: "breath"))
  }
}
