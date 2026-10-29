import Foundation
import PasswordsCore

/// The broker IPC, v4 and v5: exactly the shapes `packages/protocol/src/passwords-broker.ts`
/// declares. Frames are parsed with the strict JSON parser (no duplicate keys,
/// integers only) and every object is closed, as `z.strictObject` is. Answers
/// are encoded canonically. `Tests/Fixtures/passwords-wire.json` is written
/// from these types and parsed by the protocol's schemas.
public enum Wire {
  /// Legacy callers keep their existing wire; new authorities opt in to 5.
  public static let protocolVersion: Int64 = 4
  public static let latestProtocolVersion: Int64 = 5
  public static let supportedProtocolVersions: [Int64] = [4, 5]
  public static let maxAccounts = 100

  public enum Method: String, CaseIterable, Sendable {
    case hello
    case status
    case windowOpen = "window.open"
    case signInProbe = "signin.probe"
    case signInRequest = "signin.request"
    case signInApprove = "signin.approve"
    case signInRelease = "signin.release"
    case signInCancel = "signin.cancel"
  }

  public enum ErrorCode: String, Sendable {
    case invalid
    case unavailable
    case `internal`
  }

  /// A refusal, sent as `{error:{code,message},id}`. Messages never carry a
  /// parameter value: the desktop logs them, and the card shows those of
  /// `signin.approve`.
  public struct Failure: Error, Equatable, Sendable {
    public let code: ErrorCode
    public let message: String

    public init(_ code: ErrorCode, _ message: String) {
      self.code = code
      self.message = message
    }

    static func invalid(_ message: String) -> Failure { Failure(.invalid, message) }
  }

  /// `{id, method, params}`.
  public struct Request: Sendable {
    public let id: Int64
    public let method: String
    public let params: JSONValue

    /// Nil when the frame has no id an answer could carry: the connection is
    /// then closed, since nothing can be matched to a call.
    public static func parse(_ frame: Data) -> Request? {
      guard let value = try? CanonicalJSON.parse(frame),
        let object = try? StrictObject(
          value, keys: ["id", "method", "params"], context: "request"),
        let id = try? object.integer("id"), id >= 1,
        let method = try? object.string("method"),
        case .object? = try? object.value("params")
      else { return nil }
      return Request(id: id, method: method, params: object.fields["params"]!)
    }

    public var json: JSONValue {
      .object(["id": .integer(id), "method": .string(method), "params": params])
    }
  }

  public static func result(id: Int64, _ result: JSONValue) -> Data {
    encode(.object(["id": .integer(id), "result": result]))
  }

  public static func error(id: Int64, _ failure: Failure) -> Data {
    encode(
      .object([
        "error": .object([
          "code": .string(failure.code.rawValue),
          "message": .string(String(failure.message.prefix(2_000))),
        ]),
        "id": .integer(id),
      ]))
  }

  public static func statusChanged(_ status: Status) -> Data {
    encode(.object(["event": .string("status.changed"), "params": status.json]))
  }

  /// Every value the broker builds is within the canonical encoder's range;
  /// a failure here is a broker bug and closes nothing silently.
  static func encode(_ value: JSONValue) -> Data {
    do {
      return try CanonicalJSON.encode(value)
    } catch {
      preconditionFailure("The broker built a reply it cannot encode.")
    }
  }

  // MARK: Parameters

  public struct HelloParams: Equatable, Sendable {
    public let clientVersion: String
    /// Any integer: a client of another version is answered, not refused.
    public let protocolVersion: Int64

    public init(clientVersion: String, protocolVersion: Int64) {
      self.clientVersion = clientVersion
      self.protocolVersion = protocolVersion
    }

    public init(json: JSONValue) throws {
      let object = try strict(json, ["client", "protocolVersion"])
      let client = try strict(try field(object, "client"), ["version"])
      clientVersion = try string(client, "version")
      protocolVersion = try integer(object, "protocolVersion")
      guard WireRules.length(clientVersion, within: 1...64) else {
        throw Failure.invalid("hello needs a client version.")
      }
    }

    public var json: JSONValue {
      .object([
        "client": .object(["version": .string(clientVersion)]),
        "protocolVersion": .integer(protocolVersion),
      ])
    }
  }

  /// `signin.probe`: the site only. The answer is whether a saved login
  /// covers it, which no Deployment or Workspace changes.
  public struct ProbeParams: Equatable, Sendable {
    public let site: String

    public init(site: String) {
      self.site = site
    }

    public init(json: JSONValue) throws {
      site = try string(try strict(json, ["site"]), "site")
      guard WireRules.site(site) != nil else {
        throw Failure.invalid("signin.probe needs a site such as https://github.com.")
      }
    }

    public var json: JSONValue { .object(["site": .string(site)]) }
  }

