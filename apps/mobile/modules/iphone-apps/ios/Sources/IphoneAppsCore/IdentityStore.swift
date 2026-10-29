import CryptoKit
import Foundation

public enum IdentityAccount: String, CaseIterable {
  case runnerKey = "runner-key"
  case approvalKey = "approval-key"
  case enrollmentToken = "enrollment-token"
}

public protocol IdentityVault: AnyObject {
  /// A protected-data or Keychain failure throws. Only nil proves an item is absent.
  func read(_ account: IdentityAccount) throws -> Data?
  func write(_ value: Data, account: IdentityAccount) throws
  func remove(_ account: IdentityAccount) throws
}

public protocol IdentityRecordStore: AnyObject {
  func read() throws -> Data?
  func write(_ value: Data) throws
  func remove() throws
}

public enum IdentityStoreError: Error {
  case enrolledElsewhere, notPrepared, wrongDeployment, missingIdentity, invalidIdentity
}

public struct PreparedIdentitySnapshot: Encodable {
  public let deploymentId: String
  public let runnerId: String
}

public struct PreparedIdentity {
  public let deploymentId: String
  public let runnerId: String
  public let mintKey: String
  public var publicSnapshot: PreparedIdentitySnapshot {
    PreparedIdentitySnapshot(deploymentId: deploymentId, runnerId: runnerId)
  }
}

public struct PersistedIphoneIdentity: Codable {
  public enum State: String, Codable { case prepared, pending, enrolled }
  public let version: Int
  public let deploymentId: String
  public var deploymentName: String?
  public var hostInstanceId: String?
  public var hostUrl: String?
  public let runnerId: String
  public var name: String?
  public var state: State
  public var enrollmentId: String?
  public var expiresAt: String?
  public var mintKey: String
}

/// The record is the install marker. No Keychain item outlives an absent or
/// corrupt record; protected data unavailability is a thrown, retryable error.
public final class IdentityStore {
  private let vault: any IdentityVault
  private let record: any IdentityRecordStore
  private let lock = NSRecursiveLock()

  public init(vault: any IdentityVault, record: any IdentityRecordStore) {
    self.vault = vault
    self.record = record
  }

  public func load() throws -> PersistedIphoneIdentity? {
    lock.lock(); defer { lock.unlock() }
    guard let bytes = try record.read(),
      let identity = try? JSONDecoder().decode(PersistedIphoneIdentity.self, from: bytes),
      identity.version == 1 else {
      try wipe()
      return nil
    }
    let tokenPresent = try vault.read(.enrollmentToken) != nil
    guard try vault.read(.runnerKey) != nil, try vault.read(.approvalKey) != nil,
      (identity.state != .pending || tokenPresent) else {
      try wipe()
      return nil
    }
    if identity.state == .enrolled && tokenPresent { try vault.remove(.enrollmentToken) }
    return identity
  }

  public func prepare(deploymentId: String) throws -> PreparedIdentity {
    lock.lock(); defer { lock.unlock() }
    if let old = try load() {
      guard old.deploymentId == deploymentId else { throw IdentityStoreError.enrolledElsewhere }
      return PreparedIdentity(deploymentId: old.deploymentId, runnerId: old.runnerId, mintKey: old.mintKey)
    }
    let runner = Curve25519.Signing.PrivateKey()
    var approval = Curve25519.Signing.PrivateKey()
    while approval.publicKey.rawRepresentation == runner.publicKey.rawRepresentation {
      approval = Curve25519.Signing.PrivateKey()
    }
    try vault.write(runner.rawRepresentation, account: .runnerKey)
    try vault.write(approval.rawRepresentation, account: .approvalKey)
    let identity = PersistedIphoneIdentity(
      version: 1, deploymentId: deploymentId, deploymentName: nil, hostInstanceId: nil,
      hostUrl: nil, runnerId: "rnr_\(UUID().uuidString.lowercased())", name: nil,
      state: .prepared, enrollmentId: nil, expiresAt: nil,
      mintKey: "iphone-enroll:\(UUID().uuidString.lowercased())")
    // The prepared record is durable before returning the mint key to JS.
    try save(identity)
    return PreparedIdentity(deploymentId: deploymentId, runnerId: identity.runnerId, mintKey: identity.mintKey)
  }

