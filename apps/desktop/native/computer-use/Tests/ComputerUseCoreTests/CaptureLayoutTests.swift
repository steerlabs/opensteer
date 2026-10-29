import CoreGraphics
import XCTest
@testable import ComputerUseCore

final class CaptureLayoutTests: XCTestCase {
  private func member(_ id: CGWindowID = 10, x: CGFloat = 20, y: CGFloat = 30,
                      width: CGFloat = 200, height: CGFloat = 100, layer: Int = 0,
                      visible: Bool = true, alpha: Double = 1) -> AppWindows.Entry {
    AppWindows.Entry(window: ObservedWindow(windowID: id,
      frame: CGRect(x: x, y: y, width: width, height: height)),
      layer: layer, onScreen: visible, alpha: alpha)
  }

  private func group(members: [AppWindows.Entry]? = nil,
                     root: WindowIdentity = WindowIdentity(windowID: 10, title: "Root",
                       frame: CGRect(x: 20, y: 30, width: 200, height: 100)),
                     crop: CGRect = CGRect(x: 20, y: 30, width: 200, height: 100),
                     display: CGDirectDisplayID? = 1, scale: CGFloat = 2,
                     alone: Bool = false, focus: CGWindowID? = 10,
                     lifecycle: UInt64 = 1, title: String = "Before",
                     unrelated: [AppWindows.Entry] = []) -> WindowGroup {
    let entries = members ?? [member()]
    return WindowGroup(revision: lifecycle,
      root: WindowIdentity(windowID: root.windowID, title: title, frame: root.frame),
      members: entries, crop: crop, displayID: display, nativeScale: scale,
      alone: alone, blockedBy: [],
      signature: WindowGroup.Signature(associated: entries.map(\.window.windowID),
        windows: entries + unrelated, modalIDs: [], blockers: [], focused: focus,
        menuBarOpen: false, hidden: alone, lifecycle: lifecycle))
  }

  func testCaptureLayoutIgnoresFocusLifecycleTitleAndExcludedWindows() {
    let before = group()
    let after = group(focus: 99, lifecycle: 400, title: "After",
      unrelated: [member(99, x: 900)])
    XCTAssertNotEqual(before.signature, after.signature)
    XCTAssertEqual(before.captureLayout, after.captureLayout)
  }

  func testContainedMemberChurnKeepsTheCaptureMapping() {
    let root = member()
    let sharingChrome = member(83, x: 26, y: 36, width: 66, height: 20)
    let sheet = member(84, x: 40, y: 50, width: 160, height: 60)
    let before = group()
    for entries in [[root, sharingChrome], [sheet, sharingChrome, root],
                    [root, member(85, x: 100, y: 70, width: 66, height: 20)],
                    [root, member(87, x: 20, y: 30, width: 200, height: 100)],
                    [root, member(86, x: 26, y: 36, width: 66, height: 20,
                                  layer: 3, visible: false, alpha: 0.5)], [root]] {
      let changed = group(members: entries)
      let fence = OwnerSampleFence()
      let sample = fence.current
      XCTAssertFalse(fence.retireIfLayoutChanged(from: before.captureLayout, to: changed.captureLayout))
      XCTAssertTrue(fence.accepts(sample), "Contained-only churn must keep existing input accepted")
      XCTAssertEqual(before.captureLayout, changed.captureLayout)
      XCTAssertEqual(changed.members, entries, "Contained content stays in discovery/capture/input")
    }
  }

  func testInitialLayoutDiscoveryKeepsTheFirstCaptureAccepted() {
    let fence = OwnerSampleFence()
    let first = fence.current
    // A layout refresh can finish before the stream records its first layout.
    XCTAssertTrue(fence.retireIfLayoutChanged(from: nil, to: group().captureLayout),
                  "Initial discovery still reports a layout to plan")
    XCTAssertTrue(fence.accepts(first), "Initial discovery must not refuse the first capture's samples")
  }

