import Foundation
import PasswordsCore

/// The Passwords window's state and actions. The views only draw it. What
/// needs authentication, and when the saved logins hide again, is the
/// broker's: this model shows what the broker allows and follows its visit.
@MainActor
public final class PasswordsWindowModel: ObservableObject {
  public enum Screen: Equatable {
    case unsupported
    case setUp
    case settingUp
    /// Set up just now: offer Import / Add / Done.
    case setUpDone
    case ready
    case needsReset(NeedsReset)
    /// The Mac has not been unlocked since it started.
    case unavailable
  }

  public enum Logins: Equatable {
    case hidden
    case showing
    case shown([LoginSummary])
  }

  public enum Sheet: Identifiable, Equatable {
    case add
    case edit(LoginSummary)
    case importing

    public var id: String {
      switch self {
      case .add: return "add"
      case .edit(let login): return "edit-\(login.id)"
      case .importing: return "import"
      }
    }
  }

  @Published public private(set) var screen: Screen = .setUp
  @Published public private(set) var agentSignIns = false
  /// Newest first.
  @Published public private(set) var activity: [ActivityEntry] = []
  @Published public private(set) var logins: Logins = .hidden
  @Published public var search = ""
  @Published public var sheet: Sheet?
  @Published public private(set) var importFlow: ImportFlow?
  /// One sentence about the last action that did not work.
  @Published public var message: String?
  @Published public private(set) var working = false

  public let development: Bool
  private let broker: Broker
  private let activityLog: ActivityLog
  private let runner: ImportRunner
  private var observation: UUID?

  public init(broker: Broker, activityLog: ActivityLog, runner: ImportRunner) {
    self.broker = broker
    self.activityLog = activityLog
    self.runner = runner
    development = broker.development
    observation = broker.observe { [weak self] event in self?.brokerChanged(event) }
    refresh()
  }

  public var visibleLogins: [LoginSummary] {
    guard case .shown(let all) = logins else { return [] }
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let sorted = all.sorted {
      ($0.site, $0.username.lowercased(), $0.id) < ($1.site, $1.username.lowercased(), $1.id)
    }
    guard !query.isEmpty else { return sorted }
    return sorted.filter {
      $0.site.lowercased().contains(query) || $0.username.lowercased().contains(query)
        || ($0.label?.lowercased().contains(query) ?? false)
        || $0.origins.contains { $0.lowercased().contains(query) }
    }
  }

  // MARK: Following the broker

  private func brokerChanged(_ event: BrokerEvent) {
    if case .windowLocked = event { relock() }
    refresh()
  }

  private func refresh() {
    let next: Screen
    switch broker.condition {
    case .unsupported: next = .unsupported
    case .needsReset(let reason): next = .needsReset(reason)
    case .notSetUp: next = screen == .settingUp ? .settingUp : .setUp
    case .ready: next = screen == .setUpDone ? .setUpDone : .ready
    case .unavailable: next = .unavailable
    }
    if next != screen { screen = next }
    agentSignIns = broker.agentSignInsSetting
    Task { await loadActivity() }
  }

  func loadActivity() async {
    let entries = await activityLog.entries()
    activity = Array(entries.reversed().prefix(20))
  }

  /// The broker ended the visit: nothing it showed stays, and the forms
  /// and the import that needed it close.
  func relock() {
    logins = .hidden
    search = ""
    sheet = nil
    importFlow = nil
  }

  /// Ends the visit in the broker, which ends whatever import is open.
  public func windowClosed() {
    broker.windowClosed()
    relock()
    message = nil
  }

  // MARK: Setup and state

  public func setUp() async {
    message = nil
    screen = .settingUp
    do {
      try await broker.setUp()
      screen = .setUpDone
      logins = .shown([])
    } catch PresenceError.cancelled {
      screen = .setUp
    } catch is PresenceError {
      screen = .setUp
      message = Copy.notConfirmed
    } catch {
      screen = .setUp
      message = Copy.couldNotSave
      refresh()
    }
  }

  public func finishSetup() {
    screen = .ready
    refresh()
  }

  public func setAgentSignIns(_ on: Bool) async {
    do {
      try await broker.setAgentSignIns(on)
    } catch {
      message = Copy.couldNotSave
    }
    agentSignIns = broker.agentSignInsSetting
  }

  public func startFresh() async {
    do {
      try await broker.startFresh()
      message = nil
    } catch PresenceError.cancelled {
      message = nil
    } catch is PresenceError {
      message = Copy.notConfirmed
    } catch {
      message = Copy.couldNotSave
    }
    refresh()
  }

  public func tryAgain() async {
    await broker.reload()
  }

  // MARK: Saved passwords

  public func showPasswords() async {
    guard logins == .hidden else { return }
    message = nil
    logins = .showing
    do {
      let list = try await broker.showLogins()
      // A lock while Touch ID was showing already set the list back to hidden.
      if logins == .showing { logins = .shown(list) }
    } catch PresenceError.cancelled {
      logins = .hidden
    } catch {
      logins = .hidden
      message = Self.sentence(for: error)
    }
  }

  /// Hide ends the visit: showing them again authenticates again.
  public func hidePasswords() {
    broker.windowClosed()
    relock()
  }

