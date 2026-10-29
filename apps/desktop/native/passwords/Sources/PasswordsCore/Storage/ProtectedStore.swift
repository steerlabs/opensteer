import Foundation

/// The small pieces of state that must not live in the vault folder.
public enum ProtectedName: String, CaseIterable, Sendable {
  /// `SecureEnclave.P256.KeyAgreement.PrivateKey.dataRepresentation`.
  case ownerAgreementKey = "owner-agreement-key"
  /// `SecureEnclave.P256.Signing.PrivateKey.dataRepresentation`.
  case ownerSigningKey = "owner-signing-key"
  /// The accepted head, canonical `{"hash","seq","vaultId"}`. Opening refuses
  /// a vault folder older than this or forked from it.
  case checkpoint
  /// Broker settings; the broker owns the format.
  case settings
  /// How the owner keys were made (`OwnerKeyPolicy`).
  case ownerKeyPolicy = "owner-key-policy"
}

/// Protected state cannot be read yet because the Mac has not been unlocked
/// since it started. It says nothing about the vault, so it never means the
/// vault needs a reset.
public struct NotUnlockedSinceRestart: Error, Equatable, Sendable {
  public init() {}
}

/// Storage for `ProtectedName` values. Production uses the broker's
/// data-protection keychain access group, which other programs cannot read
/// or roll back; `FileProtectedStore` is for tests and development builds.
public protocol ProtectedStore: Sendable {
  func read(_ name: ProtectedName) throws -> Data?
  /// Replaces the value atomically.
  func write(_ name: ProtectedName, _ data: Data) throws
  /// Succeeds when the value does not exist.
  func delete(_ name: ProtectedName) throws
}

/// One 0600 file per name in a 0700 directory, written atomically.
///
/// A same-user process can read and roll back these files, so this store
/// gives no rollback protection; it exists for tests and development builds.
public final class FileProtectedStore: ProtectedStore {
  public static let maxValueBytes = 1 << 20
  public let directory: URL

  /// Creates `directory` (mode 0700) if it does not exist.
  public init(directory: URL) throws {
    self.directory = directory
    if !AtomicFile.exists(directory) {
      try AtomicFile.makePrivateDirectory(directory)
    }
  }

  public func read(_ name: ProtectedName) throws -> Data? {
    try AtomicFile.read(url(name), maxBytes: Self.maxValueBytes)
  }

  public func write(_ name: ProtectedName, _ data: Data) throws {
    guard data.count <= Self.maxValueBytes else { throw StorageError.tooLarge(name.rawValue) }
    try AtomicFile.write(data, to: url(name), exclusive: false)
  }

  public func delete(_ name: ProtectedName) throws {
    try AtomicFile.remove(url(name))
  }

  private func url(_ name: ProtectedName) -> URL {
    directory.appendingPathComponent(name.rawValue)
  }
}
