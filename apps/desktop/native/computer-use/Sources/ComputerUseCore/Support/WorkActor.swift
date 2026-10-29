import Foundation

/// The serial executor for agent sessions' Accessibility reads and actions.
/// Person input uses PersonInputActor; shared focus guards inherit their caller's
/// executor so an agent's slow AX read cannot occupy the person's lane.
///
/// It is its own thread rather than the main thread or the shared concurrency
/// pool. An Accessibility call to an app that stops answering blocks its
/// caller for up to the two-second messaging timeout; on the main thread that
/// held the pill's `Stop`, `session.close`, `session.open` and `hello` behind
/// it, and on the shared pool it would starve unrelated tasks. A dedicated
/// serial queue may block without either, and keeps the rule that one app is
/// read or driven by one piece of work at a time.
///
/// AppKit stays on the main actor: the overlay, `NSEvent`'s factory, `NSScreen`
/// and the keyboard-layout lookup are reached from here with an `await`, which
/// is immediate because the main thread no longer waits on any app.
@globalActor
public actor WorkActor {
  public static let shared = WorkActor()

  private let queue = DispatchSerialQueue(
    label: "com.opensteer.computer-use.work", qos: .userInitiated)

  public nonisolated var unownedExecutor: UnownedSerialExecutor {
    queue.asUnownedSerialExecutor()
  }
}

/// A small lock around one value, for the state the control plane on the main
/// actor and the work executor both read.
final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) {
    self.value = value
  }

  func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
    lock.lock()
    defer { lock.unlock() }
    return try body(&value)
  }

  var current: Value { withLock { $0 } }
}