  /// What a form does after Save: close, or stay with a sentence (none
  /// when the person cancelled Touch ID themselves).
  public enum FormOutcome: Equatable {
    case saved
    case stays(String?)
  }

  public func add(website: String, username: String, password: String, twoFactor: String, label: String) async
    -> FormOutcome
  {
    guard let target = Self.website(website) else { return .stays(Copy.badWebsite) }
    guard !password.isEmpty else { return .stays(Copy.noPassword) }
    let totp: TOTPParameters?
    switch Self.twoFactor(twoFactor) {
    case .invalid: return .stays(Copy.badTwoFactor)
    case .none: totp = nil
    case .key(let parameters): totp = parameters
    }
    let draft = ItemDraft(
      origins: [target.origin], loginURL: target.loginURL, username: username, password: password, totp: totp,
      label: Self.optional(label))
    do {
      try draft.validate()
    } catch {
      return .stays(Copy.tooLong)
    }
    return await perform { try await self.broker.addLogin(draft) }
  }

  public func edit(
    _ login: LoginSummary, websites: String, username: String, newPassword: String, twoFactor: String,
    removeTwoFactor: Bool, label: String
  ) async -> FormOutcome {
    var origins: [String] = []
    for line in websites.split(whereSeparator: \.isNewline) where !line.trimmingCharacters(in: .whitespaces).isEmpty {
      guard let target = Self.website(String(line)) else { return .stays(Copy.badWebsite) }
      if !origins.contains(target.origin) { origins.append(target.origin) }
    }
    guard !origins.isEmpty else { return .stays(Copy.badWebsite) }
    guard origins.count <= VaultLimits.maxOrigins else { return .stays(Copy.tooManyWebsites) }
    let keepsLoginPage = Origins.normalizeOrigin(login.loginURL).map(origins.contains) ?? false
    let loginURL = keepsLoginPage ? login.loginURL : origins[0] + "/"
    let totp: TOTPParameters??
    if removeTwoFactor {
      totp = .some(nil)
    } else {
      switch Self.twoFactor(twoFactor) {
      case .invalid: return .stays(Copy.badTwoFactor)
      case .none: totp = nil
      case .key(let parameters): totp = .some(parameters)
      }
    }
    let edit = LoginEdit(
      id: login.id, origins: origins, loginURL: loginURL, username: username,
      password: newPassword.isEmpty ? nil : newPassword, totp: totp, label: Self.optional(label))
    do {
      try edit.draftForValidation.validate()
    } catch {
      return .stays(Copy.tooLong)
    }
    return await perform { try await self.broker.updateLogin(edit) }
  }

  public func delete(_ login: LoginSummary) async {
    if case .stays(let problem) = await perform({ try await self.broker.deleteLogin(id: login.id) }) {
      message = problem
    }
  }

  /// Remove on one of the login's "Allowed for agents in" lines.
  public func removeGrant(_ grant: Grant) async {
    if case .stays(let problem) = await perform({ try await self.broker.removeGrant(grant) }) {
      message = problem
    }
  }

  /// Runs one change in the broker's visit. The list on screen is replaced
  /// by the one read in the same unlock, so it never shows what was before;
  /// none comes back once the visit ended, and the list hides.
  private func perform(_ change: @escaping () async throws -> [LoginSummary]?) async -> FormOutcome {
    working = true
    defer { working = false }
    do {
      let list = try await change()
      sheet = nil
      if let list { logins = .shown(list) } else { relock() }
      return .saved
    } catch PresenceError.cancelled {
      return .stays(nil)
    } catch VaultServiceError.windowLocked {
      relock()
      return .stays(nil)
    } catch {
      return .stays(Self.sentence(for: error))
    }
  }

  // MARK: Import

  public func startImport() {
    importFlow = ImportFlow(broker: broker, runner: runner) { [weak self] in
      self?.importFlow = nil
      self?.sheet = nil
      Task { await self?.showUpdatedList() }
    }
    sheet = .importing
  }

  /// After an import, the list as it is now, read in the same visit.
  private func showUpdatedList() async {
    guard case .shown = logins else { return }
    do {
      logins = .shown(try await broker.listLogins())
    } catch {
      relock()
    }
  }

  // MARK: Helpers

  static func sentence(for error: Error) -> String {
    switch error {
    case PresenceError.failed: return Copy.notConfirmed
    case PresenceError.unavailable: return Copy.cannotAuthenticate
    case VaultError.headMoved: return Copy.changedElsewhere
    case VaultError.invalidItem, VaultError.tooManyItems: return Copy.tooLong
    case is VaultError, VaultServiceError.notReady: return Copy.couldNotOpen
    default: return Copy.couldNotSave
    }
  }

  /// What the person typed as a website: a bare host becomes `https://host/`.
  static func website(_ text: String) -> (origin: String, loginURL: String)? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let url = trimmed.contains("://") ? trimmed : "https://" + trimmed
    guard let origin = Origins.normalizeOrigin(url), let loginURL = Origins.normalizeLoginURL(url) else { return nil }
    return (origin, loginURL)
  }

  enum TwoFactor {
    case none
    case key(TOTPParameters)
    case invalid
  }

  static func twoFactor(_ text: String) -> TwoFactor {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return .none }
    guard let parameters = try? TOTPParameters(parsing: trimmed) else { return .invalid }
    return .key(parameters)
  }

  private static func optional(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
