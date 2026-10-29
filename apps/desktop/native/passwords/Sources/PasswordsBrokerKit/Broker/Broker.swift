import Foundation
import PasswordsCore

public struct BrokerConfiguration: Sendable {
  /// Compiled into the executable; reported truthfully in `hello`.
  public var development: Bool
  public var brokerVersion: String
  /// How long the window's saved logins stay shown without a window action.
  public var windowIdleLimit: TimeInterval

  public init(development: Bool, brokerVersion: String, windowIdleLimit: TimeInterval = 5 * 60) {
    self.development = development
    self.brokerVersion = brokerVersion
    self.windowIdleLimit = windowIdleLimit
  }
}

/// One import, from the file the person picked to its commit or its end.
/// Only the broker makes them, so a sheet can name its import but never
/// bring back one that ended.
public struct ImportID: Hashable, Sendable {
  fileprivate let serial: Int
}

public enum BrokerEvent: Sendable {
  /// The status, the vault's condition or the history changed.
  case changed
  /// The window's visit ended: its saved logins are hidden again.
  case windowLocked
}

/// The broker's state machine: connections, sign-in transactions, the
/// vault's condition, the agent sign-in setting and the Passwords window's
/// visit. It is where the authentication policy lives: the owner keys never
/// need the person, so every action the design lists asks here first.
///
/// Everything runs on the main actor. Frames arrive in order per connection;
/// work that waits (an authentication, the vault queue) resumes here and
/// re-checks that its transaction is still the one it started for. Vault
/// work that writes for a sign-in also holds its transaction's authority,
/// because the queue runs it whether or not the sign-in has ended.
@MainActor
public final class Broker: IPCServerDelegate {
  /// Sign-ins being looked up or released, at once.
  public static let maxUnderWay = 4
  /// Sign-ins waiting for approval on the card, at once. Counted apart from those under way, so cards nobody
  /// answered never hold back an account the person allowed.
  public static let maxWaitingForThePerson = 4
  /// A request never waits longer than this, whatever `expiresAt` says.
  public static let maxLifetime: TimeInterval = 60 * 60

  private struct Connection {
    let connection: IPCConnection
    var protocolVersion: Int64?
  }

  /// The window's saved logins, shown after one authentication until the
  /// window closes, the Mac locks or sleeps, or `windowIdleLimit` passes
  /// without a window action.
  private struct Visit {
    let serial: Int
    let authentication: Authentication
    var idle: DispatchWorkItem
  }

  private struct OpenImport {
    let id: ImportID
    /// The visit it belongs to; it ends with it.
    let visit: Int
    var prepared = false
  }

  private let configuration: BrokerConfiguration
  private let vault: VaultService
  private let presence: any PresenceChecker
  private let activity: ActivityLog
  public weak var windows: PasswordsWindowPresenter?

  public private(set) var condition: VaultCondition = .notSetUp
  /// The stored setting; agents can sign in only when the vault is also ready.
  public private(set) var agentSignInsSetting = false
  private var connections: [Int: Connection] = [:]
  private var transactions: [String: Transaction] = [:]
  private var lastStatus: Wire.Status?
  private var serial = 0
  private var observers: [UUID: @MainActor (BrokerEvent) -> Void] = [:]
  private var visit: Visit?
  /// Bumped whenever a visit ends, so a window authentication that finishes
  /// afterwards opens nothing.
  private var windowGeneration = 0
  /// Window authentications showing now; ending the visit withdraws them.
  private var windowPrompts: [Int: Task<Authentication, Error>] = [:]
  /// The one import the window may show. The broker alone ends it.
  private var openImport: OpenImport?

  public init(
    configuration: BrokerConfiguration, vault: VaultService, presence: any PresenceChecker,
    activity: ActivityLog
  ) {
    self.configuration = configuration
    self.vault = vault
    self.presence = presence
    self.activity = activity
  }

  /// Reads the vault's condition and the setting. Call before serving.
  public func load() async {
    condition = await vault.examine()
    agentSignInsSetting = await vault.agentSignIns()
    publish()
  }

  public var development: Bool { configuration.development }

  /// Nil while the Mac has not been unlocked since it started: the wire's
  /// states describe the vault, and nothing is known about it yet.
  public var status: Wire.Status? {
    condition.wire.map {
      Wire.Status(vault: $0, agentSignIns: condition == .ready && agentSignInsSetting)
    }
  }

  /// Each open sign-in's deadline, by transaction ID.
  var deadlines: [String: Date] { transactions.mapValues(\.expiresAt) }

  /// Whether the window's saved logins are shown: a visit is live.
  public var loginsShown: Bool { visit != nil }

  public func observe(_ handler: @escaping @MainActor (BrokerEvent) -> Void) -> UUID {
    let token = UUID()
    observers[token] = handler
    return token
  }

