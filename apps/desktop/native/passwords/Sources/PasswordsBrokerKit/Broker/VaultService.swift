import Foundation
import PasswordsCore

/// What this Mac's vault is right now.
public enum VaultCondition: Equatable, Sendable {
  case notSetUp
  case ready
  /// No Secure Enclave: this Mac cannot hold a vault.
  case unsupported
  case needsReset(NeedsReset)
  /// The Mac has not been unlocked since it started, so the keys cannot be
  /// read yet. Nothing is wrong with the vault.
  case unavailable

  /// Nil while `unavailable`: the wire's states describe the vault, and this
  /// says nothing about it.
  public var wire: Wire.VaultState? {
    switch self {
    case .notSetUp: return .notSetUp
    case .ready: return .ready
    case .unsupported: return .unsupported
    case .needsReset: return .needsReset
    case .unavailable: return nil
    }
  }
}

public enum NeedsReset: Equatable, Sendable {
  /// This Mac's keys are missing or are not the vault's owners: the files
  /// came from another Mac (Migration Assistant, a restored backup).
  case otherMac
  /// The keys are here but the vault failed verification or could not be read.
  case damaged
  /// Set up by an earlier version, whose keys needed the person for every
  /// use (`OwnerKeyPolicy`). It is not migrated.
  case olderVersion
}

/// Where the owner keys come from. Production: the Secure Enclave. Tests:
/// software keys, so nothing can prompt.
public protocol OwnerKeyProvider: Sendable {
  var isAvailable: Bool { get }
  func load(from store: any ProtectedStore) throws -> any OwnerKeyStore
  func create(in store: any ProtectedStore) throws -> any OwnerKeyStore
}

public struct SecureEnclaveOwnerKeys: OwnerKeyProvider {
  public init() {}
  public var isAvailable: Bool { SecureEnclaveOwnerKeyStore.isAvailable }
  public func load(from store: any ProtectedStore) throws -> any OwnerKeyStore {
    try SecureEnclaveOwnerKeyStore.load(from: store)
  }
  public func create(in store: any ProtectedStore) throws -> any OwnerKeyStore {
    try SecureEnclaveOwnerKeyStore.create(in: store)
  }
}

public enum VaultServiceError: Error, Equatable, Sendable {
  case notReady
  case alreadySetUp
  case unsupported
  /// The import ended (the window closed, Cancel, the visit ended) or was never prepared.
  case noImport
  /// The window's saved logins are hidden again: it closed, the Mac locked
  /// or slept, or nothing happened for a while. Showing them authenticates again.
  case windowLocked
}

/// What an approval's vault work found. Nothing is written unless it is
/// `approved`.
enum Approval: Sendable {
  /// The login as it is now; with a grant, the grant was written.
  case approved(Item)
  /// The login changed, or is no longer within the site: the site's logins
  /// as they are now, without passwords.
  case changed([LoginSummary])
  /// Agent sign-ins were off.
  case off
}

/// What a sign-in request finds for its site.
public enum SiteLookup: Sendable {
  /// A grant for the request's Deployment, Workspace and site names this
  /// login, which still has an origin within the site.
  case granted(Item)
  /// The site's logins to choose from, without passwords.
  case choose([LoginSummary])
}

/// A saved login as the window lists it and the card offers it: no
/// password, no TOTP secret. `grants` are the Workspaces allowed to use it.
public struct LoginSummary: Equatable, Sendable, Identifiable {
  public let id: String
  public let revision: Int64
  /// The registrable domain of the first origin, e.g. `github.com`.
  public let site: String
  public let origins: [String]
  public let loginURL: String
  public let username: String
  public let label: String?
  public let updatedAt: Int64
  public let hasTOTP: Bool
  public let grants: [Grant]

  init(_ item: Item, grants: [Grant] = []) {
    id = item.id
    revision = item.revision
    origins = item.origins
    loginURL = item.loginURL
    username = item.username
    label = item.label
    updatedAt = item.updatedAt
    hasTOTP = item.totp != nil
    self.grants = grants.filter {
      $0.loginId == item.id && $0.revision == item.revision && $0.isCurrentPermission
    }
    let host = item.origins.first.map { String($0.dropFirst("https://".count)) } ?? ""
    let bare = host.split(separator: ":").first.map(String.init) ?? host
    site = Origins.registrableDomain(bare) ?? bare
  }

