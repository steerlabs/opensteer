import Foundation
import OpensteerAppleData

/// The production invocation path. iOS supplies the real EventKit/Contacts
/// actors; the non-simulator journey supplies explicitly fake OS actors.
public final class IphoneDispatch: @unchecked Sendable {
  private let lock = NSRecursiveLock()
  private let gate: AdmissionGate
  private let clock: any MonotonicClock
  private let providers: [String: any DataProvider]
  private let onWorkChange: (@Sendable () -> Void)?
  private struct Request {
    let ticket: AdmissionTicket
    var task: Task<JSONValue, Error>?
  }
  private var requests: [String: Request] = [:]

  public init(gate: AdmissionGate, clock: any MonotonicClock,
    providers: [String: any DataProvider], onWorkChange: (@Sendable () -> Void)? = nil) {
    self.gate = gate
    self.clock = clock
    self.providers = providers
    self.onWorkChange = onWorkChange
  }

  public func cancel(_ requestId: String) {
    lock.lock()
    let request = requests[requestId]
    let decision = gate.cancel(request?.ticket)
    if decision == .notStarted { requests.removeValue(forKey: requestId) }
    lock.unlock()
    // A write that crossed its fence still reports its actual outcome.
    if decision == .notStarted { request?.task?.cancel(); onWorkChange?() }
  }

  public func cancelAll(generation: UInt64? = nil) {
    lock.lock()
    let removed = requests.filter { generation == nil || $0.value.ticket.generation == generation }
    for (id, request) in removed {
      _ = gate.cancel(request.ticket)
      requests.removeValue(forKey: id)
    }
    lock.unlock()
    for request in removed.values { request.task?.cancel() }
    if !removed.isEmpty { onWorkChange?() }
  }

  private func admit(_ requestId: String, fence: String, timeoutMs: Int, effect: DataEffect) -> AdmissionDecision {
    lock.lock(); defer { lock.unlock() }
    guard requests[requestId] == nil else { return .busy }
    // Admission and registration share a turn with cancelAll, so teardown
    // cannot run between accepting a ticket and finding the task it owns.
    let decision = gate.admit(fence: fence, timeoutMs: timeoutMs, effect: effect)
    if let ticket = decision.ticket { requests[requestId] = Request(ticket: ticket) }
    return decision
  }

  private func start(_ requestId: String, ticket: AdmissionTicket, provider: any DataProvider,
    operation: String, arguments: [String: JSONValue], budget: WorkBudget) -> Task<JSONValue, Error>? {
    lock.lock(); defer { lock.unlock() }
    guard requests[requestId]?.ticket == ticket else { return nil }
    let task = Task {
      try Task.checkCancellation()
      return try await provider.invoke(operation: operation, arguments: arguments, budget: budget)
    }
    requests[requestId]?.task = task
    return task
  }

  private func forget(_ requestId: String, ticket: AdmissionTicket) {
    lock.lock(); defer { lock.unlock() }
    if requests[requestId]?.ticket == ticket { requests.removeValue(forKey: requestId) }
  }

  public func run(_ frame: [String: Any], fence: AuxiliaryFence, receivedAt: UInt64,
    permission: IphonePermission, deviceName: String) async -> [String: Any]? {
    guard let requestId = frame["requestId"] as? String, !requestId.isEmpty else { return nil }
    let invoke: IphoneInvoke
    do { invoke = try IphoneWire.invoke(frame, expected: fence) }
    catch { return IphoneWire.error(fence, requestId: requestId, code: "invalid-arguments",
      message: "These arguments could not be read.") }
    let elapsed = Int((clock.now() - receivedAt) / 1_000_000)
    let remainingMs = invoke.timeoutMs - elapsed
    let decision = admit(requestId, fence: fence.tag, timeoutMs: remainingMs, effect: invoke.effect)
    guard let ticket = decision.ticket else {
      let sentence = decision == .background ? AdmissionGate.backgroundSentence(name: deviceName)
        : "This iPhone could not start that request."
      return IphoneWire.error(fence, requestId: requestId, code: "failed", message: sentence)
    }
    onWorkChange?()
    defer { forget(requestId, ticket: ticket); onWorkChange?() }

    if let refusal = InvokeRules.validate(definitionId: invoke.definitionId, operation: invoke.operation,
      contract: invoke.contract, effect: invoke.effect, access: invoke.access, permission: permission) {
      guard gate.complete(ticket) else { return nil }
      switch refusal {
      case .unsupported:
        return IphoneWire.error(fence, requestId: requestId, code: "unsupported",
          message: "This operation comes from a different Opensteer version.")
      case .readOnly:
        return IphoneWire.error(fence, requestId: requestId, code: "failed", message: "This app is read only.")
      case .permissionRequired:
        return IphoneWire.error(fence, requestId: requestId, code: "permission-required",
          message: InvokeRules.permissionStatus(permission, app: invoke.definitionId).detail ??
            "Allow this app in iPhone Settings.")
      }
    }
    guard let provider = providers[invoke.definitionId] else {
      guard gate.complete(ticket) else { return nil }
      return IphoneWire.error(fence, requestId: requestId, code: "unsupported",
        message: "This iPhone does not serve that app.")
    }
    let budget = WorkBudget(requestEnd: Date().addingTimeInterval(Double(max(0, remainingMs - 1_000)) / 1_000),
      writeStart: { [gate] in
        guard gate.beginWrite(ticket) == .started else {
          throw HelperError(.failed, AdmissionGate.backgroundSentence(name: deviceName))
        }
      })
    do {
      guard let task = start(requestId, ticket: ticket, provider: provider,
        operation: invoke.operation, arguments: invoke.arguments, budget: budget) else { return nil }
      let value = try await task.value
      guard gate.complete(ticket) else { return nil }
      return IphoneWire.result(fence, requestId: requestId, value: value)
    } catch let error as IphoneArgumentsError {
      guard gate.complete(ticket) else { return nil }
      return IphoneWire.error(fence, requestId: requestId, code: "invalid-arguments", message: error.message)
    } catch let error as HelperError {
      guard gate.complete(ticket) else { return nil }
      let code: String
      switch error.code {
      case .permissionRequired: code = "permission-required"
      case .unsupported: code = "unsupported"
      case .outcomeUnknown: code = "outcome-unknown"
      default: code = "failed"
      }
      return IphoneWire.error(fence, requestId: requestId, code: code, message: error.message)
    } catch {
      guard gate.complete(ticket) else { return nil }
      let mapped = InvokeRules.providerError(effect: invoke.effect)
      return IphoneWire.error(fence, requestId: requestId, code: mapped.code.rawValue, message: mapped.message)
    }
  }
}
