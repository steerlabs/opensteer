import CryptoKit
import Darwin
import Foundation

/// Public facts about the accepted head commit.
public struct VaultHead: Sendable {
  public let vaultId: String
  public let seq: Int64
  /// SHA-256 hex of the head commit's canonical bytes.
  public let hash: String
  public let epoch: Int64
  public let createdAt: Int64
  public let owners: [VaultOwner]

  init(_ verified: VerifiedCommit) {
    vaultId = verified.commit.vaultId
    seq = verified.commit.seq
    hash = verified.hash
    epoch = verified.commit.epoch
    createdAt = verified.commit.createdAt
    owners = verified.commit.owners
  }
}

/// A verified vault folder, locked. Opening checks only public data, so it
/// needs no key.
///
/// It may be kept open for a long time (the broker keeps one for its life),
/// so it never trusts what it verified earlier: every unlock and every commit
/// verifies the folder again against the current checkpoint, under the
/// vault's lock, and requires the head this object holds. A copy restored
/// underneath, or a head another instance moved past, is refused.
///
/// Not thread-safe: the broker owns one per process and serialises use.
public final class Vault {
  public let root: URL
  let store: VaultStore
  let protectedStore: any ProtectedStore
  let lock: VaultLock
  var tip: VerifiedCommit

  public var head: VaultHead { VaultHead(tip) }
  var tipPointer: HeadPointer { HeadPointer(hash: tip.hash, seq: tip.commit.seq) }

  private init(root: URL, store: VaultStore, protectedStore: any ProtectedStore, tip: VerifiedCommit) {
    self.root = root
    self.store = store
    self.protectedStore = protectedStore
    self.lock = VaultLock(root: root)
    self.tip = tip
  }

  /// Whether a vault folder exists at `root` (it may still fail to open).
  public static func exists(at root: URL) -> Bool {
    AtomicFile.exists(root)
  }

  /// Creates a vault with `owner` as its only owner and signs its genesis
  /// commit. `root` must not exist; its parent must. The checkpoint in
  /// `protectedStore` is replaced.
  public static func create(
    root: URL,
    protectedStore: any ProtectedStore,
    deviceName: String,
    owner: any OwnerKeyStore
  ) throws -> Vault {
    guard Commit.isValidDeviceName(deviceName) else { throw VaultError.invalidDeviceName }
    return try VaultLock(root: root).withLock {
      try createLocked(root: root, protectedStore: protectedStore, deviceName: deviceName, owner: owner)
    }
  }

  private static func createLocked(
    root: URL,
    protectedStore: any ProtectedStore,
    deviceName: String,
    owner: any OwnerKeyStore
  ) throws -> Vault {
    guard !AtomicFile.exists(root) else { throw VaultError.alreadyExists }
    let parent = root.deletingLastPathComponent()
    let staging = parent.appendingPathComponent(".\(root.lastPathComponent).staging-\(UUID().uuidString)")
    try VaultStore.makeLayout(at: staging)
    var placed = false
    defer { if !placed { try? FileManager.default.removeItem(at: staging) } }

    let store = VaultStore(root: staging)
    let vaultId = VaultIDs.newUUID()
    let epochKey = SymmetricKey(size: .bits256)
    let manifestHash = try store.writeObject(try Manifest(vaultId: vaultId, seq: 0, items: [], grants: []).seal(epochKey: epochKey, epoch: 0))
    let member = VaultOwner(owner, deviceName: deviceName)
    var commit = Commit(
      createdAt: Clock.nowMillis(),
      envelopes: [try EpochEnvelope.seal(epochKey, to: member, vaultId: vaultId, epoch: 0)],
      epoch: 0,
      manifest: manifestHash,
      owners: [member],
      parent: nil,
      seq: 0,
      signer: member.signingKeyID,
      vaultId: vaultId,
      signature: Data()
    )
    commit.signature = try sign(commit, owner: owner)
    let bytes = try commit.bytes()
    let genesis = try History.verifyGenesis(bytes)
    try store.writeCommit(0, bytes)
    let pointer = HeadPointer(hash: genesis.hash, seq: 0)
    try store.writeHead(pointer)

    // The checkpoint goes first: a crash before the rename leaves no vault,
    // which reads as "set up", rather than a vault without a checkpoint.
    let previousCheckpoint = try protectedStore.read(.checkpoint)
    try protectedStore.write(.checkpoint, try Checkpoint(vaultId: vaultId, head: pointer).bytes())
    do {
      try AtomicFile.renameExclusive(staging, to: root)
    } catch {
      if let previousCheckpoint {
        try? protectedStore.write(.checkpoint, previousCheckpoint)
      } else {
        try? protectedStore.delete(.checkpoint)
      }
      if case StorageError.alreadyExists = error { throw VaultError.alreadyExists }
      throw error
    }
    placed = true
    try AtomicFile.syncDirectory(parent)
    return try openLocked(root: root, protectedStore: protectedStore)
  }

  /// Opens and verifies the folder against the checkpoint.
  ///
  /// The whole chain is verified from genesis (hashes, parents, signatures,
  /// authority). A commit at HEAD + 1 left by a crash is adopted only if it
  /// fully verifies. The history must contain the checkpoint; a newer
  /// verified tip advances it.
  public static func open(root: URL, protectedStore: any ProtectedStore) throws -> Vault {
    try VaultLock(root: root).withLock { try openLocked(root: root, protectedStore: protectedStore) }
  }

