import Foundation

public enum PhoneBrowserFailure: Error { case forbidden, unavailable, alreadyUsed, full, invalidFrame }

public final class PhoneBrowserAdmission {
  public private(set) var epoch = 0
  public private(set) var fence: AuxiliaryFence?
  public private(set) var leaseDeadline: Int64 = 0
  public var primaryLeaseDeadline: Int64 = .max
  public private(set) var capability: [String: Any]?
  public private(set) var capabilityDeadline: Int64 = 0
  private var heartbeatAt: Int64 = 0

  public init() {}

  public func setEpoch(_ value: Int) throws {
    guard value >= epoch, value >= 0, value <= 9_007_199_254_740_991 else { throw PhoneBrowserFailure.forbidden }
    if value != epoch { retire(); epoch = value }
  }

  public func retire() {
    epoch += 1; release()
  }

  public func release() { fence = nil; leaseDeadline = 0; capability = nil; capabilityDeadline = 0 }

  public func advanceEpoch() -> Int { epoch += 1; return epoch }

  public func adopt(_ welcome: [String: Any], now: Int64) throws {
    try WireField.type(welcome, "host.auxiliary.welcome")
    let next = try AuxiliaryFence(welcome)
    try PhoneBrowserValidation.fence(welcome)
    guard next.module == "browser" else { throw PhoneBrowserFailure.forbidden }
    let deadline = try Self.milliseconds(welcome, "streamLeaseExpiresAt")
    guard deadline > now else { throw PhoneBrowserFailure.unavailable }
    fence = next; leaseDeadline = deadline; heartbeatAt = 0; capability = nil
  }

  public func renew(until deadline: Int64, now: Int64) throws {
    guard fence != nil, leaseDeadline > now else { throw PhoneBrowserFailure.unavailable }
    leaseDeadline = max(leaseDeadline, deadline)
  }

  public func accepts(_ fields: [String: Any], epoch: Int, now: Int64) -> Bool {
    epoch == self.epoch && leaseDeadline > now && primaryLeaseDeadline > now && fence != nil && (try? AuxiliaryFence(fields)) == fence
  }

  public func check(epoch: Int, now: Int64, capability requested: [String: Any]? = nil) throws {
    guard epoch == self.epoch, fence != nil, leaseDeadline > now, primaryLeaseDeadline > now else { throw PhoneBrowserFailure.unavailable }
    if let requested {
      guard capabilityDeadline > now, let capability,
        Self.sameCapability(requested, capability) else { throw PhoneBrowserFailure.forbidden }
    }
  }

  public func grant(_ lease: [String: Any], now: Int64) throws {
    guard Set(lease.keys) == Set(["runtimeId", "capabilityLeaseId", "capabilityGeneration", "expiresAt"]),
      try WireField.string(lease, "runtimeId").utf16.count <= 255,
      PhoneBrowserValidation.identifier(try WireField.string(lease, "capabilityLeaseId"), prefix: "bcl") else { throw PhoneBrowserFailure.forbidden }
    _ = try WireField.int(lease, "capabilityGeneration", range: 1...9_007_199_254_740_991)
    let deadline = try Self.milliseconds(lease, "expiresAt")
    guard deadline > now else { throw PhoneBrowserFailure.forbidden }
    if let capability {
      let old = try WireField.int(capability, "capabilityGeneration", range: 1...9_007_199_254_740_991)
      let next = try WireField.int(lease, "capabilityGeneration", range: 1...9_007_199_254_740_991)
      guard next > old || (next == old && capabilityDeadline > now && Self.sameCapability(lease, capability)) else { throw PhoneBrowserFailure.forbidden }
    }
    capability = lease; capabilityDeadline = deadline
  }

  public func revoke(_ reference: [String: Any]) {
    if let capability, Self.sameCapability(reference, capability) { capabilityDeadline = 0 }
  }

  public func heartbeat(now: Int64) -> String {
    heartbeatAt = max(now, heartbeatAt + 1)
    return ISO8601DateFormatter.phoneBrowser.string(from: Date(timeIntervalSince1970: Double(heartbeatAt) / 1000))
  }

  public static func sameCapability(_ left: [String: Any], _ right: [String: Any]) -> Bool {
    ["runtimeId", "capabilityLeaseId", "capabilityGeneration"].allSatisfy {
      guard let first = left[$0] as? NSObject, let second = right[$0] as? NSObject else { return false }
      return first == second
    }
  }

  public static func milliseconds(_ fields: [String: Any], _ name: String) throws -> Int64 {
    Int64(try WireField.date(fields, name).timeIntervalSince1970 * 1000)
  }
}

extension ISO8601DateFormatter {
  static var phoneBrowser: ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }
}
