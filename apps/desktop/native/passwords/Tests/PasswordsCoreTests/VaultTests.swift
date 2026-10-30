import CryptoKit
import XCTest
import PasswordsTestSupport
@testable import PasswordsCore

final class VaultTests: XCTestCase {
  func testCreateWritesSignedGenesis() throws {
    let fixture = try VaultFixture()
    let vault = try fixture.open()
    XCTAssertEqual(vault.head.seq, 0)
    XCTAssertEqual(vault.head.epoch, 0)
    XCTAssertEqual(vault.head.owners.map(\.deviceName), ["Test Mac"])
    XCTAssertEqual(vault.head.owners.first?.signingKeyID, KeyID.of(fixture.owner.signingPublicKey))

    let genesis = try fixture.commitJSON(0)
    XCTAssertEqual(genesis["parent"], .null)
    XCTAssertEqual(genesis["signer"], .string(KeyID.of(fixture.owner.signingPublicKey)))
    guard case .array(let envelopes)? = genesis["envelopes"], case .object(let envelope)? = envelopes.first else { return XCTFail() }
    XCTAssertEqual(envelopes.count, 1)
    XCTAssertEqual(envelope["recipient"], .string(KeyID.of(fixture.owner.agreementPublicKey)))
    XCTAssertEqual(Hex.sha256(try Data(contentsOf: fixture.commitURL(0))), vault.head.hash)

    let manager = FileManager.default
    for directory in [fixture.root, fixture.commitsURL, fixture.objectsURL] {
      XCTAssertEqual(try manager.attributesOfItem(atPath: directory.path)[.posixPermissions] as? Int, 0o700)
    }
    for file in [fixture.headURL, fixture.commitURL(0)] {
      XCTAssertEqual(try manager.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
    }
    XCTAssertEqual(try fixture.withUnlocked { $0.itemCount }, 0)
    // The vault's lock lives beside it; no staging folder is left.
    XCTAssertEqual(try manager.contentsOfDirectory(atPath: fixture.directory.path).sorted(), [".Vault.lock", "Protected", "Vault"])
  }

  func testCreateRefusesExistingRoot() throws {
    let fixture = try VaultFixture()
    XCTAssertThrowsVaultError(.alreadyExists, try Vault.create(
      root: fixture.root, protectedStore: fixture.protected, deviceName: "Test Mac", owner: fixture.owner))
    XCTAssertThrowsVaultError(.invalidDeviceName, try Vault.create(
      root: fixture.directory.appendingPathComponent("Other"), protectedStore: fixture.protected,
      deviceName: "bad\nname", owner: fixture.owner))
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: fixture.directory.path).sorted(), [".Vault.lock", "Protected", "Vault"])
  }

  func testAddAndRead() throws {
    let fixture = try VaultFixture()
    let totp = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    let ids = try fixture.withUnlocked {
      try $0.add([draft("example.com", totp: totp, label: "Example"), draft("example.org", username: "bob")])
    }
    XCTAssertEqual(ids.count, 2)
    let items = try fixture.items()
    XCTAssertEqual(Set(items.map(\.id)), Set(ids))
    let example = try XCTUnwrap(items.first { $0.origins == ["https://example.com"] })
    XCTAssertEqual(example.loginURL, "https://example.com/login")
    XCTAssertEqual(example.label, "Example")
    XCTAssertEqual(example.totp, totp)
    XCTAssertEqual(example.createdAt, example.updatedAt)
    XCTAssertEqual(try fixture.open().head.seq, 1)
  }

  func testPasswordBytesPreserved() throws {
    let passwords = [
      "  pa\u{0308}ssw\u{006F}\u{0308}rd  ",
      "  p\u{E4}ssw\u{F6}rd  ",
      "\u{1F511}\u{00A0}key\t",
      "line one\r\nline two\n",
      "quote\" back\\slash \u{0001} nul\u{0000}",
      "\u{FB33}\u{05D3}\u{05BC}",
      String(repeating: "x", count: VaultLimits.maxPasswordBytes),
    ]
    let fixture = try VaultFixture()
    try fixture.withUnlocked { vault in
      try vault.add(passwords.enumerated().map { draft("site\($0.offset).example.com", username: " u\u{0301}ser\($0.offset)\t", password: $0.element) })
    }
    let items = try fixture.items()
    for (index, password) in passwords.enumerated() {
      let item = try XCTUnwrap(items.first { $0.origins == ["https://site\(index).example.com"] })
      XCTAssertEqual(Array(try XCTUnwrap(item.password).utf8), Array(password.utf8), "password \(index)")
      XCTAssertEqual(Array(item.username.utf8), Array(" u\u{0301}ser\(index)\t".utf8), "username \(index)")
    }
    // NFD and NFC spellings are different passwords.
    let first = try XCTUnwrap(items.first { $0.origins == ["https://site0.example.com"] })
    let second = try XCTUnwrap(items.first { $0.origins == ["https://site1.example.com"] })
    XCTAssertEqual(first.password, second.password, "Swift == ignores normalisation")
    XCTAssertFalse(try XCTUnwrap(first.password).utf8.elementsEqual(XCTUnwrap(second.password).utf8))
  }

  func testUnchangedItemsKeepObjects() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com"), draft("b.example.com")])
    let (before, a) = try fixture.withUnlocked { vault -> ([String: ManifestEntry], Item) in
      (Dictionary(uniqueKeysWithValues: vault.entries.map { ($0.id, $0) }), try XCTUnwrap(try vault.items().first { $0.origins == ["https://a.example.com"] }))
    }
    let objectsBefore = try fixture.objectNames()
    var changed = a
    changed.password = "a-new-password"
    let result = try fixture.withUnlocked { try $0.commit(VaultChanges(update: [changed])) }
    XCTAssertEqual(result.updated, [a.id])
    let after = try fixture.withUnlocked { vault in Dictionary(uniqueKeysWithValues: vault.entries.map { ($0.id, $0) }) }
    for (id, entry) in before where id != a.id {
      XCTAssertEqual(after[id], entry, "unchanged items keep hash and revision")
    }
    XCTAssertEqual(after[a.id]?.revision, 2)
    XCTAssertNotEqual(after[a.id]?.hash, before[a.id]?.hash)
    // Objects are content addressed and never removed: one new item object and one manifest.
    XCTAssertEqual(try fixture.objectNames().subtracting(objectsBefore).count, 2)

    let updated = try XCTUnwrap(try fixture.items().first { $0.id == a.id })
    XCTAssertEqual(a.revision, 1, "items read back carry their manifest revision")
    XCTAssertEqual(updated.revision, 2)
    XCTAssertEqual(updated.password, "a-new-password")
    XCTAssertEqual(updated.createdAt, a.createdAt)
    XCTAssertGreaterThanOrEqual(updated.updatedAt, a.updatedAt)

    XCTAssertThrowsVaultError(.noChanges, try fixture.withUnlocked { try $0.update(updated) })
  }

  func testDeleteAndChangeErrors() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com"), draft("b.example.com")])
    let items = try fixture.items()
    XCTAssertThrowsVaultError(.itemNotFound("00000000-0000-4000-8000-000000000000"),
      try fixture.withUnlocked { try $0.delete(ids: ["00000000-0000-4000-8000-000000000000"]) })
    XCTAssertThrowsVaultError(.invalidItem("an item is changed twice"),
      try fixture.withUnlocked { try $0.commit(VaultChanges(update: [items[0]], delete: [items[0].id])) })
    XCTAssertThrowsVaultError(.noChanges, try fixture.withUnlocked { try $0.commit(VaultChanges()) })
    try fixture.withUnlocked { try $0.delete(ids: [items[0].id]) }
    XCTAssertEqual(try fixture.items().map(\.id), [items[1].id])
    XCTAssertThrowsVaultError(.itemNotFound(items[0].id), try fixture.withUnlocked { try $0.update(items[0]) })
  }

  func testItemValidation() throws {
    let long = { (count: Int) in String(repeating: "x", count: count) }
    let invalid: [(String, ItemDraft)] = [
      ("no origins", ItemDraft(origins: [], loginURL: "https://example.com/", username: "a", password: "p")),
      ("nine origins", ItemDraft(origins: (0..<9).map { "https://s\($0).example.com" }, loginURL: "https://s0.example.com/", username: "a", password: "p")),
      ("unnormalised origin", ItemDraft(origins: ["https://Example.com"], loginURL: "https://example.com/", username: "a", password: "p")),
      ("origin with path", ItemDraft(origins: ["https://example.com/"], loginURL: "https://example.com/", username: "a", password: "p")),
      ("http origin", ItemDraft(origins: ["http://example.com"], loginURL: "http://example.com/", username: "a", password: "p")),
      ("public suffix", ItemDraft(origins: ["https://github.io"], loginURL: "https://github.io/", username: "a", password: "p")),
      ("repeated origin", ItemDraft(origins: ["https://example.com", "https://example.com"], loginURL: "https://example.com/", username: "a", password: "p")),
      ("login URL off origins", ItemDraft(origins: ["https://example.com"], loginURL: "https://login.example.com/", username: "a", password: "p")),
      ("unnormalised login URL", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com", username: "a", password: "p")),
      ("login URL fragment", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/#x", username: "a", password: "p")),
      ("long username", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: long(1_025), password: "p")),
      ("empty password", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: "a", password: "")),
      ("long password", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: "a", password: long(4_097))),
      ("long multibyte password", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: "a", password: String(repeating: "\u{E4}", count: 2_049))),
      ("empty label", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: "a", password: "p", label: "")),
      ("long label", ItemDraft(origins: ["https://example.com"], loginURL: "https://example.com/", username: "a", password: "p", label: long(201))),
    ]
    let fixture = try VaultFixture()
    for (name, item) in invalid {
      XCTAssertThrowsError(try item.validate(), name) { error in
        guard case .invalidItem = error as? VaultError else { return XCTFail("\(name): \(error)") }
      }
      XCTAssertThrowsError(try fixture.withUnlocked { try $0.add([item]) }, name)
    }
    XCTAssertNoThrow(try ItemDraft(
      origins: (0..<8).map { "https://s\($0).example.com" }, loginURL: "https://s3.example.com/a?b", username: long(1_024),
      password: long(4_096), label: long(200)).validate())
    XCTAssertEqual(try fixture.open().head.seq, 0, "invalid drafts never commit")
  }

  func testStoredItemsDoNotDependOnTheSuffixList() throws {
    // As if the list had since made github.io a public suffix.
    let stored = Item(
      id: VaultIDs.newUUID(),
      draft: ItemDraft(origins: ["https://github.io"], loginURL: "https://github.io/", username: "a", password: "p"),
      createdAt: 1, updatedAt: 1, revision: 1)
    XCTAssertNoThrow(try Item(json: stored.json, revision: stored.revision))
    XCTAssertThrowsError(try stored.validate(), "writes still need a valid origin")
    XCTAssertFalse(Origins.isWithinSite("https://github.io", site: "https://github.io"), "use-time matching refuses it")
    guard case .object(var fields) = stored.json else { return XCTFail() }
    fields["origins"] = .array([.string("http://github.io")])
    XCTAssertThrowsError(try Item(json: .object(fields), revision: 1), "reads still require HTTPS and the limits")
  }

  func testItemCountLimit() throws {
    let fixture = try VaultFixture()
    let drafts = (0...VaultLimits.maxItems).map { draft("s\($0).example.com") }
    XCTAssertThrowsVaultError(.tooManyItems, try fixture.withUnlocked { try $0.add(drafts) })
    XCTAssertEqual(try fixture.open().head.seq, 0)
  }

  func testNonOwnerCannotUnlock() throws {
    let fixture = try VaultFixture()
    XCTAssertThrowsVaultError(.notAMember, try fixture.open().unlock(owner: SoftwareOwnerKeyStore()))
  }

  func testCloseDropsAccess() throws {
    let fixture = try VaultFixture(items: [draft()])
    let unlocked = try fixture.open().unlock(owner: fixture.owner)
    XCTAssertTrue(unlocked.isOpen)
    unlocked.close()
    XCTAssertFalse(unlocked.isOpen)
    XCTAssertNil(unlocked.epochKey)
    XCTAssertTrue(unlocked.entries.isEmpty)
    XCTAssertTrue(unlocked.grants.isEmpty)
    XCTAssertThrowsVaultError(.closed, try unlocked.items())
    XCTAssertThrowsVaultError(.closed, try unlocked.items(withinSite: "https://example.com"))
    XCTAssertThrowsVaultError(.closed, try unlocked.add([draft("b.example.com")]))
  }

  func testItemsWithinSite() throws {
    let fixture = try VaultFixture(items: [
      draft("example.com"), draft("login.example.com", username: "second"), draft("example.org"),
      draft("bucket.s3.amazonaws.com"), draft("evil-example.com"),
      ItemDraft(origins: ["https://example.net", "https://accounts.example.com:8443"], loginURL: "https://example.net/", username: "multi", password: "p"),
    ])
    let matches = try fixture.withUnlocked { try $0.items(withinSite: "https://example.com") }
    XCTAssertEqual(Set(matches.map(\.username)), ["alice@example.com", "second", "multi"])
    XCTAssertTrue(try fixture.withUnlocked { try $0.items(withinSite: "https://amazonaws.com") }.isEmpty)
    XCTAssertEqual(try fixture.withUnlocked { try $0.items(withinSite: "https://bucket.s3.amazonaws.com") }.count, 1)
  }

  /// L3: a site search decrypts every item to read its origins, and keeps
  /// none of them: not the other sites' passwords, not even the matches,
  /// which only the caller holds. (Second review, finding 7.)
  func testSiteSearchKeepsNothingBehind() throws {
    let fixture = try VaultFixture(items: [
      draft("example.com", password: "SYNTHETIC-MATCH"), draft("example.org", password: "SYNTHETIC-OTHER"),
    ])
    let unlocked = try fixture.open().unlock(owner: fixture.owner)
    defer { unlocked.close() }
    XCTAssertEqual(try unlocked.items(withinSite: "https://example.com").map(\.password), ["SYNTHETIC-MATCH"])
    let held = Mirror(reflecting: unlocked).children.map { String(reflecting: $0.value) }.joined()
    XCTAssertFalse(held.contains("SYNTHETIC-MATCH") || held.contains("SYNTHETIC-OTHER"))
  }

  func testCrashBetweenCommitAndHeadIsAdopted() throws {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    let headAtOne = try Data(contentsOf: fixture.headURL)
    let checkpointAtOne = try XCTUnwrap(try fixture.protected.read(.checkpoint))
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    let headAtTwo = try Data(contentsOf: fixture.headURL)

    // The commit file and objects were written; HEAD and the checkpoint were not.
    try headAtOne.write(to: fixture.headURL)
    try fixture.protected.write(.checkpoint, checkpointAtOne)
    let vault = try fixture.open()
    XCTAssertEqual(vault.head.seq, 2)
    XCTAssertEqual(try Data(contentsOf: fixture.headURL), headAtTwo)
    XCTAssertEqual(try Checkpoint(bytes: try XCTUnwrap(try fixture.protected.read(.checkpoint))).head.seq, 2)
    XCTAssertEqual(try fixture.items().count, 2)
  }

  func testConcurrentWriterDetected() throws {
    let fixture = try VaultFixture()
    let first = try fixture.open().unlock(owner: fixture.owner)
    let second = try fixture.open().unlock(owner: fixture.owner)
    let third = try fixture.open().unlock(owner: fixture.owner)
    let headAtZero = try Data(contentsOf: fixture.headURL)
    try first.add([draft("a.example.com")])
    XCTAssertThrowsVaultError(.headMoved, try second.add([draft("b.example.com")]))
    // Even with HEAD put back, the folder no longer matches the checkpoint
    // the first writer pinned, so the third is refused before it writes.
    try headAtZero.write(to: fixture.headURL)
    XCTAssertThrowsVaultError(.unexpectedCommit(seq: 1), try third.add([draft("c.example.com")]))
    XCTAssertEqual(try fixture.open().head.seq, 1)
    XCTAssertEqual(try fixture.items().map(\.origins), [["https://a.example.com"]])
  }

  func testLeftoverTempFilesIgnored() throws {
    let fixture = try VaultFixture(items: [draft()])
    for directory in [fixture.root, fixture.commitsURL, fixture.objectsURL] {
      try Data("partial".utf8).write(to: directory.appendingPathComponent(".tmp-\(UUID().uuidString)"))
    }
    try Data().write(to: fixture.commitsURL.appendingPathComponent(".DS_Store"))
    XCTAssertEqual(try fixture.open().head.seq, 1)
    XCTAssertEqual(try fixture.items().count, 1)
  }

  func testVerifyHistory() throws {
    let fixture = try VaultFixture(items: [draft()])
    let vault = try fixture.open()
    XCTAssertEqual(try vault.verifyHistory().seq, 1)
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    XCTAssertThrowsVaultError(.headMoved, try vault.verifyHistory())
  }
}