  public func stopObserving(_ token: UUID) {
    observers[token] = nil
  }

  // MARK: Connections

  public func connectionOpened(_ connection: IPCConnection) {
    connections[connection.id] = Connection(connection: connection)
  }

  public func connectionClosed(_ connection: IPCConnection) {
    connections[connection.id] = nil
    for transaction in transactions.values where transaction.connectionID == connection.id {
      // Usage is recorded at password release; connection loss ends authority.
      end(transaction, outcome: .cancelled, failure: nil)
    }
  }

  public func connection(_ connection: IPCConnection, received frame: Data) {
    guard let state = connections[connection.id] else { return }
    guard let request = Wire.Request.parse(frame) else {
      Log.ipc.error(
        "Closing connection \(connection.id, privacy: .public): a frame was not a request.")
      connection.close()
      return
    }
    guard state.protocolVersion != nil else {
      greet(connection, request)
      return
    }
    let call = HeldCall(connectionID: connection.id, requestID: request.id)
    guard let method = Wire.Method(rawValue: request.method) else {
      reply(call, failure: .invalid("Opensteer Passwords has no method by that name."))
      return
    }
    answering(call) { try self.handle(method, request.params, call: call) }
  }

  private func greet(_ connection: IPCConnection, _ request: Wire.Request) {
    let call = HeldCall(connectionID: connection.id, requestID: request.id)
    guard request.method == Wire.Method.hello.rawValue else {
      reply(call, failure: .invalid("The first message on a connection must be hello."))
      connection.close()
      return
    }
    let hello: Wire.HelloParams
    do {
      hello = try Wire.HelloParams(json: request.params)
    } catch {
      reply(call, failure: .invalid("Opensteer Passwords could not read that hello."))
      connection.close()
      return
    }
    reply(
      call,
      Wire.HelloResult(
        brokerVersion: configuration.brokerVersion, development: configuration.development,
        protocolVersion: Wire.supportedProtocolVersions.contains(hello.protocolVersion)
          ? hello.protocolVersion : Wire.latestProtocolVersion
      ).json)
    // Another version learns this broker's from the answer, which is how the
    // desktop tells the person to update; nothing else is served to it.
    guard Wire.supportedProtocolVersions.contains(hello.protocolVersion) else {
      connection.close()
      return
    }
    connections[connection.id]?.protocolVersion = hello.protocolVersion
  }

  private func handle(_ method: Wire.Method, _ params: JSONValue, call: HeldCall) throws {
    guard let version = connections[call.connectionID]?.protocolVersion else { return }
    switch method {
    case .hello:
      throw Wire.Failure.invalid("This connection already said hello.")
    case .status:
      try Wire.empty(params)
      whenExamined(call) {
        guard let status = self.status else { throw Self.notUnlocked }
        self.reply(call, status.json)
      }
    case .windowOpen:
      try Wire.empty(params)
      reply(call, Wire.emptyResult)
      windows?.openPasswordsWindow()
    case .signInProbe:
      let probe = try Wire.ProbeParams(json: params)
      whenExamined(call) { self.probe(probe, call: call) }
    case .signInRequest:
      let request = try Wire.SignInRequestParams(json: params, protocolVersion: version)
      whenExamined(call) { try self.signInRequest(request, call: call) }
    case .signInApprove:
      try approve(try Wire.ApproveParams(json: params), call: call)
    case .signInRelease:
      try release(try Wire.ReleaseParams(json: params, protocolVersion: version), call: call)
    case .signInCancel:
      let cancel = try Wire.TransactionParams(json: params)
      // Cancelling what already ended (an expiry) is done already.
      if let transaction = transactions[cancel.transactionId],
        transaction.connectionID == call.connectionID
      {
        end(transaction, outcome: .cancelled, failure: Self.ended)
      }
      reply(call, Wire.emptyResult)
    }
  }

  /// Runs `body` now, or after examining the vault again while the Mac had
  /// not been unlocked since it started: it may have been since.
  private func whenExamined(_ call: HeldCall, _ body: @escaping @MainActor () throws -> Void) {
    guard condition == .unavailable else { return answering(call, body) }
    Task {
      await reload()
      answering(call, body)
    }
  }

  private func answering(_ call: HeldCall, _ body: () throws -> Void) {
    do {
      try body()
    } catch let failure as Wire.Failure {
      reply(call, failure: failure)
    } catch {
      reply(call, failure: Wire.Failure(.internal, "Opensteer Passwords could not do that."))
    }
  }

  // MARK: Probe and request