  /// Whether an edit to these values would sign in somewhere else, or as
  /// someone else: the change that always authenticates afresh.
  func repoints(origins: [String], loginURL: String, username: String) -> Bool {
    origins.count != self.origins.count
      || !zip(origins, self.origins).allSatisfy { $0.utf8.elementsEqual($1.utf8) }
      || !loginURL.utf8.elementsEqual(self.loginURL.utf8)
      || !username.utf8.elementsEqual(self.username.utf8)
  }
}

/// What an import would do, counted for the preview. No passwords.
public struct ImportPreview: Equatable, Sendable {
  public let new: Int
  public let updates: Int
  public let alreadySaved: Int
  /// Rows the file had that cannot be imported, with the reason in plain words.
  public let skipped: [SkippedRow]
  /// Web addresses left out of logins that are imported (Bitwarden's
  /// "Never" and pattern URIs), with the reason.
  public let leftOut: [SkippedRow]
  /// The rows `commitImport` will write.
  public var importCount: Int { new + updates }

  public struct SkippedRow: Equatable, Sendable {
    public let row: Int
    public let reason: String
  }
}

/// The vault, its keys and the broker's protected settings, used only on one
/// serial queue: `Vault` is not thread-safe.
///
/// The owner keys never need the person, so nothing here prompts. Whether
/// the person must authenticate is the broker's policy: every call that
/// writes or lists for them takes the `Authentication` it asked for. The
/// reads an agent's sign-in makes (the probe, a lookup that a grant answers)
/// and removing a grant take none.
public final class VaultService: @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.opensteer.passwords.vault")
  private let root: URL
  private let protectedStore: any ProtectedStore
  private let keys: any OwnerKeyProvider
  private let deviceName: String
  // Confined to `queue`.
  private var vault: Vault?
  private var owner: (any OwnerKeyStore)?
  private var pendingImport:
    (id: ImportID, unlocked: UnlockedVault, plan: ImportPlan, rows: Set<Int>)?

  public init(
    root: URL, protectedStore: any ProtectedStore, keys: any OwnerKeyProvider, deviceName: String
  ) {
    self.root = root
    self.protectedStore = protectedStore
    self.keys = keys
    self.deviceName = deviceName
  }

  private func run<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { continuation.resume(with: Result { try body() }) }
    }
  }

  // MARK: State

  /// Loads the keys and opens the vault from public data.
  public func examine() async -> VaultCondition {
    (try? await run { self.examineNow() }) ?? .needsReset(.damaged)
  }

  private func examineNow() -> VaultCondition {
    discardImportNow()
    vault = nil
    owner = nil
    guard keys.isAvailable else { return .unsupported }
    guard Vault.exists(at: root) else { return .notSetUp }
    do {
      return try open()
    } catch is NotUnlockedSinceRestart {
      return .unavailable
    } catch {
      Log.vault.error("The vault could not be opened.")
      return .needsReset(.damaged)
    }
  }

  /// Every protected read can fail with `NotUnlockedSinceRestart`, which
  /// passes through: it says nothing about the vault.
  private func open() throws -> VaultCondition {
    guard OwnerKeyPolicy.isCurrent(try protectedStore.read(.ownerKeyPolicy)) else {
      return .needsReset(.olderVersion)
    }
    let loaded: any OwnerKeyStore
    do {
      loaded = try keys.load(from: protectedStore)
    } catch let error as NotUnlockedSinceRestart {
      throw error
    } catch OwnerKeyError.keysMissing {
      return .needsReset(.otherMac)
    } catch is StorageError {
      Log.vault.error("The owner keys could not be read.")
      return .needsReset(.damaged)
    } catch {
      // A key representation this Secure Enclave cannot open was made on another Mac.
      return .needsReset(.otherMac)
    }
    let opened: Vault
    do {
      opened = try Vault.open(root: root, protectedStore: protectedStore)
    } catch let error as NotUnlockedSinceRestart {
      throw error
    } catch {
      Log.vault.error("The vault could not be opened.")
      return .needsReset(.damaged)
    }
    let agreement = KeyID.of(loaded.agreementPublicKey)
    guard opened.head.owners.contains(where: { $0.agreementKeyID == agreement }) else {
      return .needsReset(.otherMac)
    }
    vault = opened
    owner = loaded
    return .ready
  }

  /// Creates new owner keys, records their policy and creates the vault.
  /// Whatever an earlier setup or vault left in protected state is replaced:
  /// no vault depends on it, and setup is the opt-in, so the settings go too.
  public func setUp(_ authentication: Authentication) async throws -> VaultCondition {
    return try await run {
      guard self.keys.isAvailable else { throw VaultServiceError.unsupported }
      guard !Vault.exists(at: self.root) else { throw VaultServiceError.alreadySetUp }
      for name in ProtectedName.allCases { try self.protectedStore.delete(name) }
      let owner = try self.keys.create(in: self.protectedStore)
      try self.protectedStore.write(.ownerKeyPolicy, try OwnerKeyPolicy.record())
      _ = try Vault.create(
        root: self.root, protectedStore: self.protectedStore, deviceName: self.deviceName,
        owner: owner)
      return self.examineNow()
    }
  }

  /// Removes the vault folder, grants included, and every protected value.
  public func startFresh(_ authentication: Authentication) async throws -> VaultCondition {
    try await run {
      self.discardImportNow()
      self.vault = nil
      self.owner = nil
      if AtomicFile.exists(self.root) { try FileManager.default.removeItem(at: self.root) }
      for name in ProtectedName.allCases { try self.protectedStore.delete(name) }
      return self.examineNow()
    }
  }

  // MARK: Settings

  /// "Agents can sign in with your passwords". Missing means on (setting up
  /// was the opt-in); unreadable means off, so a damaged value never lets
  /// agents in.
  public func agentSignIns() async -> Bool {
    (try? await run { self.agentSignInsNow() }) ?? false
  }

  /// On this queue, so it reads the switch as `setAgentSignIns` left it for
  /// the work queued after it.
  private func agentSignInsNow() -> Bool {
    let stored: Data?
    do {
      stored = try protectedStore.read(.settings)
    } catch {
      return false
    }
    guard let data = stored else { return true }
    guard let value = try? CanonicalJSON.parseCanonical(data),
      let object = try? StrictObject(value, keys: ["agentSignIns", "v"], context: "settings"),
      (try? object.integer("v")) == 1
    else {
      Log.vault.error("The settings are unreadable; agent sign-ins are off.")
      return false
    }
    switch try? object.string("agentSignIns") {
    case "on": return true
    case "off": return false
    default:
      Log.vault.error("The settings are unreadable; agent sign-ins are off.")
      return false
    }
  }

  public func setAgentSignIns(_ on: Bool) async throws {
    try await run {
      try self.protectedStore.write(
        .settings,
        try CanonicalJSON.encode(
          .object(["agentSignIns": .string(on ? "on" : "off"), "v": .integer(1)])))
    }
  }

  // MARK: Sign-ins

  /// Whether a saved login has an origin within `site`. Never asks anyone.
  public func hasLogin(withinSite site: String) async throws -> Bool {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      return !(try unlocked.items(withinSite: site).isEmpty)
    }
  }

  /// A request's read: the granted login, when the grant for `grant` names
  /// one that is still within the site, or else the site's logins to choose
  /// from. Never asks anyone; reads the vault as it is now (the unlock
  /// verifies it against the checkpoint under the vault lock, and this queue
  /// orders the read with every commit).
  public func lookUp(
    withinSite site: String, grant key: GrantKey, permissionVersion: Int64
  ) async throws -> SiteLookup {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      let items = try unlocked.items(withinSite: site)
      if let grant = try unlocked.grant(for: key), grant.authorizes(permissionVersion: permissionVersion),
        let item = items.first(where: { $0.id == grant.loginId && $0.revision == grant.revision })
      {
        return .granted(item)
      }
      return .choose(Self.accountChoices(items))
    }
  }

  private static func accountChoices(_ items: [Item]) -> [LoginSummary] {
    let newestFirst = items.sorted {
      $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
    }
    struct Identity: Hashable {
      let username: [UInt8]
      let password: [UInt8]
    }
    var originsByIdentity: [Identity: Set<String>] = [:]
    var kept: [Item] = []
    for item in newestFirst {
      let identity = Identity(
        username: Array(item.username.utf8), password: Array(item.password.utf8))
      let origins = Set(item.origins)
      if let seen = originsByIdentity[identity], !seen.isDisjoint(with: origins) { continue }
      originsByIdentity[identity, default: []].formUnion(origins)
      kept.append(item)
    }
    return kept.map { LoginSummary($0) }
  }

  /// The person allowed `loginId` at `revision`. Decided in one unlock, in
  /// queue order with every other vault change and with the switch's own
  /// write: agent sign-ins are on, the login is still that revision within
  /// the site, and the sign-in is still live, and only then is `grant`
  /// written (Allow). Nil when the sign-in ended first; nothing is written
  /// unless the answer is `approved`.
  func approve(
    withinSite site: String, loginId: String, revision: Int64, grant: GrantChange?,
    authority: TransactionAuthority, expiresAt: Date, _ authentication: Authentication
  ) async throws -> Approval? {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      guard self.agentSignInsNow() else { return .off }
      let items = try unlocked.items(withinSite: site)
      guard let item = items.first(where: { $0.id == loginId && $0.revision == revision }) else {
        return .changed(Self.accountChoices(items))
      }
      guard expiresAt > Date() else { return nil }
      return try authority.whileLive {
        if let grant {
          do {
            _ = try unlocked.commit(VaultChanges(grant: [grant]))
          } catch VaultError.noChanges {
            // Allowed already, as this login.
          }
        }
        return .approved(item)
      }
    }
  }

  /// Runs in queue order with login edits, revocations and the off switch.
  func release(
    _ params: Wire.ReleaseParams, login: Wire.Login, site: String, grant key: GrantKey?,
    permissionVersion: Int64, authority: TransactionAuthority, expiresAt: Date
  ) async throws -> Wire.ReleaseResult {
    try await run {
      guard expiresAt > Date() else { return .refused(.ended) }
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      guard self.agentSignInsNow() else { return .refused(.passwordsOff) }
      guard let item = try? unlocked.item(id: login.id), item.revision == login.revision else {
        return .refused(.revoked)
      }
      if let key {
        guard let grant = try unlocked.grant(for: key), grant.loginId == login.id,
          grant.revision == login.revision, grant.authorizes(permissionVersion: permissionVersion)
        else {
          return .refused(.revoked)
        }
      }
      // A login covers its whole registrable site, as approval offered it.
      guard item.origins.contains(where: { Origins.isWithinSite($0, site: site) }) else {
        return .refused(.wrongSite)
      }
      switch params.destination {
      case .app:
        guard permissionVersion == 5 else { return .refused(.revoked) }
      case .browser(let origin):
        guard Origins.isWithinSite(origin, site: site) else { return .refused(.wrongSite) }
      }
      return try authority.whileLive {
        guard expiresAt > Date() else { return .refused(.ended) }
        switch params.field {
        case .username: return .released(item.username)
        case .password: return .released(item.password)
        case .totp:
          guard let totp = item.totp else { return .refused(.noTOTP) }
          return .released(try totp.code(at: Date()))
        }
      } ?? .refused(.ended)
    }
  }

  // MARK: The Passwords window

  /// Every login, without passwords, with its grants.
  public func summaries(_ authentication: Authentication) async throws -> [LoginSummary] {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      return try Self.summaries(unlocked)
    }
  }

  /// One login as it is now, for the broker to decide whether an edit needs
  /// a fresh authentication. Never asks anyone.
  func summary(id: String) async throws -> LoginSummary? {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      do {
        return LoginSummary(try unlocked.item(id: id), grants: unlocked.grants)
      } catch VaultError.itemNotFound {
        return nil
      }
    }
  }

  /// One commit: `build` sees the unlocked vault and returns the changes, or
  /// nil when there is nothing to write. With `listing`, the logins after the
  /// change are read in the same unlock.
  @discardableResult
  public func change(
    _ authentication: Authentication, listing: Bool = false,
    _ build: @escaping @Sendable (UnlockedVault) throws -> VaultChanges?
  ) async throws -> [LoginSummary]? {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      if let changes = try build(unlocked) { _ = try unlocked.commit(changes) }
      return listing ? try Self.summaries(unlocked) : nil
    }
  }

  /// Removes `grant`: its key's grant, while it still names the same login.
  /// One that an Allow put in its place since is not the one the person
  /// removed, and stays. It only reduces what agents may do, so it takes no
  /// authentication.
  @discardableResult
  public func removeGrant(_ grant: Grant, listing: Bool) async throws -> [LoginSummary]? {
    try await run {
      let unlocked = try self.unlockNow()
      defer { unlocked.close() }
      if try unlocked.grant(for: grant.key) == grant {
        _ = try unlocked.commit(VaultChanges(revoke: [grant.key]))
      }
      return listing ? try Self.summaries(unlocked) : nil
    }
  }

  private static func summaries(_ unlocked: UnlockedVault) throws -> [LoginSummary] {
    let grants = unlocked.grants.filter(\.isCurrentPermission)
    return try unlocked.items().map { LoginSummary($0, grants: grants) }
  }

  // MARK: Import

  /// Unlocks and plans import `id` against the saved logins. The unlocked
  /// vault waits, on this queue only, for `commitImport` or `discardImport`
  /// of the same ID. Only the broker's open import comes here; another still
  /// pending has ended and its discard has not run yet.
  public func prepareImport(_ result: ImportResult, id: ImportID, _ authentication: Authentication)
    async throws
    -> ImportPreview
  {
    return try await run {
      self.discardImportNow()
      let unlocked = try self.unlockNow()
      do {
        let plan = try ImportPlan(candidates: result.candidates, existing: try unlocked.items())
        var rows = Set<Int>()
        var new = 0
        var updates = 0
        var already = 0
        var skipped = result.skipped.map {
          ImportPreview.SkippedRow(row: $0.row, reason: ImportText.reason($0.reason))
        }
        let groupSizes = Dictionary(grouping: plan.entries, by: \.group).mapValues(\.count)
        for entry in plan.entries {
          switch entry.classification {
          case .new:
            new += 1
            rows.insert(entry.candidate.sourceRow)
          case .update:
            updates += 1
            rows.insert(entry.candidate.sourceRow)
          case .duplicate:
            already += 1
          case .conflict:
            // The file disagrees with itself, or several saved logins match:
            // nothing here can say which password or two-factor key is
            // right, so none is guessed and the person is told why.
            let inFile = groupSizes[entry.group, default: 1] > 1
            skipped.append(
              ImportPreview.SkippedRow(
                row: entry.candidate.sourceRow,
                reason: inFile ? ImportText.conflictInFile : ImportText.conflictWithSaved))
          }
        }
        skipped.sort { $0.row < $1.row }
        self.pendingImport = (id, unlocked, plan, rows)
        let leftOut = result.ignoredURLs.map {
          ImportPreview.SkippedRow(row: $0.row, reason: ImportText.reason($0.reason))
        }
        return ImportPreview(
          new: new, updates: updates, alreadySaved: already, skipped: skipped, leftOut: leftOut)
      } catch {
        unlocked.close()
        throw error
      }
    }
  }

  /// Writes prepared import `id` as one commit and closes the vault.
  public func commitImport(_ id: ImportID) async throws -> Int {
    try await run {
      guard let pending = self.pendingImport, pending.id == id else {
        throw VaultServiceError.noImport
      }
      self.pendingImport = nil
      defer { pending.unlocked.close() }
      guard !pending.rows.isEmpty else { return 0 }
      let result = try pending.unlocked.commit(try pending.plan.changes(selecting: pending.rows))
      return result.added.count + result.updated.count
    }
  }

  /// Queued at once, so every vault call made after it runs after it.
  public func discardImport(_ id: ImportID) {
    queue.async {
      if self.pendingImport?.id == id { self.discardImportNow() }
    }
  }

  /// Whether a prepared import holds the vault unlocked.
  var holdsImport: Bool {
    get async { (try? await run { self.pendingImport != nil }) ?? false }
  }

  private func discardImportNow() {
    pendingImport?.unlocked.close()
    pendingImport = nil
  }

  private func unlockNow() throws -> UnlockedVault {
    guard let vault, let owner else { throw VaultServiceError.notReady }
    return try vault.unlock(owner: owner)
  }
}

/// Carries a non-Sendable value onto the vault queue, where it is used alone.
struct Unchecked<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}

/// What the person reads about rows an import leaves out.
public enum ImportText {
  public static let conflictInFile =
    "the file has this login more than once, with different passwords or two-factor keys"
  public static let conflictWithSaved = "more than one saved password matches it"

  public static func reason(_ reason: ImportSkipReason) -> String {
    switch reason {
    case .notHTTPS: return "not an https website"
    case .noPassword: return "no password"
    case .noURL: return "no website"
    case .unsupportedURL: return "not a website address"
    case .invalidTOTP: return "a two-factor code Opensteer can’t read"
    case .tooLarge: return "too long"
    case .notLogin: return "not a login"
    case .columnCount: return "the row doesn’t line up with the columns"
    case .urlsSpanSites:
      return
        "its web addresses belong to different sites; import Bitwarden’s .json export to keep them"
    case .neverMatch: return "Bitwarden is set never to fill it there"
    case .regexMatch: return "Bitwarden matches it with a pattern Opensteer can’t use"
    }
  }
}