  /// One sign-in, named by the Host: the Deployment, Workspace and site pick
  /// a grant; the names and reason are display text.
  public struct SignInRequestParams: Equatable, Sendable {
    public let deploymentId: String
    public let deploymentName: String
    /// As sent; `expiresAt` is the parsed instant.
    public let expiresAtText: String
    public let expiresAt: Date
    public let reason: String
    public enum Scope: Equatable, Sendable {
      case browser(runtimeId: String, sessionId: String)
      case workspace
    }
    public let scope: Scope
    public let permissionVersion: Int64
    public let site: String
    /// The site's registrable domain, e.g. `github.com`.
    public let siteHost: String
    public let threadTitle: String
    public let transactionId: String
    public let workspaceId: String
    public let workspaceName: String

    public init(json: JSONValue, protocolVersion negotiated: Int64? = nil) throws {
      let version: Int64
      if let negotiated { version = negotiated }
      else if case .object(let fields) = json, fields["protocolVersion"] != nil { version = 5 }
      else { version = 4 }
      var keys: Set<String> = [
        "deploymentId", "deploymentName", "expiresAt", "reason", "site", "threadTitle",
        "transactionId", "workspaceId", "workspaceName",
      ]
      switch version {
      case 4: keys.formUnion(["runtimeId", "sessionId"])
      case 5: keys.formUnion(["protocolVersion", "permissionVersion"])
      default: throw Failure.invalid("signin.request needs a supported protocol.")
      }
      let object = try strict(json, keys)
      deploymentId = try string(object, "deploymentId")
      deploymentName = try string(object, "deploymentName")
      expiresAtText = try string(object, "expiresAt")
      reason = try string(object, "reason")
      if version == 4 {
        let runtimeId = try string(object, "runtimeId")
        let sessionId = try string(object, "sessionId")
        guard WireRules.length(runtimeId, within: 1...255),
          WireRules.length(sessionId, within: 1...128)
        else { throw Failure.invalid("signin.request needs a runtime and session.") }
        scope = .browser(runtimeId: runtimeId, sessionId: sessionId)
      } else {
        guard try integer(object, "protocolVersion") == 5,
          try integer(object, "permissionVersion") == 5
        else { throw Failure.invalid("signin.request needs protocol and permission version 5.") }
        scope = .workspace
      }
      permissionVersion = version
      site = try string(object, "site")
      threadTitle = try string(object, "threadTitle")
      transactionId = try string(object, "transactionId")
      workspaceId = try string(object, "workspaceId")
      workspaceName = try string(object, "workspaceName")
      guard WireRules.length(deploymentId, within: 1...128),
        WireRules.trimmedText(deploymentName, max: 120),
        WireRules.trimmedText(reason, max: 500), WireRules.trimmedText(threadTitle, max: 200),
        WireRules.trimmedText(workspaceName, max: 120)
      else {
        throw Failure.invalid("signin.request has a field that is empty, untrimmed or too long.")
      }
      guard WireRules.isUUID(transactionId) else {
        throw Failure.invalid("signin.request needs a UUID transactionId.")
      }
      guard WireRules.workspaceId(workspaceId) else {
        throw Failure.invalid("signin.request needs a Workspace ID.")
      }
      guard let expiresAt = WireRules.isoDate(expiresAtText) else {
        throw Failure.invalid("signin.request needs expiresAt as an ISO date with an offset.")
      }
      self.expiresAt = expiresAt
      guard let siteHost = WireRules.site(site) else {
        throw Failure.invalid("signin.request needs a site such as https://github.com.")
      }
      self.siteHost = siteHost

    }

    /// The grant this sign-in would use.
    public var grantKey: GrantKey {
      GrantKey(deploymentId: deploymentId, workspaceId: workspaceId, site: site)
    }

    /// Legacy uniqueness stays session-scoped; modern authority belongs to a Workspace.
    var transactionKey: [String] {
      switch scope {
      case .browser(let runtimeId, let sessionId):
        return ["4", deploymentId, runtimeId, sessionId, site]
      case .workspace:
        return ["5", deploymentId, workspaceId, site]
      }
    }

    public var json: JSONValue {
      var fields: [String: JSONValue] = [
        "deploymentId": .string(deploymentId),
        "deploymentName": .string(deploymentName),
        "expiresAt": .string(expiresAtText),
        "reason": .string(reason),
        "site": .string(site),
        "threadTitle": .string(threadTitle),
        "transactionId": .string(transactionId),
        "workspaceId": .string(workspaceId),
        "workspaceName": .string(workspaceName),
      ]
      switch scope {
      case .browser(let runtimeId, let sessionId):
        fields["runtimeId"] = .string(runtimeId)
        fields["sessionId"] = .string(sessionId)
      case .workspace:
        fields["protocolVersion"] = .integer(5)
        fields["permissionVersion"] = .integer(permissionVersion)
      }
      return .object(fields)
    }
  }

