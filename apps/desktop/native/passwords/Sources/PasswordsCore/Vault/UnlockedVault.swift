import CryptoKit
import Foundation

public struct CommitResult: Sendable {
  public let head: VaultHead
  public let added: [String]
  public let updated: [String]
  public let deleted: [String]
}

/// A vault unlocked for one action.
///
/// It holds the epoch key and the manifest (item IDs, revisions and object
/// hashes, and the grants), never decrypted items: every read decrypts on
/// demand and returns plaintext only to the caller. Call `close()` as soon as
/// the action's selection or commit is done; deinit closes as a backstop.
public final class UnlockedVault {
  private let vault: Vault
  private let owner: any OwnerKeyStore
  private(set) var epochKey: SymmetricKey?
  private(set) var entries: [ManifestEntry]
  /// Sorted by key, at most one per key.
  public private(set) var grants: [Grant]
  /// The head `entries` were read at. A commit made since, through another
  /// unlock of the same `Vault`, makes them stale.
  private let readAt: String

  init(vault: Vault, owner: any OwnerKeyStore, epochKey: SymmetricKey, manifest: Manifest) {
    self.vault = vault
    self.owner = owner
    self.epochKey = epochKey
    entries = manifest.items
    grants = manifest.grants
    readAt = vault.tip.hash
  }

  deinit {
    if isOpen { close() }
  }

  public var head: VaultHead { vault.head }
  public var isOpen: Bool { epochKey != nil }
  public var itemCount: Int { entries.count }

  /// Drops the epoch key and the manifest.
  public func close() {
    epochKey = nil
    entries = []
    grants = []
  }

  /// Every item, decrypted. Any object that fails to decrypt is an error.
  public func items() throws -> [Item] {
    let key = try requireOpen()
    return try entries.map { try decrypt($0, key) }
  }

  /// Items with an origin within `site` (`Origins.isWithinSite`). Every item
  /// is decrypted to read its origins; only matches are returned.
  public func items(withinSite site: String) throws -> [Item] {
    let key = try requireOpen()
    var matches: [Item] = []
    for entry in entries {
      let item = try decrypt(entry, key)
      if item.origins.contains(where: { Origins.isWithinSite($0, site: site) }) {
        matches.append(item)
      }
    }
    return matches
  }

  public func item(id: String) throws -> Item {
    let key = try requireOpen()
    guard let entry = entries.first(where: { $0.id == id }) else { throw VaultError.itemNotFound(id) }
    return try decrypt(entry, key)
  }

  /// The grant for `key`, if the person allowed one.
  public func grant(for key: GrantKey) throws -> Grant? {
    _ = try requireOpen()
    return grants.first { $0.key == key && $0.isCurrentPermission }
  }

  /// Adds items in one commit. Returns their new IDs.
  @discardableResult
  public func add(_ drafts: [ItemDraft]) throws -> [String] {
    try commit(VaultChanges(add: drafts)).added
  }

  public func update(_ item: Item) throws {
    _ = try commit(VaultChanges(update: [item]))
  }

  public func delete(ids: [String]) throws {
    _ = try commit(VaultChanges(delete: ids))
  }

  /// Writes one commit with all of `changes`, signed by the owner.
  ///
  /// New items get revision 1; changed items get revision + 1 and a fresh
  /// data key; unchanged items keep their object and revision. Grants of a
  /// deleted login, or of one whose origins, login URL or username changed,
  /// are removed; a grant written here needs its login to have an origin
  /// within the grant's site.
  public func commit(_ changes: VaultChanges) throws -> CommitResult {
    let epochKey = try requireOpen()
    let signerID = KeyID.of(owner.signingPublicKey)
    guard vault.tip.commit.owners.contains(where: { $0.signingKeyID == signerID }) else { throw VaultError.notAMember }
    // Held across the check and every write: the folder is the one the
    // checkpoint pins and the one this unlock read, until the commit is in.
    return try vault.lock.withLock {
      let checkpoint = try vault.verifyCurrentLocked()
      guard vault.tip.hash == readAt else { throw VaultError.headMoved }
      return try commitLocked(changes, epochKey: epochKey, signerID: signerID, replacing: checkpoint)
    }
  }

