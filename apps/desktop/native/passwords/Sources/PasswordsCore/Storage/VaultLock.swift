import Darwin
import Foundation

/// The lock every check-then-use of one vault folder holds: opening,
/// unlocking, committing and re-verifying. Without it, another instance or
/// process could move the checkpoint between the moment a history was checked
/// against it and the moment that history was used.
///
/// It is a kernel `flock` on `<parent>/.<folder>.lock`, beside the folder
/// rather than in it, so a folder replaced underneath (a restored copy) still
/// shares the lock. The kernel releases it with the descriptor, however the
/// holder exits; the file is never removed. Each operation opens its own
/// descriptor, so two `Vault`s in one process exclude each other too, and an
/// operation must never start another while it holds the lock.
struct VaultLock {
  let url: URL

  init(root: URL) {
    url = root.deletingLastPathComponent().appendingPathComponent(".\(root.lastPathComponent).lock")
  }

  func withLock<T>(_ body: () throws -> T) throws -> T {
    guard let descriptor = try AtomicFile.openRegular(url, O_RDWR, create: true) else {
      throw StorageError.posix(operation: "open", path: url.lastPathComponent, code: ENOENT)
    }
    defer { Darwin.close(descriptor) }
    while flock(descriptor, LOCK_EX) != 0 {
      guard errno == EINTR else {
        throw StorageError.posix(operation: "flock", path: url.lastPathComponent, code: errno)
      }
    }
    return try body()
  }
}
