import Foundation

/// The live sessions and which one holds each app.
///
/// An app is claimed by the first observe or act that names it and released
/// when that session closes; every other session's call on it is `busy`.
@MainActor
final class SessionRegistry {
  private(set) var sessions: [String: HelperSession] = [:]
  private(set) var owners: [String: String] = [:]

  static let busy = HelperError(.busy, "This app is already being used by another task.")

  func insert(_ session: HelperSession) { sessions[session.sessionId] = session }

  /// Whether another session holds this app, checked before any work is done
  /// to resolve it for this one.
  func requireAvailable(_ key: String, for session: HelperSession) throws {
    if let owner = owners[key.lowercased()], owner != session.sessionId { throw Self.busy }
  }

  func claim(_ app: AppSessionState, for session: HelperSession) throws {
    try session.cancellation.check()
    guard sessions[session.sessionId] === session else {
      throw HelperError(.noSession, "That session is no longer open on this Mac.")
    }
    try requireAvailable(app.key, for: session)
    owners[app.key] = session.sessionId
  }

  @discardableResult
  func remove(_ id: String, reason: SessionCancelReason) -> HelperSession? {
    guard let session = sessions.removeValue(forKey: id) else { return nil }
    session.cancellation.cancel(reason)
    owners = owners.filter { $0.value != id }
    return session
  }
}
