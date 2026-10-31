import CoreGraphics
import XCTest

@testable import ComputerUseCore

final class EventTapContextTests: XCTestCase {
  func testRegistrationOutlivesTheOwnerAndStoppedCallbacksPassThrough() {
    var calls = 0
    var owner: EventTap.Context? = EventTap.Context { _, _ in calls += 1; return nil }
    weak var observed = owner
    let registration = Unmanaged.passRetained(owner!).toOpaque()
    let event = CGEvent(source: nil)!

    XCTAssertNil(owner!.receive(.keyDown, event))
    XCTAssertEqual(calls, 1)
    owner!.stop()
    owner = nil

    // Native callbacks may already be queued when the EventTap owner leaves.
    XCTAssertNotNil(observed)
    XCTAssertTrue(Unmanaged<EventTap.Context>.fromOpaque(registration)
      .takeUnretainedValue().receive(.keyDown, event) === event)
    XCTAssertEqual(calls, 1)
    Unmanaged<EventTap.Context>.fromOpaque(registration).release()
    XCTAssertNil(observed)
  }

  func testAHandlerCanStopItsOwnTapWithoutHoldingTheCallbackLock() {
    var calls = 0
    weak var observed: EventTap.Context?
    let context = EventTap.Context { _, event in
      calls += 1
      observed?.stop()
      return event
    }
    observed = context
    let event = CGEvent(source: nil)!
    XCTAssertTrue(context.receive(.keyDown, event) === event)
    XCTAssertTrue(context.receive(.keyUp, event) === event)
    XCTAssertEqual(calls, 1)
  }
}
