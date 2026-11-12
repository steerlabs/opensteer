import Foundation
import PasswordsCore

/// Strict protocol 10 IPC; the fixture pins the TypeScript and Swift shapes.
public enum Wire {
  public static let protocolVersion: Int64 = 10
  public static let latestProtocolVersion: Int64 = 10
  public static let supportedProtocolVersions: [Int64] = [10]
  public static let maxAccounts = 100

  public enum Method: String, CaseIterable, Sendable {
    case cardProbe = "card.probe"
    case cardRequest = "card.request"
    case cardApprove = "card.approve"
    case cardRelease = "card.release"
    case fillAccounts = "fill.accounts"
    case fillBegin = "fill.begin"
    case hello
    case saveBegin = "save.begin"
    case saveCommit = "save.commit"
    case saveCancel = "save.cancel"
    case status
    case windowOpen = "window.open"
    case signInProbe = "signin.probe"
    case signInRequest = "signin.request"
    case signInApprove = "signin.approve"
    case signInCommit = "signin.commit"
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

  public static func statusChanged(_ status: Status, protocolVersion: Int64 = Wire.protocolVersion) -> Data {
    encode(.object(["event": .string("status.changed"), "params": status.json(protocolVersion: protocolVersion)]))
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
  /// covers it, independent of Deployment consent.
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

  /// Consent is personal to this Deployment and site, independent of task or folder.
  public struct SignInRequestParams: Equatable, Sendable {
    public let deploymentId: String
    public let deploymentName: String
    public let expiresAtText: String
    public let expiresAt: Date
    public let reason: String
    public let protocolVersion: Int64
    public let permissionVersion: Int64
    public let site: String
    public let siteHost: String
    public let threadTitle: String
    public let transactionId: String

    public init(json: JSONValue, protocolVersion negotiated: Int64? = nil) throws {
      guard negotiated == nil || negotiated == Wire.protocolVersion else {
        throw Failure.invalid("Update Opensteer to request this sign-in.")
      }
      let object = try strict(json, [
        "deploymentId", "deploymentName", "expiresAt", "reason", "site", "threadTitle",
        "transactionId", "protocolVersion", "permissionVersion",
      ])
      protocolVersion = try integer(object, "protocolVersion")
      permissionVersion = try integer(object, "permissionVersion")
      guard protocolVersion == 10, permissionVersion == 6 else {
        throw Failure.invalid("Update Opensteer to request this sign-in.")
      }
      deploymentId = try string(object, "deploymentId")
      deploymentName = try string(object, "deploymentName")
      expiresAtText = try string(object, "expiresAt")
      reason = try string(object, "reason")
      site = try string(object, "site")
      threadTitle = try string(object, "threadTitle")
      transactionId = try string(object, "transactionId")
      guard WireRules.deploymentId(deploymentId),
        WireRules.trimmedText(deploymentName, max: 120),
        WireRules.trimmedText(reason, max: 500), WireRules.trimmedText(threadTitle, max: 200)
      else { throw Failure.invalid("signin.request has an invalid field.") }
      guard WireRules.isUUID(transactionId) else {
        throw Failure.invalid("signin.request needs a UUID transactionId.")
      }
      guard let expiresAt = WireRules.isoDate(expiresAtText) else {
        throw Failure.invalid("signin.request needs expiresAt as an ISO date with an offset.")
      }
      self.expiresAt = expiresAt
      guard let host = WireRules.site(site) else {
        throw Failure.invalid("signin.request needs an HTTPS site.")
      }
      siteHost = host
    }

    public var grantKey: GrantKey { GrantKey(deploymentId: deploymentId, site: site) }
    var transactionKey: [String] { [deploymentId, site] }
    public var json: JSONValue {
      .object([
        "deploymentId": .string(deploymentId), "deploymentName": .string(deploymentName),
        "expiresAt": .string(expiresAtText), "reason": .string(reason), "site": .string(site),
        "threadTitle": .string(threadTitle), "transactionId": .string(transactionId),
        "protocolVersion": .integer(protocolVersion), "permissionVersion": .integer(permissionVersion),
      ])
    }
  }

  /// Allow (`remember`) or Only this time, for one offered account at the
  /// revision the card showed.
  public struct ApproveParams: Equatable, Sendable {
    public let loginId: String
    public let remember: Bool
    public let revision: Int64
    public let transactionId: String
    public let permissionVersion: Int64

    public init(loginId: String, remember: Bool, revision: Int64, transactionId: String) {
      self.permissionVersion = 6
      self.loginId = loginId
      self.remember = remember
      self.revision = revision
      self.transactionId = transactionId
    }

    public init(json: JSONValue) throws {
      let object = try strict(
        json, ["loginId", "remember", "revision", "transactionId", "permissionVersion"])
      permissionVersion = try integer(object, "permissionVersion")
      guard permissionVersion == 6 else {
        throw Failure.invalid("Update Opensteer to approve this sign-in.")
      }
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
        "permissionVersion": .integer(permissionVersion),
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
      self.protocolVersion = Wire.protocolVersion
    }

    public init(json: JSONValue, protocolVersion negotiated: Int64? = nil) throws {
      guard negotiated == nil || negotiated == Wire.protocolVersion else {
        throw Failure.invalid("Update Opensteer to release this sign-in.")
      }
      guard case .object(let fields) = json, case .string(let kind)? = fields["kind"] else {
        throw Failure.invalid("signin.release needs an explicit destination kind.")
      }
      let object: StrictObject
      switch kind {
      case "app":
        object = try strict(json, ["transactionId", "field", "kind"])
        destination = .app
      case "browser":
        object = try strict(json, ["transactionId", "field", "kind", "origin"])
        destination = .browser(origin: try string(object, "origin"))
      default: throw Failure.invalid("signin.release needs a supported destination kind.")
      }
      protocolVersion = Wire.protocolVersion
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
        fields["kind"] = .string("browser")
      }
      return .object(fields)
    }
  }

