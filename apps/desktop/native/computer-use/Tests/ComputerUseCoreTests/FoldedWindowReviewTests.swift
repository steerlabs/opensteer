import ApplicationServices
import CoreGraphics
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class FoldedWindowReviewTests: XCTestCase {
  @WorkActor func testPostedMutationBoundaries() async throws {
    for route in ["mouse", "scroll", "key", "typing"] {
      for deadline in [false, true] {
        let receiver = hostApp(
          identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
          path: "/tmp/Fixture.app")
        defer { receiver.focus.stop() }
        let monitor = WindowMonitor()
        let binding = ActionRunner.Binding(
          processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
          windowFrame: CGRect(x: 0, y: 0, width: 200, height: 200), onScreen: false)
        receiver.latest = LatestObservation(
          observationId: "snapshot", processIdentifier: getpid(), windowID: 1,
          windowFrame: binding.windowFrame,
          coordinates: ObservationCoordinates(
            cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 200, height: 200)),
          elements: [], takenAt: Date())
        let cancellation = SessionCancellation()
        let boundary = Locked(0)
        let budget = deadline ? WorkBudget(requestEnd: Date().addingTimeInterval(2)) : .unlimited
        var calls = hostAccessibility()
        calls.isSettable = { element, attribute in
          false
        }
        var context = hostContext(
          app: receiver, cancellation: cancellation, monitor: monitor, overlay: nil, budget: budget,
          accessibility: calls)
        context.savedCheck = {
          guard Thread.isMainThread else { return }
          boundary.withLock { $0 += 1 }
          if deadline {
            Thread.sleep(forTimeInterval: max(0, budget.remaining()) + 0.005)
            try budget.check()
          } else {
            cancellation.cancel(.stoppedByUser)
            try cancellation.check()
          }
        }
        var failure: HelperError?
        do {
          switch route {
          case "mouse":
            let point = CGPoint(x: binding.windowFrame.minX + 40, y: binding.windowFrame.minY + 90)
            try await ActionRunner.postClick(
              try ActionRunner.eventTarget(for: point, binding: binding), button: .left, count: 1,
              binding: binding, context, restarted: "fixture")
          case "scroll":
            _ = try await ActionRunner.scroll(
              target: .point(CGPoint(x: 40, y: 90)), direction: .down, amount: 1, binding: binding,
              context)
          case "key": _ = try await ActionRunner.key(keys: "x", binding: binding, context)
          default:
            _ = try await ActionRunner.type(text: "never", target: nil, binding: binding, context)
          }
        } catch let error as HelperError { failure = error }
        XCTAssertEqual(boundary.current, 1, route)
        XCTAssertEqual(
          failure, deadline ? WorkBudget.requestExpired : SessionCancelReason.stoppedByUser.error,
          route)
        XCTAssertFalse(context.deliveryProgress.current, route)
      }
    }
  }

  @WorkActor func testTransientReadRecoveryKeepsTheRetainedIdentity() throws {
    let app = hostApp(
      identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    let bound = SessionWindow(
      process: try XCTUnwrap(ProcessStamp.of(getpid())),
      element: AXUIElementCreateApplication(getpid()), windowID: 1)
    app.verified = bound.process
    app.windows[bound.ref] = bound
    let monitor = WindowMonitor()
    let attempts = Locked(0)
    bound.liveness.copyAttribute = { _, _, value in
      let attempt = attempts.withLock {
        $0 += 1
        return $0
      }
      if attempt <= 2 { return .cannotComplete }
      value.pointee = "AXWindow" as CFString
      return .success
    }
    bound.liveness.readPID = { _, value in
      value.pointee = getpid()
      return .success
    }
    bound.liveness.readWindowID = { _, value in
      value.pointee = 1
      return .success
    }
    bound.liveness.isHidden = { _ in false }
    bound.liveness.readServer = { _ in
      KeyWindow.ServerState(
        processIdentifier: getpid(),
        entry: AppWindows.Entry(
          window: ObservedWindow(windowID: 1, frame: CGRect(x: 0, y: 0, width: 200, height: 200)),
          layer: 0, onScreen: true, alpha: 1))
    }
    for _ in 0..<2 {
      XCTAssertThrowsError(try SessionWindows.resolve(app: app, ref: bound.ref, monitor: monitor)) {
        error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
      XCTAssertFalse(bound.closed)
      XCTAssertTrue(app.windows[bound.ref] === bound)
      XCTAssertFalse(app.retiredWindowRefs.contains(bound.ref))
    }
    XCTAssertTrue(try SessionWindows.resolve(app: app, ref: bound.ref, monitor: monitor) === bound)
    XCTAssertTrue(app.windows[bound.ref] === bound)
    XCTAssertFalse(bound.closed)
  }

  @WorkActor func testKeyboardReceiptRedactsTextAfterPlainFocusRead() async throws {
    let field = AXUIElementCreateApplication(111)
    let secure = AXUIElementCreateApplication(222)
    let prepared = Locked(false)
    let reads = Locked<[CGWindowID]>([])
    let delivered = Locked("")
    let app = hostApp(
      identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    defer { app.focus.stop() }
    var calls = hostAccessibility()
    calls.focusedElement = { _ in
      let id: CGWindowID = prepared.current ? 1 : 2
      reads.withLock { $0.append(id) }
      return prepared.current ? secure : field
    }
    calls.window = { element in CFEqual(element, field) ? 2 : 1 }
    calls.attributes = { element in
      ElementAttributes(role: CFEqual(element, field) ? "AXTextField" : "AXSecureTextField")
    }
    var context = hostContext(
      app: app, cancellation: SessionCancellation(), monitor: WindowMonitor(), overlay: nil,
      budget: .unlimited, accessibility: calls)
    context.keyOwner = { _, _ in
      prepared.withLock { $0 = true }
      return (1, secure)
    }
    let text = "plain\tcanary"
    context.input = InputCalls(
      mouse: { _, _, _, _, _, _ in XCTFail("Unexpected mouse post") },
      scroll: { _, _, _, _ in XCTFail("Unexpected scroll post") },
      press: { key, _, characters, destination, _, gate in
        try gate()
        XCTAssertEqual(destination.processIdentifier, getpid())
        XCTAssertEqual(destination.windowID, 1)
        delivered.withLock { $0 += key == 48 ? "\t" : characters ?? "" }
      },
      unicode: { _, _, _, _ in XCTFail("Unexpected unicode post") })
    let binding = ActionRunner.Binding(
      processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 200, height: 200), onScreen: false)
    let receipt = try await ActionRunner.type(text: text, target: nil, binding: binding, context)
    XCTAssertEqual(receipt, "Typed \(text.count) characters")
    XCTAssertEqual(delivered.current, text)
    XCTAssertEqual(reads.current.first, 2)
    XCTAssertEqual(reads.current.last, 1)
    XCTAssertGreaterThanOrEqual(reads.current.count, 2)
  }
}