  /// `replacing` is the checkpoint the history was just verified against;
  /// the new pin replaces it and nothing else.
  private func commitLocked(_ changes: VaultChanges, epochKey: SymmetricKey, signerID: String, replacing previous: Data)
    throws -> CommitResult
  {
    let parent = vault.tip

    let vaultId = parent.commit.vaultId
    let epoch = parent.commit.epoch
    let seq = parent.commit.seq + 1
    let now = Clock.nowMillis()
    let original = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
    var next = original
    var objects: [Data] = []
    var touched = Set<String>()
    var added: [String] = []
    var updated: [String] = []
    var deleted: [String] = []
    /// Logins whose grants go: deleted, or pointed somewhere else.
    var repointed = Set<String>()
    /// What a grant written here checks its login against.
    var written: [String: Item] = [:]

    for draft in changes.add {
      try draft.validate()
      let item = Item(id: VaultIDs.newUUID(), draft: draft, createdAt: now, updatedAt: now, revision: 1)
      let bytes = try ItemCodec.seal(item, vaultId: vaultId, epoch: epoch, revision: 1, epochKey: epochKey)
      objects.append(bytes)
      next[item.id] = ManifestEntry(id: item.id, revision: 1, hash: Hex.sha256(bytes))
      added.append(item.id)
      written[item.id] = item
    }
    // An edited item, or a new password for one, written as the next
    // revision of the item as it is now; an item that would not change is
    // left as it was.
    func revise(_ id: String, _ apply: (Item) -> Item) throws {
      guard touched.insert(id).inserted else { throw VaultError.invalidItem("an item is changed twice") }
      guard let entry = original[id] else { throw VaultError.itemNotFound(id) }
      let current = try decrypt(entry, epochKey)
      var item = apply(current)
      item.createdAt = current.createdAt
      item.updatedAt = current.updatedAt
      try item.validate()
      written[item.id] = item
      if item.isIdentical(to: current) { return }
      if !item.signsInTheSameWay(as: current) { repointed.insert(item.id) }
      item.updatedAt = max(now, current.updatedAt)
      let revision = entry.revision + 1
      let bytes = try ItemCodec.seal(item, vaultId: vaultId, epoch: epoch, revision: revision, epochKey: epochKey)
      objects.append(bytes)
      next[item.id] = ManifestEntry(id: item.id, revision: revision, hash: Hex.sha256(bytes))
      updated.append(item.id)
    }
    for edited in changes.update {
      try revise(edited.id) { _ in edited }
    }
    for replacement in changes.replace {
      try revise(replacement.itemID) { current in
        var item = current
        item.password = replacement.password
        item.totp = replacement.totp ?? current.totp
        return item
      }
    }
    for id in changes.delete {
      guard touched.insert(id).inserted else { throw VaultError.invalidItem("an item is changed twice") }
      guard original[id] != nil else { throw VaultError.itemNotFound(id) }
      next[id] = nil
      deleted.append(id)
      repointed.insert(id)
    }
    guard next.count <= VaultLimits.maxItems else { throw VaultError.tooManyItems }

    var nextGrants = Dictionary(uniqueKeysWithValues: grants.filter(\.isCurrentPermission).map { ($0.key, $0) })
    for (key, grant) in nextGrants where repointed.contains(grant.loginId) { nextGrants[key] = nil }
    for key in changes.revoke { nextGrants[key] = nil }
    for change in changes.grant {
      let loginId: String
      switch change.login {
      case .saved(let id): loginId = id
      case .added(let index):
        guard added.indices.contains(index) else { throw VaultError.invalidGrant("a grant names a login this commit does not add") }
        loginId = added[index]
      }
      guard !repointed.contains(loginId) else {
        throw VaultError.invalidGrant("a grant names a login this commit deletes or points elsewhere")
      }
      let login: Item
      if let item = written[loginId] {
        login = item
      } else if let entry = original[loginId] {
        login = try decrypt(entry, epochKey)
      } else {
        throw VaultError.itemNotFound(loginId)
      }
      guard Origins.isSite(change.key.site), login.origins.contains(where: { Origins.isWithinSite($0, site: change.key.site) })
      else { throw VaultError.invalidGrant("a grant's login has no website within its site") }
      let grant = Grant(
        key: change.key, loginId: loginId, deploymentName: change.deploymentName, workspaceName: change.workspaceName, revision: next[loginId]!.revision, permissionVersion: change.permissionVersion)
      try grant.validateStored()
      nextGrants[change.key] = grant
    }
    let grantsAfter = nextGrants.values.sorted { $0.key.precedes($1.key) }
    guard !(added.isEmpty && updated.isEmpty && deleted.isEmpty && grantsAfter == grants) else { throw VaultError.noChanges }

    let nextEntries = next.values.sorted { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }
    try Manifest.checkGrants(grantsAfter, items: nextEntries)
    let manifestBytes = try Manifest(vaultId: vaultId, seq: seq, items: nextEntries, grants: grantsAfter)
      .seal(epochKey: epochKey, epoch: epoch)
    let envelopes = try parent.commit.owners
      .map { try EpochEnvelope.seal(epochKey, to: $0, vaultId: vaultId, epoch: epoch) }
      .sorted { $0.recipient.utf8.lexicographicallyPrecedes($1.recipient.utf8) }
    var commit = Commit(
      createdAt: now,
      envelopes: envelopes,
      epoch: epoch,
      manifest: Hex.sha256(manifestBytes),
      owners: parent.commit.owners,
      parent: parent.hash,
      seq: seq,
      signer: signerID,
      vaultId: vaultId,
      signature: Data()
    )
    commit.signature = try Vault.sign(commit, owner: owner)
    let bytes = try commit.bytes()
    let verified = try History.verifyChild(bytes, of: parent)

    // Objects, then the commit, then the checkpoint, then HEAD and this
    // object. Nothing, on disk or here, moves past what the checkpoint pins:
    // a head that was never pinned could be released from and then rolled
    // back unnoticed. A crash after the commit leaves a child that open
    // verifies, adopts and pins; a failed pin removes it again.
    for object in objects { try vault.store.writeObject(object) }
    try vault.store.writeObject(manifestBytes)
    try vault.store.writeCommit(seq, bytes)
    let pointer = HeadPointer(hash: verified.hash, seq: seq)
    let pinned = Checkpoint(vaultId: vaultId, head: pointer)
    // Compare-and-swap, so a writer that does not share the lock is refused
    // rather than overwritten.
    guard try vault.protectedStore.read(.checkpoint) == previous else {
      try? vault.store.removeCommit(seq)
      throw VaultError.headMoved
    }
    do {
      try vault.protectedStore.write(.checkpoint, try pinned.bytes())
    } catch {
      try recoverFailedPin(pinned, seq: seq, previous: previous, error: error)
    }
    try vault.store.writeHead(pointer)
    vault.tip = verified
    entries = nextEntries
    grants = grantsAfter
    return CommitResult(head: vault.head, added: added, updated: updated, deleted: deleted)
  }

  /// A checkpoint write reported an error. What the store holds now decides:
  /// the new pin means the write landed after all, and the commit stands;
  /// the old pin means it did not, and the commit file goes, leaving the
  /// vault as it was (its new objects stay, unreferenced). Anything else is
  /// unknown, so the commit file stays in the history a pin may name, and
  /// the next open settles it as it settles a crash.
  private func recoverFailedPin(_ pinned: Checkpoint, seq: Int64, previous: Data, error: Error) throws {
    let stored = (try? vault.protectedStore.read(.checkpoint)).flatMap { $0 }
    if stored.flatMap({ try? Checkpoint(bytes: $0) }) == pinned { return }
    if stored == previous {
      try? vault.store.removeCommit(seq)
    }
    throw error
  }

  private func requireOpen() throws -> SymmetricKey {
    guard let epochKey else { throw VaultError.closed }
    return epochKey
  }

  private func decrypt(_ entry: ManifestEntry, _ epochKey: SymmetricKey) throws -> Item {
    let commit = vault.tip.commit
    return try ItemCodec.open(
      try vault.store.readObject(entry.hash), entry: entry,
      vaultId: commit.vaultId, epoch: commit.epoch, epochKey: epochKey)
  }
}
