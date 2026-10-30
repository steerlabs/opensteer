import CryptoKit
import XCTest
import PasswordsTestSupport
@testable import PasswordsCore

/// A hostile store: every change to the vault folder must make open or
/// unlock fail, never be repaired or skipped.
final class VaultTamperTests: XCTestCase {
  /// A vault at seq 2 with two items.
  private func makeFixture() throws -> VaultFixture {
    let fixture = try VaultFixture(items: [draft("a.example.com")])
    try fixture.withUnlocked { try $0.add([draft("b.example.com")]) }
    return fixture
  }

  /// A child of `parentSeq`, signed by `signer` after `mutate`.
  private func forgeChild(
    _ fixture: VaultFixture,
    of parentSeq: Int,
    signer: P256.Signing.PrivateKey,
    mutate: (inout Commit) throws -> Void = { _ in }
  ) throws -> Data {
    let parentBytes = try Data(contentsOf: fixture.commitURL(parentSeq))
    var commit = try Commit.parse(parentBytes, expectedSeq: Int64(parentSeq))
    commit.seq += 1
    commit.parent = Hex.sha256(parentBytes)
    commit.signer = KeyID.of(signer.publicKey)
    try mutate(&commit)
    commit.signature = try ECDSA.normalizedLowS(try signer.signature(for: try commit.signedBytes()).rawRepresentation)
    return try commit.bytes()
  }

  private func setHead(_ fixture: VaultFixture, commit bytes: Data, seq: Int64) throws {
    try HeadPointer(hash: Hex.sha256(bytes), seq: seq).bytes().write(to: fixture.headURL)
  }

  private func entries(_ fixture: VaultFixture) throws -> [ManifestEntry] {
    try fixture.withUnlocked { $0.entries }
  }

  private func flipByte(_ url: URL, at index: Int = 10) throws {
    var data = try Data(contentsOf: url)
    data[index] ^= 0x01
    try data.write(to: url)
  }

  func testTamperedObjectRejected() throws {
    let fixture = try makeFixture()
    let entry = try XCTUnwrap(try entries(fixture).first)
    try flipByte(fixture.objectsURL.appendingPathComponent(entry.hash))
    XCTAssertThrowsVaultError(.corruptObject(entry.hash), try fixture.open().unlock(owner: fixture.owner))

    let manifest = try fixture.open().tip.commit.manifest
    try flipByte(fixture.objectsURL.appendingPathComponent(manifest))
    XCTAssertThrowsVaultError(.corruptObject(manifest), try fixture.open())
  }

  func testMissingObjectRejected() throws {
    let fixture = try makeFixture()
    let entry = try XCTUnwrap(try entries(fixture).last)
    try FileManager.default.removeItem(at: fixture.objectsURL.appendingPathComponent(entry.hash))
    XCTAssertNoThrow(try fixture.open(), "opening checks public data only")
    XCTAssertThrowsVaultError(.missingObject(entry.hash), try fixture.open().unlock(owner: fixture.owner))
  }

  func testMissingManifestRejected() throws {
    let fixture = try makeFixture()
    let manifest = try fixture.open().tip.commit.manifest
    try FileManager.default.removeItem(at: fixture.objectsURL.appendingPathComponent(manifest))
    XCTAssertThrowsVaultError(.missingObject(manifest), try fixture.open())
  }

  func testObjectSwappedBetweenItemsRejected() throws {
    let fixture = try makeFixture()
    let unlocked = try fixture.open().unlock(owner: fixture.owner)
    defer { unlocked.close() }
    let key = try XCTUnwrap(unlocked.epochKey)
    let vaultId = unlocked.head.vaultId
    let (a, b) = (unlocked.entries[0], unlocked.entries[1])
    let bBytes = try Data(contentsOf: fixture.objectsURL.appendingPathComponent(b.hash))

    XCTAssertNoThrow(try ItemCodec.open(bBytes, entry: b, vaultId: vaultId, epoch: 0, epochKey: key))
    let wrongBindings = [
      ManifestEntry(id: a.id, revision: b.revision, hash: b.hash),
      ManifestEntry(id: b.id, revision: b.revision + 1, hash: b.hash),
    ]
    for entry in wrongBindings {
      XCTAssertThrowsVaultError(.corruptObject(b.hash), try ItemCodec.open(bBytes, entry: entry, vaultId: vaultId, epoch: 0, epochKey: key))
    }
    XCTAssertThrowsVaultError(.corruptObject(b.hash), try ItemCodec.open(bBytes, entry: b, vaultId: vaultId, epoch: 1, epochKey: key))
    XCTAssertThrowsVaultError(.corruptObject(b.hash), try ItemCodec.open(
      bBytes, entry: b, vaultId: "16fd2706-8baf-433b-82eb-8c7fada847da", epoch: 0, epochKey: key))
    XCTAssertThrowsVaultError(.corruptObject(b.hash), try ItemCodec.open(
      bBytes, entry: b, vaultId: vaultId, epoch: 0, epochKey: SymmetricKey(size: .bits256)))

    // On disk the hash check catches the swap first.
    try bBytes.write(to: fixture.objectsURL.appendingPathComponent(a.hash))
    XCTAssertThrowsVaultError(.corruptObject(a.hash), try fixture.open().unlock(owner: fixture.owner))
  }

