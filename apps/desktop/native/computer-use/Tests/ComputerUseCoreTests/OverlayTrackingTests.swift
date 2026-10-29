import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// The overlay's cost over a whole session, and what it leaves behind: the
/// window tracker places each frame once and orders a panel only when it has
/// to, the slow breath asks for a low frame rate, and nothing a session drew
/// outlives it or lands after something newer.
/// Manual frames and private notifications keep tracker tests off the window server.
@MainActor
final class OverlayTrackingTests: XCTestCase {

  // MARK: - Tracker

  private let driver = ManualFrameDriver()
  private let center = NotificationCenter()

  private final class Counter {
    var orderings: [WindowOrdering] = []
    var moved = false
  }

  private func tracker(_ counter: Counter) -> WindowTracker {
    let tracker = WindowTracker(clock: driver, now: { 0 }, center: { _ in self.center })
    tracker.refresh = { ordering in
      counter.orderings.append(ordering)
      return counter.moved
    }
    return tracker
  }

  func testAFollowPlacesNothingItselfAndLeavesItToTheNextFrame() {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isActive = true
    defer { tracker.isActive = false }
    tracker.follow()
    tracker.follow()
    XCTAssertEqual(counter.orderings, [], "A drag's events do not each place everything.")
    XCTAssertTrue(tracker.isFollowing)
  }

  func testAPollThatSeesAMovePlacesOnceAndThenFollows() {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isActive = true
    defer { tracker.isActive = false }
    counter.moved = true
    tracker.tick()
    XCTAssertEqual(counter.orderings, [.verify], "One placement per tick, which checks the order.")
    XCTAssertTrue(tracker.isFollowing)
    tracker.tick()
    XCTAssertEqual(counter.orderings.count, 1, "While following, the frames place everything.")
  }

  func testAStillPollDoesNotFollow() {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isActive = true
    defer { tracker.isActive = false }
    tracker.tick()
    XCTAssertEqual(counter.orderings.count, 1)
    XCTAssertFalse(tracker.isFollowing)
  }

  func testAppEventsAreIgnoredWhileNothingIsDrawn() {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isActive = true
    defer { tracker.isActive = false }
    tracker.windowEvent()
    XCTAssertFalse(tracker.isFollowing)
    tracker.isDrawing = true
    tracker.windowEvent()
    XCTAssertTrue(tracker.isFollowing)
  }

  func testNothingIsFollowedWhileNothingIsWanted() {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isDrawing = true
    tracker.follow()
    tracker.tick()
    XCTAssertFalse(tracker.isFollowing)
    XCTAssertEqual(counter.orderings, [])
  }

  func testARestackOrdersEveryPanelOnTheNextFrame() async throws {
    let counter = Counter()
    let tracker = tracker(counter)
    tracker.isActive = true
    defer { tracker.isActive = false }
    tracker.follow(restacked: true)
    driver.advance(0)
    driver.advance(0.01)
    XCTAssertEqual(counter.orderings.first, .always)
    XCTAssertFalse(counter.orderings.dropFirst().contains(.always), "Only the first frame.")
  }

  func testTheTrackerForwardsAReduceMotionChange() async throws {
    let tracker = WindowTracker(clock: driver, now: { 0 }, center: { _ in self.center })
    var events: [WorkspaceEvent] = []
    tracker.onWorkspaceEvent = { events.append($0) }
    center.post(
      name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    let deadline = Date().addingTimeInterval(2)
    while events.isEmpty, Date() < deadline {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertEqual(events, [.motionPreferenceChanged])
    XCTAssertFalse(tracker.isFollowing, "A preference change moves no window.")
  }

  func testObserversGoWithTheirOwner() {
    let center = NotificationCenter()
    let name = Notification.Name("OverlayTrackingTests.ping")
    final class Box: @unchecked Sendable { var count = 0 }
    let box = Box()
    var observations: NotificationObservations? = NotificationObservations()
    observations?.observe(name, on: center) { _ in box.count += 1 }
    center.post(name: name, object: nil)
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    XCTAssertEqual(box.count, 1)
    observations = nil
    center.post(name: name, object: nil)
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    XCTAssertEqual(box.count, 1)
  }

}
