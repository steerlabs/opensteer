import Foundation
import PasswordsCore

/// A protected store whose reads or writes can be held, so a test can end a
/// sign-in while its vault read or its commit is under way, or can fail as a
/// keychain does before the Mac's first unlock.
final class ControlledStore: ProtectedStore, @unchecked Sendable {
  private let inner: FileProtectedStore
  private let condition = NSCondition()
  private var closed = false
  private var waiting = 0
  private var writesHeld = false
  private var waitingWriteCount = 0
  private var locked = false

  init(directory: URL) throws {
    inner = try FileProtectedStore(directory: directory)
  }

  /// Reads wait until `open()`.
  func close() {
    condition.withLock { closed = true }
  }

  /// Writes wait until `open()`; reads go on. A commit pins its checkpoint
  /// with a write, so it waits there, mid-commit.
  func holdWrites() {
    condition.withLock { writesHeld = true }
  }

  func open() {
    condition.withLock {
      closed = false
      writesHeld = false
      condition.broadcast()
    }
  }

  /// Reads waiting for `open()` now.
  var waitingReads: Int { condition.withLock { waiting } }

  /// Writes waiting for `open()` now.
  var waitingWrites: Int { condition.withLock { waitingWriteCount } }

  /// Every call fails with `NotUnlockedSinceRestart` while true.
  var notUnlockedSinceRestart: Bool {
    get { condition.withLock { locked } }
    set { condition.withLock { locked = newValue } }
  }

  func read(_ name: ProtectedName) throws -> Data? {
    try condition.withLock {
      if locked { throw NotUnlockedSinceRestart() }
      waiting += 1
      while closed { condition.wait() }
      waiting -= 1
    }
    return try inner.read(name)
  }

  func write(_ name: ProtectedName, _ data: Data) throws {
    try condition.withLock {
      if locked { throw NotUnlockedSinceRestart() }
      waitingWriteCount += 1
      while writesHeld { condition.wait() }
      waitingWriteCount -= 1
    }
    try inner.write(name, data)
  }

  func delete(_ name: ProtectedName) throws {
    if notUnlockedSinceRestart { throw NotUnlockedSinceRestart() }
    try inner.delete(name)
  }
}