// MARK: Grants

extension VaultTests {
  fileprivate static func key(_ workspace: Int, site: String = "https://example.com") -> GrantKey {
    GrantKey(
      deploymentId: "dep_personal", workspaceId: String(format: "wsp_00000000-0000-4000-8000-%012d", workspace), site: site)
  }

  fileprivate static func grant(_ workspace: Int, _ login: GrantChange.Login, site: String = "https://example.com")
    -> GrantChange
  {
    GrantChange(
      key: key(workspace, site: site), login: login, deploymentName: "Personal", workspaceName: "Workspace \(workspace)")
  }

  /// V25: what a grant may name, how many there may be, and one per key.
  func testGrantValidation() throws {
    let fixture = try VaultFixture(items: [draft("example.com"), draft("example.org", username: "org")])
    let items = try fixture.items()
    let com = try XCTUnwrap(items.first { $0.username == "alice@example.com" }).id
    let org = try XCTUnwrap(items.first { $0.username == "org" }).id
    let seq = try fixture.open().head.seq
    func refused(_ expected: VaultError, _ changes: VaultChanges, line: UInt = #line) {
      XCTAssertThrowsVaultError(expected, try fixture.withUnlocked { try $0.commit(changes) }, line: line)
    }
    let outside = VaultError.invalidGrant("a grant's login has no website within its site")
    refused(outside, VaultChanges(grant: [Self.grant(1, .saved(id: org))]))
    for site in ["https://login.example.com", "http://example.com", "https://example.com:8443", "https://com"] {
      refused(outside, VaultChanges(grant: [Self.grant(1, .saved(id: com), site: site)]))
    }
    let missing = "00000000-0000-4000-8000-000000000000"
    refused(.itemNotFound(missing), VaultChanges(grant: [Self.grant(1, .saved(id: missing))]))
    refused(
      .invalidGrant("a grant names a login this commit does not add"), VaultChanges(grant: [Self.grant(1, .added(index: 0))]))
    refused(
      .invalidGrant("a grant names a login this commit deletes or points elsewhere"),
      VaultChanges(delete: [com], grant: [Self.grant(1, .saved(id: com))]))
    let names = VaultError.invalidGrant("a grant's names must be 1 to \(VaultLimits.maxGrantFieldBytes) bytes of text")
    for name in ["", "line\nbreak", String(repeating: "n", count: VaultLimits.maxGrantFieldBytes + 1)] {
      refused(
        names,
        VaultChanges(grant: [
          GrantChange(key: Self.key(1), login: .saved(id: com), deploymentName: "Personal", workspaceName: name)
        ]))
      refused(
        names,
        VaultChanges(grant: [
          GrantChange(
            key: GrantKey(deploymentId: name, workspaceId: "wsp_1", site: "https://example.com"), login: .saved(id: com),
            deploymentName: "Personal", workspaceName: "Main")
        ]))
    }
    refused(.tooManyGrants, VaultChanges(grant: (0...VaultLimits.maxGrants).map { Self.grant($0, .saved(id: com)) }))
    refused(.noChanges, VaultChanges(revoke: [Self.key(1)]))
    XCTAssertEqual(try fixture.open().head.seq, seq, "nothing refused was written")

    // Sorted by key, one per key, and kept across commits and reopening.
    try fixture.withUnlocked {
      _ = try $0.commit(VaultChanges(grant: [Self.grant(2, .saved(id: com)), Self.grant(1, .saved(id: com))]))
    }
    XCTAssertEqual(try fixture.withUnlocked { $0.grants.map(\.key) }, [Self.key(1), Self.key(2)])
    refused(.noChanges, VaultChanges(grant: [Self.grant(1, .saved(id: com))]))
    try fixture.withUnlocked { try $0.add([draft("example.com", username: "second")]) }
    let second = try XCTUnwrap(try fixture.items().first { $0.username == "second" }).id
    try fixture.withUnlocked { _ = try $0.commit(VaultChanges(grant: [Self.grant(1, .saved(id: second))])) }
    let grants = try fixture.withUnlocked { $0.grants }
    XCTAssertEqual(grants.map(\.loginId), [second, com], "the new Allow replaced the first for its key")
    XCTAssertTrue(grants.allSatisfy { $0.permissionVersion == 4 && $0.revision == 1 })
    XCTAssertEqual(grants.first?.workspaceName, "Workspace 1")
    XCTAssertEqual(grants.first?.deploymentName, "Personal")
    XCTAssertEqual(try fixture.withUnlocked { try $0.grant(for: Self.key(2))?.loginId }, com)

    // A commit that adds a login and grants it at once.
    let added = try fixture.withUnlocked {
      try $0.commit(VaultChanges(add: [draft("example.net", username: "net")], grant: [Self.grant(3, .added(index: 0), site: "https://example.net")]))
        .added
    }
    XCTAssertEqual(try fixture.withUnlocked { try $0.grant(for: Self.key(3, site: "https://example.net"))?.loginId }, added.first)

    try fixture.withUnlocked { _ = try $0.commit(VaultChanges(revoke: [Self.key(2), Self.key(9)])) }
    XCTAssertNil(try fixture.withUnlocked { try $0.grant(for: Self.key(2)) })
  }