  func testTamperedCommitRejected() throws {
    let fixture = try makeFixture()
    var commit = try fixture.commitJSON(1)
    guard case .integer(let createdAt)? = commit["createdAt"] else { return XCTFail() }
    commit["createdAt"] = .integer(createdAt + 1)
    try fixture.writeCommitJSON(1, commit)
    XCTAssertThrowsVaultError(.badSignature(seq: 1), try fixture.open())

    let other = try makeFixture()
    var genesis = try other.commitJSON(0)
    guard case .object(var membership)? = genesis["membership"], case .array(var owners)? = membership["owners"],
      case .object(var owner) = owners[0] else { return XCTFail() }
    owner["deviceName"] = .string("Attacker Mac")
    owners[0] = .object(owner)
    membership["owners"] = .array(owners)
    genesis["membership"] = .object(membership)
    try other.writeCommitJSON(0, genesis)
    XCTAssertThrowsVaultError(.badSignature(seq: 0), try other.open())
  }

  func testNonCanonicalCommitRejected() throws {
    let fixture = try makeFixture()
    var text = String(decoding: try Data(contentsOf: fixture.commitURL(1)), as: UTF8.self)
    text = text.replacingOccurrences(of: ",\"epoch\":", with: ", \"epoch\":")
    try Data(text.utf8).write(to: fixture.commitURL(1))
    XCTAssertThrowsVaultError(.corruptCommit(seq: 1, reason: "not canonical JSON"), try fixture.open())
  }

  func testForgedSignatureRejected() throws {
    let fixture = try makeFixture()
    let bytes = try Data(contentsOf: fixture.commitURL(1))
    var commit = try Commit.parse(bytes, expectedSeq: 1)
    commit.signature = try ECDSA.normalizedLowS(try P256.Signing.PrivateKey().signature(for: try commit.signedBytes()).rawRepresentation)
    try commit.bytes().write(to: fixture.commitURL(1))
    XCTAssertThrowsVaultError(.badSignature(seq: 1), try fixture.open())

    commit.signature = Data(repeating: 0x11, count: 64)
    try commit.bytes().write(to: fixture.commitURL(1))
    XCTAssertThrowsVaultError(.badSignature(seq: 1), try fixture.open())
  }

  func testMalleatedSignatureRejected() throws {
    let fixture = try makeFixture()
    var commit = try Commit.parse(try Data(contentsOf: fixture.commitURL(1)), expectedSeq: 1)
    commit.signature = try CryptoTests.negateS(commit.signature)
    XCTAssertTrue(fixture.owner.signingPublicKey.isValidSignature(
      try P256.Signing.ECDSASignature(rawRepresentation: commit.signature), for: try commit.signedBytes()))
    try commit.bytes().write(to: fixture.commitURL(1))
    XCTAssertThrowsVaultError(.badSignature(seq: 1), try fixture.open())
  }