  /// `status` and `window.open` take `{}` and nothing else.
  static func empty(_ json: JSONValue) throws {
    _ = try strict(json, [])
  }

  public struct FillAccountsParams: Equatable, Sendable {
    public let origin: String
    public init(json: JSONValue) throws {
      origin = try string(try strict(json, ["origin"]), "origin")
      guard WireRules.origin(origin) else { throw Failure.invalid("Filling needs an exact HTTPS origin.") }
    }
    public var json: JSONValue { .object(["origin": .string(origin)]) }
  }

  public enum FillPresence: String, Sendable { case here, elsewhere }

  public struct FillBeginParams: Equatable, Sendable {
    public let transactionId: String
    public let loginId: String
    public let revision: Int64
    public let origin: String
    public let presence: FillPresence
    public let site: String
    public var siteHost: String { String(site.dropFirst("https://".count)) }

    public init(json: JSONValue) throws {
      let object = try strict(json, ["transactionId", "loginId", "revision", "origin", "presence"])
      transactionId = try transaction(object)
      loginId = try string(object, "loginId")
      revision = try integer(object, "revision")
      origin = try string(object, "origin")
      guard WireRules.isUUID(loginId), (0...9_007_199_254_740_991).contains(revision),
        WireRules.origin(origin), let presence = FillPresence(rawValue: try string(object, "presence"))
      else { throw Failure.invalid("Invalid saved login fill.") }
      guard let host = URL(string: origin)?.host, let domain = Origins.registrableDomain(host)
      else { throw Failure.invalid("Invalid fill site.") }
      self.site = "https://" + domain
      self.presence = presence
    }
    public var json: JSONValue {
      .object(["transactionId": .string(transactionId), "loginId": .string(loginId),
        "revision": .integer(revision), "origin": .string(origin), "presence": .string(presence.rawValue)])
    }
  }

