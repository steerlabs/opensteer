import ApplicationServices
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class WindowMonitorTests: XCTestCase {
  func testOnlyTheObservedWindowTokenInvalidatesForDestructionOrMinimization() {
    let monitor = WindowMonitor()
    let pid: pid_t = 123
    // AX tokens can be compared without permission or a query to a live app.
    let observed = AXUIElementCreateApplication(pid)
    let child = AXUIElementCreateSystemWide()
    let otherWindow = AXUIElementCreateApplication(456)
    for minimized in [false, true] {
      monitor.noteObservation(processIdentifier: pid, windowID: 10, window: observed)
      let revision = monitor.observationRevision(processIdentifier: pid)
      for unrelated in [child, otherWindow] {
        monitor.noteWindowEvent(
          processIdentifier: pid,
          kind: minimized ? .miniaturized(element: unrelated) : .destroyed(element: unrelated))
        XCTAssertNil(monitor.state(of: pid).staleReason)
        XCTAssertNil(monitor.observationError(since: revision, processIdentifier: pid))
      }
      // A separate token representing the same AX object also matches.
      let same = AXUIElementCreateApplication(pid)
      XCTAssertTrue(CFEqual(observed, same))
      monitor.noteWindowEvent(
        processIdentifier: pid,
        kind: minimized ? .miniaturized(element: same) : .destroyed(element: same))
      XCTAssertEqual(monitor.state(of: pid).staleReason, minimized ? .minimized : .closed)
      XCTAssertEqual(
        monitor.state(of: pid).staleReason?.message,
        minimized ? "The observed window was minimized." : "The observed window closed.")
      XCTAssertEqual(
        monitor.observationError(since: revision, processIdentifier: pid)?.message,
        "This app changed while it was being observed.")
    }
  }

  func testFirstReasonSurvivesLaterEventsUntilAnObservationCommits() {
    let monitor = WindowMonitor()
    let window = AXUIElementCreateApplication(123)
    monitor.noteObservation(processIdentifier: 123, windowID: 10, window: window)
    monitor.noteWindowEvent(processIdentifier: 123, kind: .miniaturized(element: window))
    monitor.noteWindowEvent(processIdentifier: 123, kind: .destroyed(element: window))
    monitor.noteWindowEvent(processIdentifier: 123, kind: .focusedWindowChanged(windowID: 20))
    XCTAssertEqual(monitor.state(of: 123).staleReason, .minimized)
    monitor.noteObservation(processIdentifier: 123, windowID: 10, window: window)
    XCTAssertNil(monitor.state(of: 123).staleReason)
    monitor.noteWindowEvent(processIdentifier: 123, kind: .focusedWindowChanged(windowID: nil))
    XCTAssertNil(monitor.state(of: 123).staleReason)
  }

  func testForgetDiscardsTheObservedToken() {
    let monitor = WindowMonitor()
    let window = AXUIElementCreateApplication(123)
    monitor.noteObservation(processIdentifier: 123, windowID: 10, window: window)
    monitor.forget(processIdentifier: 123)
    XCTAssertNil(monitor.observedWindow(of: 123))
    monitor.noteWindowEvent(processIdentifier: 123, kind: .destroyed(element: window))
    XCTAssertNil(monitor.state(of: 123).staleReason)
  }

  func testCommitRejectsAWindowEventWithoutClearingItsEvidence() {
    let monitor = WindowMonitor()
    let original = AXUIElementCreateApplication(123)
    let replacement = AXUIElementCreateApplication(456)
    monitor.noteObservation(processIdentifier: 123, windowID: 10, window: original)
    let revision = monitor.observationRevision(processIdentifier: 123)
    monitor.noteWindowEvent(processIdentifier: 123, kind: .destroyed(element: original))

    let error = monitor.commitObservation(
      processIdentifier: 123, windowID: 20, window: replacement, since: revision)
    XCTAssertEqual(error?.code, .staleObservation)
    XCTAssertEqual(monitor.state(of: 123).staleReason, .closed)
    XCTAssertTrue(CFEqual(monitor.observedWindow(of: 123), original))
  }

  func testAWindowChangeAfterCompletedInputKeepsReceiptsWithoutCallingTheBatchStale() {
    let changed = HelperError(.staleObservation, "The observed window closed.")
    XCTAssertEqual(ActionRunner.failureAfter(changed, performed: []), changed)
    XCTAssertEqual(
      ActionRunner.failureAfter(changed, performed: ["Clicked \"Save\""]),
      HelperError(.failed, "The observed window closed."))
    let unsupported = HelperError(.unsupported, "This element cannot be clicked.")
    XCTAssertEqual(
      ActionRunner.failureAfter(unsupported, performed: ["Clicked \"Save\""]), unsupported)
  }

  @WorkActor
  func testABatchKeepsItsReceiptWhenTheObservedProcessWasReplacedBeforeTheNextAction()
    async throws
  {
    let current = try XCTUnwrap(hostStamp(getpid()))
    let replaced = ProcessStamp(
      processIdentifier: current.processIdentifier,
      startSeconds: current.startSeconds + 1,
      startMicroseconds: current.startMicroseconds)
    let app = hostApp(
      identity: .init(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    let observationId = "0123456789abcdef"
    app.record(
      LatestObservation(
        observationId: observationId, processIdentifier: current.processIdentifier, windowID: 10,
        windowFrame: .zero,
        coordinates: .init(cropOrigin: .zero, scale: 1, geometry: .init(width: 100, height: 100)),
        elements: [], takenAt: Date()))
    app.verified = replaced

    let result = try await ActionRunner.run(
      actions: [
        .key(keys: "Escape"), .click(target: .index(0), button: .left, count: 1),
      ], app: app, observationId: observationId, cancellation: SessionCancellation(),
      monitor: WindowMonitor(), overlay: nil, budget: .unlimited,
      accessibility: hostAccessibility(),
      stamp: { hostStamp($0) }, isHidden: { _ in false }, requireUnlocked: {})
    XCTAssertEqual(result.performed, [])
    XCTAssertEqual(result.error?.code, .staleObservation)
    XCTAssertEqual(result.error?.message, "This app restarted since it was observed.")
    XCTAssertNotNil(app.latest)
  }

  @WorkActor
  func testAReusedOrDifferentProcessIdentifierCannotContinueAnObservedAction() throws {
    let current = try XCTUnwrap(hostStamp(getpid()))
    let replaced = ProcessStamp(
      processIdentifier: current.processIdentifier,
      startSeconds: current.startSeconds + 1,
      startMicroseconds: current.startMicroseconds)
    let app = hostApp(
      identity: .init(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    func record(_ pid: pid_t) {
      app.record(
        LatestObservation(
          observationId: "0123456789abcdef", processIdentifier: pid, windowID: 10,
          windowFrame: .zero,
          coordinates: .init(cropOrigin: .zero, scale: 1, geometry: .init(width: 100, height: 100)),
          elements: [], takenAt: Date()))
    }
    record(current.processIdentifier)
    app.verified = replaced
    XCTAssertThrowsError(try AppProcess.verifyObserved(app, readStamp: { hostStamp($0) })) {
      error in
      XCTAssertEqual((error as? HelperError)?.code, .staleObservation)
    }
    app.verified = current
    record(current.processIdentifier + 1)
    XCTAssertThrowsError(try AppProcess.verifyObserved(app, readStamp: { hostStamp($0) })) {
      error in
      XCTAssertEqual((error as? HelperError)?.code, .staleObservation)
    }
  }

  @WorkActor
  func testBindingReturnsEachRecordedReasonWithoutRecoveryInstructions() throws {
    let pid: pid_t = 123
    let window = AXUIElementCreateApplication(pid)
    let monitor = WindowMonitor()
    let app = hostApp(
      identity: .init(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    app.record(
      LatestObservation(
        observationId: "0123456789abcdef", processIdentifier: pid, windowID: 10,
        windowFrame: .zero,
        coordinates: .init(cropOrigin: .zero, scale: 1, geometry: .init(width: 100, height: 100)),
        elements: [], takenAt: Date()))
    let cases: [(AppAXObserver.EventKind, String)] = [
      (.destroyed(element: window), "The observed window closed."),
      (.miniaturized(element: window), "The observed window was minimized."),
    ]
    for (event, message) in cases {
      monitor.noteObservation(processIdentifier: pid, windowID: 10, window: window)
      monitor.noteWindowEvent(processIdentifier: pid, kind: event)
      XCTAssertThrowsError(
        try ActionRunner.binding(app: app, processIdentifier: pid, monitor: monitor)
      ) {
        XCTAssertEqual(($0 as? HelperError)?.code, .staleObservation)
        XCTAssertEqual(($0 as? HelperError)?.message, message)
      }
    }
  }
}