  func testSignerOutsideMembershipRejected() throws {
    let fixture = try makeFixture()
    let outsider = P256.Signing.PrivateKey()
    let forged = try forgeChild(fixture, of: 2, signer: outsider)
    try forged.write(to: fixture.commitURL(3))
    XCTAssertThrowsVaultError(.unauthorizedSigner(seq: 3), try fixture.open())
    try setHead(fixture, commit: forged, seq: 3)
    XCTAssertThrowsVaultError(.unauthorizedSigner(seq: 3), try fixture.open())

    // Listing itself as an owner does not help: authority comes from the parent.
    let impostor = SoftwareOwnerKeyStore()
    let selfListed = try forgeChild(fixture, of: 2, signer: impostor.signingKey) { commit in
      let member = VaultOwner(deviceName: "Impostor", agreementPublicKey: impostor.agreementPublicKey, signingPublicKey: impostor.signingPublicKey)
      commit.owners = [member]
      commit.epoch += 1
      commit.envelopes = [try EpochEnvelope.seal(SymmetricKey(size: .bits256), to: member, vaultId: commit.vaultId, epoch: commit.epoch)]
    }
    try selfListed.write(to: fixture.commitURL(3))
    try setHead(fixture, commit: selfListed, seq: 3)
    XCTAssertThrowsVaultError(.unauthorizedSigner(seq: 3), try fixture.open())
  }

  func testGenesisSignedByNonMemberRejected() throws {
    let fixture = try VaultFixture()
    var genesis = try Commit.parse(try Data(contentsOf: fixture.commitURL(0)), expectedSeq: 0)
    let outsider = P256.Signing.PrivateKey()
    genesis.signer = KeyID.of(outsider.publicKey)
    genesis.signature = try ECDSA.normalizedLowS(try outsider.signature(for: try genesis.signedBytes()).rawRepresentation)
    try genesis.bytes().write(to: fixture.commitURL(0))
    XCTAssertThrowsVaultError(.unauthorizedSigner(seq: 0), try fixture.open())
  }

  func testBrokenParentChainRejected() throws {
    let fixture = try makeFixture()
    let wrongParent = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { $0.parent = Hex.sha256(Data("x".utf8)) }
    try wrongParent.write(to: fixture.commitURL(3))
    XCTAssertThrowsVaultError(.brokenChain(seq: 3), try fixture.open())

    let otherVault = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { $0.vaultId = "16fd2706-8baf-433b-82eb-8c7fada847da" }
    try otherVault.write(to: fixture.commitURL(3))
    XCTAssertThrowsVaultError(.brokenChain(seq: 3), try fixture.open())

    let wrongSeq = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { $0.seq = 4 }
    try wrongSeq.write(to: fixture.commitURL(3))
    XCTAssertThrowsVaultError(.corruptCommit(seq: 3, reason: "sequence number does not match the file name"), try fixture.open())
  }

  func testMissingCommitRejected() throws {
    let fixture = try makeFixture()
    try FileManager.default.removeItem(at: fixture.commitURL(1))
    XCTAssertThrowsVaultError(.missingCommit(seq: 1), try fixture.open())
    let other = try makeFixture()
    try FileManager.default.removeItem(at: other.commitURL(2))
    XCTAssertThrowsVaultError(.missingCommit(seq: 2), try other.open())
  }

  func testEnvelopeForNonMemberRejected() throws {
    let fixture = try makeFixture()
    let outsider = VaultOwner(SoftwareOwnerKeyStore(), deviceName: "Outsider")
    let extra = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { commit in
      commit.envelopes.append(try EpochEnvelope.seal(SymmetricKey(size: .bits256), to: outsider, vaultId: commit.vaultId, epoch: commit.epoch))
      commit.envelopes.sort { $0.recipient < $1.recipient }
    }
    try extra.write(to: fixture.commitURL(3))
    XCTAssertThrowsError(try fixture.open()) { error in
      guard case .corruptCommit(seq: 3, _)? = error as? VaultError else { return XCTFail("\(error)") }
    }
    let missing = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { $0.envelopes = [] }
    try missing.write(to: fixture.commitURL(3))
    XCTAssertThrowsError(try fixture.open()) { error in
      guard case .corruptCommit(seq: 3, _)? = error as? VaultError else { return XCTFail("\(error)") }
    }
  }

