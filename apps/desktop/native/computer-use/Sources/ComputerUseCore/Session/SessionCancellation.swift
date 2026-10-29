import Foundation

/// Why a running batch has to stop where it is.
public enum SessionCancelReason: Sendable, Equatable {
  /// The person pressed `Stop` on the pill.
  case stoppedByUser
  /// The session was closed — by `session.close`, by the owning connection
  /// dropping, or by the idle sweep.
  case closed

  var error: HelperError {
    switch self {
    case .stoppedByUser:
      return HelperError(.stoppedByUser, "The person stopped this session on their Mac.")
    case .closed:
      return HelperError(.noSession, "This session was closed while the actions were running.")
    }
  }
}

/// One session's stop signal, shared with whatever work is running inside it.
///
/// It is a separate object from the session on purpose: `Stop` and
/// `session.close` take the session away immediately on the main actor, and
/// the work already running on the work executor has to find out without
/// waiting for the main actor, which is why it is a lock rather than actor
/// state. Work checks it before every action, before every Accessibility read
/// of a window walk, and inside the actions that take many steps — every chunk
/// of `type`, every tick of `scroll` — because "stop" that waits for a hundred
/// characters to finish typing is not stop.
public final class SessionCancellation: Sendable {
  private struct State {
    var reason: SessionCancelReason?
    var handlers: [UUID: @Sendable () -> Void] = [:]
  }
  private let state = Locked(State())

  public init() {}

  public var reason: SessionCancelReason? { state.withLock { $0.reason } }

  public var isCancelled: Bool { reason != nil }

  /// The first reason wins: a session closed after the person pressed `Stop`
  /// still reports `stopped-by-user`, which is what the Run needs to read.
  public func cancel(_ reason: SessionCancelReason) {
    let handlers = state.withLock { current -> [@Sendable () -> Void] in
      guard current.reason == nil else { return [] }
      current.reason = reason
      let handlers = Array(current.handlers.values)
      current.handlers.removeAll()
      return handlers
    }
    for handler in handlers { handler() }
  }

  /// Resource cleanup must also run during the post-action menu guard tail,
  /// when there is no running action left to poll Stop.
  func onCancel(_ handler: @escaping @Sendable () -> Void) -> UUID {
    let id = UUID()
    let cancelled = state.withLock { current in
      guard current.reason == nil else { return true }
      current.handlers[id] = handler
      return false
    }
    if cancelled { handler() }
    return id
  }

  func removeCancelHandler(_ id: UUID) {
    _ = state.withLock { $0.handlers.removeValue(forKey: id) }
  }

  public func check() throws {
    if let reason { throw reason.error }
  }
}
