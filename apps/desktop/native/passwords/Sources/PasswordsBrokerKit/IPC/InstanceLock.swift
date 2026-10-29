import Darwin
import Foundation
import PasswordsCore

/// The kernel `flock` on `<root>/broker.lock` that makes this the only broker
/// of its build for this user. It is taken before the socket is touched and
/// held until the process exits, however it exits; the kernel releases it
/// with the descriptor. The file is never removed: unlinking a locked file
/// would let the next broker lock a new one beside it.
public final class InstanceLock: @unchecked Sendable {
  private var descriptor: Int32

  private init(descriptor: Int32) {
    self.descriptor = descriptor
  }

  public enum Failure: Error, Equatable {
    /// Another broker held it for the whole wait.
    case held
    case unavailable(Int32)
  }

  /// Takes the lock, waiting up to `wait` for another holder to exit.
  ///
  /// A broker the desktop launched afresh may start while the instance it
  /// replaces is still quitting (that one notices its socket was taken), so
  /// the wait is a few seconds rather than none.
  public static func acquire(at url: URL, wait: TimeInterval) throws -> InstanceLock {
    // A named pipe or a symlink in place of the lock file is refused at once.
    let descriptor: Int32
    do {
      guard let opened = try AtomicFile.openRegular(url, O_RDWR, create: true) else { throw Failure.unavailable(ENOENT) }
      descriptor = opened
    } catch let failure as Failure {
      throw failure
    } catch {
      throw Failure.unavailable(EINVAL)
    }
    let deadline = Date().addingTimeInterval(max(0, wait))
    while true {
      if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return InstanceLock(descriptor: descriptor) }
      let code = errno
      guard code == EWOULDBLOCK || code == EINTR else {
        Darwin.close(descriptor)
        throw Failure.unavailable(code)
      }
      guard Date() < deadline else {
        Darwin.close(descriptor)
        throw Failure.held
      }
      usleep(100_000)
    }
  }

  /// Releases it early; only tests and an orderly quit call this.
  public func release() {
    guard descriptor >= 0 else { return }
    Darwin.close(descriptor)
    descriptor = -1
  }

  deinit {
    release()
  }
}
