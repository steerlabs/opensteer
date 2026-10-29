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
    case lookingUp
    case choosing([Wire.Account])
    case authorized(login: Wire.Login, remembered: Bool)
  }

  struct Pending {
    enum Kind { case lookup, approve, release }
    let serial: Int
    let kind: Kind
    let call: HeldCall
    var task: Task<Void, Never>?
  }

  let request: Wire.SignInRequestParams
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

  init(request: Wire.SignInRequestParams, connectionID: Int, expiresAt: Date) {
    self.request = request
    self.connectionID = connectionID
    self.permissionVersion = request.permissionVersion
    self.expiresAt = expiresAt
  }

  var id: String { request.transactionId }
  var key: [String] { request.transactionKey }
  var waitsForThePerson: Bool {
    if case .choosing = stage { return true }
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
