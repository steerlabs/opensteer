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
  case helperNotReady = "helper-not-ready"
  case timeout = "timeout"
  case storageMissing = "profile-storage-missing"
  case bindingMismatch = "profile-binding-mismatch"
  case profileDeleted = "profile-deleted"
  case staleChooser = "stale-chooser"
  case tooLarge = "too-large"
  case dialogOpen = "dialog-open"
  case outcomeUnknown = "outcome-unknown"
  case forbidden = "forbidden"
}

public final class EpochGate: @unchecked Sendable {
  private let lock = NSRecursiveLock()
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

  public func adopt(_ value: Int) throws {
    try lock.withLock {
      guard value >= epoch else { throw BrowserRefusal.staleEpoch }
      epoch = value
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
