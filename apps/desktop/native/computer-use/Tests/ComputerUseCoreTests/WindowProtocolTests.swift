import ApplicationServices
import CoreGraphics
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

// Failure matrix: see the pre-implementation record in the external evidence.
// Real window ownership, pixel capture and input are exercised by VM journeys.
final class WindowProtocolTests: XCTestCase {

  @WorkActor
  func testPointRoutingRefusesGapsAndRevalidatesTheWholeMemberFrame() throws {
    let binding = ActionRunner.Binding(
      processIdentifier: 123, windowID: 1,
      windowFrame: CGRect(x: -200, y: 0, width: 100, height: 100),
      windows: [ObservedWindow(windowID: 1, frame: CGRect(x: -200, y: 0, width: 100, height: 100))])
    XCTAssertThrowsError(
      try ActionRunner.eventTarget(for: CGPoint(x: -50, y: 30), binding: binding))
  }

  func testFocusChangeDoesNotInvalidateExplicitWindowSnapshots() {
    let monitor = WindowMonitor()
    let token = AXUIElementCreateApplication(123)
    monitor.noteObservation(processIdentifier: 123, windowID: 1, window: token)
    monitor.noteWindowEvent(processIdentifier: 123, kind: .focusedWindowChanged(windowID: 2))
    XCTAssertNil(monitor.state(of: 123).staleReason)
  }

}
