import Darwin
import XCTest
import PasswordsTestSupport
@testable import PasswordsCore

/// The checkpoint in the `ProtectedStore` pins the newest head this Mac
/// accepted, so the vault folder cannot be rolled back, forked or swapped.
final class CheckpointTests: XCTestCase {
  private func checkpoint(_ fixture: VaultFixture) throws -> Checkpoint {
    try Checkpoint(bytes: try XCTUnwrap(try fixture.protected.read(.checkpoint)))
  }

  private func copy(_ source: URL, to destination: URL) throws {
    try? FileManager.default.removeItem(at: destination)
    try FileManager.default.copyItem(at: source, to: destination)
  }

  func testCommitAdvancesCheckpoint() throws {
    let fixture = try VaultFixture()
    for seq in 1...3 {
      try fixture.withUnlocked { try $0.add([draft("s\(seq).example.com")]) }
      let head = try fixture.open().head
      let pinned = try checkpoint(fixture)
      XCTAssertEqual(pinned.head, HeadPointer(hash: head.hash, seq: Int64(seq)))
      XCTAssertEqual(pinned.vaultId, head.vaultId)
    }
  }

  func testRolledBackVaultRejected() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let snapshot = fixture.directory.appendingPathComponent("snapshot")
    try copy(fixture.root, to: snapshot)
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    try copy(snapshot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }

  func testForkRejected() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let forkRoot = fixture.directory.appendingPathComponent("fork")
    let forkProtected = try FileProtectedStore(directory: fixture.directory.appendingPathComponent("fork-protected"))
    try copy(fixture.root, to: forkRoot)
    try forkProtected.write(.checkpoint, try XCTUnwrap(try fixture.protected.read(.checkpoint)))

    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    let fork = try Vault.open(root: forkRoot, protectedStore: forkProtected).unlock(owner: fixture.owner)
    try fork.add([draft("evil.example.com")])
    fork.close()
    XCTAssertEqual(try Vault.open(root: forkRoot, protectedStore: forkProtected).head.seq, 2)

    try copy(forkRoot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }

  func testOtherVaultRejected() throws {
    let fixture = try VaultFixture(items: [draft()])
    let other = try VaultFixture(items: [draft()])
    XCTAssertThrowsVaultError(.rollbackDetected, try Vault.open(root: other.root, protectedStore: fixture.protected))
  }

  func testMissingCheckpointRejected() throws {
    let fixture = try VaultFixture()
    try fixture.protected.delete(.checkpoint)
    XCTAssertThrowsVaultError(.checkpointMissing, try fixture.open())
    XCTAssertNil(try fixture.protected.read(.checkpoint), "never re-created silently")
  }

  func testCorruptCheckpointRejected() throws {
    let fixture = try VaultFixture()
    let pinned = try checkpoint(fixture)
    let variants = [
      "garbage",
      "{\"hash\":\"\(pinned.head.hash)\",\"seq\":0}",
      "{\"hash\":\"\(pinned.head.hash)\",\"seq\":0,\"vaultId\":\"not-a-uuid\"}",
    ]
    for variant in variants {
      try fixture.protected.write(.checkpoint, Data(variant.utf8))
      XCTAssertThrowsVaultError(.corruptCheckpoint, try fixture.open())
    }
  }

