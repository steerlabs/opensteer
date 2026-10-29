import Foundation

public enum HostTargetError: Error { case invalidURL, mismatch }

public struct HostTarget {
  public let url: URL
  public init(_ raw: String) throws {
    guard let url = URL(string: raw), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let host = components.host, !host.isEmpty, components.user == nil,
      components.password == nil, components.query == nil, components.fragment == nil,
      components.path.isEmpty || components.path == "/" else { throw HostTargetError.invalidURL }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
    guard components.scheme == "https" || (components.scheme == "http" && loopback) else {
      throw HostTargetError.invalidURL
    }
    self.url = url
  }
  public static func validate(url: String, expectedInstanceId: String, discoveredInstanceId: String) throws {
    _ = try HostTarget(url)
    guard expectedInstanceId == discoveredInstanceId else { throw HostTargetError.mismatch }
  }
}

public enum ConnectionIssue: Equatable {
  case enrollmentExpired, enrollmentRefused, hostUnreachable, hostMismatch, remoteAccessOff
  case removed, needsUpdate, profileMismatch, protocolError, failed
}

public struct ConnectionPolicy {
  public static let followRedirects = false
  private var violations = 0
  public init() {}
  public mutating func violation() -> ConnectionIssue? {
    violations += 1
    return violations >= 2 ? .protocolError : nil
  }
  public mutating func validFrame() { violations = 0 }
  public static func issue(reason: String?, closeCode: Int, enrolling: Bool = false) -> ConnectionIssue {
    if closeCode == 4010 { return .removed }
    if enrolling && reason == nil { return .enrollmentRefused }
    switch reason {
    case "runner-enrollment-expired": return .enrollmentExpired
    case "runner-enrollment-refused": return .enrollmentRefused
    case "personal-remote-access-off": return .remoteAccessOff
    case "runner-device-profile-mismatch": return .profileMismatch
    case "iphone-app-outdated", "runner-proof-format-mismatch": return .needsUpdate
    default: return .failed
    }
  }
  public static func shouldRetry(_ issue: ConnectionIssue) -> Bool {
    switch issue {
    case .removed, .needsUpdate, .profileMismatch, .enrollmentExpired, .enrollmentRefused: return false
    default: return true
    }
  }
}

public enum FrameDecodeError: Error { case tooLarge, invalidJSON, notObject }

public enum FrameDecoder {
  public static let maxBytes = 1_048_576
  public static func decode(_ data: Data) throws -> [String: Any] {
    guard data.count <= maxBytes else { throw FrameDecodeError.tooLarge }
    guard let value = try? JSONSerialization.jsonObject(with: data), let object = value as? [String: Any] else {
      throw FrameDecodeError.notObject
    }
    return object
  }
  public static func encode(_ object: [String: Any]) throws -> Data {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    guard data.count <= maxBytes else { throw FrameDecodeError.tooLarge }
    return data
  }
}
