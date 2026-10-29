import ApplicationServices
import XCTest

@testable import ComputerUseCore

/// Review finding 3: a route chosen for an action is the route that action
/// gets. A failure never becomes a second attempt down the other one, because
/// the first one may already have done the thing (§1 invariant 4).
final class KeyRouteTests: XCTestCase {
  /// Text goes in through Accessibility when the focused element takes
  /// `AXSelectedText`, which is what typing does to it. Line breaks and tabs
  /// are keys a person presses, so text holding them goes by keyboard, as does
  /// everything an element cannot take through Accessibility.
  func testTypingPrefersAccessibilityInsertionAndKeepsKeysAsKeys() {
    XCTAssertEqual(
      ActionRunner.typeRoute(text: "hello", selectedTextSettable: true), .accessibility)
    XCTAssertEqual(ActionRunner.typeRoute(text: "hello", selectedTextSettable: false), .keyboard)
    for text in ["one\ntwo", "a\tb", "done\r"] {
      XCTAssertEqual(ActionRunner.typeRoute(text: text, selectedTextSettable: true), .keyboard)
    }
  }

  @MainActor
  func testKeyboardTypingPressesReturnAndTabRatherThanInsertingThem() {
    let presses = VirtualKeys.presses(for: "a\nb\tc\r\n")
    XCTAssertEqual(presses.map(\.virtualKey), [0, 36, 11, 48, 8, 36])
    XCTAssertEqual(presses.map(\.characters), ["a", "\r", "b", "\t", "c", "\r"])
    // A character no key types still goes, as one key carrying it.
    XCTAssertEqual(VirtualKeys.presses(for: "👨‍👩‍👧"), [.init(virtualKey: 0, flags: [], characters: "👨‍👩‍👧")])
  }

  func testASuccessfulPressIsNoError() {
    XCTAssertNil(
      ActionRunner.pressOutcome(
        .success,
        whatMayHaveHappened: "the shortcut ran",
        failure: "nope"
      )
    )
  }

  /// An app that did not answer in time may still have acted, so the batch
  /// stops and nothing is retried.
  @MainActor
  func testCannotCompleteIsOutcomeUnknown() throws {
    let error = try XCTUnwrap(
      ActionRunner.pressOutcome(
        .cannotComplete,
        whatMayHaveHappened: "the shortcut ran",
        failure: "nope"
      )
    )
    XCTAssertEqual(error.code, .outcomeUnknown)
    XCTAssertTrue(error.message.contains("whether the shortcut ran is unknown"))
  }

  /// Setting AXValue is also a mutation: a timeout cannot prove the app did
  /// not apply it, so callers must not invite a duplicate retry.
  @MainActor
  func testSetValueCannotCompleteIsOutcomeUnknown() throws {
    let error = try XCTUnwrap(ActionRunner.setValueOutcome(.cannotComplete))
    XCTAssertEqual(error.code, .outcomeUnknown)
    XCTAssertTrue(error.message.contains("whether the value changed is unknown"))
  }

  /// Any other answer is a refusal the caller must throw — never a `nil` that
  /// would let the caller carry on to the synthetic route.
  @MainActor
  func testEveryOtherAnswerIsAFailureTheCallerMustThrow() throws {
    for status: AXError in [.failure, .actionUnsupported, .invalidUIElement, .notImplemented] {
      let error = try XCTUnwrap(
        ActionRunner.pressOutcome(
          status,
          whatMayHaveHappened: "the shortcut ran",
          failure: "This app's menu did not accept that shortcut."
        ),
        "\(status) must not be treated as success"
      )
      XCTAssertEqual(error.code, .failed)
    }
  }
}

/// Review finding 4: ScreenCaptureKit reads the Screen Recording grant at
/// process start, so the helper has to restart once it is first granted — and
/// the desktop keeps a connection open the whole time, so an open connection
/// can never be the thing that holds the restart back.
final class RestartDecisionTests: XCTestCase {
  func testNoPendingGrantMeansStay() {
    XCTAssertEqual(
      HelperRuntime.restartDecision(
        grantPending: false, sessionActive: false, appCallsInFlight: false),
      .stay
    )
    XCTAssertEqual(
      HelperRuntime.restartDecision(
        grantPending: false, sessionActive: true, appCallsInFlight: false),
      .stay
    )
  }

  func testAPendingGrantWithNoSessionRestartsEvenWithAConnectionOpen() {
    XCTAssertEqual(
      HelperRuntime.restartDecision(
        grantPending: true, sessionActive: false, appCallsInFlight: false),
      .restart
    )
  }

  /// A Calendar or Reminders change still running would be cut off, and the
  /// Run told only that it may or may not have happened.
  func testAnAppCallInFlightHoldsTheRestartBack() {
    XCTAssertEqual(
      HelperRuntime.restartDecision(
        grantPending: true, sessionActive: false, appCallsInFlight: true),
      .stay
    )
  }

  func testALiveSessionHoldsTheRestartBack() {
    XCTAssertEqual(
      HelperRuntime.restartDecision(
        grantPending: true, sessionActive: true, appCallsInFlight: false),
      .stay
    )
  }
}
