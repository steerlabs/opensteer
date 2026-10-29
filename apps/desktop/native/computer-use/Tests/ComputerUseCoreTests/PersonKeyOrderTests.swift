import CoreGraphics
import XCTest

@testable import ComputerUseCore

/// The person's keys land in the order typed while some are sent on to their
/// app. A fake window server: a sent-on key lands later, in the order sent; a
/// key the person's app receives directly lands at once. Both pass the watch on
/// the person's app.
final class PersonKeyOrderTests: XCTestCase {
  final class World: @unchecked Sendable {
    var clock = 0.0
    var tap: ((CGEvent) -> CGEvent?)?
    var installs = true
    var stopped = 0
    var inFlight: [CGEvent] = []
    var landed: [String] = []
    var scheduled: [@Sendable () -> Void] = []

    lazy var order = PersonKeyOrder(
      post: { [unowned self] _, event in inFlight.append(event) },
      install: { [unowned self] _, handler in
        guard installs else { return nil }
        tap = handler
        return { [unowned self] in stopped += 1 }
      },
      schedule: { [unowned self] _, body in scheduled.append(body) },
      now: { [unowned self] in clock })

    /// A key from the keyboard: not one this process posted.
    func key(_ name: String, at stamp: UInt64, code: CGKeyCode = 29) -> CGEvent {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
      event.timestamp = stamp
      event.setIntegerValueField(FocusEvents.sourcePIDField, value: 0)
      names[ObjectIdentifier(event)] = name
      return event
    }
    var names: [ObjectIdentifier: String] = [:]

    func sendOn(_ event: CGEvent) { XCTAssertTrue(order.sendOn(event, to: 7)) }

    /// One of the person's keys reaching their app directly.
    func typed(_ event: CGEvent) {
      if let passed = tap?(event) { landed.append(names[ObjectIdentifier(passed)] ?? "?") }
    }

    /// Everything sent on lands, in the order sent, through the same watch.
    func land() {
      var index = 0
      while index < inFlight.count, index < 20 {
        if let passed = tap?(inFlight[index]) { landed.append(names[ObjectIdentifier(passed)] ?? "?") }
        index += 1
      }
      inFlight.removeAll()
    }

    func runScheduled() {
      let due = scheduled
      scheduled.removeAll()
      for body in due { body() }
    }
  }

  func testAKeyTypedRightAfterOneSentOnLandsAfterIt() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("0", at: 1))
    world.clock = 0.010
    world.typed(world.key("1", at: 2))
    world.land()
    XCTAssertEqual(world.landed, ["0", "1"])
  }

  func testADifferentKeyWithTheSameTimestampIsNotTakenForOneSentOn() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("0", at: 5, code: 29))
    world.typed(world.key("1", at: 5, code: 18))
    world.land()
    XCTAssertEqual(world.landed, ["0", "1"])
  }

  func testAKeyStillOnItsWayAfterFiftyMillisecondsIsNotOvertaken() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("0", at: 1))
    world.clock = 0.060
    world.typed(world.key("1", at: 2))
    world.land()
    XCTAssertEqual(world.landed, ["0", "1"])
  }

  func testAKeySentOnThatNeverArrivesStopsHoldingTheirKeysAndNoneIsLost() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("0", at: 1))
    world.inFlight.removeAll()
    world.clock = 1.1
    world.typed(world.key("1", at: 2))
    XCTAssertEqual(world.landed, ["1"])
    XCTAssertTrue(world.inFlight.isEmpty)
  }

  func testWithoutAWatchOnThePersonsAppNothingIsHeld() {
    let world = World()
    world.installs = false
    XCTAssertFalse(world.order.hold(7))
  }

  func testTheWatchStopsOnlyOnceReleasedAndEverythingSentOnHasArrived() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("0", at: 1))
    world.order.release(7)
    world.runScheduled()
    XCTAssertEqual(world.stopped, 0, "Stopped while a key was on its way")
    world.land()
    world.runScheduled()
    XCTAssertEqual(world.stopped, 1)
  }

  /// One key lost and a newer one still on its way: the watch stays for the
  /// newer one.
  func testAKeyStillOnItsWayKeepsTheWatchWhenAnOlderOneIsLost() {
    let world = World()
    XCTAssertTrue(world.order.hold(7))
    world.sendOn(world.key("lost", at: 1))
    world.inFlight.removeAll()
    world.clock = 0.9
    world.sendOn(world.key("0", at: 2))
    world.order.release(7)
    world.clock = 1.0
    world.runScheduled()
    XCTAssertEqual(world.stopped, 0, "Stopped while a newer key was on its way")
    world.typed(world.key("1", at: 3))
    world.land()
    XCTAssertEqual(world.landed, ["0", "1"])
  }
}
