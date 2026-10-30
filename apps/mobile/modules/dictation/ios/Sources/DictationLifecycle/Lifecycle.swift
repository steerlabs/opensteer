public struct DictationLifecycle {
  public private(set) var session: String?
  public private(set) var expiring: String?
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
  public mutating func expire() -> String? { expiring = session; return session }
  public mutating func ended(_ id: String) -> Bool? {
    guard session == id else { return nil }
    let previous = previousIdleTimer
    session = nil; expiring = nil; previousIdleTimer = nil
    return previous
  }
}
