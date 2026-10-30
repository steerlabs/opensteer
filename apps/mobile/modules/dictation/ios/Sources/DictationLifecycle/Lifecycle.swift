public struct DictationLifecycle {
  public private(set) var session: String?
  private var expired: Set<String> = []
  public var expiring: String? { session.flatMap { expired.contains($0) ? $0 : nil } }
  public func isExpiring(_ id: String) -> Bool { expired.contains(id) }
  private var acceptsListening = false
  public private(set) var previousIdleTimer: Bool?
  public init() {}
  public mutating func begin(_ id: String) { if session == nil { session = id; acceptsListening = true } }
  public mutating func listening(_ id: String, previous: Bool) -> Bool {
    guard session == id, acceptsListening, previousIdleTimer == nil else { return false }
    previousIdleTimer = previous; return true
  }
  public mutating func stopListening() -> Bool? {
    acceptsListening = false
    let previous = previousIdleTimer; previousIdleTimer = nil; return previous
  }
  public mutating func expire(_ id: String) -> String? {
    guard session == id else { return nil }
    expired.insert(id); return id
  }
  public mutating func ended(_ id: String) -> Bool? {
    expired.remove(id)
    return cancelled(id)
  }
  public mutating func cancelled(_ id: String) -> Bool? {
    guard session == id else { return nil }
    let previous = previousIdleTimer
    session = nil; acceptsListening = false; previousIdleTimer = nil
    return previous
  }
}

@MainActor public final class DictationCancellation {
  private var pending: Task<Void, Never>?
  public init() {}
  public func wait() async { await pending?.value }
  public func run(_ operation: @escaping @MainActor () async -> Void) async {
    let previous = pending
    let task = Task { @MainActor in
      await previous?.value
      await operation()
    }
    pending = task
    await task.value
  }
}
