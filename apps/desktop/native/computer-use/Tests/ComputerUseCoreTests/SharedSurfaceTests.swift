import ApplicationServices
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class SharedSurfaceTests: XCTestCase {
  func testCaptureTargetsRemainBoundToEachAppAndSession() throws {
    let targets = CaptureTargetStore()
    let process = try XCTUnwrap(hostStamp(getpid()))
    let notes = CaptureTarget(
      observationId: "notes",
      app: .init(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil),
      process: process, windowID: 10)
    let calendar = CaptureTarget(
      observationId: "calendar",
      app: .init(bundleId: "com.apple.iCal", displayName: "Calendar", teamId: nil),
      process: process, windowID: 20)
    targets.publish(notes, for: "session")
    targets.publish(calendar, for: "session")
    XCTAssertEqual(targets.current(for: "session", appKey: "com.apple.notes"), notes)
    XCTAssertEqual(targets.current(for: "session", appKey: "com.apple.ical"), calendar)
    XCTAssertNil(targets.current(for: "session", appKey: "another.app"))
    XCTAssertNil(targets.current(for: "another-session", appKey: "com.apple.notes"))
    targets.remove("session", appKey: "com.apple.notes")
    XCTAssertNil(targets.current(for: "session", appKey: "com.apple.notes"))
    XCTAssertEqual(targets.current(for: "session", appKey: "com.apple.ical"), calendar)
    targets.publish(notes, for: "session")
    XCTAssertEqual(targets.current(for: "session", appKey: "com.apple.ical"), calendar)
    targets.remove("session")
    XCTAssertNil(targets.current(for: "session", appKey: "com.apple.ical"))
  }

  func testCommittedObservationReportsHelperActivationExactlyOnce() {
    let monitor = WindowMonitor()
    let pid = getpid()
    monitor.noteLaunch(processIdentifier: pid, broughtForward: true)
    let revision = monitor.observationRevision(processIdentifier: pid)
    XCTAssertNil(
      monitor.commitObservation(
        processIdentifier: pid, windowID: 10, window: AXUIElementCreateApplication(pid),
        since: revision))
    XCTAssertTrue(monitor.takeFocusChanged(processIdentifier: pid))
    XCTAssertFalse(monitor.takeFocusChanged(processIdentifier: pid))
    monitor.noteLaunch(processIdentifier: pid, broughtForward: true)
    XCTAssertNotNil(
      monitor.commitObservation(
        processIdentifier: pid, windowID: 10, window: AXUIElementCreateApplication(pid),
        since: revision))
    XCTAssertTrue(monitor.takeFocusChanged(processIdentifier: pid))
  }

  @WorkActor
  func testEveryMutationChecksWhetherTheMacLocked() throws {
    let app = hostApp(
      identity: .init(bundleId: "fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    let context = hostContext(
      app: app, cancellation: SessionCancellation(), monitor: WindowMonitor(), overlay: nil,
      budget: .unlimited, requireUnlocked: { try HelperRuntime.requireUnlocked(locked: true) })
    let binding = ActionRunner.Binding(
      processIdentifier: getpid(), windowID: 10, windowFrame: .zero)
    XCTAssertThrowsError(try context.checkStep(binding, restarted: "Restarted")) {
      XCTAssertEqual(($0 as? HelperError)?.code, .unsupported)
      XCTAssertEqual(
        ($0 as? HelperError)?.message, "The Mac is locked; ask the person to unlock it.")
    }
  }
}