  private func probe(_ params: Wire.ProbeParams, call: HeldCall) {
    switch condition {
    case .unavailable: return reply(call, Wire.Availability.unavailable.json)
    case .notSetUp, .needsReset, .unsupported: return reply(call, Wire.Availability.notSetUp.json)
    case .ready: break
    }
    guard agentSignInsSetting else { return reply(call, Wire.Availability.off.json) }
    Task {
      do {
        let found = try await vault.hasLogin(withinSite: params.site)
        reply(call, (found ? Wire.Availability.hasLogin : .noLogin).json)
      } catch {
        Log.broker.error("The vault could not be read for a sign-in.")
        reply(call, Wire.Availability.unavailable.json)
        await reload()
      }
    }
  }

  private func signInRequest(_ params: Wire.SignInRequestParams, call: HeldCall) throws {
    guard transactions[params.transactionId] == nil else {
      throw Wire.Failure.invalid("That sign-in was already requested.")
    }
    if let refusal = releaseRefusal { return answer(call, refusal) }
    let now = Date()
    guard params.expiresAt > now else {
      throw Wire.Failure.invalid("That sign-in already expired.")
    }
    let key = params.transactionKey
    guard !transactions.values.contains(where: { $0.key == key }),
      transactions.values.filter({ !$0.waitsForThePerson && $0.pending != nil }).count
        < Self.maxUnderWay
    else { return reply(call, Wire.Decision.unavailable(.busy).json) }
    let transaction = Transaction(
      request: params, connectionID: call.connectionID,
      expiresAt: min(params.expiresAt, now.addingTimeInterval(Self.maxLifetime)))
    transactions[transaction.id] = transaction
    scheduleExpiry(transaction)
    hold(transaction, .lookup, call) { serial in
      await self.lookUp(transaction, serial: serial, call: call)
    }
  }

  /// Authorizes the granted login, or offers the site's accounts. No one is
  /// asked either way.
  private func lookUp(_ transaction: Transaction, serial: Int, call: HeldCall) async {
    let request = transaction.request
    let found: SiteLookup
    do {
      found = try await vault.lookUp(
        withinSite: request.site, grant: request.grantKey,
        permissionVersion: transaction.permissionVersion)
    } catch {
      guard isCurrent(transaction, serial) else { return }
      return vaultFailed(transaction, error)
    }
    guard isCurrent(transaction, serial) else { return }
    transaction.pending = nil
    switch found {
    case .granted(let item):
      // The switch or the vault may have changed during the read.
      if let refusal = releaseRefusal { return refuse(transaction, refusal, call) }
      authorize(item, for: transaction, call: call, remembered: true, automatic: true)
    case .choose(let logins):
      guard transactions.values.filter(\.waitsForThePerson).count < Self.maxWaitingForThePerson
      else {
        // Refused like a request that was never admitted: nobody saw it.
        reply(call, Wire.Decision.unavailable(.busy).json)
        return end(transaction, outcome: nil, failure: nil)
      }
      offerAccounts(logins, transaction: transaction, call: call)
    }
  }

  private static func accounts(_ logins: [LoginSummary], request: Wire.SignInRequestParams) -> [Wire
    .Account]
  {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return logins.compactMap { login -> (Wire.Account, Int64)? in
      let onPage = false
      guard
        let origin = login.origins.first(where: { Origins.isWithinSite($0, site: request.site) }),
        let host = URL(string: origin)?.host
      else { return nil }
      let label = login.label?.trimmingCharacters(in: .whitespacesAndNewlines)
      let repeated =
        label.map { text in
          let lower = text.lowercased()
          return lower == request.siteHost
            || login.origins.contains {
              lower == $0.lowercased() || lower == URL(string: $0)?.host?.lowercased()
            }
        } ?? false
      return (
        Wire.Account(
          host: host, onPage: onPage,
          updatedAt: formatter.string(
            from: Date(timeIntervalSince1970: Double(login.updatedAt) / 1000)),
          id: login.id, revision: login.revision, username: login.username,
          label: repeated || label?.isEmpty == true ? nil : label), login.updatedAt
      )
    }.sorted {
      let left = $0.0
      let right = $1.0
      if left.onPage != right.onPage { return left.onPage }
      if left.host != right.host { return left.host < right.host }
      let a = left.username.lowercased()
      let b = right.username.lowercased()
      if a != b { return a < b }
      if $0.1 != $1.1 { return $0.1 > $1.1 }
      return left.id < right.id
    }.prefix(Wire.maxAccounts).map { $0.0 }
  }

  private func offerAccounts(
    _ logins: [LoginSummary], transaction: Transaction, call: HeldCall, changedID: String? = nil
  ) {
    let accounts = Self.accounts(logins, request: transaction.request)
    let message = changedID.map { id in
      accounts.contains { $0.id == id } ? Copy.accountChanged : Copy.accountGone
    }
    let decision = Wire.Decision.approve(accounts, message: message).json
    guard Wire.result(id: call.requestID, decision).count <= Frame.maxBytes else {
      reply(call, failure: .invalid("The saved account list is too large to display."))
      return end(transaction, outcome: nil, failure: nil)
    }
    transaction.stage = .choosing(accounts)
    reply(call, decision)
  }

