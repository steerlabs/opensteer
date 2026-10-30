import Foundation

/// Authority is the verified socket connection, never a caller-supplied owner id.
public struct SessionOwner {
  public private(set) var session: String?
  public private(set) var connection: Int?
  public init() {}
  public mutating func claim(session: String, connection: Int) -> Bool {
    guard self.session == nil else { return false }
    self.session = session
    self.connection = connection
    return true
  }
  public func owns(session: String, connection: Int) -> Bool {
    self.session == session && self.connection == connection
  }
  public mutating func release(session: String) {
    if self.session == session {
      self.session = nil
      connection = nil
    }
  }
  public mutating func disconnected(_ connection: Int) -> String? {
    guard self.connection == connection, let session else { return nil }
    release(session: session)
    return session
  }
}