  func testRefreshWhileRestartPendingKeepsTheRestartedSamples() {
    let fence = OwnerSampleFence()
    let before = group()
    let resized = group(members: [member(width: 260)])
    let old = fence.current
    XCTAssertTrue(fence.retireIfLayoutChanged(from: before.captureLayout, to: resized.captureLayout,
                                              restartPending: false))
    XCTAssertFalse(fence.accepts(old), "The first change still fences the old samples")
    let restarted = fence.start()
    // The restarted stream records its own layout later; meanwhile a refresh
    // still compares the old layout with the new one.
    XCTAssertTrue(fence.retireIfLayoutChanged(from: before.captureLayout, to: resized.captureLayout,
                                              restartPending: true))
    XCTAssertTrue(fence.accepts(restarted), "A pending restart's samples must stay accepted")
  }

  func testCaptureLayoutChangesWithRootTransformAndSampleGeometry() {
    let before = group()
    let changes: [(String, WindowGroup)] = [
      ("root identity", group(root: WindowIdentity(windowID: 11, title: nil, frame: before.root.frame))),
      ("root origin with fixed crop", group(root: WindowIdentity(windowID: 10, title: nil,
        frame: CGRect(x: 21, y: 30, width: 200, height: 100)))),
      ("root size with fixed crop", group(root: WindowIdentity(windowID: 10, title: nil,
        frame: CGRect(x: 20, y: 30, width: 199, height: 100)))),
      ("crop origin", group(crop: CGRect(x: 21, y: 30, width: 200, height: 100))),
      ("crop size", group(crop: CGRect(x: 20, y: 30, width: 199, height: 100))),
      ("display", group(display: 2)),
      ("scale", group(scale: 1)),
      ("capture mode only", group(alone: true)),
    ]
    for (name, changed) in changes {
      let fence = OwnerSampleFence()
      let sample = fence.current
      XCTAssertTrue(fence.retireIfLayoutChanged(from: before.captureLayout, to: changed.captureLayout), name)
      XCTAssertFalse(fence.accepts(sample), name)
      let next = fence.start()
      XCTAssertFalse(fence.accepts(sample), name)
      XCTAssertTrue(fence.accepts(next), name)
      XCTAssertNotEqual(before.captureLayout, changed.captureLayout, name)
    }
  }

  func testExteriorMembersAndCompositionBoundsStillFenceOldSamples() {
    let before = group()
    let sibling = member(11, x: 200, y: 50, width: 80, height: 60)
    let extended = group(members: [member(), sibling],
      crop: CGRect(x: 20, y: 30, width: 260, height: 100))
    func fences(_ from: WindowGroup, _ to: WindowGroup, _ name: String) {
      let fence = OwnerSampleFence()
      let sample = fence.current
      XCTAssertTrue(fence.retireIfLayoutChanged(from: from.captureLayout, to: to.captureLayout), name)
      XCTAssertFalse(fence.accepts(sample), name)
      let next = fence.start()
      XCTAssertFalse(fence.accepts(sample), name)
      XCTAssertTrue(fence.accepts(next), name)
    }
    fences(before, extended, "Composition expands")
    fences(extended, before, "Composition shrinks")
    XCTAssertNotEqual(before.captureLayout, extended.captureLayout, "Composition expands")
    XCTAssertNotEqual(extended.captureLayout, before.captureLayout, "Composition shrinks")
    let clipped = group(members: [member(), sibling])
    fences(before, clipped, "Exterior clipped member")
    XCTAssertNotEqual(before.captureLayout, clipped.captureLayout, "Exterior transform remains fenced even when clipped")
    for edge in [member(11, x: 19), member(11, y: 29),
                 member(11, width: 201), member(11, height: 101), member(11, x: 20.5)] {
      fences(before, group(members: [member(), edge]), "At 2x even 0.5pt outward fences conservatively")
      XCTAssertNotEqual(before.captureLayout, group(members: [member(), edge]).captureLayout)
    }
    let fence = OwnerSampleFence()
    let queued = fence.current
    XCTAssertTrue(fence.retireIfLayoutChanged(from: before.captureLayout, to: extended.captureLayout))
    XCTAssertFalse(fence.accepts(queued))
    let next = fence.start()
    XCTAssertFalse(fence.accepts(queued))
    XCTAssertTrue(fence.accepts(next))
  }
}