  /// A login the person typed into a page, held by the broker until they
  /// answer. Its values are never trimmed or normalized, and no message here
  /// names one.
  public struct SaveBeginParams: Sendable {
    public let transactionId: String
    /// As sent; the vault's site rules decide later whether it can be saved.
    public let origin: String
    public let username: String
    public let password: String

    public init(json: JSONValue) throws {
      let object = try strict(json, ["transactionId", "origin", "username", "password"])
      transactionId = try transaction(object)
      origin = try string(object, "origin")
      username = try string(object, "username")
      password = try string(object, "password")
      guard WireRules.length(origin, within: 1...2_048),
        (1...VaultLimits.maxUsernameBytes).contains(username.utf8.count),
        (1...VaultLimits.maxPasswordBytes).contains(password.utf8.count)
      else { throw Failure.invalid("Invalid login to save.") }
    }

    public var json: JSONValue {
      .object(["transactionId": .string(transactionId), "origin": .string(origin),
        "username": .string(username), "password": .string(password)])
    }
  }

  // MARK: Results

  public enum SaveSkipReason: String, CaseIterable, Sendable {
    case saved, off, unsaveable, unavailable
    case notSetUp = "not-set-up"
  }
  public enum SaveDecision: Equatable, Sendable {
    case offer(Date), skip(SaveSkipReason)
    public var json: JSONValue {
      switch self {
      case .offer(let deadline):
        return .object(["decision": .string("offer"), "expiresAt": .string(ActivityLog.timestamp(deadline))])
      case .skip(let reason): return .object(["decision": .string("skip"), "reason": .string(reason.rawValue)])
      }
    }
  }

  public enum SaveRefusal: String, CaseIterable, Sendable { case saved, ended, off, unavailable }
  public enum SaveCommitResult: Equatable, Sendable {
    case saved, refused(SaveRefusal)
    public var json: JSONValue {
      switch self {
      case .saved: return .object(["saved": .bool(true)])
      case .refused(let reason): return .object(["saved": .bool(false), "reason": .string(reason.rawValue)])
      }
    }
  }

  public struct FillAccount: Equatable, Sendable {
    public let id: String
    public let revision: Int64
    public let username: String
    public let label: String?
    public let hasCode: Bool
    public var json: JSONValue {
      .object(["id": .string(id), "revision": .integer(revision), "username": .string(username),
        "label": label.map(JSONValue.string) ?? .null, "hasCode": .bool(hasCode)])
    }
  }

  public enum FillState: String, Sendable { case on, off; case notSetUp = "not-set-up" }
  public static func fillAccounts(_ state: FillState, _ accounts: [FillAccount] = []) -> JSONValue {
    .object(["fill": .string(state.rawValue), "accounts": .array(accounts.map(\.json))])
  }

  public enum FillUnavailableReason: String, Sendable {
    case off = "fill-off", notSetUp = "not-set-up", busy
  }
  public enum FillDecision: Equatable, Sendable {
    case authorized(Date), changed, cancelled, unavailable(FillUnavailableReason)
    public var json: JSONValue {
      switch self {
      case .authorized(let deadline):
        return .object(["decision": .string("authorized"), "expiresAt": .string(ActivityLog.timestamp(deadline))])
      case .changed: return .object(["decision": .string("changed")])
      case .cancelled: return .object(["decision": .string("cancelled")])
      case .unavailable(let reason):
        return .object(["decision": .string("unavailable"), "reason": .string(reason.rawValue)])
      }
    }
  }

  public enum VaultState: String, Sendable {
    case notSetUp = "not-set-up"
    case ready
    case unsupported
    case needsReset = "needs-reset"
  }

  public struct Status: Equatable, Sendable {
    public let vault: VaultState
    public let agentSignIns: Bool
    public let personFill: Bool
    public let personSave: Bool

    public init(vault: VaultState, agentSignIns: Bool, personFill: Bool = false, personSave: Bool = false) {
      self.vault = vault
      self.agentSignIns = agentSignIns
      self.personFill = personFill
      self.personSave = personSave
    }

    public var json: JSONValue { json(protocolVersion: Wire.protocolVersion) }