  /// Allow (`remember`) or Only this time, for one offered account at the
  /// revision the card showed.
  public struct ApproveParams: Equatable, Sendable {
    public let loginId: String
    public let remember: Bool
    public let revision: Int64
    public let transactionId: String

    public init(loginId: String, remember: Bool, revision: Int64, transactionId: String) {
      self.loginId = loginId
      self.remember = remember
      self.revision = revision
      self.transactionId = transactionId
    }

    public init(json: JSONValue) throws {
      let object = try strict(json, ["loginId", "remember", "revision", "transactionId"])
      loginId = try string(object, "loginId")
      remember = try bool(object, "remember")
      revision = try integer(object, "revision")
      transactionId = try transaction(object)
      guard WireRules.isUUID(loginId) else {
        throw Failure.invalid("signin.approve needs a UUID loginId.")
      }
      guard revision >= 0 else { throw Failure.invalid("signin.approve needs a revision.") }
    }

    public var json: JSONValue {
      .object([
        "loginId": .string(loginId), "remember": .bool(remember), "revision": .integer(revision),
        "transactionId": .string(transactionId),
      ])
    }
  }

  public struct TransactionParams: Equatable, Sendable {
    public let transactionId: String

    public init(transactionId: String) {
      self.transactionId = transactionId
    }

    public init(json: JSONValue) throws {
      transactionId = try transaction(try strict(json, ["transactionId"]))
    }

    public var json: JSONValue { .object(["transactionId": .string(transactionId)]) }
  }

  public enum ReleaseField: String, CaseIterable, Sendable {
    case username, password, totp
  }

  public enum ReleaseDestination: Equatable, Sendable {
    case browser(origin: String)
    case app
  }

  public struct ReleaseParams: Equatable, Sendable {
    public let transactionId: String
    public let field: ReleaseField
    public let destination: ReleaseDestination
    public let protocolVersion: Int64

    public init(transactionId: String, field: ReleaseField, origin: String) {
      self.transactionId = transactionId
      self.field = field
      self.destination = .browser(origin: origin)
      self.protocolVersion = 4
    }

    public init(json: JSONValue, protocolVersion negotiated: Int64? = nil) throws {
      let version: Int64
      if let negotiated { version = negotiated }
      else if case .object(let fields) = json, fields["kind"] != nil { version = 5 }
      else { version = 4 }
      let object: StrictObject
      switch version {
      case 4:
        object = try strict(json, ["transactionId", "field", "origin"])
        destination = .browser(origin: try string(object, "origin"))
      case 5:
        // The discriminant is mandatory; an absent origin never grants app scope.
        guard case .object(let fields) = json, case .string(let kind)? = fields["kind"] else {
          throw Failure.invalid("signin.release needs an explicit destination kind.")
        }
        switch kind {
        case "app":
          object = try strict(json, ["transactionId", "field", "kind"])
          destination = .app
        case "browser":
          object = try strict(json, ["transactionId", "field", "kind", "origin"])
          destination = .browser(origin: try string(object, "origin"))
        default: throw Failure.invalid("signin.release needs a supported destination kind.")
        }
      default: throw Failure.invalid("signin.release needs a supported protocol.")
      }
      protocolVersion = version
      transactionId = try transaction(object)
      guard let parsed = ReleaseField(rawValue: try string(object, "field")) else {
        throw Failure.invalid("signin.release needs a supported field.")
      }
      field = parsed
      if case .browser(let origin) = destination, !WireRules.origin(origin) {
        throw Failure.invalid("signin.release needs an exact HTTPS origin.")
      }
    }

    public var json: JSONValue {
      var fields: [String: JSONValue] = [
        "transactionId": .string(transactionId), "field": .string(field.rawValue),
      ]
      switch destination {
      case .app: fields["kind"] = .string("app")
      case .browser(let origin):
        fields["origin"] = .string(origin)
        if protocolVersion == 5 { fields["kind"] = .string("browser") }
      }
      return .object(fields)
    }
  }

  /// `status` and `window.open` take `{}` and nothing else.
  static func empty(_ json: JSONValue) throws {
    _ = try strict(json, [])
  }

  // MARK: Results

  public enum VaultState: String, Sendable {
    case notSetUp = "not-set-up"
    case ready
    case unsupported
    case needsReset = "needs-reset"
  }

  public struct Status: Equatable, Sendable {
    public let vault: VaultState
    public let agentSignIns: Bool

    public init(vault: VaultState, agentSignIns: Bool) {
      self.vault = vault
      self.agentSignIns = agentSignIns
    }

    public var json: JSONValue {
      .object([
        "agentSignIns": .string(agentSignIns ? "on" : "off"), "vault": .string(vault.rawValue),
      ])
    }
  }

