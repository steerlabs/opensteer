import Foundation

public enum VaultLimits {
  public static let maxItems = 10_000
  public static let maxOrigins = 8
  /// Field limits are UTF-8 bytes.
  public static let maxUsernameBytes = 1_024
  public static let maxPasswordBytes = 4_096
  public static let maxLabelBytes = 200
  public static let maxLoginURLBytes = 2_048
  public static let maxDeviceNameBytes = 200
  public static let maxOwners = 16
  public static let maxGrants = 1_000
  /// A grant's IDs and names, in UTF-8 bytes; the wire allows less.
  public static let maxGrantFieldBytes = 512
}

/// One saved login, decrypted.
///
/// `password` and `username` are kept byte for byte: never trimmed,
/// normalised or compared with `==` (which ignores Unicode normalisation).
public struct Item: Sendable {
  /// Lower-case UUID.
  public let id: String
  /// 1–8 normalised HTTPS origins (`Origins.normalizeOrigin`), no duplicates.
  public var origins: [String]
  /// Normalised (`Origins.normalizeLoginURL`); its origin is in `origins`.
  public var loginURL: String
  public var username: String
  public var password: String
  public var totp: TOTPParameters?
  /// Nil or 1–200 bytes.
  public var label: String?
  /// Milliseconds since 1970, set by the vault.
  public internal(set) var createdAt: Int64
  public internal(set) var updatedAt: Int64
  /// The manifest revision this copy was read at. It lives in the manifest,
  /// not in the item's own plaintext, so it is set when the vault decrypts.
  public internal(set) var revision: Int64

  init(id: String, draft: ItemDraft, createdAt: Int64, updatedAt: Int64, revision: Int64) {
    self.id = id
    self.revision = revision
    origins = draft.origins
    loginURL = draft.loginURL
    username = draft.username
    password = draft.password
    totp = draft.totp
    label = draft.label
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  var draft: ItemDraft {
    ItemDraft(origins: origins, loginURL: loginURL, username: username, password: password, totp: totp, label: label)
  }

  /// Whether two items hold exactly the same bytes in every field.
  public func isIdentical(to other: Item) -> Bool {
    guard let mine = try? CanonicalJSON.encode(json), let theirs = try? CanonicalJSON.encode(other.json) else { return false }
    return mine == theirs
  }

  /// Whether `other` signs in to the same place as the same account: the
  /// same origins, login URL and username, byte for byte. A grant follows a
  /// login only while this holds.
  func signsInTheSameWay(as other: Item) -> Bool {
    origins.count == other.origins.count && zip(origins, other.origins).allSatisfy { $0.sameBytes(as: $1) }
      && loginURL.sameBytes(as: other.loginURL) && username.sameBytes(as: other.username)
  }

  /// Full validation, for writes.
  func validate() throws {
    try validateStored()
    try draft.validate()
  }

  /// Validation for reads. Origin normalisation is left out: it depends on
  /// the bundled Public Suffix List and the OS's IDNA tables, and an update
  /// to either must not make saved items unreadable. Site matching checks
  /// origins again when an item is used.
  func validateStored() throws {
    guard VaultIDs.isUUID(id) else { throw VaultError.invalidItem("id is not a lower-case UUID") }
    try draft.validateLimits()
    guard createdAt >= 0, updatedAt >= createdAt else { throw VaultError.invalidItem("timestamps are out of order") }
  }

  var json: JSONValue {
    .object([
      "createdAt": .integer(createdAt),
      "id": .string(id),
      "label": label.map(JSONValue.string) ?? .null,
      "loginURL": .string(loginURL),
      "origins": .array(origins.map(JSONValue.string)),
      "password": .string(password),
      "totp": totp?.json ?? .null,
      "updatedAt": .integer(updatedAt),
      "username": .string(username),
      "v": .integer(1),
    ])
  }

  init(json: JSONValue, revision: Int64) throws {
    guard formatVersion(of: json) == 1 else { throw VaultError.unsupportedVersion }
    self.revision = revision
    let object = try StrictObject(
      json,
      keys: ["createdAt", "id", "label", "loginURL", "origins", "password", "totp", "updatedAt", "username", "v"],
      context: "item"
    )
    let origins = try object.array("origins").map { value -> String in
      guard case .string(let origin) = value else { throw JSONError.shape("origin is not a string") }
      return origin
    }
    let totpValue = try object.value("totp")
    id = try object.string("id")
    self.origins = origins
    loginURL = try object.string("loginURL")
    username = try object.string("username")
    password = try object.string("password")
    totp = totpValue == .null ? nil : try TOTPParameters(json: totpValue)
    label = try object.optionalString("label")
    createdAt = try object.integer("createdAt")
    updatedAt = try object.integer("updatedAt")
    try validateStored()
  }
}

/// A login to add. The vault assigns its ID and timestamps.
public struct ItemDraft: Sendable {
  public var origins: [String]
  public var loginURL: String
  public var username: String
  public var password: String
  public var totp: TOTPParameters?
  public var label: String?

