public struct DocumentReadiness: Sendable {
  public private(set) var document: String?
  private var navigating = false
  private var ready: [String: String] = [:]
  private var pending: [String: String] = [:]
  public init() {}
  public mutating func provisional() { navigating = true; pending.removeAll() }
  public mutating func failed() { navigating = false; pending.removeAll() }
  public mutating func commit(document: String) {
    self.document = document
    ready = pending
    pending.removeAll()
    navigating = false
  }
  public mutating func helper(frame: String, token: String) {
    if navigating || document == nil { pending[frame] = token }
    else { ready[frame] = token }
  }
  public mutating func invalidate() {
    document = nil
    navigating = false
    ready.removeAll()
    pending.removeAll()
  }
  public func require(frame: String, document expected: String? = nil) throws -> String {
    if let expected, expected != document { throw BrowserRefusal.staleDocument }
    guard document != nil, !navigating, let token = ready[frame] else { throw BrowserRefusal.helperNotReady }
    return token
  }
}
