import Foundation

/// `ComputerAppIdentity` on the wire, spelled exactly as
/// `packages/integration-core/src/computer-app.ts` spells it: the bundle
/// identifier, the display name at approval time, and the signing team
/// (`null` for an unsigned app). The bundle identifier is the durable key; the
/// process id and window never are.
public struct AppIdentity: Codable, Sendable, Equatable, Hashable {
  public let bundleId: String
  public let displayName: String
  public let teamId: String?

  public init(bundleId: String, displayName: String, teamId: String?) {
    self.bundleId = bundleId
    self.displayName = displayName
    self.teamId = teamId
  }

  /// An unsigned app — and every Apple platform binary — has no team, and the
  /// protocol says that is `null`. Swift would leave the key out entirely,
  /// which is a different shape to a strict schema.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(bundleId, forKey: .bundleId)
    try container.encode(displayName, forKey: .displayName)
    try container.encode(teamId, forKey: .teamId)
  }

  private enum CodingKeys: String, CodingKey {
    case bundleId, displayName, teamId
  }
}

/// The app one observe or act targets: the identity the Host resolved from
/// the connection and the access it resolved from the effective grant. Every
/// call carries it, so the helper enforces the target of each call rather than
/// a list declared when the session opened.
public struct SessionApp: Decodable, Sendable, Equatable {
  public let access: AppAccess
  public let identity: AppIdentity

  public init(access: AppAccess, identity: AppIdentity) {
    self.access = access
    self.identity = identity
  }
}

/// One filtered installed-app row. Icons are omitted unless requested and available.
public struct InstalledApp: Encodable, Sendable {
  public let identity: AppIdentity
  public let running: Bool
  public let iconPng: String?
}

/// The answer to `app.resolve`, before anybody approves the app.
public struct ResolvedApp: Encodable, Sendable {
  public let allowed: Bool
  public let identity: AppIdentity
  public let path: String
  public let reason: String
  public let risk: AppRisk
  public let running: Bool
}

/// How much a session may do with one app, in the protocol's words (§1).
public enum AppAccess: String, Codable, Sendable {
  case read
  case readWrite = "read-write"
}
