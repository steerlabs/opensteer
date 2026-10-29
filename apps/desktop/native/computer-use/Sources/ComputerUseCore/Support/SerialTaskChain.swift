import Foundation

/// Runs asynchronous work in the order it was handed over.
///
/// Every session's observe and act, and the other calls that are not
/// bookkeeping, wait here for the work before them. `HelperRuntime` answers
/// `hello`, `session.open`, `session.close` and passive permission reads
/// outside this lane, so none of them ever waits behind a running batch.
final class SerialTaskChain: @unchecked Sendable {
  private let lock = NSLock()
  private var tail: Task<Void, Never>?

  func enqueue(_ work: @escaping @Sendable () async -> Void) {
    lock.lock()
    let previous = tail
    tail = Task {
      await previous?.value
      await work()
    }
    lock.unlock()
  }
}

/// One request waiting in the serial lane, which either starts or runs out of
/// time first — never both.
///
/// A request still waiting when its deadline passes is answered there and
/// then, as not done, so the Host can tell work that never started from work
/// whose answer was lost; when its turn comes it is skipped.
final class QueuedWork: @unchecked Sendable {
  private enum State {
    case waiting
    case started
    case expired
  }

  private let state = Locked(State.waiting)

  static let expired = HelperError(
    .failed,
    "This Mac was still busy with earlier work when this request ran out of time, "
      + "so nothing was done; try again.")

  /// Whether the work may start now. False once it has expired.
  func start() -> Bool {
    state.withLock { state in
      guard case .waiting = state else { return false }
      state = .started
      return true
    }
  }

  /// Whether the deadline caught the work still waiting.
  func expire() -> Bool {
    state.withLock { state in
      guard case .waiting = state else { return false }
      state = .expired
      return true
    }
  }
}