  // MARK: The person's answers on the card

  /// Allow or Only this time: the broker authenticates the person for this
  /// login at this revision, reads it again after the wait, and authorizes it
  /// only if it is unchanged; Allow also grants it, in the same unlock. A
  /// login that changed meanwhile is offered again with the site's accounts
  /// as they are now; agent sign-ins off or the vault not ready end the
  /// sign-in with `unavailable`, as a request's refusal does.
  private func approve(_ params: Wire.ApproveParams, call: HeldCall) throws {
    let transaction = try owned(params.transactionId, by: call.connectionID)
    guard case .choosing(let accounts) = transaction.stage, transaction.pending == nil else {
      throw Wire.Failure.invalid(Copy.signInMovedOn)
    }
    guard let account = accounts.first(where: { $0.id == params.loginId }) else {
      throw Wire.Failure.invalid(Copy.notOffered)
    }
    if let refusal = releaseRefusal { return refuse(transaction, refusal, call) }
    // The card is behind what is offered: it is told, and nobody is asked.
    guard account.revision == params.revision else {
      return reply(call, Wire.Decision.approve(accounts, message: Copy.accountChanged).json)
    }
    let request = transaction.request
    let username = Display.account(account.username)
    let reason =
      params.remember
      ? Copy.allowReason(
        workspace: Display.name(request.workspaceName, unnamed: Copy.unnamedWorkspace, limit: 60),
        site: request.siteHost,
        username: username, permissionVersion: transaction.permissionVersion)
      : Copy.onceReason(
        site: request.siteHost, username: username, permissionVersion: transaction.permissionVersion)
    hold(transaction, .approve, call) { serial in
      await self.approve(
        transaction, serial: serial, account: account, remember: params.remember, reason: reason,
        call: call)
    }
  }

  private func approve(
    _ transaction: Transaction, serial: Int, account: Wire.Account, remember: Bool, reason: String,
    call: HeldCall
  ) async {
    let authentication: Authentication
    do {
      authentication = try await presence.authenticate(reason: reason)
    } catch {
      guard isCurrent(transaction, serial) else { return }
      transaction.pending = nil
      return reply(call, failure: .invalid(Self.notice(error)))
    }
    guard isCurrent(transaction, serial) else { return }
    if let refusal = releaseRefusal { return refuse(transaction, refusal, call) }
    let request = transaction.request
    let names = Self.grantNames(request)
    let grant =
      remember
      ? GrantChange(
        key: request.grantKey, login: .saved(id: account.id), deploymentName: names.deployment,
        workspaceName: names.workspace, permissionVersion: transaction.permissionVersion)
      : nil
    let approval: Approval?
    do {
      approval = try await vault.approve(
        withinSite: request.site, loginId: account.id, revision: account.revision, grant: grant,
        authority: transaction.authority, expiresAt: transaction.expiresAt, authentication)
    } catch {
      guard isCurrent(transaction, serial) else { return }
      if let refusal = releaseRefusal { return refuse(transaction, refusal, call) }
      return vaultFailed(transaction, error)
    }
    guard isCurrent(transaction, serial), let approval else { return }
    // The switch or the vault may have changed since the vault work ran.
    if let refusal = releaseRefusal { return refuse(transaction, refusal, call) }
    switch approval {
    case .approved(let item):
      transaction.pending = nil
      authorize(item, for: transaction, call: call, remembered: remember, automatic: false)
    case .changed(let logins):
      transaction.pending = nil
      offerAccounts(logins, transaction: transaction, call: call, changedID: account.id)
    case .off:
      refuse(transaction, .reason(.passwordsOff), call)
    }
  }

  /// The Workspace and Deployment names a grant keeps for display.
  private static func grantNames(_ request: Wire.SignInRequestParams) -> (
    deployment: String, workspace: String
  ) {
    (
      Display.name(request.deploymentName, unnamed: Copy.unnamedDeployment),
      Display.name(request.workspaceName, unnamed: Copy.unnamedWorkspace)
    )
  }

  /// Pins every authorization, including Only this time, without a field value.
  private func authorize(
    _ item: Item, for transaction: Transaction, call: HeldCall, remembered: Bool, automatic: Bool
  ) {
    guard transaction.expiresAt > Date() else {
      reply(call, failure: Wire.Failure(.unavailable, "This sign-in expired."))
      return end(transaction, outcome: .expired, failure: nil)
    }
    guard item.origins.contains(where: { Origins.isWithinSite($0, site: transaction.request.site) })
    else {
      return reply(call, failure: .invalid(Copy.accountChanged))
    }
    let login = Wire.Login(
      id: item.id, revision: item.revision,
      account: String(Display.maskedAccount(item.username).prefix(200)), hasTOTP: item.totp != nil)
    transaction.stage = .authorized(login: login, remembered: remembered)
    transaction.account = login.account
    transaction.automatic = automatic
    reply(call, Wire.Decision.authorized(login).json)
  }

