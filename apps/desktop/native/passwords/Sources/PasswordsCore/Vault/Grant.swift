import Foundation

/// The personal Deployment and site a grant answers for: at most one grant
/// per key. Keys compare as UTF-8 bytes, never by Unicode equivalence, so two
/// IDs that only look alike are two keys.
public struct GrantKey: Hashable, Sendable {
  public let deploymentId: String
  /// `https://<registrable domain>`.
  public let site: String

  public init(deploymentId: String, site: String) {
    self.deploymentId = deploymentId
    self.site = site
  }

  private var fields: [String] { [deploymentId, site] }

  public static func == (left: GrantKey, right: GrantKey) -> Bool {
    zip(left.fields, right.fields).allSatisfy { $0.utf8.elementsEqual($1.utf8) }
  }

  public func hash(into hasher: inout Hasher) {
    for field in fields { hasher.combine(Array(field.utf8)) }
  }

  /// The manifest's order: field by field, in UTF-8 byte order.
  func precedes(_ other: GrantKey) -> Bool {
    for (mine, theirs) in zip(fields, other.fields) where !mine.utf8.elementsEqual(theirs.utf8) {
      return mine.utf8.lexicographicallyPrecedes(theirs.utf8)
    }
    return false
  }
}

/// Remembered personal consent pins the selected login and revision in the sealed manifest.
public struct Grant: Sendable, Equatable {
  public let key: GrantKey
  public let permissionVersion: Int64
  public let revision: Int64
  public var isCurrentPermission: Bool {
    permissionVersion == 6 && revision >= 1
  }

  public func authorizes(permissionVersion required: Int64) -> Bool {
    required == 6 && isCurrentPermission
  }
  public let loginId: String
  public let deploymentName: String

  public init(
    key: GrantKey, loginId: String, deploymentName: String,
    revision: Int64, permissionVersion: Int64 = 6
  ) {
    self.permissionVersion = permissionVersion
    self.revision = revision
    self.key = key
    self.loginId = loginId
    self.deploymentName = deploymentName
  }

  /// Field shape, which needs no Public Suffix List. The site rule
  /// (`Origins.isSite`) is checked when a grant is written; on read, the
  /// broker checks the login is within the site at every release.
  func validateStored() throws {
    guard permissionVersion == 6, revision >= 1 else {
      throw VaultError.invalidGrant("a grant has an unsupported permission")
    }
    for field in [key.deploymentId, deploymentName] {
      guard (1...VaultLimits.maxGrantFieldBytes).contains(field.utf8.count),
        !field.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
      else {
        throw VaultError.invalidGrant(
          "a grant's names must be 1 to \(VaultLimits.maxGrantFieldBytes) bytes of text")
      }
    }
    guard key.site.hasPrefix("https://"), key.site.utf8.count <= VaultLimits.maxLoginURLBytes else {
      throw VaultError.invalidGrant("a grant's site must be an HTTPS site")
    }
    guard VaultIDs.isUUID(loginId) else {
      throw VaultError.invalidGrant("a grant's login ID is not a lower-case UUID")
    }
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "deploymentId": .string(key.deploymentId),
      "deploymentName": .string(deploymentName),
      "loginId": .string(loginId),
      "site": .string(key.site),
    ]
    fields["permissionVersion"] = .integer(permissionVersion)
    fields["revision"] = .integer(revision)
    return .object(fields)
  }

  init(json: JSONValue) throws {
    guard case .object(let fields) = json else {
      throw VaultError.invalidGrant("a grant is not an object")
    }
    let object = try StrictObject(json, keys: [
      "deploymentId", "deploymentName", "loginId", "site", "permissionVersion", "revision",
    ], context: "grant")
    permissionVersion = try object.integer("permissionVersion")
    revision = try object.integer("revision")
    key = GrantKey(
      deploymentId: try object.string("deploymentId"),
      site: try object.string("site"))
    loginId = try object.string("loginId")
    deploymentName = try object.string("deploymentName")
    try validateStored()
  }
}