  /// V26: deleting a login, or changing its origins, login URL or username,
  /// drops its grants; a password, label or two-factor change keeps them.
  func testGrantsFollowTheirLogins() throws {
    let fixture = try VaultFixture(items: [draft("example.com"), draft("example.com", username: "other")])
    let items = try fixture.items()
    let id = try XCTUnwrap(items.first { $0.username == "alice@example.com" }).id
    let other = try XCTUnwrap(items.first { $0.username == "other" }).id
    func allow() throws {
      try fixture.withUnlocked {
        _ = try $0.commit(VaultChanges(grant: [Self.grant(1, .saved(id: id)), Self.grant(2, .saved(id: id))]))
      }
    }
    func grantedLogins() throws -> [String] { try fixture.withUnlocked { $0.grants.map(\.loginId) } }
    func edit(_ change: (inout Item) throws -> Void) throws {
      try fixture.withUnlocked { unlocked in
        var item = try unlocked.item(id: id)
        try change(&item)
        try unlocked.update(item)
      }
    }
    try fixture.withUnlocked { _ = try $0.commit(VaultChanges(grant: [Self.grant(3, .saved(id: other))])) }
    try allow()
    XCTAssertEqual(try grantedLogins(), [id, id, other])

    try edit { $0.password = "a-new-password" }
    try edit { $0.label = "Work" }
    try edit { $0.totp = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP") }
    try fixture.withUnlocked {
      _ = try $0.commit(VaultChanges(replace: [CredentialReplacement(itemID: id, password: "imported", totp: nil)]))
    }
    XCTAssertEqual(try grantedLogins(), [id, id, other], "kept: it still signs in to the same place as the same account")

    let repoints: [(String, (inout Item) -> Void)] = [
      ("username", { $0.username = "alice@example.org" }),
      ("login URL", { $0.loginURL = "https://example.com/other-login" }),
      ("origins", { $0.origins = ["https://example.com", "https://login.example.com"] }),
    ]
    for (what, change) in repoints {
      try edit(change)
      XCTAssertEqual(try grantedLogins(), [other], "a \(what) change drops the login's grants and only those")
      try allow()
    }
    try fixture.withUnlocked { try $0.delete(ids: [id]) }
    XCTAssertEqual(try grantedLogins(), [other], "deleting the login drops its grants")
  }
}