  /// Read and validate afresh for each field; no secret survives in the transaction.
  private func release(_ params: Wire.ReleaseParams, call: HeldCall) throws {
    guard let transaction = transactions[params.transactionId],
      transaction.connectionID == call.connectionID,
      transaction.expiresAt > Date(),
      case .authorized(let login, let remembered) = transaction.stage
    else {
      return reply(call, Wire.ReleaseResult.refused(.ended).json)
    }
    guard transaction.pending == nil else { throw Wire.Failure.invalid(Copy.signInMovedOn) }
    guard condition == .ready else { return reply(call, Wire.ReleaseResult.refused(.revoked).json) }
    guard agentSignInsSetting else {
      return reply(call, Wire.ReleaseResult.refused(.passwordsOff).json)
    }
    guard params.destination != .app || transaction.permissionVersion == 5 else {
      return reply(call, Wire.ReleaseResult.refused(.revoked).json)
    }
    let request = transaction.request
    let authority = transaction.authority
    let expiresAt = transaction.expiresAt
    hold(transaction, .release, call) { serial in
      let result: Wire.ReleaseResult
      do {
        result = try await self.vault.release(
          params, login: login, site: request.site,
          grant: remembered ? request.grantKey : nil, permissionVersion: transaction.permissionVersion,
          authority: authority, expiresAt: expiresAt)
      } catch {
        guard self.isCurrent(transaction, serial) else { return }
        transaction.pending = nil
        self.reply(call, Wire.ReleaseResult.refused(.revoked).json)
        await self.reload()
        return
      }
      guard self.isCurrent(transaction, serial) else { return }
      transaction.pending = nil
      guard transaction.expiresAt > Date() else {
        self.reply(call, Wire.ReleaseResult.refused(.ended).json)
        return self.end(transaction, outcome: .expired, failure: nil)
      }
      guard self.condition == .ready else {
        return self.reply(call, Wire.ReleaseResult.refused(.revoked).json)
      }
      guard self.agentSignInsSetting else {
        return self.reply(call, Wire.ReleaseResult.refused(.passwordsOff).json)
      }
      if case .released = result, params.field == .password, !transaction.used {
        transaction.used = true
        self.record(transaction, outcome: .used)
      }
      self.reply(call, result.json)
    }
  }

  private func owned(_ transactionId: String, by connectionID: Int) throws -> Transaction {
    // Another connection's transaction does not exist from here.
    guard let transaction = transactions[transactionId], transaction.connectionID == connectionID
    else {
      throw Wire.Failure.invalid(Copy.signInEnded)
    }
    return transaction
  }

  /// Holds `call` on `transaction` while `work` waits. Ending the
  /// transaction cancels the work, which withdraws an authentication still
  /// showing, revokes its authority over vault work already queued, and
  /// answers the call.
  private func hold(
    _ transaction: Transaction, _ kind: Transaction.Pending.Kind, _ call: HeldCall,
    _ work: @escaping @MainActor (Int) async -> Void
  ) {
    let serial = nextSerial()
    transaction.pending = Transaction.Pending(serial: serial, kind: kind, call: call)
    transaction.pending?.task = Task { await work(serial) }
  }

  private func isCurrent(_ transaction: Transaction, _ serial: Int) -> Bool {
    transactions[transaction.id] === transaction && transaction.pending?.serial == serial
  }

  private enum Refusal {
    /// The vault is not ready, or the person turned agent sign-ins off.
    case reason(Wire.UnavailableReason)
    /// The Mac has not been unlocked since it started: nothing is known
    /// about the vault, so it is the unlock sentence, as `status` says.
    case notUnlocked
  }

  /// Why nothing may be released right now. Checked again after every wait.
  private var releaseRefusal: Refusal? {
    switch condition {
    case .ready: return agentSignInsSetting ? nil : .reason(.passwordsOff)
    case .unavailable: return .notUnlocked
    case .notSetUp, .needsReset, .unsupported: return .reason(.notSetUp)
    }
  }

  private func answer(_ call: HeldCall, _ refusal: Refusal) {
    switch refusal {
    case .reason(let reason): reply(call, Wire.Decision.unavailable(reason).json)
    case .notUnlocked: reply(call, failure: Self.notUnlocked)
    }
  }

  /// Answers the refusal and ends the sign-in, which leaves the desktop
  /// nothing to finish, as when a request is refused.
  private func refuse(_ transaction: Transaction, _ refusal: Refusal, _ call: HeldCall) {
    transaction.pending = nil
    answer(call, refusal)
    end(transaction, outcome: .cancelled, failure: nil)
  }