  func testRemovingOwnerWithoutNewEpochRejected() throws {
    let fixture = try makeFixture()
    let second = VaultOwner(SoftwareOwnerKeyStore(), deviceName: "Second Mac")
    let added = try forgeChild(fixture, of: 2, signer: fixture.owner.signingKey) { commit in
      commit.owners.append(second)
      commit.envelopes = try commit.owners.map { try EpochEnvelope.seal(SymmetricKey(size: .bits256), to: $0, vaultId: commit.vaultId, epoch: commit.epoch) }
        .sorted { $0.recipient < $1.recipient }
    }
    try added.write(to: fixture.commitURL(3))
    try setHead(fixture, commit: added, seq: 3)
    XCTAssertEqual(try fixture.open().head.owners.count, 2, "adding an owner keeps the epoch")

    func removal(epochDelta: Int64) throws -> Data {
      try forgeChild(fixture, of: 3, signer: fixture.owner.signingKey) { commit in
        commit.owners.removeLast()
        commit.epoch += epochDelta
        commit.envelopes = try commit.owners.map { try EpochEnvelope.seal(SymmetricKey(size: .bits256), to: $0, vaultId: commit.vaultId, epoch: commit.epoch) }
      }
    }
    for delta: Int64 in [0, 2] {
      let bytes = try removal(epochDelta: delta)
      try bytes.write(to: fixture.commitURL(4))
      try setHead(fixture, commit: bytes, seq: 4)
      XCTAssertThrowsError(try fixture.open(), "epoch + \(delta)") { error in
        guard case .corruptCommit(seq: 4, _)? = error as? VaultError else { return XCTFail("\(error)") }
      }
    }
    let rotated = try removal(epochDelta: 1)
    try rotated.write(to: fixture.commitURL(4))
    try setHead(fixture, commit: rotated, seq: 4)
    XCTAssertEqual(try fixture.open().head.epoch, 1)
  }

  func testCorruptHeadRejected() throws {
    let fixture = try makeFixture()
    let good = try Data(contentsOf: fixture.headURL)
    let hash = try fixture.open().head.hash
    let variants: [String] = [
      "garbage",
      "{\"hash\": \"\(hash)\",\"seq\":2}",
      "{\"extra\":1,\"hash\":\"\(hash)\",\"seq\":2}",
      "{\"hash\":\"\(hash.uppercased())\",\"seq\":2}",
      "{\"hash\":\"\(hash)\",\"seq\":-1}",
      "{\"hash\":\"\(hash)\"}",
    ]
    for variant in variants {
      try Data(variant.utf8).write(to: fixture.headURL)
      XCTAssertThrowsVaultError(.corruptHead, try fixture.open())
    }
    try FileManager.default.removeItem(at: fixture.headURL)
    XCTAssertThrowsVaultError(.headMissing, try fixture.open())
    try good.write(to: fixture.headURL)
    XCTAssertNoThrow(try fixture.open())
  }

  func testHeadHashMismatchRejected() throws {
    let fixture = try makeFixture()
    try HeadPointer(hash: Hex.sha256(Data("x".utf8)), seq: 2).bytes().write(to: fixture.headURL)
    XCTAssertThrowsVaultError(.headMismatch, try fixture.open())
  }

