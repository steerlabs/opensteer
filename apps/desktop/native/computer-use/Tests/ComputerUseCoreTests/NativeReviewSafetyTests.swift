import ApplicationServices
import CoreGraphics
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class NativeReviewSafetyTests: XCTestCase {

  @WorkActor
  func testStopDuringTheLastElementReadPreventsValueMutation() async throws {
    let cancellation = SessionCancellation()
    let app = hostApp(
      identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    let handle = AXUIElementCreateApplication(getpid())
    app.latest = LatestObservation(
      observationId: "snapshot", processIdentifier: getpid(), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 200, height: 200),
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 200, height: 200)),
      elements: [
        ObservedElement(
          node: AXElementNode(handle), attributes: ElementAttributes(role: "AXTextField"),
          frame: CGRect(x: 20, y: 20, width: 80, height: 30), depth: 0)
      ], takenAt: Date())
    let writes = Locked(0)
    var calls = hostAccessibility()
    calls.isSettable = { _, _ in true }
    calls.attributes = { _ in ElementAttributes(role: "AXTextField") }
    calls.setAttribute = { _, _, _ in
      writes.withLock { $0 += 1 }
      return .success
    }
    var context = hostContext(
      app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
      budget: .unlimited, accessibility: calls)
    context.requireUnlocked = {}
    context.elementCheck = { _, _ in cancellation.cancel(.stoppedByUser) }
    let binding = ActionRunner.Binding(
      processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 200, height: 200), onScreen: false)
    do {
      _ = try await ActionRunner.setValue(index: 0, value: "never", binding: binding, context)
      XCTFail("Stop during final AX validation must win")
    } catch let error as HelperError { XCTAssertEqual(error.code, .stoppedByUser) }
    XCTAssertEqual(writes.current, 0)
  }

  @MainActor
  func testPublicationFailureKeepsCompletedReceiptsAfterStop() async {
    let cancellation = SessionCancellation()
    let result = await HelperRuntime.finishAct(
      ActionRunner.RunResult(performed: ["Clicked first"], error: nil), cancellation: cancellation,
      publish: {
        cancellation.cancel(.stoppedByUser)
        throw HelperError(.noSession, "closed")
      })
    XCTAssertEqual(result.performed, ["Clicked first"])
    XCTAssertEqual(result.error?.code, .stoppedByUser)
  }
  /// These call the production mutation routes. A late Stop in the final
  /// retained-element validation must prevent the actual AX call, not merely
  /// make a separately invoked gate throw.
  @WorkActor
  func testLateValidationStopsEveryAXMutationRoute() async throws {
    for route in ["press", "value", "focus", "selected-text"] {
      for deadline in [false, true] {
        let cancellation = SessionCancellation()
        let handle = AXUIElementCreateApplication(getpid())
        let app = hostApp(
          identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
          path: "/tmp/Fixture.app")
        defer { app.focus.stop() }
        let frame = CGRect(x: 0, y: 0, width: 200, height: 200)
        app.latest = LatestObservation(
          observationId: "snapshot", processIdentifier: getpid(), windowID: 1, windowFrame: frame,
          coordinates: ObservationCoordinates(
            cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 200, height: 200)),
          elements: [
            ObservedElement(
              node: AXElementNode(handle), attributes: ElementAttributes(role: "AXTextField"),
              frame: CGRect(x: 20, y: 20, width: 80, height: 30), depth: 0)
          ], takenAt: Date())
        let writes = Locked(0)
        let validations = Locked(0)
        let budget = deadline ? WorkBudget(requestEnd: Date().addingTimeInterval(2)) : .unlimited
        var calls = hostAccessibility()
        calls.offersPress = { _ in true }
        calls.isSettable = { _, _ in true }
        calls.focusedElement = { _ in handle }
        calls.window = { _ in 1 }
        calls.attributes = { _ in ElementAttributes(role: "AXTextField") }
        calls.press = { _ in
          writes.withLock { $0 += 1 }
          return .success
        }
        calls.setAttribute = { _, _, _ in
          writes.withLock { $0 += 1 }
          return .success
        }
        var context = hostContext(
          app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
          budget: budget, accessibility: calls)
        context.requireUnlocked = {}
        context.elementCheck = { _, _ in
          validations.withLock { $0 += 1 }
          if deadline {
            Thread.sleep(forTimeInterval: max(0, budget.remaining()) + 0.005)
          } else {
            cancellation.cancel(.stoppedByUser)
          }
        }
        let binding = ActionRunner.Binding(
          processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
          windowFrame: frame, onScreen: false)
        do {
          switch route {
          case "press":
            _ = try await ActionRunner.click(
              target: .index(0), button: .left, count: 1, binding: binding, context)
          case "value":
            _ = try await ActionRunner.setValue(index: 0, value: "never", binding: binding, context)
          case "focus":
            _ = try await ActionRunner.type(
              text: "never", target: .index(0), binding: binding, context)
          default:
            _ = try await ActionRunner.type(text: "never", target: nil, binding: binding, context)
          }
          XCTFail("Late Stop lost on \(route)")
        } catch {
          XCTAssertEqual(
            error as? HelperError,
            deadline ? WorkBudget.requestExpired : SessionCancelReason.stoppedByUser.error, route)
        }
        XCTAssertEqual(validations.current, 1, "The late read must actually run: " + route)
        XCTAssertEqual(writes.current, 0, route)
        XCTAssertFalse(context.deliveryProgress.current, route)
      }
    }
  }

  @WorkActor
  func testStopDuringTheFinalMenuPathReadPreventsTheMenuPress() async throws {
    for deadline in [false, true] {
      let cancellation = SessionCancellation()
      let reads = Locked(0)
      let writes = Locked(0)
      let budget = deadline ? WorkBudget(requestEnd: Date().addingTimeInterval(2)) : .unlimited
      let handle = AXUIElementCreateApplication(getpid())
      let app = hostApp(
        identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
        path: "/tmp/Fixture.app")
      defer { app.focus.stop() }
      var calls = hostAccessibility()
      calls.menuLookup = { _, _, _ in .item(handle) }
      calls.menuPath = { _ in
        reads.withLock { $0 += 1 }
        if deadline {
          Thread.sleep(forTimeInterval: max(0, budget.remaining()) + 0.005)
        } else {
          cancellation.cancel(.stoppedByUser)
        }
        return ["File", "Save"]
      }
      calls.press = { _ in
        writes.withLock { $0 += 1 }
        return .success
      }
      var context = hostContext(
        app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
        budget: budget, accessibility: calls)
      context.requireUnlocked = {}
      let binding = ActionRunner.Binding(
        processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
        windowFrame: .zero, onScreen: false)
      do {
        _ = try await ActionRunner.key(keys: "cmd+s", binding: binding, context)
        XCTFail("Menu press followed Stop")
      } catch {
        XCTAssertEqual(
          error as? HelperError,
          deadline ? WorkBudget.requestExpired : SessionCancelReason.stoppedByUser.error)
      }
      XCTAssertEqual(reads.current, 1)
      XCTAssertEqual(writes.current, 0)
      XCTAssertFalse(context.deliveryProgress.current)
    }
  }
}