  private func vaultFailed(_ transaction: Transaction, _ error: Error) {
    Log.broker.error("The vault could not be read for a sign-in.")
    end(transaction, outcome: .failed, failure: Wire.Failure(.internal, Copy.couldNotOpenForSignIn))
    Task { await reload() }
  }

  private static func notice(_ error: Error) -> String {
    switch error as? PresenceError {
    case .failed?: return Copy.notConfirmed
    case .unavailable?: return Copy.cannotAuthenticate
    case .cancelled?, nil: return Copy.authenticationCancelled
    }
  }

  // MARK: Ending

  private static let ended = Wire.Failure(.unavailable, Copy.signInEnded)
  private static let notUnlocked = Wire.Failure(.unavailable, Copy.notUnlockedSinceRestart)

  /// The screen locked: the window's saved logins are hidden again. Sign-ins
  /// carry on: an allowed account still signs in while the Mac is locked.
  public func screenLocked() {
    endVisit()
  }

  /// The Mac is going to sleep.
  public func willSleep() {
    endVisit()
  }

  /// The screen unlocked: a vault that could not be read before the Mac's
  /// first unlock can be now.
  public func screenUnlocked() {
    guard condition == .unavailable else { return }
    Task { await reload() }
  }

  /// The broker is quitting: the visit and the import end now, before the
  /// process does.
  public func stop() {
    endVisit()
  }

  /// After a wake: deadlines that passed while the Mac slept end now.
  public func sweepExpired() {
    let now = Date()
    for transaction in transactions.values where transaction.expiresAt <= now {
      expire(transaction)
    }
  }

  private func scheduleExpiry(_ transaction: Transaction) {
    let work = DispatchWorkItem { [weak self, weak transaction] in
      MainActor.assumeIsolated {
        guard let self, let transaction else { return }
        self.expire(transaction)
      }
    }
    transaction.expiry = work
    DispatchQueue.main.asyncAfter(
      wallDeadline: .now() + max(0, transaction.expiresAt.timeIntervalSinceNow), execute: work)
  }

  private func expire(_ transaction: Transaction) {
    end(
      transaction, outcome: .expired, failure: Wire.Failure(.unavailable, "This sign-in expired."))
  }

  /// Ends `transaction` once, with one Activity entry, or none when it
  /// never reached the person (`outcome` nil). Vault work it queued writes
  /// nothing from now on. A call still held is answered with `failure`; nil:
  /// the connection is gone, or the call was answered already.
  private func end(_ transaction: Transaction, outcome: ActivityOutcome?, failure: Wire.Failure?) {
    guard transactions[transaction.id] === transaction else { return }
    transactions[transaction.id] = nil
    transaction.authority.revoke()
    transaction.expiry?.cancel()
    transaction.expiry = nil
    if let pending = transaction.pending {
      pending.task?.cancel()
      if case .release = pending.kind {
        if connections[transaction.connectionID] != nil {
          reply(pending.call, Wire.ReleaseResult.refused(.ended).json)
        }
      } else if let failure {
        reply(pending.call, failure: failure)
      }
    }
    transaction.pending = nil
    guard let outcome, !transaction.used else { return }
    record(transaction, outcome: outcome)
  }

  private func record(_ transaction: Transaction, outcome: ActivityOutcome) {
    let request = transaction.request
    activity.append(
      ActivityEntry(
        at: Date(), site: request.siteHost, account: transaction.account,
        deployment: Display.clean(request.deploymentName, limit: 120),
        workspace: Display.clean(request.workspaceName, limit: 120),
        thread: Display.clean(request.threadTitle, limit: 200), automatic: transaction.automatic,
        outcome: outcome))
    notify(.changed)
  }

  // MARK: Status

  private func publish() {
    let current = status
    if current != lastStatus {
      lastStatus = current
      if let current {
        let event = Wire.statusChanged(current)
        for state in connections.values where state.protocolVersion != nil { state.connection.send(event) }
      }
    }
    notify(.changed)
  }

  private func notify(_ event: BrokerEvent) {
    for observer in Array(observers.values) { observer(event) }
  }

  private func reply(_ call: HeldCall, _ result: JSONValue) {
    connections[call.connectionID]?.connection.send(Wire.result(id: call.requestID, result))
  }

  private func reply(_ call: HeldCall, failure: Wire.Failure) {
    connections[call.connectionID]?.connection.send(Wire.error(id: call.requestID, failure))
  }

  private func nextSerial() -> Int {
    serial += 1
    return serial
  }

  // MARK: Vault state

  /// Reads the vault's condition again (Try Again, after an error, or once
  /// the Mac is unlocked), which drops a prepared import.
  public func reload() async {
    endImport()
    apply(await vault.examine())
    agentSignInsSetting = await vault.agentSignIns()
    publish()
  }

  private func apply(_ next: VaultCondition) {
    condition = next
    if next != .ready { endVisit() }
  }

