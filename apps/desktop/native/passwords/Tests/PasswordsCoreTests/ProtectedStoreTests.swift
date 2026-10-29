import Darwin
import XCTest
@testable import PasswordsCore

final class ProtectedStoreTests: XCTestCase {
  func testFilesArePrivateAndAtomic() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeDirectory = directory.appendingPathComponent("Protected")
    let store = try FileProtectedStore(directory: storeDirectory)

    XCTAssertNil(try store.read(.settings))
    try store.write(.settings, Data("one".utf8))
    try store.write(.settings, Data("two".utf8))
    XCTAssertEqual(try store.read(.settings), Data("two".utf8))

    let manager = FileManager.default
    XCTAssertEqual(try manager.attributesOfItem(atPath: storeDirectory.path)[.posixPermissions] as? Int, 0o700)
    XCTAssertEqual(try manager.attributesOfItem(atPath: storeDirectory.appendingPathComponent("settings").path)[.posixPermissions] as? Int, 0o600)
    XCTAssertEqual(try manager.contentsOfDirectory(atPath: storeDirectory.path), ["settings"])

    try store.delete(.settings)
    try store.delete(.settings)
    XCTAssertNil(try store.read(.settings))
    XCTAssertThrowsError(try store.write(.settings, Data(count: FileProtectedStore.maxValueBytes + 1)))

    // Reopening an existing directory keeps its contents.
    try store.write(.checkpoint, Data("c".utf8))
    XCTAssertEqual(try FileProtectedStore(directory: storeDirectory).read(.checkpoint), Data("c".utf8))
  }

  /// C12: a named pipe where a vault file or a protected value should be made
  /// `open` wait for a writer that never comes. Files are opened without
  /// blocking and must be regular. (Second review, finding 3.)
  func testFIFOIsRefusedAtOnce() throws {
    let fixture = try VaultFixture()
    try FileManager.default.removeItem(at: fixture.headURL)
    XCTAssertEqual(mkfifo(fixture.headURL.path, 0o600), 0)
    let root = fixture.root
    let protected = fixture.protected
    let openError = Self.withinTwoSeconds(releasing: fixture.headURL) {
      do {
        _ = try Vault.open(root: root, protectedStore: protected)
        return nil
      } catch {
        return error
      }
    }
    XCTAssertEqual(openError as? StorageError, .notARegularFile("HEAD"))

    let checkpoint = fixture.protected.directory.appendingPathComponent(ProtectedName.checkpoint.rawValue)
    try FileManager.default.removeItem(at: checkpoint)
    XCTAssertEqual(mkfifo(checkpoint.path, 0o600), 0)
    let readError = Self.withinTwoSeconds(releasing: checkpoint) {
      do {
        _ = try protected.read(.checkpoint)
        return nil
      } catch {
        return error
      }
    }
    XCTAssertEqual(readError as? StorageError, .notARegularFile("checkpoint"))
  }

  /// Runs `work` off this thread. A call still blocked after two seconds is
  /// a failure; the pipe is then opened for writing so the reader returns
  /// and the test process can finish.
  private static func withinTwoSeconds(releasing fifo: URL, _ work: @escaping @Sendable () -> Error?) -> Error? {
    let done = DispatchSemaphore(value: 0)
    let result = NSLock()
    nonisolated(unsafe) var outcome: Error?
    DispatchQueue.global().async {
      let error = work()
      result.withLock { outcome = error }
      done.signal()
    }
    if done.wait(timeout: .now() + 2) == .timedOut {
      XCTFail("still waiting on \(fifo.lastPathComponent) after two seconds")
      let writer = Darwin.open(fifo.path, O_WRONLY | O_NONBLOCK)
      if writer >= 0 { Darwin.close(writer) }
      _ = done.wait(timeout: .now() + 2)
    }
    return result.withLock { outcome }
  }

  func testRefusesSymlinks() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try FileProtectedStore(directory: directory.appendingPathComponent("Protected"))
    let target = directory.appendingPathComponent("elsewhere")
    try Data("x".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: store.directory.appendingPathComponent("settings"), withDestinationURL: target)
    XCTAssertThrowsError(try store.read(.settings))
  }

  func testNamesAreFixed() {
    XCTAssertEqual(ProtectedName.allCases.map(\.rawValue), ["owner-agreement-key", "owner-signing-key", "checkpoint", "settings", "owner-key-policy"])
  }
}
