import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore

@MainActor
final class OverlayOrderingTests: XCTestCase {
  func testAPanelIsOrderedOnlyWhenItHasTo() {
    let window = TrackedWindow(
      id: 7, frame: CGRect(x: 0, y: 0, width: 100, height: 100), level: 0, onScreen: true)
    let placed = WindowOverlayPanel.Placement(window: 7, level: 0)
    func needs(
      _ placement: WindowOverlayPanel.Placement?, _ ordering: WindowOrdering,
      visible: Bool = true, above: Bool = true
    ) -> Bool {
      WindowOverlayPanel.needsOrdering(
        placement, window: window, ordering: ordering, isVisible: visible
      ) { above }
    }
    XCTAssertFalse(needs(placed, .ifChanged))
    XCTAssertFalse(needs(placed, .verify))
    XCTAssertTrue(needs(placed, .verify, above: false), "Its window was raised over it.")
    XCTAssertTrue(needs(placed, .always))
    XCTAssertTrue(needs(nil, .ifChanged), "Never ordered, or ordered out since.")
    XCTAssertTrue(needs(placed, .ifChanged, visible: false))
    XCTAssertTrue(needs(WindowOverlayPanel.Placement(window: 8, level: 0), .ifChanged))
    XCTAssertTrue(needs(WindowOverlayPanel.Placement(window: 7, level: 3), .ifChanged))
  }

  func testDirectlyAboveAllowsOnlyTheHelpersOwnPanelsBetween() {
    let own: Set<CGWindowID> = [50, 51]
    func above(_ stack: [CGWindowID]) -> Bool {
      WindowSnapshot.isDirectlyAbove(panel: 50, window: 10, frontToBack: stack, own: own)
    }
    XCTAssertTrue(above([1, 50, 10, 2]))
    XCTAssertTrue(above([50, 51, 10]), "The outline between the pointer and its window.")
    XCTAssertFalse(above([50, 10, 2].reversed()), "The window was raised over it.")
    XCTAssertFalse(above([50, 3, 10]), "Another window came between them.")
    XCTAssertFalse(above([50, 2]), "The window is not on screen.")
  }

  func testAPlacementReadsTheStackingOnlyWhenItVerifies() {
    var reads = 0
    let snapshot = WindowSnapshot(
      windows: [],
      stacking: {
        reads += 1
        return []
      }, own: { [] })
    XCTAssertEqual(reads, 0)
    _ = snapshot.isDirectlyAbove(panel: 1, window: 2)
    _ = snapshot.isDirectlyAbove(panel: 3, window: 2)
    XCTAssertEqual(reads, 1, "Read once and shared by every panel.")
  }

  func testTheBreathAsksForALowFrameRate() {
    for animation in Breath.animations() + Breath.animations(opacity: (0.35, 0.9), scale: nil) {
      XCTAssertLessThanOrEqual(animation.preferredFrameRateRange.maximum, 15)
      XCTAssertGreaterThan(animation.preferredFrameRateRange.minimum, 0)
    }
  }
}