  /// Setup asks for the person first; its authentication then opens the
  /// window's first visit, so Import and Add follow without another prompt.
  public func setUp() async throws {
    guard condition == .notSetUp else { throw VaultServiceError.alreadySetUp }
    let authentication = try await authenticateForWindow(Copy.setUpReason)
    let next = try await vault.setUp(authentication)
    apply(next)
    agentSignInsSetting = await vault.agentSignIns()
    if next == .ready { beginVisit(authentication) }
    publish()
  }

  /// No authentication either way: off stops every later field release.
  public func setAgentSignIns(_ on: Bool) async throws {
    try await vault.setAgentSignIns(on)
    agentSignInsSetting = on
    publish()
  }

  public func startFresh() async throws {
    guard case .needsReset = condition else { throw VaultServiceError.notReady }
    let authentication = try await authenticateForWindow(Copy.startFreshReason)
    endImport()
    apply(try await vault.startFresh(authentication))
    agentSignInsSetting = await vault.agentSignIns()
    publish()
  }

  // MARK: The Passwords window's visit

  /// Authenticates, opens a visit and lists the saved logins.
  public func showLogins() async throws -> [LoginSummary] {
    let authentication = try await authenticateForWindow(Copy.showReason)
    let opened = beginVisit(authentication)
    let list = try await vaultWork { try await self.vault.summaries(authentication) }
    guard visit?.serial == opened else { throw VaultServiceError.windowLocked }
    return list
  }

  /// The saved logins again, within the live visit.
  public func listLogins() async throws -> [LoginSummary] {
    let live = try useVisit()
    let list = try await vaultWork { try await self.vault.summaries(live.authentication) }
    guard visit?.serial == live.serial else { throw VaultServiceError.windowLocked }
    return list
  }

  /// Within the visit; no further authentication. Returns the logins after
  /// the change, or nil when the visit ended meanwhile.
  public func addLogin(_ draft: ItemDraft) async throws -> [LoginSummary]? {
    try draft.validate()
    let visit = try useVisit()
    return try await windowChange(visit) { _ in VaultChanges(add: [draft]) }
  }

  /// A password, two-factor or label change is within the visit. A change
  /// of websites, login page or username always authenticates afresh, and
  /// applies only to the login as it was when that was decided.
  public func updateLogin(_ edit: LoginEdit) async throws -> [LoginSummary]? {
    try edit.draftForValidation.validate()
    var visit = try useVisit()
    guard let current = try await vaultWork({ try await self.vault.summary(id: edit.id) }) else {
      throw VaultError.itemNotFound(edit.id)
    }
    var authentication = visit.authentication
    if current.repoints(origins: edit.origins, loginURL: edit.loginURL, username: edit.username) {
      authentication = try await authenticateForWindow(Copy.repointReason(site: current.site))
      visit = try useVisit()
    }
    let revision = current.revision
    return try await windowChange(visit, authentication) { unlocked in
      let saved = try unlocked.item(id: edit.id)
      guard saved.revision == revision else { throw VaultError.headMoved }
      var item = saved
      item.origins = edit.origins
      item.loginURL = edit.loginURL
      item.username = edit.username
      if let password = edit.password { item.password = password }
      if let totp = edit.totp { item.totp = totp }
      item.label = edit.label
      return item.isIdentical(to: saved) ? nil : VaultChanges(update: [item])
    }
  }

  public func deleteLogin(id: String) async throws -> [LoginSummary]? {
    let visit = try useVisit()
    return try await windowChange(visit) { _ in VaultChanges(delete: [id]) }
  }

  /// Remove on "Allowed for agents in": it only reduces what agents may do,
  /// so it needs no authentication. It removes the grant the line showed,
  /// for its login, never one that replaced it since. Returns the logins
  /// after it while the visit lives.
  public func removeGrant(_ grant: Grant) async throws -> [LoginSummary]? {
    let live = try? useVisit()
    let list = try await vaultWork { try await self.vault.removeGrant(grant, listing: live != nil) }
    guard let live, visit?.serial == live.serial else { return nil }
    return list
  }

  /// The window closed: the visit ends with it.
  public func windowClosed() {
    endVisit()
  }

  /// Replaces any visit; an import of the one before can no longer commit.
  @discardableResult
  private func beginVisit(_ authentication: Authentication) -> Int {
    visit?.idle.cancel()
    let serial = nextSerial()
    visit = Visit(serial: serial, authentication: authentication, idle: scheduleIdle(serial))
    return serial
  }

