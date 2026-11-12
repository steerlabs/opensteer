import CryptoKit
import Foundation

public enum IdentityAccount: String, CaseIterable {
  case runnerKey = "runner-key"
  case obsoleteApprovalKey = "approval-key"
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
  case enrolledElsewhere, notPrepared, wrongDeployment, missingIdentity, invalidIdentity, erasurePending
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
  public var browserErasurePending: Bool? = nil
  public var browserReplayStorageInstanceId: String? = nil
}

/// A signed self-leave waiting for its Host. It outlives the key it was signed
/// with, so erasure never waits on the network.
public struct DeviceLeaveObligation: Codable, Equatable {
  public let version: Int
  public let deploymentId: String
  public let runnerId: String
  public let hostUrl: String
  public let issuedAt: String
  public let signature: String
}

/// An absent install marker retires Keychain items; a corrupt marker refuses
/// admission without losing a possible pending browser erasure obligation.
public final class IdentityStore {
  private let vault: any IdentityVault
  private let record: any IdentityRecordStore
  private let leaveRecord: (any IdentityRecordStore)?
  private let lock = NSRecursiveLock()

  public init(vault: any IdentityVault, record: any IdentityRecordStore, leaveRecord: (any IdentityRecordStore)? = nil) {
    self.vault = vault
    self.record = record
    self.leaveRecord = leaveRecord
  }

  /// Signs this device's leave and makes it durable before returning, so the
  /// caller may erase the key afterwards. A prepared identity has nothing on
  /// the Host to leave and returns nil.
  public func persistLeave(issuedAt: String) throws -> DeviceLeaveObligation? {
    lock.lock(); defer { lock.unlock() }
    guard let leaveRecord else { throw IdentityStoreError.missingIdentity }
    guard let identity = try load(), identity.state != .prepared, let hostUrl = identity.hostUrl else { return nil }
    let obligation = DeviceLeaveObligation(version: 1, deploymentId: identity.deploymentId,
      runnerId: identity.runnerId, hostUrl: hostUrl, issuedAt: issuedAt,
      signature: try IphoneProofs.deviceLeave(try runnerKey(), deploymentId: identity.deploymentId,
        runnerId: identity.runnerId, issuedAt: issuedAt))
    try leaveRecord.write(JSONEncoder().encode(obligation))
    return obligation
  }

  public func pendingLeave() throws -> DeviceLeaveObligation? {
    lock.lock(); defer { lock.unlock() }
    guard let bytes = try leaveRecord?.read(), !bytes.isEmpty else { return nil }
    guard let obligation = try? JSONDecoder().decode(DeviceLeaveObligation.self, from: bytes),
      obligation.version == 1 else { throw IdentityStoreError.invalidIdentity }
    return obligation
  }

  /// Only the obligation for this runner is dropped; a later identity's survives.
  public func completeLeave(runnerId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard let current = try pendingLeave(), current.runnerId == runnerId else { return }
    try leaveRecord?.remove()
  }

  /// The bind proof for a session on the Deployment this identity was added to.
  public func signSessionBinding(deploymentId: String, sessionId: String, issuedAt: String) throws -> (runnerId: String, signature: String) {
    lock.lock(); defer { lock.unlock() }
    guard let identity = try load(), identity.state == .enrolled,
      identity.browserErasurePending != true else { throw IdentityStoreError.notPrepared }
    guard identity.deploymentId == deploymentId else { throw IdentityStoreError.wrongDeployment }
    return (identity.runnerId, try IphoneProofs.deviceSessionBind(try runnerKey(), deploymentId: deploymentId,
      runnerId: identity.runnerId, sessionId: sessionId, issuedAt: issuedAt))
  }

  public func load() throws -> PersistedIphoneIdentity? {
    lock.lock(); defer { lock.unlock() }
    guard let bytes = try record.read() else {
      try wipe()
      return nil
    }
    guard let identity = try? JSONDecoder().decode(PersistedIphoneIdentity.self, from: bytes),
      identity.version == 1 else { throw IdentityStoreError.invalidIdentity }
    if identity.browserErasurePending == true { return identity }
    let tokenPresent = try vault.read(.enrollmentToken) != nil
    guard try vault.read(.runnerKey) != nil,
      (identity.state != .pending || tokenPresent) else {
      try wipe()
      return nil
    }
    try vault.remove(.obsoleteApprovalKey)
    if identity.state == .enrolled && tokenPresent { try vault.remove(.enrollmentToken) }
    return identity
  }

  public func prepare(deploymentId: String) throws -> PreparedIdentity {
    lock.lock(); defer { lock.unlock() }
    if let old = try load() {
      guard old.browserErasurePending != true else { throw IdentityStoreError.erasurePending }
      guard old.deploymentId == deploymentId else { throw IdentityStoreError.enrolledElsewhere }
      return PreparedIdentity(deploymentId: old.deploymentId, runnerId: old.runnerId, mintKey: old.mintKey)
    }
    let runner = Curve25519.Signing.PrivateKey()
    try vault.write(runner.rawRepresentation, account: .runnerKey)
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
    guard identity.browserErasurePending != true else { throw IdentityStoreError.erasurePending }
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
    guard identity.browserErasurePending != true else { throw IdentityStoreError.erasurePending }
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
    guard identity.browserErasurePending != true else { throw IdentityStoreError.erasurePending }
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

  public func enrollmentToken() throws -> String? {
    guard let bytes = try vault.read(.enrollmentToken) else { return nil }
    return String(data: bytes, encoding: .utf8)
  }

  public func runnerPublicKey() throws -> String { IphoneProofs.publicKeyPem(try runnerKey()) }

  public func wipe() throws {
    lock.lock(); defer { lock.unlock() }
    if let bytes = try record.read() {
      guard let identity = try? JSONDecoder().decode(PersistedIphoneIdentity.self, from: bytes), identity.version == 1 else { throw IdentityStoreError.invalidIdentity }
      if identity.browserErasurePending == true { throw IdentityStoreError.erasurePending }
    }
    try wipeConfirmed()
  }

  public func markBrowserErasurePending() throws -> PersistedIphoneIdentity {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load() else { throw IdentityStoreError.missingIdentity }
    identity.browserErasurePending = true
    try save(identity)
    return identity
  }

  public func markBrowserReplayInitialized(storageInstanceId: String) throws -> PersistedIphoneIdentity {
    lock.lock(); defer { lock.unlock() }
    guard var identity = try load(), identity.browserErasurePending != true,
      identity.browserReplayStorageInstanceId == nil || identity.browserReplayStorageInstanceId == storageInstanceId else { throw IdentityStoreError.erasurePending }
    identity.browserReplayStorageInstanceId = storageInstanceId
    try save(identity)
    return identity
  }

  @discardableResult public func completeBrowserErasure(deploymentId: String, confirmed: Bool) throws -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let identity = try load(), identity.deploymentId == deploymentId,
      identity.browserErasurePending == true else { throw IdentityStoreError.wrongDeployment }
    guard confirmed else { return false }
    try wipeConfirmed()
    return true
  }

  private func wipeConfirmed() throws {
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
