import ApplicationServices
import Darwin
import XCTest
@testable import ComputerUseCore

final class MacVideoRecoveryTests: XCTestCase {
  @MainActor
  private func fixture(authority: @escaping @Sendable () -> Bool = { true }) async
    -> (MacWindowVideoProducer, MacVideoBinding, Locked<[MacVideoState]>) {
    let binding = await Task { @WorkActor in
      MacVideoBinding(OwnerViewWindow.Binding(target: CaptureTarget(observationId: "fixture",
        app: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
        process: ProcessStamp.of(getpid())!, windowID: 1),
        element: AXUIElementCreateApplication(getpid())))
    }.value
    let states = Locked<[MacVideoState]>([])
    let producer = MacWindowVideoProducer(id: "stream", binding: binding,
      operations: SerialTaskChain(), authority: authority,
      onState: { state in states.withLock { $0.append(state) } })
    return (producer, binding, states)
  }

  @MainActor
  func testPlanInvalidationKeepsTheExactViewRecoverable() async {
    for message in ["This window's ownership changed; observe again.",
                    "This app changed while it was being observed."] {
      let (producer, binding, states) = await fixture()
      defer { producer.stop() }
      for _ in 0..<3 {
        producer.startFailed(HelperError(.staleObservation, message), operation: "plan")
        XCTAssertFalse(producer.ended, "A stale plan must not permanently end the view")
        XCTAssertTrue(producer.needsResume, "The lifecycle pass must plan again, even before a first frame")
        XCTAssertFalse(producer.hasFrame)
        XCTAssertNil(producer.inputMap, "No input may use an invalidated capture plan")
        XCTAssertTrue(states.current.allSatisfy { $0.state != "failed" })
        XCTAssertTrue(producer.binding === binding, "Recovery must keep the exact window binding")
      }
    }
  }

  @MainActor
  func testDefinitiveWindowLossAndOtherFailuresRemainTerminal() async {
    for error in [SessionWindows.closed,
                  HelperError(.permissionRequired, "Permission ended"),
                  HelperError(.unsupported, "Capture is unsupported")] {
      let (producer, _, states) = await fixture()
      producer.startFailed(error, operation: "plan")
      XCTAssertTrue(producer.ended)
      XCTAssertFalse(producer.needsResume)
      XCTAssertNil(producer.inputMap)
      XCTAssertEqual(states.current.last?.state, "failed")
      if error == SessionWindows.closed { XCTAssertEqual(states.current.last?.reason, "window-closed") }
    }
    let (producer, binding, states) = await fixture()
    binding.window.liveness.close()
    producer.startFailed(HelperError(.staleObservation, "Association changed"), operation: "plan")
    XCTAssertTrue(producer.ended)
    XCTAssertFalse(producer.needsResume)
    XCTAssertEqual(states.current.last?.reason, "window-closed")
  }

  @MainActor
  func testStopDeadlineAndRevocationFenceLateInvalidations() async {
    for reason in ["sharing-stopped", "capture-timeout", "permission-required"] {
      let (producer, _, states) = await fixture()
      producer.startFailed(HelperError(.staleObservation, "Association changed"), operation: "plan")
      XCTAssertTrue(producer.needsResume)
      producer.stop(reason: reason, failed: reason != "sharing-stopped")
      let count = states.current.count
      producer.startFailed(HelperError(.staleObservation, "Association changed again"), operation: "plan")
      XCTAssertTrue(producer.ended)
      XCTAssertFalse(producer.needsResume)
      XCTAssertEqual(states.current.count, count, "Late planning must not revive a terminal view")
      XCTAssertEqual(states.current.last?.reason, reason)
    }
    let (producer, _, states) = await fixture(authority: { false })
    producer.startFailed(HelperError(.staleObservation, "Association changed"), operation: "plan")
    XCTAssertTrue(producer.ended)
    XCTAssertFalse(producer.needsResume)
    XCTAssertEqual(states.current.last?.reason, "owner-ended")
  }
}