  func testInvalidPendingChildRejected() throws {
    let fixture = try makeFixture()
    let head = try Data(contentsOf: fixture.headURL)
    try Data("not a commit".utf8).write(to: fixture.commitURL(3))
    XCTAssertThrowsVaultError(.corruptCommit(seq: 3, reason: "not canonical JSON"), try fixture.open())
    XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.commitURL(3).path), "never deleted")
    XCTAssertEqual(try Data(contentsOf: fixture.headURL), head, "never adopted")
  }

  func testCommitBeyondPendingRejected() throws {
    let fixture = try makeFixture()
    let genesis = try Data(contentsOf: fixture.commitURL(0))
    let vaultId = try fixture.open().head.vaultId
    try setHead(fixture, commit: genesis, seq: 0)
    try fixture.protected.write(.checkpoint, try Checkpoint(vaultId: vaultId, head: HeadPointer(hash: Hex.sha256(genesis), seq: 0)).bytes())
    XCTAssertThrowsVaultError(.unexpectedCommit(seq: 2), try fixture.open())
  }

  func testUnexpectedCommitFileRejected() throws {
    for name in ["notes.txt", "1.json", "00000000000a.json", "0000000000001.json"] {
      let fixture = try makeFixture()
      try Data().write(to: fixture.commitsURL.appendingPathComponent(name))
      XCTAssertThrowsVaultError(.unexpectedFile(name), try fixture.open())
    }
  }

  func testOversizedObjectRejected() throws {
    let fixture = try makeFixture()
    let manifest = try fixture.open().tip.commit.manifest
    try Data(count: VaultStore.maxObjectBytes + 1).write(to: fixture.objectsURL.appendingPathComponent(manifest))
    XCTAssertThrowsVaultError(.corruptObject(manifest), try fixture.open())
  }

  /// C13: a commit signature is over a fixed context and the commit, so a
  /// signature an owner key made for anything else can never pass as one.
  /// (Second review, finding 9.)
  func testCommitSignaturesAreDomainSeparated() throws {
    let fixture = try makeFixture()
    let bytes = try Data(contentsOf: fixture.commitURL(2))
    let commit = try Commit.parse(bytes, expectedSeq: 2)
    let signed = try commit.signedBytes()
    XCTAssertTrue(signed.starts(with: Data("opensteer-passwords commit v1\n".utf8)))
    XCTAssertEqual(signed.dropFirst(30), try CanonicalJSON.encode(commit.unsignedJSON()))
    // The same commit signed over its bare JSON, as the context-free form was.
    var bare = commit
    let message = try CanonicalJSON.encode(commit.unsignedJSON())
    bare.signature = try ECDSA.normalizedLowS(try fixture.owner.signingKey.signature(for: message).rawRepresentation)
    try bare.bytes().write(to: fixture.commitURL(2))
    try setHead(fixture, commit: try bare.bytes(), seq: 2)
    XCTAssertThrowsVaultError(.badSignature(seq: 2), try fixture.open())
  }

  /// V24: HEAD and the checkpoint carry `"v":1` like every other format, so a
  /// later version is refused rather than misread. (Second review, finding 10.)
  func testHeadAndCheckpointCarryAVersion() throws {
    let fixture = try makeFixture()
    let head = try CanonicalJSON.parse(try Data(contentsOf: fixture.headURL))
    XCTAssertEqual(head["v"], .integer(1))
    let pinned = try CanonicalJSON.parse(try XCTUnwrap(try fixture.protected.read(.checkpoint)))
    XCTAssertEqual(pinned["v"], .integer(1))
    guard case .object(var fields) = head else { return XCTFail() }
    fields["v"] = .integer(2)
    try CanonicalJSON.encode(.object(fields)).write(to: fixture.headURL)
    XCTAssertThrowsVaultError(.unsupportedVersion, try fixture.open())
  }

  func testUnknownVersionRejected() throws {
    let fixture = try makeFixture()
    let item = try fixture.items()[0]
    let parent = try Data(contentsOf: fixture.commitURL(2))
    var fields = try fixture.commitJSON(2)
    fields["seq"] = .integer(3)
    fields["parent"] = .string(Hex.sha256(parent))
    fields["v"] = .integer(2)
    fields["signature"] = nil
    let signature = try fixture.owner.signingKey.signature(for: try CanonicalJSON.encode(.object(fields))).rawRepresentation
    fields["signature"] = .string(Base64URL.encode(try ECDSA.normalizedLowS(signature)))
    try fixture.writeCommitJSON(3, fields)
    XCTAssertThrowsVaultError(.unsupportedVersion, try fixture.open())

    let object = try CanonicalJSON.encode(.object(["ct": .string("AA"), "v": .integer(2)]))
    XCTAssertThrowsVaultError(.unsupportedVersion, try SealedObject.parse(object, hash: Hex.sha256(object)))
    guard case .object(var itemFields) = item.json else { return XCTFail() }
    itemFields["v"] = .integer(3)
    XCTAssertThrowsVaultError(.unsupportedVersion, try Item(json: .object(itemFields), revision: 1))
  }
}

// MARK: Grants

