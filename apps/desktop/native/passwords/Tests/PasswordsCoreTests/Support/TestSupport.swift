import Foundation
import PasswordsTestSupport
import XCTest
@testable import PasswordsCore

func fixtureData(_ name: String) throws -> Data {
  let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"), "missing fixture \(name)")
  return try Data(contentsOf: url)
}

func makeTemporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("passwords-tests-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

func draft(
  _ host: String = "example.com",
  username: String = "alice@example.com",
  password: String = "test-password-123",
  totp: TOTPParameters? = nil,
  label: String? = nil
) -> ItemDraft {
  ItemDraft(origins: ["https://\(host)"], loginURL: "https://\(host)/login", username: username, password: password, totp: totp, label: label)
}

/// A vault in a fresh temporary directory, with its protected store and one
/// software owner.
final class VaultFixture {
  let directory: URL
  let root: URL
  let protected: FileProtectedStore
  let owner = SoftwareOwnerKeyStore()

  init(items: [ItemDraft] = []) throws {
    directory = try makeTemporaryDirectory()
    root = directory.appendingPathComponent("Vault")
    protected = try FileProtectedStore(directory: directory.appendingPathComponent("Protected"))
    _ = try Vault.create(root: root, protectedStore: protected, deviceName: "Test Mac", owner: owner)
    if !items.isEmpty {
      try withUnlocked { try $0.add(items) }
    }
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }

  func open() throws -> Vault {
    try Vault.open(root: root, protectedStore: protected)
  }

  @discardableResult
  func withUnlocked<T>(owner: (any OwnerKeyStore)? = nil, _ body: (UnlockedVault) throws -> T) throws -> T {
    let unlocked = try open().unlock(owner: owner ?? self.owner)
    defer { unlocked.close() }
    return try body(unlocked)
  }

  func items() throws -> [Item] {
    try withUnlocked { try $0.items() }
  }

  var headURL: URL { root.appendingPathComponent("HEAD") }
  var commitsURL: URL { root.appendingPathComponent("commits") }
  var objectsURL: URL { root.appendingPathComponent("objects") }

  func commitURL(_ seq: Int) -> URL {
    commitsURL.appendingPathComponent(String(format: "%012d.json", seq))
  }

  func commitJSON(_ seq: Int) throws -> [String: JSONValue] {
    guard case .object(let fields) = try CanonicalJSON.parse(try Data(contentsOf: commitURL(seq))) else {
      throw JSONError.shape("commit")
    }
    return fields
  }

  func writeCommitJSON(_ seq: Int, _ fields: [String: JSONValue]) throws {
    try CanonicalJSON.encode(.object(fields)).write(to: commitURL(seq))
  }

  func objectNames() throws -> Set<String> {
    Set(try FileManager.default.contentsOfDirectory(atPath: objectsURL.path).filter { !$0.hasPrefix(".") })
  }
}

func XCTAssertThrowsVaultError<T>(
  _ expected: VaultError,
  _ expression: @autoclosure () throws -> T,
  file: StaticString = #filePath,
  line: UInt = #line
) {
  XCTAssertThrowsError(try expression(), file: file, line: line) { error in
    XCTAssertEqual(error as? VaultError, expected, "\(error)", file: file, line: line)
  }
}

/// A protected store whose checkpoint writes can fail on cue: before the
/// write (nothing stored) or after it (stored, then an error, as an atomic
/// rename whose directory sync failed reports it). It records what HEAD on
/// disk said at the moment of each checkpoint write.
final class ScriptedCheckpointStore: ProtectedStore, @unchecked Sendable {
  enum Failure {
    case none
    case beforeWriting
    case afterWriting
  }

  let inner: FileProtectedStore
  let headURL: URL
  var failure = Failure.none
  private(set) var headsAtCheckpointWrites: [Data] = []

  init(_ inner: FileProtectedStore, headURL: URL) {
    self.inner = inner
    self.headURL = headURL
  }

  func read(_ name: ProtectedName) throws -> Data? { try inner.read(name) }

  func write(_ name: ProtectedName, _ data: Data) throws {
    guard name == .checkpoint else { return try inner.write(name, data) }
    headsAtCheckpointWrites.append((try? Data(contentsOf: headURL)) ?? Data())
    switch failure {
    case .none:
      try inner.write(name, data)
    case .beforeWriting:
      throw NSError(domain: "synthetic-checkpoint-failure", code: 1)
    case .afterWriting:
      try inner.write(name, data)
      throw NSError(domain: "synthetic-checkpoint-failure", code: 2)
    }
  }

  func delete(_ name: ProtectedName) throws { try inner.delete(name) }
}

extension JSONValue {
  subscript(_ key: String) -> JSONValue? {
    guard case .object(let fields) = self else { return nil }
    return fields[key]
  }
}

/// A protected store that runs `hook` once, just before the first write of
/// the checkpoint, to interleave another writer deterministically.
final class InterleavingStore: ProtectedStore, @unchecked Sendable {
  let base: FileProtectedStore
  var hook: (() throws -> Void)?
  init(base: FileProtectedStore) { self.base = base }
  func read(_ name: ProtectedName) throws -> Data? { try base.read(name) }
  func write(_ name: ProtectedName, _ data: Data) throws {
    if name == .checkpoint, let hook {
      self.hook = nil
      try hook()
    }
    try base.write(name, data)
  }
  func delete(_ name: ProtectedName) throws { try base.delete(name) }
}

/// A protected store whose `n`th read of the checkpoint first runs a hook:
/// a writer that does not share the vault's lock moving the checkpoint.
final class CheckpointRaceStore: ProtectedStore, @unchecked Sendable {
  let base: FileProtectedStore
  var reads = 0
  var onRead: [Int: () throws -> Void] = [:]
  init(base: FileProtectedStore) { self.base = base }
  func read(_ name: ProtectedName) throws -> Data? {
    if name == .checkpoint {
      reads += 1
      try onRead[reads]?()
    }
    return try base.read(name)
  }
  func write(_ name: ProtectedName, _ data: Data) throws { try base.write(name, data) }
  func delete(_ name: ProtectedName) throws { try base.delete(name) }
}