  public init(origins: [String], loginURL: String, username: String, password: String, totp: TOTPParameters? = nil, label: String? = nil) {
    self.origins = origins
    self.loginURL = loginURL
    self.username = username
    self.password = password
    self.totp = totp
    self.label = label
  }

  /// Checks the limits the vault enforces on commit, so a form can be
  /// checked before asking the person to authenticate.
  public func validate() throws {
    try validateLimits()
    for origin in origins {
      guard let normalized = Origins.normalizeOrigin(origin), normalized.sameBytes(as: origin) else {
        throw VaultError.invalidItem("\(origin) is not a normalised HTTPS origin")
      }
    }
    guard let normalized = Origins.normalizeLoginURL(loginURL), normalized.sameBytes(as: loginURL),
      let loginOrigin = Origins.origin(ofLoginURL: loginURL), origins.contains(loginOrigin)
    else { throw VaultError.invalidItem("the login URL must be a normalised HTTPS URL on one of the origins") }
  }

  /// Counts and sizes, which need no Public Suffix List.
  func validateLimits() throws {
    guard (1...VaultLimits.maxOrigins).contains(origins.count) else {
      throw VaultError.invalidItem("an item needs 1 to \(VaultLimits.maxOrigins) origins")
    }
    guard Set(origins).count == origins.count else { throw VaultError.invalidItem("origins repeat") }
    guard origins.allSatisfy({ $0.hasPrefix("https://") }), loginURL.hasPrefix("https://") else {
      throw VaultError.invalidItem("origins and the login URL must be HTTPS")
    }
    guard loginURL.utf8.count <= VaultLimits.maxLoginURLBytes else { throw VaultError.invalidItem("the login URL is too long") }
    guard username.utf8.count <= VaultLimits.maxUsernameBytes else { throw VaultError.invalidItem("the username is too long") }
    guard (1...VaultLimits.maxPasswordBytes).contains(password.utf8.count) else {
      throw VaultError.invalidItem("the password must be 1 to \(VaultLimits.maxPasswordBytes) bytes")
    }
    if let label {
      guard (1...VaultLimits.maxLabelBytes).contains(label.utf8.count) else {
        throw VaultError.invalidItem("the label must be nil or 1 to \(VaultLimits.maxLabelBytes) bytes")
      }
    }
  }
}

/// A new password (and two-factor seed) for a saved item, resolved against
/// the item as it is when the commit is made.
public struct CredentialReplacement: Sendable {
  public let itemID: String
  public let password: String
  /// Nil keeps the saved two-factor seed.
  public let totp: TOTPParameters?

  public init(itemID: String, password: String, totp: TOTPParameters?) {
    self.itemID = itemID
    self.password = password
    self.totp = totp
  }
}

/// One user action's changes, committed as exactly one commit.
///
/// Grants follow their logins: deleting a login, or changing its origins,
/// login URL or username, removes its grants in the same commit.
public struct VaultChanges: Sendable {
  public var add: [ItemDraft]
  /// Items with edited fields. Their `createdAt` is kept and `updatedAt` set
  /// by the vault; an item whose fields did not change is left as it was.
  public var update: [Item]
  public var replace: [CredentialReplacement]
  public var delete: [String]
  /// Set or replace the grant for each key, for a saved login or one of
  /// `add`, whose ID the vault assigns.
  public var grant: [GrantChange]
  /// Remove the grant for each key; a key without one is left as it is.
  public var revoke: [GrantKey]

  public init(
    add: [ItemDraft] = [], update: [Item] = [], replace: [CredentialReplacement] = [], delete: [String] = [],
    grant: [GrantChange] = [], revoke: [GrantKey] = []
  ) {
    self.add = add
    self.update = update
    self.replace = replace
    self.delete = delete
    self.grant = grant
    self.revoke = revoke
  }
}

/// A grant to write: its key and names, for a saved login or one this
/// commit adds.
public struct GrantChange: Sendable {
  public enum Login: Sendable {
    case saved(id: String)
    case added(index: Int)
  }

  public let key: GrantKey
  public let login: Login
  public let deploymentName: String
  public let workspaceName: String
  public let permissionVersion: Int64

  public init(
    key: GrantKey, login: Login, deploymentName: String, workspaceName: String,
    permissionVersion: Int64 = 4
  ) {
    self.key = key
    self.login = login
    self.deploymentName = deploymentName
    self.workspaceName = workspaceName
    self.permissionVersion = permissionVersion
  }
}

enum VaultIDs {
  static func newUUID() -> String { UUID().uuidString.lowercased() }

  static func isUUID(_ text: String) -> Bool {
    guard let uuid = UUID(uuidString: text) else { return false }
    return uuid.uuidString.lowercased() == text
  }
}
