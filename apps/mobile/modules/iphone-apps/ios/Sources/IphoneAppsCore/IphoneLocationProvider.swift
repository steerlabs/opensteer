import Foundation
import OpensteerAppleData

public struct IphoneLocationFix: Sendable {
  public let latitude: Double
  public let longitude: Double
  public let horizontalAccuracyMeters: Double
  public let capturedAt: Date
  public init(latitude: Double, longitude: Double, horizontalAccuracyMeters: Double, capturedAt: Date) {
    self.latitude = latitude
    self.longitude = longitude
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
    self.capturedAt = capturedAt
  }
}

public enum IphoneLocationEvent: Sendable {
  case fixes([IphoneLocationFix]), stateChanged, failed
}

@MainActor
public protocol IphoneLocationPort: AnyObject, Sendable {
  var permission: IphonePermission { get }
  var precise: Bool { get }
  var foreground: Bool { get }
  var cachedLocation: IphoneLocationFix? { get }
  var onChange: (@MainActor @Sendable (IphoneLocationEvent) -> Void)? { get set }
  func startUpdating()
  func stopUpdating()
}

@MainActor
public final class IphoneLocationProvider: DataProvider {
  private struct Waiter {
    let started: Date
    let maxAge: Double
    let deadline: Date
    let continuation: CheckedContinuation<JSONValue, Error>
    let timeout: Task<Void, Never>
  }
  private let store: any IphoneLocationPort
  private let deviceName: String
  private var waiters: [UUID: Waiter] = [:]
  private static let unavailable = HelperError(.failed, "Couldn't get a current location. Keep Opensteer open and try again.")

  public init(store: any IphoneLocationPort, deviceName: String = "this iPhone") {
    self.store = store
    self.deviceName = deviceName
    store.onChange = { [weak self] event in self?.receive(event) }
  }

  public func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue {
    guard operation == "current_location" else { throw HelperError(.unsupported, "This Location operation isn't supported.") }
    guard arguments.keys.allSatisfy({ $0 == "maxAgeSeconds" }) else { throw IphoneArgumentsError("Unknown Location argument.") }
    var maxAge: Double = 30
    if let value = arguments["maxAgeSeconds"] {
      guard case .number(let number) = value, number.isFinite, number.rounded() == number,
        (0...300).contains(number) else { throw IphoneArgumentsError("maxAgeSeconds must be an integer from 0 to 300.") }
      maxAge = number
    }
    try Task.checkCancellation()
    try checkState()
    let started = Date()
    guard budget.remaining(now: started) > 0 else { throw Self.unavailable }
    if maxAge > 0, let fix = store.cachedLocation, valid(fix, started: started, maxAge: maxAge) { return result(fix) }
    let id = UUID()
    let delay = min(15, budget.remaining(now: started))
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        let timeout = Task { [weak self] in
          do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
          catch { return }
          self?.finish(id, .failure(Self.unavailable))
        }
        let first = waiters.isEmpty
        waiters[id] = Waiter(started: started, maxAge: maxAge, deadline: started.addingTimeInterval(delay), continuation: continuation, timeout: timeout)
        if first { store.startUpdating() }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.finish(id, .failure(CancellationError())) }
    }
  }

  private func checkState() throws {
    guard store.foreground else { throw HelperError(.failed, AdmissionGate.backgroundSentence(name: deviceName)) }
    guard store.permission == .granted else { throw HelperError(.permissionRequired, "Allow Location in Opensteer on this iPhone before trying again.") }
  }
  private func valid(_ fix: IphoneLocationFix, started: Date, maxAge: Double) -> Bool {
    let now = Date()
    return fix.latitude.isFinite && (-90...90).contains(fix.latitude)
      && fix.longitude.isFinite && (-180...180).contains(fix.longitude)
      && fix.horizontalAccuracyMeters.isFinite && fix.horizontalAccuracyMeters > 0
      && fix.capturedAt.timeIntervalSince1970.isFinite && fix.capturedAt <= now
      && (maxAge == 0 ? fix.capturedAt >= started : fix.capturedAt >= now.addingTimeInterval(-maxAge))
  }
  private func result(_ fix: IphoneLocationFix) -> JSONValue {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return .object(["latitude": .number(fix.latitude), "longitude": .number(fix.longitude),
      "horizontalAccuracyMeters": .number(fix.horizontalAccuracyMeters),
      "capturedAt": .string(formatter.string(from: fix.capturedAt)),
      "accuracy": .string(store.precise ? "precise" : "approximate")])
  }
  private func receive(_ event: IphoneLocationEvent) {
    guard !waiters.isEmpty else { return }
    do { try checkState() } catch {
      for id in Array(waiters.keys) { finish(id, .failure(error)) }
      return
    }
    switch event {
    case .stateChanged: break
    case .failed:
      for id in Array(waiters.keys) { finish(id, .failure(Self.unavailable)) }
    case .fixes(let fixes):
      for (id, waiter) in Array(waiters) {
        guard Date() < waiter.deadline else { finish(id, .failure(Self.unavailable)); continue }
        if let fix = fixes.reversed().first(where: { valid($0, started: waiter.started, maxAge: waiter.maxAge) }) {
          finish(id, .success(result(fix)))
        }
      }
    }
  }
  private func finish(_ id: UUID, _ result: Result<JSONValue, Error>) {
    guard let waiter = waiters.removeValue(forKey: id) else { return }
    waiter.timeout.cancel()
    if waiters.isEmpty { store.stopUpdating() }
    waiter.continuation.resume(with: result)
  }
}