  private static func openLocked(root: URL, protectedStore: any ProtectedStore) throws -> Vault {
    guard AtomicFile.exists(root) else { throw VaultError.notFound }
    guard let checkpointBytes = try protectedStore.read(.checkpoint) else { throw VaultError.checkpointMissing }
    let checkpoint = try Checkpoint(bytes: checkpointBytes)
    let store = VaultStore(root: root)
    let verified = try verify(store: store, checkpoint: checkpoint, allowPendingCommit: true)
    let pointer = HeadPointer(hash: verified.tip.hash, seq: verified.tip.commit.seq)
    // Pinned before HEAD names it, as every commit is; any failure throws,
    // so no `Vault` exists for a head that is not pinned.
    let advanced = Checkpoint(vaultId: verified.tip.commit.vaultId, head: pointer)
    if advanced != checkpoint {
      // Compare-and-swap: replaced only while it is still the checkpoint the
      // history was verified against, an ancestor of the adopted head. The
      // lock already excludes writers that share it; this refuses to undo
      // one that does not.
      guard try protectedStore.read(.checkpoint) == checkpointBytes else { throw VaultError.headMoved }
      try protectedStore.write(.checkpoint, try advanced.bytes())
    }
    if verified.headOnDisk != pointer {
      try store.writeHead(pointer)
    }
    return Vault(root: root, store: store, protectedStore: protectedStore, tip: verified.tip)
  }

  /// Re-reads and re-verifies the folder from public data against the
  /// current checkpoint. Throws `rollbackDetected` for a folder older than
  /// the checkpoint and `headMoved` if another writer committed since this
  /// vault was opened.
  @discardableResult
  public func verifyHistory() throws -> VaultHead {
    _ = try lock.withLock { try verifyCurrentLocked() }
    return head
  }

  /// The check every unlock and commit makes first, holding the lock: the
  /// folder as it is now, verified against the checkpoint as it is now, has
  /// exactly the head this object holds. Returns the checkpoint's bytes, the
  /// value a commit may replace.
  @discardableResult
  func verifyCurrentLocked() throws -> Data {
    guard let checkpointBytes = try protectedStore.read(.checkpoint) else { throw VaultError.checkpointMissing }
    let verified = try Self.verify(store: store, checkpoint: try Checkpoint(bytes: checkpointBytes), allowPendingCommit: false)
    guard verified.tip.hash == tip.hash, verified.headOnDisk == tipPointer else { throw VaultError.headMoved }
    return checkpointBytes
  }

  /// Opens the epoch key with `owner`, then decrypts the manifest and checks
  /// that every listed object exists and hashes correctly. Items stay
  /// encrypted until read. Whether the person must authenticate first is the
  /// caller's policy.
  public func unlock(owner: any OwnerKeyStore) throws -> UnlockedVault {
    try lock.withLock { try unlockLocked(owner: owner) }
  }

  private func unlockLocked(owner: any OwnerKeyStore) throws -> UnlockedVault {
    try verifyCurrentLocked()
    guard let envelope = tip.commit.envelope(for: KeyID.of(owner.agreementPublicKey)) else { throw VaultError.notAMember }
    let commit = tip.commit
    let epochKey: SymmetricKey
    do {
      epochKey = try owner.unwrap(envelope: envelope.keyEnvelope(vaultId: commit.vaultId, epoch: commit.epoch))
    } catch is CryptoError {
      throw VaultError.decryptionFailed
    }
    let manifest = try Manifest.open(
      try store.readObject(commit.manifest), hash: commit.manifest,
      epochKey: epochKey, vaultId: commit.vaultId, epoch: commit.epoch, seq: commit.seq)
    for entry in manifest.items {
      _ = try SealedObject.parse(try store.readObject(entry.hash), hash: entry.hash)
    }
    return UnlockedVault(vault: self, owner: owner, epochKey: epochKey, manifest: manifest)
  }

  // MARK: Internals

  static func sign(_ commit: Commit, owner: any OwnerKeyStore) throws -> Data {
    let message = try commit.signedBytes()
    let signature = try ECDSA.normalizedLowS(try owner.sign(message))
    guard ECDSA.isValid(signature, for: message, by: owner.signingPublicKey) else {
      throw VaultError.signerProducedInvalidSignature
    }
    return signature
  }

  private struct Verified {
    let tip: VerifiedCommit
    let headOnDisk: HeadPointer
  }

  private static func verify(store: VaultStore, checkpoint: Checkpoint, allowPendingCommit: Bool) throws -> Verified {
    let head = try store.readHead()
    let seqs = try store.commitSeqs()
    for (index, seq) in seqs.enumerated() where seq != Int64(index) {
      throw VaultError.missingCommit(seq: Int64(index))
    }
    let last = Int64(seqs.count) - 1
    guard last >= head.seq else { throw VaultError.missingCommit(seq: last + 1) }
    guard last <= head.seq + 1 else { throw VaultError.unexpectedCommit(seq: head.seq + 2) }
    guard last == head.seq || allowPendingCommit else { throw VaultError.unexpectedCommit(seq: last) }

    var checkpointHash: String?
    var tip: VerifiedCommit?
    for seq in 0...last {
      guard let bytes = try store.readCommit(seq) else { throw VaultError.missingCommit(seq: seq) }
      let verified = try tip.map { try History.verifyChild(bytes, of: $0) } ?? History.verifyGenesis(bytes)
      if seq == head.seq, verified.hash != head.hash { throw VaultError.headMismatch }
      if seq == checkpoint.head.seq { checkpointHash = verified.hash }
      tip = verified
    }
    guard let tip else { throw VaultError.missingCommit(seq: 0) }
    guard checkpoint.vaultId == tip.commit.vaultId, checkpointHash == checkpoint.head.hash else {
      throw VaultError.rollbackDetected
    }
    _ = try SealedObject.parse(try store.readObject(tip.commit.manifest), hash: tip.commit.manifest)
    return Verified(tip: tip, headOnDisk: head)
  }
}

enum Clock {
  static func nowMillis() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
  }
}
