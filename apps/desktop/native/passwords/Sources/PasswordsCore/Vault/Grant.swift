import Foundation

/// The Deployment, Workspace and site a grant answers for: at most one grant
/// per key. Keys compare as UTF-8 bytes, never by Unicode equivalence, so two
/// IDs that only look alike are two keys.
public struct GrantKey: Hashable, Sendable {
  public let deploymentId: String
  public let workspaceId: String
  /// `https://<registrable domain>`.
  public let site: String

  public init(deploymentId: String, workspaceId: String, site: String) {
    self.deploymentId = deploymentId
    self.workspaceId = workspaceId
    self.site = site
  }

  private var fields: [String] { [deploymentId, workspaceId, site] }

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

/// "Agents in this Workspace may sign in to this site as this login", which
/// the person allowed once with Touch ID or the Mac password. The names are
/// what the Host called the Workspace and Deployment then, kept for display.
///
/// Current grants add `permissionVersion` (4 for browsers, 5 for websites and apps)
/// and the pinned login `revision`
/// to the legacy names/key fields,
/// inside the sealed manifest.
public struct Grant: Sendable, Equatable {
  public let key: GrantKey
  public let permissionVersion: Int64
  public let revision: Int64?
  public var isCurrentPermission: Bool {
    [4, 5].contains(permissionVersion) && revision != nil
  }

  public func authorizes(permissionVersion required: Int64) -> Bool {
    switch required {
    case 4: return isCurrentPermission
    case 5: return isCurrentPermission && permissionVersion == 5
    default: return false
    }
  }
  public let loginId: String
  public let deploymentName: String
  public let workspaceName: String

  public init(
    key: GrantKey, loginId: String, deploymentName: String, workspaceName: String,
    revision: Int64? = nil, permissionVersion: Int64 = 4
  ) {
    self.permissionVersion = revision == nil ? 3 : permissionVersion
    self.revision = revision
    self.key = key
    self.loginId = loginId
    self.deploymentName = deploymentName
    self.workspaceName = workspaceName
  }

  /// Field shape, which needs no Public Suffix List. The site rule
  /// (`Origins.isSite`) is checked when a grant is written; on read, the
  /// broker checks the login is within the site at every release.
  func validateStored() throws {
    if permissionVersion != 3 || revision != nil {
      guard [4, 5].contains(permissionVersion), let revision, revision >= 1 else {
        throw VaultError.invalidGrant("a grant has an unsupported permission")
      }
    }
    for field in [key.deploymentId, key.workspaceId, deploymentName, workspaceName] {
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
      "workspaceId": .string(key.workspaceId),
      "workspaceName": .string(workspaceName),
    ]
    if let revision {
      fields["permissionVersion"] = .integer(permissionVersion)
      fields["revision"] = .integer(revision)
    }
    return .object(fields)
  }

  init(json: JSONValue) throws {
    guard case .object(let fields) = json else {
      throw VaultError.invalidGrant("a grant is not an object")
    }
    let versioned = fields["permissionVersion"] != nil || fields["revision"] != nil
    var keys: Set<String> = [
      "deploymentId", "deploymentName", "loginId", "site", "workspaceId", "workspaceName",
    ]
    if versioned { keys.formUnion(["permissionVersion", "revision"]) }
    let object = try StrictObject(json, keys: keys, context: "grant")
    permissionVersion = versioned ? try object.integer("permissionVersion") : 3
    revision = versioned ? try object.integer("revision") : nil
    key = GrantKey(
      deploymentId: try object.string("deploymentId"),
      workspaceId: try object.string("workspaceId"),
      site: try object.string("site"))
    loginId = try object.string("loginId")
    deploymentName = try object.string("deploymentName")
    workspaceName = try object.string("workspaceName")
    try validateStored()
  }
}