extension VaultTamperTests {
  /// V25, V19: a manifest whose grants name a login it does not list, repeat
  /// a key or are out of order is corrupt; a version 1 manifest (no grants)
  /// is refused.
  func testGrantForAMissingLoginRejected() throws {
    let fixture = try VaultFixture(items: [draft()])
    let unlocked = try fixture.open().unlock(owner: fixture.owner)
    defer { unlocked.close() }
    let epochKey = try XCTUnwrap(unlocked.epochKey)
    let vaultId = unlocked.head.vaultId
    let entries = unlocked.entries
    let login = try XCTUnwrap(entries.first).id
    func grant(_ workspace: String, _ loginId: String) -> Grant {
      Grant(
        key: GrantKey(deploymentId: "dep_personal", workspaceId: workspace, site: "https://example.com"), loginId: loginId,
        deploymentName: "Personal", workspaceName: "Main")
    }
    func opens(_ grants: [Grant]) throws -> Manifest {
      let sealed = try Manifest(vaultId: vaultId, seq: 9, items: entries, grants: grants).seal(epochKey: epochKey, epoch: 0)
      return try Manifest.open(sealed, hash: Hex.sha256(sealed), epochKey: epochKey, vaultId: vaultId, epoch: 0, seq: 9)
    }
    let legacy = try opens([grant("wsp_a", login), grant("wsp_b", login)])
    XCTAssertEqual(legacy.grants.count, 2)
    XCTAssertTrue(legacy.grants.allSatisfy { !$0.isCurrentPermission && $0.revision == nil })
    let historical = grant("wsp_a", login)
    XCTAssertEqual(try Grant(json: historical.json).json, historical.json, "legacy encoding is unchanged")
    let migrating = UnlockedVault(vault: try fixture.open(), owner: fixture.owner, epochKey: epochKey, manifest: legacy)
    defer { migrating.close() }
    XCTAssertNil(try migrating.grant(for: historical.key), "old consent never authorizes field filling")
    _ = try migrating.commit(VaultChanges(add: [draft("example.org")]))
    XCTAssertTrue(migrating.grants.isEmpty, "the next write purges all legacy grants")
    XCTAssertTrue(try fixture.withUnlocked { $0.grants.isEmpty }, "the purge survives reopening")
    let bad: [[Grant]] = [
      [grant("wsp_a", "00000000-0000-4000-8000-000000000000")],
      [grant("wsp_a", login), grant("wsp_a", login)],
      [grant("wsp_b", login), grant("wsp_a", login)],
      [grant("wsp_a", "NOT-A-UUID")],
    ]
    for grants in bad {
      XCTAssertThrowsError(try opens(grants)) {
        guard case .corruptObject? = $0 as? VaultError else { return XCTFail("\($0)") }
      }
    }

    let v1 = try CanonicalJSON.encode(.object([
      "items": .array(entries.map { .object(["hash": .string($0.hash), "id": .string($0.id), "revision": .integer($0.revision)]) }),
      "seq": .integer(9), "v": .integer(1), "vaultId": .string(vaultId),
    ]))
    let sealed = try SealedObject.seal(
      v1, epochKey: epochKey, binding: Bindings.manifest(vaultId: vaultId, epoch: 0, seq: 9, purpose: "manifest"),
      keyBinding: Bindings.manifest(vaultId: vaultId, epoch: 0, seq: 9, purpose: "manifest-key"))
    XCTAssertThrowsVaultError(
      .corruptObject(Hex.sha256(sealed)),
      try Manifest.open(sealed, hash: Hex.sha256(sealed), epochKey: epochKey, vaultId: vaultId, epoch: 0, seq: 9))
  }

  /// G12: grants are sealed in the manifest the signed commit names: nothing
  /// on disk reads as one, and a folder rolled back to before the grant is
  /// refused like any other rollback.
  func testGrantsAreSealedInTheSignedManifest() throws {
    let fixture = try VaultFixture(items: [draft()])
    let login = try XCTUnwrap(try fixture.items().first).id
    let snapshot = fixture.directory.appendingPathComponent("snapshot")
    try FileManager.default.copyItem(at: fixture.root, to: snapshot)
    let key = GrantKey(deploymentId: "dep_personal", workspaceId: "wsp_SYNTHETIC-WORKSPACE", site: "https://example.com")
    try fixture.withUnlocked {
      _ = try $0.commit(VaultChanges(grant: [
        GrantChange(key: key, login: .saved(id: login), deploymentName: "SYNTHETIC-DEPLOYMENT", workspaceName: "SYNTHETIC-NAME")
      ]))
    }
    XCTAssertEqual(try fixture.withUnlocked { $0.grants.map(\.key) }, [key])
    let files = try FileManager.default.subpathsOfDirectory(atPath: fixture.root.path)
    for file in files {
      guard let data = FileManager.default.contents(atPath: fixture.root.appendingPathComponent(file).path) else { continue }
      let text = String(decoding: data, as: UTF8.self)
      for secret in ["SYNTHETIC", "dep_personal", "example.com"] {
        XCTAssertFalse(text.contains(secret), "\(secret) readable in \(file)")
      }
    }
    try FileManager.default.removeItem(at: fixture.root)
    try FileManager.default.copyItem(at: snapshot, to: fixture.root)
    XCTAssertThrowsVaultError(.rollbackDetected, try fixture.open())
  }
}
