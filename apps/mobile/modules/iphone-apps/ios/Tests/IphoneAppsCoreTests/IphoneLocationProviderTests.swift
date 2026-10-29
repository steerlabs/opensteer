import Foundation
import XCTest
import OpensteerAppleData
@testable import IphoneAppsCore

@MainActor
final class IphoneLocationProviderTests: XCTestCase {
  func testStrictArgumentsAndPermissionNeverStartOSWork() async throws {
    let store = FakeLocationPort()
    let provider = IphoneLocationProvider(store: store)
    let invalidArguments: [[String: JSONValue]] = [["maxAgeSeconds": .number(-1)], ["maxAgeSeconds": .number(301)],
      ["maxAgeSeconds": .number(0.5)], ["maxAgeSeconds": .bool(true)], ["other": .null]]
    for args in invalidArguments {
      do { _ = try await provider.invoke(operation: "current_location", arguments: args, budget: .unlimited); XCTFail() }
      catch { XCTAssertTrue(error is IphoneArgumentsError) }
    }
    for permission in [IphonePermission.denied, .notDetermined, .restricted] {
      store.permission = permission
      do { _ = try await provider.invoke(operation: "current_location", arguments: [:], budget: .unlimited); XCTFail() }
      catch { XCTAssertEqual((error as? HelperError)?.code, .permissionRequired) }
    }
    XCTAssertEqual(store.starts, 0)
  }

  func testFreshCacheAndIndependentApproximateLabel() async throws {
    let store = FakeLocationPort()
    store.precise = false
    store.cachedLocation = fix(Date().addingTimeInterval(-2))
    let result = try await IphoneLocationProvider(store: store).invoke(operation: "current_location", arguments: [:], budget: .unlimited)
    guard case .object(let value) = result else { return XCTFail() }
    XCTAssertEqual(value["accuracy"], .string("approximate"))
    XCTAssertEqual(store.starts, 0)
  }

  func testInvalidFixesAndZeroAgeWaitForNewFix() async throws {
    let store = FakeLocationPort()
    store.cachedLocation = fix(Date())
    let provider = IphoneLocationProvider(store: store)
    let task = Task { try await provider.invoke(operation: "current_location", arguments: ["maxAgeSeconds": .number(0)], budget: .unlimited) }
    await waitForStart(store)
    store.onChange?(.fixes([fix(Date().addingTimeInterval(-10)), fix(Date().addingTimeInterval(2)),
      IphoneLocationFix(latitude: .nan, longitude: 1, horizontalAccuracyMeters: 2, capturedAt: Date()),
      IphoneLocationFix(latitude: 1, longitude: 1, horizontalAccuracyMeters: -1, capturedAt: Date())]))
    XCTAssertEqual(store.stops, 0)
    store.onChange?(.fixes([fix(Date())]))
    _ = try await task.value
    XCTAssertEqual(store.stops, 1)
  }

  func testConcurrentCancellationAndLateCallbacks() async throws {
    let store = FakeLocationPort()
    let provider = IphoneLocationProvider(store: store)
    let first = Task { try await provider.invoke(operation: "current_location", arguments: [:], budget: .unlimited) }
    let second = Task { try await provider.invoke(operation: "current_location", arguments: [:], budget: .unlimited) }
    await waitForStart(store)
    await Task.yield()
    first.cancel()
    do { _ = try await first.value; XCTFail() } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(store.starts, 1)
    XCTAssertEqual(store.stops, 0)
    store.onChange?(.fixes([fix(Date())]))
    _ = try await second.value
    XCTAssertEqual(store.stops, 1)
    store.onChange?(.fixes([fix(Date())]))
    XCTAssertEqual(store.stops, 1)
  }

  func testBackgroundPermissionLossAndDeadlineStopUpdates() async throws {
    for mode in 0..<3 {
      let store = FakeLocationPort()
      let provider = IphoneLocationProvider(store: store)
      let budget = mode == 2 ? WorkBudget(requestEnd: Date().addingTimeInterval(0.03)) : .unlimited
      let task = Task { try await provider.invoke(operation: "current_location", arguments: [:], budget: budget) }
      await waitForStart(store)
      if mode == 0 { store.foreground = false; store.onChange?(.stateChanged) }
      if mode == 1 { store.permission = .denied; store.onChange?(.stateChanged) }
      do { _ = try await task.value; XCTFail() }
      catch { XCTAssertEqual((error as? HelperError)?.code, mode == 1 ? .permissionRequired : .failed) }
      XCTAssertEqual(store.stops, 1)
    }
  }

  private func waitForStart(_ store: FakeLocationPort) async {
    for _ in 0..<100 where store.starts == 0 { await Task.yield() }
    XCTAssertEqual(store.starts, 1)
  }
  private func fix(_ date: Date) -> IphoneLocationFix {
    IphoneLocationFix(latitude: 40, longitude: -73, horizontalAccuracyMeters: 8, capturedAt: date)
  }
}

@MainActor
private final class FakeLocationPort: IphoneLocationPort {
  var permission = IphonePermission.granted
  var precise = true
  var foreground = true
  var cachedLocation: IphoneLocationFix?
  var onChange: (@MainActor @Sendable (IphoneLocationEvent) -> Void)?
  var starts = 0
  var stops = 0
  func startUpdating() { starts += 1 }
  func stopUpdating() { stops += 1 }
}