    public func json(protocolVersion: Int64) -> JSONValue {
      var fields: [String: JSONValue] = [
        "agentSignIns": .string(agentSignIns ? "on" : "off"), "vault": .string(vault.rawValue),
      ]
      fields["personFill"] = .string(personFill ? "on" : "off")
      fields["personSave"] = .string(personSave ? "on" : "off")
      return .object(fields)
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

  public struct CardRequestParams: Sendable {
    public let request: SignInRequestParams
    public init(json: JSONValue) throws {
      guard case .object(var fields) = json, fields["protocolVersion"] == .integer(10),
        fields["permissionVersion"] == .integer(7) else { throw Failure.invalid("Card use needs protocol 10 and permission 7.") }
      fields["permissionVersion"] = .integer(6)
      fields["protocolVersion"] = .integer(10)
      request = try SignInRequestParams(json: .object(fields), protocolVersion: 10)
    }
    public var json: JSONValue {
      guard case .object(var fields) = request.json else { preconditionFailure() }
      fields["permissionVersion"] = .integer(7)
      fields["protocolVersion"] = .integer(10)
      return .object(fields)
    }
  }

  public struct CardApproveParams: Sendable {
    public let transactionId: String
    public let cardId: String
    public let revision: Int64
    public init(json: JSONValue) throws {
      let object = try strict(json, ["transactionId", "cardId", "revision", "permissionVersion"])
      transactionId = try transaction(object)
      cardId = try string(object, "cardId")
      revision = try integer(object, "revision")
      guard WireRules.isUUID(cardId), revision >= 0, try integer(object, "permissionVersion") == 7 else {
        throw Failure.invalid("Invalid card approval.")
      }
    }
  }

  public enum CardField: String, CaseIterable, Sendable {
    case number, expiry, cvc, name
    case expiryMonth = "expiry-month"
    case expiryYear = "expiry-year"
    case postalCode = "billing-postal-code"
  }

  public struct CardReleaseParams: Sendable {
    public let transactionId: String
    public let topOrigin: String
    public let frameOrigin: String
    public let field: CardField
    public init(json: JSONValue) throws {
      let object = try strict(json, ["transactionId", "topOrigin", "frameOrigin", "field"])
      transactionId = try transaction(object)
      topOrigin = try string(object, "topOrigin")
      frameOrigin = try string(object, "frameOrigin")
      guard let field = CardField(rawValue: try string(object, "field")),
        WireRules.origin(topOrigin), WireRules.origin(frameOrigin) else {
        throw Failure.invalid("Invalid card destination or field.")
      }
      self.field = field
    }
  }

  public struct CardChoice: Equatable, Sendable {
    public let id: String
    public let revision: Int64
    public let brand: String
    public let lastFour: String
    public let label: String?
    public let expiryMonth: Int64
    public let expiryYear: Int64
    public init(_ card: CardItem) {
      id = card.id
      revision = card.revision
      brand = card.brand
      lastFour = card.lastFour
      label = card.draft.label
      expiryMonth = card.draft.expiryMonth
      expiryYear = card.draft.expiryYear
    }
    public var descriptor: JSONValue {
      .object(["id": .string(id), "revision": .integer(revision),
        "brand": .string(brand), "lastFour": .string(lastFour)])
    }
    public var json: JSONValue {
      guard case .object(var fields) = descriptor else { preconditionFailure() }
      fields["label"] = label.map(JSONValue.string) ?? .null
      fields["expiryMonth"] = .integer(expiryMonth)
      fields["expiryYear"] = .integer(expiryYear)
      return .object(fields)
    }
  }

  static func cardChoices(_ cards: [CardChoice], message: String? = nil) -> JSONValue {
    var fields: [String: JSONValue] = ["decision": .string("approve"), "cards": .array(cards.map(\.json))]
    if let message { fields["message"] = .string(message) }
    return .object(fields)
  }
  static func cardRefused(_ reason: String) -> JSONValue {
    .object(["released": .bool(false), "reason": .string(reason)])
  }

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
