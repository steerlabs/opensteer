import Foundation

public final class ApprovalRules {
  private let runnerId: String
  private let keyId: String
  private var requests: [String: [String: Any]] = [:]
  public init(runnerId: String, keyId: String) {
    self.runnerId = runnerId
    self.keyId = keyId
  }
  public func replace(_ requests: [[String: Any]]) {
    var selected: [String: [String: Any]] = [:]
    for request in requests {
      guard let id = request["id"] as? String,
        request["runnerId"] as? String == runnerId,
        request["kind"] as? String == "app",
        InvokeRules.apps.contains(request["definitionId"] as? String ?? "") else { continue }
      selected[id] = request
    }
    self.requests = selected
  }
  public func request(_ id: String) -> [String: Any]? { requests[id] }
  public func mayAnswer(requestId: String, expectedDefinition: String, expectedAccess: String, now: Date = Date()) -> Bool {
    guard let request = requests[requestId],
      request["definitionId"] as? String == expectedDefinition,
      request["access"] as? String == expectedAccess,
      let expires = request["expiresAt"] as? String,
      let expiry = ISO8601DateFormatter.fractional.date(from: expires) else { return false }
    return expiry > now
  }
  public func mayProve(keyId: String, runnerId: String) -> Bool {
    keyId == self.keyId && runnerId == self.runnerId
  }
  public func registered(hostKeyId: String?) -> Bool { hostKeyId == keyId }
}

private extension ISO8601DateFormatter {
  static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}
