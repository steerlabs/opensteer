import Foundation
import XCTest
import OpensteerAppleData
@testable import IphoneAppsCore

// A cancelled call must stop its provider, and an old completion must never
// remove a later call that happens to reuse the same Host request ID.
final class IphoneDispatchCancellationTests: XCTestCase {
  func testHostCancelReachesTheProviderAndDropsItsAnswer() async throws {
    let started = expectation(description: "provider started")
    let cancelled = expectation(description: "provider cancelled")
    let provider = SuspendedProvider(started: started, cancelled: cancelled)
    let (dispatch, gate, fence) = try setup(provider)
    let call = Task { await dispatch.run(frame(fence), fence: fence, receivedAt: 0,
      permission: .granted, deviceName: "Test iPhone") }
    await fulfillment(of: [started], timeout: 1)
    dispatch.cancel("request")
    await fulfillment(of: [cancelled], timeout: 1)
    provider.finish()
    let result = await call.value
    XCTAssertNil(result)
    XCTAssertEqual(gate.inFlight, 0)
  }

  func testStartedWriteStillReportsItsOutcomeAfterHostCancel() async throws {
    let started = expectation(description: "write started")
    let provider = SuspendedProvider(started: started, write: true)
    let (dispatch, gate, fence) = try setup(provider)
    let call = Task { await dispatch.run(frame(fence, write: true), fence: fence, receivedAt: 0,
      permission: .granted, deviceName: "Test iPhone") }
    await fulfillment(of: [started], timeout: 1)
    dispatch.cancel("request")
    XCTAssertEqual(provider.cancelCount, 0)
    XCTAssertEqual(gate.inFlight, 1)
    provider.finish()
    let result = await call.value
    XCTAssertEqual((result?["result"] as? [String: Any])?["kind"] as? String, "ok")
  }

  func testCancelledCompletionCannotForgetReplacement() async throws {
    let started = expectation(description: "two calls started"); started.expectedFulfillmentCount = 2
    let cancelled = expectation(description: "both cancelled"); cancelled.expectedFulfillmentCount = 2
    let provider = SuspendedProvider(started: started, cancelled: cancelled)
    let (dispatch, _, fence) = try setup(provider)
    let firstStarted = expectation(description: "first starts")
    provider.firstStarted = firstStarted
    let first = Task { await dispatch.run(frame(fence), fence: fence, receivedAt: 0,
      permission: .granted, deviceName: "Test iPhone") }
    await fulfillment(of: [firstStarted], timeout: 1)
    dispatch.cancel("request")
    let second = Task { await dispatch.run(frame(fence), fence: fence, receivedAt: 0,
      permission: .granted, deviceName: "Test iPhone") }
    await fulfillment(of: [started], timeout: 1)
    provider.finish(index: 0)
    _ = await first.value
    dispatch.cancel("request")
    await fulfillment(of: [cancelled], timeout: 1)
    provider.finish(index: 1)
    let result = await second.value
    XCTAssertNil(result)
  }

  func testTeardownCancelsProvidersButStaleGenerationDoesNotCancelNewCalls() async throws {
    let started = expectation(description: "provider started")
    let cancelled = expectation(description: "provider cancelled")
    let provider = SuspendedProvider(started: started, cancelled: cancelled)
    let (dispatch, gate, fence) = try setup(provider)
    let generation = gate.generation
    let call = Task { await dispatch.run(frame(fence), fence: fence, receivedAt: 0,
      permission: .granted, deviceName: "Test iPhone") }
    await fulfillment(of: [started], timeout: 1)
    dispatch.cancelAll(generation: generation - 1)
    XCTAssertEqual(provider.cancelCount, 0)
    gate.disconnect()
    dispatch.cancelAll()
    await fulfillment(of: [cancelled], timeout: 1)
    provider.finish()
    let result = await call.value
    XCTAssertNil(result)
  }

  private func setup(_ provider: SuspendedProvider) throws -> (IphoneDispatch, AdmissionGate, AuxiliaryFence) {
    let clock = DispatchClock()
    let fence = try AuxiliaryFence(["runnerId": "rnr_test", "bootId": "rbt_test",
      "connectionId": "connection", "connectionLeaseId": "lease", "connectionGeneration": 1,
      "auxiliaryStreamId": "stream", "module": "integrations"])
    let gate = AdmissionGate(runnerId: "rnr_test", bootId: "rbt_test", clock: clock)
    gate.activate(); gate.attach(fence: fence.tag, leaseSeconds: 30)
    return (IphoneDispatch(gate: gate, clock: clock, providers: ["apple-calendar": provider]), gate, fence)
  }
  private func frame(_ fence: AuxiliaryFence, write: Bool = false) -> [String: Any] {
    let operation = write ? "create_event" : "list_calendars"
    return fence.fields.merging(["type": "host.integrations.invoke", "requestId": "request",
      "definitionId": "apple-calendar", "operation": operation,
      "contract": InvokeRules.contract("apple-calendar", operation)!, "access": "read-write",
      "arguments": [String: Any](), "timeoutMs": 30_000]) { _, new in new }
  }
}
private final class DispatchClock: MonotonicClock { func now() -> UInt64 { 0 } }
private final class SuspendedProvider: DataProvider, @unchecked Sendable {
  private let lock = NSLock()
  private var continuations: [CheckedContinuation<JSONValue, Error>?] = []
  private var cancellations = 0
  let started: XCTestExpectation
  let cancelled: XCTestExpectation?
  let write: Bool
  var firstStarted: XCTestExpectation?
  var cancelCount: Int { lock.lock(); defer { lock.unlock() }; return cancellations }
  init(started: XCTestExpectation, cancelled: XCTestExpectation? = nil, write: Bool = false) {
    self.started = started; self.cancelled = cancelled; self.write = write
  }
  func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue {
    if write { try budget.startWrite() }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        lock.lock(); continuations.append(continuation); let first = continuations.count == 1; lock.unlock()
        started.fulfill()
        if first { firstStarted?.fulfill() }
      }
    } onCancel: {
      self.lock.lock(); self.cancellations += 1; self.lock.unlock()
      self.cancelled?.fulfill()
    }
  }
  func finish(index: Int = 0) {
    lock.lock()
    let continuation = continuations.indices.contains(index) ? continuations[index] : nil
    if continuations.indices.contains(index) { continuations[index] = nil }
    lock.unlock()
    continuation?.resume(returning: .object([:]))
  }
}