  func testCrashBeforeCheckpointIsAccepted() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let atOne = try XCTUnwrap(try fixture.protected.read(.checkpoint))
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    try fixture.withUnlocked { try $0.add([draft("c.example.com")]) }
    try fixture.protected.write(.checkpoint, atOne)
    XCTAssertEqual(try fixture.open().head.seq, 3, "a newer HEAD that chains from the checkpoint is accepted")
    XCTAssertEqual(try checkpoint(fixture).head.seq, 3)
  }

  /// K8: the head in memory and on disk never moves past what the
  /// checkpoint pins, so a failed pin can release nothing new and a rolled
  /// back folder is still caught.
  func testFailedCheckpointWriteLeavesTheOldHead() throws {
    let fixture = try VaultFixture(items: [draft(password: "SYNTHETIC-OLD-PASSWORD")])
    let snapshot = fixture.directory.appendingPathComponent("snapshot")
    try copy(fixture.root, to: snapshot)
    let headBefore = try Data(contentsOf: fixture.headURL)
    let store = ScriptedCheckpointStore(fixture.protected, headURL: fixture.headURL)
    let vault = try Vault.open(root: fixture.root, protectedStore: store)
    let unlocked = try vault.unlock(owner: fixture.owner)
    var changed = try unlocked.items()[0]
    changed.password = "SYNTHETIC-NEW-PASSWORD"
    store.failure = .beforeWriting
    XCTAssertThrowsError(try unlocked.update(changed))

    XCTAssertEqual(vault.head.seq, 1)
    XCTAssertEqual(try unlocked.items()[0].password, "SYNTHETIC-OLD-PASSWORD")
    unlocked.close()
    XCTAssertEqual(try Data(contentsOf: fixture.headURL), headBefore)
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.commitURL(2).path), "the unpinned commit is removed")
    let again = try vault.unlock(owner: fixture.owner)
    XCTAssertEqual(try again.items()[0].password, "SYNTHETIC-OLD-PASSWORD")
    again.close()
    XCTAssertEqual(try fixture.open().head.seq, 1, "reopening finds exactly the vault as it was")

    // Once the store works, the same change commits, and the old copy is a rollback.
    store.failure = .none
    let retry = try vault.unlock(owner: fixture.owner)
    try retry.update(changed)
    retry.close()
    XCTAssertEqual(vault.head.seq, 2)
    XCTAssertEqual(try checkpoint(fixture).head.seq, 2)
    try copy(snapshot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }

  /// A checkpoint that was stored although its write reported an error pins
  /// the new head, so the commit stands rather than leaving a pin to a
  /// commit that no longer exists.
  func testCheckpointThatLandedDespiteAnErrorCounts() throws {
    let fixture = try VaultFixture(items: [draft(password: "SYNTHETIC-OLD-PASSWORD")])
    let store = ScriptedCheckpointStore(fixture.protected, headURL: fixture.headURL)
    let vault = try Vault.open(root: fixture.root, protectedStore: store)
    let unlocked = try vault.unlock(owner: fixture.owner)
    var changed = try unlocked.items()[0]
    changed.password = "SYNTHETIC-NEW-PASSWORD"
    store.failure = .afterWriting
    XCTAssertNoThrow(try unlocked.update(changed))
    unlocked.close()
    XCTAssertEqual(vault.head.seq, 2)
    XCTAssertEqual(try checkpoint(fixture).head.seq, 2)
    XCTAssertEqual(try fixture.open().head.seq, 2)
    XCTAssertEqual(try fixture.items()[0].password, "SYNTHETIC-NEW-PASSWORD")
  }

  /// A crash after the pin but before HEAD moved: open adopts the pinned
  /// child, as it adopts one a crash left before the pin.
  func testCrashAfterPinBeforeHeadIsAdopted() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let headAtOne = try Data(contentsOf: fixture.headURL)
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    try headAtOne.write(to: fixture.headURL)
    XCTAssertEqual(try checkpoint(fixture).head.seq, 2)
    XCTAssertEqual(try fixture.open().head.seq, 2)
    XCTAssertEqual(try fixture.items().count, 2)
  }

  /// The order that makes the two tests above possible: the checkpoint is
  /// written while HEAD still names the old commit.
  func testCheckpointIsPinnedBeforeHeadMoves() throws {
    let fixture = try VaultFixture()
    let store = ScriptedCheckpointStore(fixture.protected, headURL: fixture.headURL)
    let headBefore = try Data(contentsOf: fixture.headURL)
    let vault = try Vault.open(root: fixture.root, protectedStore: store)
    let unlocked = try vault.unlock(owner: fixture.owner)
    try unlocked.add([draft("a.example.com")])
    unlocked.close()
    XCTAssertEqual(store.headsAtCheckpointWrites, [headBefore])
    XCTAssertNotEqual(try Data(contentsOf: fixture.headURL), headBefore)
  }

  /// K11: a `Vault` kept open (as the broker keeps one) checks the folder
  /// against the current checkpoint before every unlock, so restoring an
  /// older copy after another instance moved the checkpoint releases
  /// nothing.
  func testRetainedVaultRefusesARolledBackFolder() throws {
    let fixture = try VaultFixture(items: [draft(password: "SYNTHETIC-OLD-PASSWORD")])
    let retained = try fixture.open()
    let snapshot = fixture.directory.appendingPathComponent("snapshot")
    try copy(fixture.root, to: snapshot)
    try fixture.withUnlocked { unlocked in
      var item = try XCTUnwrap(unlocked.items().first)
      item.password = "SYNTHETIC-NEW-PASSWORD"
      try unlocked.update(item)
    }
    try copy(snapshot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
    XCTAssertThrowsVaultError(.rollbackDetected, try retained.unlock(owner: fixture.owner))
    XCTAssertThrowsVaultError(.rollbackDetected, try retained.verifyHistory())
  }

  /// K12: an `UnlockedVault` held across the change checks again before it
  /// commits, so it can neither fork the history over a rolled-back folder
  /// nor write from a head another instance moved past.
  func testRetainedUnlockedVaultChecksBeforeItCommits() throws {
    let fixture = try VaultFixture(items: [draft(password: "SYNTHETIC-OLD-PASSWORD")])
    let snapshot = fixture.directory.appendingPathComponent("snapshot")
    try copy(fixture.root, to: snapshot)
    let held = try fixture.open().unlock(owner: fixture.owner)
    var change = try XCTUnwrap(held.items().first)
    change.password = "SYNTHETIC-HELD-PASSWORD"
    try fixture.withUnlocked { unlocked in
      var item = try XCTUnwrap(unlocked.items().first)
      item.password = "SYNTHETIC-NEW-PASSWORD"
      try unlocked.update(item)
    }
    try copy(snapshot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try held.update(change))
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.commitURL(2).path), "no fork was written")
    XCTAssertEqual(try checkpoint(fixture).head.seq, 2, "the accepted head is still pinned")

    // Without a rollback: a head another instance moved past is stale.
    let fresh = try VaultFixture(items: [draft()])
    let stale = try fresh.open().unlock(owner: fresh.owner)
    var staleChange = try XCTUnwrap(stale.items().first)
    staleChange.password = "SYNTHETIC-STALE"
    try fresh.withUnlocked { try $0.add([draft("b.example.com")]) }
    XCTAssertThrowsVaultError(.headMoved, try stale.update(staleChange))
  }

  /// K14: two unlocks of one `Vault`: after the first commits, the second
  /// holds a manifest from before it and must not write over it.
  func testSecondUnlockOfOneVaultCannotOverwriteTheFirstsCommit() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let vault = try fixture.open()
    let first = try vault.unlock(owner: fixture.owner)
    let second = try vault.unlock(owner: fixture.owner)
    try first.add([draft("b.example.com")])
    XCTAssertThrowsVaultError(.headMoved, try second.add([draft("c.example.com")]))
    XCTAssertEqual(try fixture.items().map(\.origins).sorted { $0[0] < $1[0] }, [["https://a.example.com"], ["https://b.example.com"]])
  }

  /// K13: checking and using the history is one step for every instance and
  /// process: a vault operation waits while another holds the vault's lock.
  func testVaultOperationsAreSerialized() throws {
    let fixture = try VaultFixture(items: [draft()])
    let vault = try fixture.open()
    let lockURL = fixture.directory.appendingPathComponent(".Vault.lock")
    let descriptor = open(lockURL.path, O_RDWR | O_CREAT, 0o600)
    XCTAssertGreaterThanOrEqual(descriptor, 0)
    XCTAssertEqual(flock(descriptor, LOCK_EX), 0)
    let finished = DispatchSemaphore(value: 0)
    let owner = fixture.owner
    // Used by the other thread alone while this one only waits.
    nonisolated(unsafe) let other = vault
    DispatchQueue.global().async {
      let unlocked = try? other.unlock(owner: owner)
      unlocked?.close()
      finished.signal()
    }
    XCTAssertEqual(finished.wait(timeout: .now() + 0.3), .timedOut, "it waits for the lock")
    flock(descriptor, LOCK_UN)
    close(descriptor)
    XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
  }

  /// K15: an open adopting a crash-left commit and a second instance
  /// committing on top cannot interleave, so the checkpoint never moves back
  /// and a dropped newest commit is caught. (Second review, finding 2.)
  func testConcurrentOpenCannotRegressTheCheckpoint() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let checkpointAtOne = try XCTUnwrap(try fixture.protected.read(.checkpoint))
    let headAtOne = try Data(contentsOf: fixture.headURL)
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    // As if the writer of seq 2 stopped after its commit file.
    try headAtOne.write(to: fixture.headURL)
    try fixture.protected.write(.checkpoint, checkpointAtOne)
    let interleaving = InterleavingStore(base: fixture.protected)
    let otherFinished = DispatchSemaphore(value: 0)
    let root = fixture.root
    let protected = fixture.protected
    let owner = fixture.owner
    interleaving.hook = {
      DispatchQueue.global().async {
        if let other = try? Vault.open(root: root, protectedStore: protected),
          let unlocked = try? other.unlock(owner: owner)
        {
          _ = try? unlocked.add([draft("c.example.com", password: "added-in-seq-3")])
          unlocked.close()
        }
        otherFinished.signal()
      }
      XCTAssertEqual(otherFinished.wait(timeout: .now() + 0.3), .timedOut, "the other instance waits for the lock")
    }
    XCTAssertEqual(try Vault.open(root: fixture.root, protectedStore: interleaving).head.seq, 2)
    XCTAssertEqual(otherFinished.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(try checkpoint(fixture).head.seq, 3, "the checkpoint only moved forwards")
    let commitTwo = try Data(contentsOf: fixture.commitURL(2))
    try FileManager.default.removeItem(at: fixture.commitURL(3))
    try HeadPointer(hash: Hex.sha256(commitTwo), seq: 2).bytes().write(to: fixture.headURL)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }

  /// K16: a stale `Vault` cannot commit a fork onto a restored folder and
  /// pin it. (Second review, finding 2; with K11 and K12.)
  func testStaleVaultCannotCommitAForkOverTheCheckpoint() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let stale = try fixture.open()
    let headAtOne = try Data(contentsOf: fixture.headURL)
    try fixture.withUnlocked { try $0.add([draft("genuine.example.com", password: "genuine-seq-2")]) }
    try FileManager.default.removeItem(at: fixture.commitURL(2))
    try headAtOne.write(to: fixture.headURL)
    XCTAssertThrowsVaultError(.rollbackDetected, try stale.unlock(owner: fixture.owner))
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.commitURL(2).path))
    XCTAssertEqual(try checkpoint(fixture).head.seq, 2)
  }

  /// K17: a checkpoint is replaced only if it is still the one the history
  /// was verified against (compare-and-swap), so even a writer that does not
  /// share the lock is never overwritten. (Second review, finding 2.)
  func testCheckpointIsComparedBeforeItIsReplaced() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let elsewhere = try Checkpoint(
      vaultId: try fixture.open().head.vaultId, head: HeadPointer(hash: Hex.sha256(Data("elsewhere".utf8)), seq: 9)
    ).bytes()
    let racing = CheckpointRaceStore(base: fixture.protected)
    let vault = try Vault.open(root: fixture.root, protectedStore: racing)
    let unlocked = try vault.unlock(owner: fixture.owner)
    racing.reads = 0
    // Read 1 is the check before the commit; read 2 is the one before the pin.
    racing.onRead[2] = { try fixture.protected.write(.checkpoint, elsewhere) }
    XCTAssertThrowsVaultError(.headMoved, try unlocked.add([draft("b.example.com")]))
    XCTAssertEqual(try fixture.protected.read(.checkpoint), elsewhere, "the other writer's pin stands")
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.commitURL(2).path))
    XCTAssertEqual(vault.head.seq, 1)

    // The same for an open that adopts a crash-left commit.
    let adopting = try VaultFixture(items: [draft("a.example.com")])
    let checkpointAtOne = try XCTUnwrap(try adopting.protected.read(.checkpoint))
    let headAtOne = try Data(contentsOf: adopting.headURL)
    try adopting.withUnlocked { try $0.add([draft("b.example.com")]) }
    try headAtOne.write(to: adopting.headURL)
    try adopting.protected.write(.checkpoint, checkpointAtOne)
    let other = CheckpointRaceStore(base: adopting.protected)
    other.onRead[2] = { try adopting.protected.write(.checkpoint, elsewhere) }
    XCTAssertThrowsVaultError(.headMoved, try Vault.open(root: adopting.root, protectedStore: other))
    XCTAssertEqual(try adopting.protected.read(.checkpoint), elsewhere)
    XCTAssertEqual(try Data(contentsOf: adopting.headURL), headAtOne, "HEAD did not move either")
  }

  func testNewerHeadMustChainFromCheckpoint() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let vaultId = try fixture.open().head.vaultId
    let forged = Checkpoint(vaultId: vaultId, head: HeadPointer(hash: Hex.sha256(Data("elsewhere".utf8)), seq: 0))
    try fixture.protected.write(.checkpoint, try forged.bytes())
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }

  func testNoVault() throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let protected = try FileProtectedStore(directory: directory.appendingPathComponent("Protected"))
    XCTAssertFalse(Vault.exists(at: directory.appendingPathComponent("Vault")))
    XCTAssertThrowsVaultError(.notFound, try Vault.open(root: directory.appendingPathComponent("Vault"), protectedStore: protected))
  }
}