  public struct HelloResult: Equatable, Sendable {
    public let brokerVersion: String
    public let development: Bool
    public let protocolVersion: Int64

    public init(
      brokerVersion: String, development: Bool, protocolVersion: Int64 = Wire.protocolVersion
    ) {
      self.brokerVersion = brokerVersion
      self.development = development
      self.protocolVersion = protocolVersion
    }

    public var json: JSONValue {
      .object([
        "brokerVersion": .string(brokerVersion), "development": .bool(development),
        "protocolVersion": .integer(protocolVersion),
      ])
    }
  }

  /// What the Mac says about one site, without asking anyone.
  public enum Availability: String, CaseIterable, Sendable {
    case hasLogin = "has-login"
    case noLogin = "no-login"
    case off
    case notSetUp = "not-set-up"
    case unavailable

    public var json: JSONValue { .object(["passwords": .string(rawValue)]) }
  }

  /// A pinned authorization descriptor, never a credential.
  public struct Login: Equatable, Sendable {
    public let id: String
    public let revision: Int64
    public let account: String
    public let hasTOTP: Bool

    public var json: JSONValue {
      .object([
        "id": .string(id), "revision": .integer(revision), "account": .string(account),
        "hasTOTP": .bool(hasTOTP),
      ])
    }
  }

  public enum ReleaseReason: String, CaseIterable, Sendable {
    case ended, revoked
    case wrongSite = "wrong-site"
    case noTOTP = "no-totp"
    case passwordsOff = "passwords-off"
  }

  public enum ReleaseResult: Equatable, Sendable {
    case released(String)
    case refused(ReleaseReason)

    public var json: JSONValue {
      switch self {
      case .released(let value): return .object(["released": .bool(true), "value": .string(value)])
      case .refused(let reason):
        return .object(["released": .bool(false), "reason": .string(reason.rawValue)])
      }
    }
  }

  /// A saved login the person can choose; never its password.
  public struct Account: Equatable, Sendable {
    public let host: String
    public let onPage: Bool
    public let updatedAt: String
    public let id: String
    public let revision: Int64
    public let username: String
    public let label: String?

    public var json: JSONValue {
      .object([
        "host": .string(host), "onPage": .bool(onPage), "updatedAt": .string(updatedAt),
        "id": .string(id), "label": label.map(JSONValue.string) ?? .null,
        "revision": .integer(revision),
        "username": .string(username),
      ])
    }
  }

  public enum UnavailableReason: String, Sendable {
    case passwordsOff = "passwords-off"
    case notSetUp = "not-set-up"
    case busy
  }

  /// `signin.request`'s answer, and `signin.approve`'s: `approve` from an
  /// approval offers the accounts again, with the sentence the card shows,
  /// because the one chosen changed or is gone; `unavailable` from an
  /// approval is never `busy`.
  public enum Decision: Equatable, Sendable {
    case authorized(Login)
    case approve([Account], message: String? = nil)
    case unavailable(UnavailableReason)

    public var json: JSONValue {
      switch self {
      case .authorized(let login):
        return .object(["decision": .string("authorized"), "login": login.json])
      case .approve(let accounts, let message):
        var fields: [String: JSONValue] = [
          "accounts": .array(accounts.map(\.json)), "decision": .string("approve"),
        ]
        if let message { fields["message"] = .string(message) }
        return .object(fields)
      case .unavailable(let reason):
        return .object(["decision": .string("unavailable"), "reason": .string(reason.rawValue)])
      }
    }
  }

  public static let emptyResult: JSONValue = .object([:])

  // MARK: Reading

  private static func strict(_ value: JSONValue, _ keys: Set<String>) throws -> StrictObject {
    do {
      return try StrictObject(value, keys: keys, context: "params")
    } catch {
      throw Failure.invalid("The parameters are not the expected object.")
    }
  }

  private static func field(_ object: StrictObject, _ key: String) throws -> JSONValue {
    guard let value = object.fields[key] else { throw Failure.invalid("A parameter is missing.") }
    return value
  }

  private static func string(_ object: StrictObject, _ key: String) throws -> String {
    guard case .string(let value)? = object.fields[key] else {
      throw Failure.invalid("A parameter is not a string.")
    }
    return value
  }

  private static func integer(_ object: StrictObject, _ key: String) throws -> Int64 {
    guard case .integer(let value)? = object.fields[key] else {
      throw Failure.invalid("A parameter is not an integer.")
    }
    return value
  }

  private static func bool(_ object: StrictObject, _ key: String) throws -> Bool {
    guard case .bool(let value)? = object.fields[key] else {
      throw Failure.invalid("A parameter is not a boolean.")
    }
    return value
  }

  private static func transaction(_ object: StrictObject) throws -> String {
    let id = try string(object, "transactionId")
    guard WireRules.isUUID(id) else { throw Failure.invalid("transactionId is not a UUID.") }
    return id
  }
}