  public func enroll(
    deploymentId: String, deploymentName: String, hostInstanceId: String, hostUrl: String,
    enrollmentId: String, enrollmentToken: String, expiresAt: String, name: String
  ) throws {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load() else { throw IdentityStoreError.notPrepared }
    guard identity.deploymentId == deploymentId else { throw IdentityStoreError.wrongDeployment }
    guard identity.state != .enrolled else { throw IdentityStoreError.invalidIdentity }
    try vault.write(Data(enrollmentToken.utf8), account: .enrollmentToken)
    identity.deploymentName = deploymentName
    identity.hostInstanceId = hostInstanceId
    identity.hostUrl = hostUrl
    identity.enrollmentId = enrollmentId
    identity.expiresAt = expiresAt
    identity.name = name
    identity.state = .pending
    try save(identity)
  }

  @discardableResult public func markEnrolled() throws -> PersistedIphoneIdentity {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load(), identity.state == .pending else { throw IdentityStoreError.notPrepared }
    identity.state = .enrolled
    try save(identity)
    // The durable state wins if Keychain cleanup is briefly unavailable. A
    // later load removes the consumed token; reconnect must authenticate.
    try? vault.remove(.enrollmentToken)
    return identity
  }

  public func discardPendingEnrollment() throws -> String {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load(), identity.state != .enrolled else { throw IdentityStoreError.notPrepared }
    try vault.remove(.enrollmentToken)
    identity.state = .prepared
    identity.enrollmentId = nil
    identity.expiresAt = nil
    identity.mintKey = "iphone-enroll:\(UUID().uuidString.lowercased())"
    try save(identity)
    return identity.mintKey
  }

  public func retarget(hostInstanceId: String, hostUrl: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load(), identity.hostInstanceId == hostInstanceId else {
      throw IdentityStoreError.wrongDeployment
    }
    identity.hostUrl = hostUrl
    try save(identity)
  }

  public func runnerKey() throws -> Curve25519.Signing.PrivateKey {
    guard let bytes = try vault.read(.runnerKey) else { throw IdentityStoreError.missingIdentity }
    return try Curve25519.Signing.PrivateKey(rawRepresentation: bytes)
  }

  public func approvalKey() throws -> Curve25519.Signing.PrivateKey {
    guard let bytes = try vault.read(.approvalKey) else { throw IdentityStoreError.missingIdentity }
    return try Curve25519.Signing.PrivateKey(rawRepresentation: bytes)
  }

  public func enrollmentToken() throws -> String? {
    guard let bytes = try vault.read(.enrollmentToken) else { return nil }
    return String(data: bytes, encoding: .utf8)
  }

  public func runnerPublicKey() throws -> String { IphoneProofs.publicKeyPem(try runnerKey()) }
  public func approvalPublicKey() throws -> String { IphoneProofs.publicKeyPem(try approvalKey()) }
  public func approvalKeyId() throws -> String { IphoneProofs.keyId(try approvalKey()) }

  public func wipe() throws {
    lock.lock(); defer { lock.unlock() }
    // Removing the sandbox marker first prevents a restart from restoring
    // sharing even if protected Keychain data cannot be erased yet.
    do { try record.remove() }
    catch {
      // If removal failed, an invalid record is also a durable refusal to
      // restore. The next launch retries cleanup instead of accepting it.
      try record.write(Data())
    }
    var firstFailure: Error?
    for account in IdentityAccount.allCases {
      do { try vault.remove(account) }
      catch { if firstFailure == nil { firstFailure = error } }
    }
    if let firstFailure { throw firstFailure }
  }

  private func save(_ identity: PersistedIphoneIdentity) throws {
    try record.write(JSONEncoder().encode(identity))
  }
}
