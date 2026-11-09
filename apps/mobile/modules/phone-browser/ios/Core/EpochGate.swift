import Foundation

public enum BrowserRefusal: String, Error {
  case staleEpoch = "stale-epoch"
  case targetSuspended = "target-suspended"
  case targetClosed = "target-closed"
  case notActionable = "not-actionable"
  case staleDocument = "stale-document"
  case staleGeometry = "stale-geometry"
  case staleDialog = "stale-dialog"
  case unsupportedOperation = "unsupported-operation"
  case invalidArgument = "invalid-argument"
}

public final class EpochGate: @unchecked Sendable {
  private let lock = NSLock()
  private var epoch = 0

  public init() {}

  public var current: Int {
    lock.withLock { epoch }
  }

  @discardableResult public func advance() -> Int {
    lock.withLock {
      epoch += 1
      return epoch
    }
  }

  public func check(_ expected: Int) throws {
    try perform(expected) {}
  }

  public func perform<Result>(_ expected: Int, _ operation: () throws -> Result) throws -> Result {
    try lock.withLock {
      guard expected == epoch else { throw BrowserRefusal.staleEpoch }
      return try operation()
    }
  }
}