  private func scheduleIdle(_ serial: Int) -> DispatchWorkItem {
    let work = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.visit?.serial == serial else { return }
        self.endVisit()
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + configuration.windowIdleLimit, execute: work)
    return work
  }

  /// The live visit, kept alive by this use; refused once it ended.
  private func useVisit() throws -> Visit {
    guard var live = visit else { throw VaultServiceError.windowLocked }
    live.idle.cancel()
    live.idle = scheduleIdle(live.serial)
    visit = live
    return live
  }

  /// Ends the visit, the authentications showing for the window and the
  /// import: the window closed, the Mac locked or slept, the vault changed
  /// state, or the visit sat idle.
  private func endVisit() {
    windowGeneration += 1
    for prompt in windowPrompts.values { prompt.cancel() }
    windowPrompts = [:]
    endImport()
    guard let ended = visit else { return }
    ended.idle.cancel()
    visit = nil
    notify(.windowLocked)
  }

  /// One authentication for a window action, withdrawn when the visit ends
  /// (the window closing, a lock, sleep) and refused if it finished after.
  private func authenticateForWindow(_ reason: String) async throws -> Authentication {
    let generation = windowGeneration
    let key = nextSerial()
    let presence = presence
    let prompt = Task { try await presence.authenticate(reason: reason) }
    windowPrompts[key] = prompt
    defer { windowPrompts[key] = nil }
    let authentication = try await prompt.value
    guard generation == windowGeneration else { throw PresenceError.cancelled }
    return authentication
  }

  /// One commit in `authentication` (the visit's unless named), then the
  /// logins as they are, while the visit that asked is still live.
  private func windowChange(
    _ asking: Visit, _ authentication: Authentication? = nil,
    _ build: @escaping @Sendable (UnlockedVault) throws -> VaultChanges?
  ) async throws -> [LoginSummary]? {
    let list = try await vaultWork {
      try await self.vault.change(authentication ?? asking.authentication, listing: true, build)
    }
    return visit?.serial == asking.serial ? list : nil
  }

  /// A vault error that means the vault is no longer what it was reloads it.
  private func vaultWork<T>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch let error as VaultError where Self.meansReload(error) {
      await reload()
      throw error
    }
  }

  private static func meansReload(_ error: VaultError) -> Bool {
    switch error {
    case .invalidItem, .itemNotFound, .noChanges, .closed, .tooManyItems, .invalidGrant,
      .tooManyGrants, .headMoved:
      return false
    default: return true
    }
  }

  // MARK: Import

  /// Opens an import in the live visit, ending any other.
  public func beginImport() throws -> ImportID {
    let live = try useVisit()
    endImport()
    let id = ImportID(serial: nextSerial())
    openImport = OpenImport(id: id, visit: live.serial)
    return id
  }

  /// The visit's authentication covers the preview and the import's commit.
  /// The import is checked again after the wait, so a file read that
  /// finishes after it ended prepares nothing. A failure ends the import.
  public func prepareImport(_ result: ImportResult, for id: ImportID) async throws -> ImportPreview
  {
    guard let open = openImport, open.id == id, !open.prepared, let live = try? useVisit(),
      live.serial == open.visit
    else { throw VaultServiceError.noImport }
    do {
      let preview = try await vaultWork {
        try await self.vault.prepareImport(result, id: id, live.authentication)
      }
      guard openImport?.id == id, visit?.serial == open.visit else {
        vault.discardImport(id)
        throw VaultServiceError.noImport
      }
      openImport?.prepared = true
      return preview
    } catch {
      endImport(id)
      throw error
    }
  }

  /// Commits prepared import `id`, which ends it either way.
  public func commitImport(_ id: ImportID) async throws -> Int {
    guard let open = openImport, open.id == id, open.prepared, let live = try? useVisit(),
      live.serial == open.visit
    else { throw VaultServiceError.noImport }
    defer { endImport(id) }
    return try await vault.commitImport(id)
  }

  /// Ends import `id`, or whichever is open when nil, whatever the sheet
  /// shows: the vault it unlocked is dropped.
  public func endImport(_ id: ImportID? = nil) {
    guard let open = openImport, id == nil || open.id == id else { return }
    openImport = nil
    vault.discardImport(open.id)
  }
}

/// The Edit form's result.
public struct LoginEdit: Sendable {
  public let id: String
  public let origins: [String]
  public let loginURL: String
  public let username: String
  /// Nil keeps the saved password.
  public let password: String?
  /// Nil keeps the saved two-factor setup; `.some(nil)` removes it.
  public let totp: TOTPParameters??
  public let label: String?

  public init(
    id: String, origins: [String], loginURL: String, username: String, password: String?,
    totp: TOTPParameters??,
    label: String?
  ) {
    self.id = id
    self.origins = origins
    self.loginURL = loginURL
    self.username = username
    self.password = password
    self.totp = totp
    self.label = label
  }

  /// Checked before any authentication, so a bad form never costs one. The
  /// saved password is unknown here; a placeholder stands in for its limits.
  var draftForValidation: ItemDraft {
    ItemDraft(
      origins: origins, loginURL: loginURL, username: username, password: password ?? "unchanged",
      totp: totp ?? nil, label: label)
  }
}
