import Foundation
import PasswordsCore

/// A call the broker answers later, on the connection it came on.
struct HeldCall {
  let connectionID: Int
  let requestID: Int64
}

/// A connection-owned authorization. Only metadata is retained between releases.
@MainActor
final class Transaction {
  enum Stage {
    case choosingCards([Wire.CardChoice])
    case preparedCard(Wire.CardChoice)
    case authorizedCard(Wire.CardChoice)
    case lookingUp
    case choosing([Wire.Account])
    case prepared(login: Wire.Login, remember: Bool)
    case authorized(login: Wire.Login, remembered: Bool)
  }

  struct Pending {
    enum Kind { case lookup, approve, release, fillBegin }
    let serial: Int
    let kind: Kind
    let call: HeldCall
    var task: Task<Void, Never>?
  }

  enum Kind: Sendable { case login, card, person }
  enum Context {
    case agent(Wire.SignInRequestParams, Kind)
    case person(Wire.FillBeginParams)
  }
  let context: Context
  var kind: Kind {
    switch context { case .agent(_, let kind): return kind; case .person: return .person }
  }
  var isCard: Bool { kind == .card }
  var isPerson: Bool { kind == .person }
  var request: Wire.SignInRequestParams? {
    if case .agent(let request, _) = context { return request }
    return nil
  }
  var person: Wire.FillBeginParams? {
    if case .person(let params) = context { return params }
    return nil
  }
  var site: String {
    switch context { case .agent(let request, _): return request.site; case .person(let params): return params.site }
  }
  let connectionID: Int
  let permissionVersion: Int64
  let expiresAt: Date
  let authority = TransactionAuthority()
  var stage: Stage = .lookingUp
  var pending: Pending?
  var account: String?
  var automatic = false
  var used = false
  var expiry: DispatchWorkItem?

  init(request: Wire.SignInRequestParams, connectionID: Int, expiresAt: Date, kind: Kind = .login) {
    precondition(kind != .person)
    self.context = .agent(request, kind)
    self.connectionID = connectionID
    self.permissionVersion = kind == .card ? 7 : request.permissionVersion
    self.expiresAt = expiresAt
  }

  init(person: Wire.FillBeginParams, connectionID: Int, expiresAt: Date) {
    context = .person(person)
    self.connectionID = connectionID
    permissionVersion = 8
    self.expiresAt = expiresAt
  }

  var id: String {
    switch context { case .agent(let request, _): return request.transactionId; case .person(let params): return params.transactionId }
  }
  var key: [String] {
    switch context {
    case .agent(let request, _): return [isCard ? "card" : "login"] + request.transactionKey
    case .person(let params): return ["person", params.transactionId]
    }
  }
  var waitsForThePerson: Bool {
    if case .choosing = stage { return true }
    if case .choosingCards = stage { return true }
    return false
  }
}

/// Revocation prevents queued approval/release work from acting after cancellation.
final class TransactionAuthority: @unchecked Sendable {
  private let lock = NSLock()
  private var live = true
  func revoke() {
    lock.withLock { live = false }
  }

  /// Runs only while cancellation has not revoked the transaction.
  func whileLive<T>(_ body: () throws -> T) rethrows -> T? {
    try lock.withLock {
      guard live else { return nil }
      return try body()
    }
  }
}
