import CryptoKit
import XCTest
@testable import PasswordsCore

final class ItemV2Tests: XCTestCase {
  func payload() -> JSONValue {
    let key = P256.Signing.PrivateKey()
    let passkey: JSONValue = .object([
      "algorithm": .integer(-7), "createdAt": .integer(1),
      "credentialId": .string(Base64URL.encode(Data(repeating: 1, count: 16))),
      "privateKey": .string(Base64URL.encode(key.derRepresentation)), "rpId": .string("example.com"),
      "userDisplayName": .string(""), "userHandle": .string("AQ"), "userName": .string(""), "v": .integer(1),
    ])
    let json: JSONValue = .object([
      "createdAt": .integer(1), "id": .string("00000000-0000-0000-0000-000000000001"),
      "label": .null, "loginURL": .string("https://example.com/"),
      "origins": .array([.string("https://example.com")]), "passkeys": .array([passkey]),
      "password": .null, "totp": .null, "updatedAt": .integer(1), "username": .string(""), "v": .integer(2),
    ])
    return json
  }

  func testV2Reader() throws {
    let json = payload()
    let item = try Item(json: json, revision: 1)
    XCTAssertEqual(try CanonicalJSON.encode(item.json), try CanonicalJSON.encode(json))
  }

  func replacing(_ value: JSONValue, _ key: String, _ replacement: JSONValue) -> JSONValue {
    guard case .object(var fields) = value else { fatalError() }
    fields[key] = replacement
    return .object(fields)
  }

  func testValidationRefusals() throws {
    let json = payload()
    guard case .array(let keys)? = json["passkeys"], let key = keys.first else { return XCTFail() }
    let invalid: [(String, JSONValue)] = [
      ("algorithm", .integer(-257)), ("v", .integer(2)),
      ("credentialId", .string(Base64URL.encode(Data(repeating: 0, count: 15)))),
      ("credentialId", .string(Base64URL.encode(Data(repeating: 0, count: 1024)))),
      ("credentialId", .string("AQ==")),
      ("userHandle", .string("")), ("userHandle", .string(Base64URL.encode(Data(repeating: 0, count: 65)))),
      ("privateKey", .string("AQ")), ("privateKey", .string("AQ==")),
      ("userName", .string(String(repeating: "é", count: 513))),
      ("userDisplayName", .string(String(repeating: "x", count: 1025))),
      ("createdAt", .string("1")),
    ]
    for (field, value) in invalid {
      XCTAssertThrowsError(try Item(json: replacing(json, "passkeys", .array([replacing(key, field, value)])), revision: 1), field)
    }
    for rpId in ["EXAMPLE.com", "127.0.0.1", "localhost", "com", "example.com.", "xn--invalid-.com", "example.org", "example.com:443", "example.com/path"] {
      let item = try Item(json: replacing(json, "passkeys", .array([replacing(key, "rpId", .string(rpId))])), revision: 1)
      XCTAssertThrowsError(try item.validate(), rpId)
    }
    for keys in [[], [key, key], Array(repeating: key, count: 9)] {
      XCTAssertThrowsError(try Item(json: replacing(json, "passkeys", .array(keys)), revision: 1))
    }
    let anotherID = replacing(key, "credentialId", .string(Base64URL.encode(Data(repeating: 2, count: 16))))
    let anotherHandle = replacing(key, "userHandle", .string("Ag"))
    for other in [anotherID, anotherHandle] {
      XCTAssertThrowsError(try Item(json: replacing(json, "passkeys", .array([key, other])), revision: 1))
    }
    for password in ["", String(repeating: "x", count: 4097)] {
      XCTAssertThrowsError(try Item(json: replacing(json, "password", .string(password)), revision: 1))
    }
  }

  func testPasskeySiteRuleChangeRefusesValidation() throws {
    let item = try Item(json: payload(), revision: 1)
    let passkey = try XCTUnwrap(item.passkeys.first)
    try passkey.validate(origins: item.origins, siteOfOrigin: { _ in "old-site" })
    XCTAssertThrowsError(try passkey.validate(origins: item.origins, siteOfOrigin: { _ in nil }))
    let decoded = try Item(json: item.json, revision: 1)
    XCTAssertEqual(decoded.passkeys.count, 1)
  }

  func testSavedPasskeyWithChangedDomainRulesRemainsReadable() throws {
    let json = payload()
    guard case .array(let keys)? = json["passkeys"], let key = keys.first else { return XCTFail() }
    for rpId in ["com", "example.net"] {
      let stale = replacing(json, "passkeys", .array([replacing(key, "rpId", .string(rpId))]))
      let fixture = try VaultFixture()
      _ = try install(stale, in: fixture.open(), owner: fixture.owner, store: fixture.protected)
      try fixture.withUnlocked { unlocked in
        let item = try XCTUnwrap(unlocked.items().first)
        XCTAssertEqual(item.passkeys.first?.rpId, rpId)
        XCTAssertEqual(try unlocked.items(withinSite: "https://example.com").count, 1)
        XCTAssertThrowsError(try unlocked.update(item))
        _ = try unlocked.add([draft("example.org")])
        XCTAssertEqual(try unlocked.items().count, 2)
        XCTAssertEqual(try unlocked.items(withinSite: "https://example.org").count, 1)
      }
    }
  }

  func testV1EncodingUnchanged() throws {
    let v2 = replacing(replacing(payload(), "passkeys", .array([])), "password", .string("secret"))
    guard case .object(var fields) = v2 else { return XCTFail() }
    fields.removeValue(forKey: "passkeys")
    fields["v"] = .integer(1)
    let bytes = try CanonicalJSON.encode(.object(fields))
    XCTAssertEqual(try CanonicalJSON.encode(Item(json: v2, revision: 1).json), bytes)
    XCTAssertEqual(try CanonicalJSON.encode(Item(json: .object(fields), revision: 1).json), bytes)
  }
}

extension ItemV2Tests {
  func install(_ payload: JSONValue, in vault: Vault, owner: any OwnerKeyStore, store: any ProtectedStore, manifestVersion: Int64 = 2) throws -> ManifestEntry {
    let unlocked = try vault.unlock(owner: owner)
    defer { unlocked.close() }
    let epochKey = try XCTUnwrap(unlocked.epochKey)
    let id = "00000000-0000-0000-0000-000000000001"
    let commit = vault.tip.commit
    let object = try SealedObject.seal(CanonicalJSON.encode(payload), epochKey: epochKey,
      binding: Bindings.item(vaultId: commit.vaultId, epoch: commit.epoch, itemId: id, revision: 1, purpose: "item"),
      keyBinding: Bindings.item(vaultId: commit.vaultId, epoch: commit.epoch, itemId: id, revision: 1, purpose: "item-key"))
    let entry = ManifestEntry(id: id, revision: 1, hash: try vault.store.writeObject(object))
    let manifest: JSONValue = .object([
      "grants": .array([]), "items": .array([.object(["id": .string(id), "hash": .string(entry.hash), "revision": .integer(1)])]),
      "seq": .integer(commit.seq + 1), "v": .integer(manifestVersion), "vaultId": .string(commit.vaultId),
    ])
    let bytes = try SealedObject.seal(CanonicalJSON.encode(manifest), epochKey: epochKey,
      binding: Bindings.manifest(vaultId: commit.vaultId, epoch: commit.epoch, seq: commit.seq + 1, purpose: "manifest"),
      keyBinding: Bindings.manifest(vaultId: commit.vaultId, epoch: commit.epoch, seq: commit.seq + 1, purpose: "manifest-key"))
    var next = commit
    next.seq += 1
    next.parent = vault.tip.hash
    next.manifest = try vault.store.writeObject(bytes)
    next.signature = try Vault.sign(next, owner: owner)
    try vault.store.writeCommit(next.seq, next.bytes())
    // Opening adopts the signed child and pins it by the ordinary crash-recovery path.
    _ = try Vault.open(root: vault.root, protectedStore: store)
    return entry
  }

  func testPreservationAndOriginEdit() throws {
    let fixture = try VaultFixture()
    _ = try install(payload(), in: fixture.open(), owner: fixture.owner, store: fixture.protected)
    let saved = try XCTUnwrap(fixture.items().first)
    let keys = try CanonicalJSON.encode(.array(saved.passkeys.map(\.json)))
    try fixture.withUnlocked { unlocked in
      _ = try unlocked.add([draft("example.org")])
    }
    try fixture.withUnlocked { unlocked in
      var item = try unlocked.item(id: saved.id)
      item.label = "Renamed"
      item.username = "changed"
      try unlocked.update(item)
    }
    try fixture.withUnlocked { unlocked in
      _ = try unlocked.commit(VaultChanges(replace: [CredentialReplacement(itemID: saved.id, password: "replacement", totp: nil)]))
    }
    try fixture.withUnlocked { unlocked in
      let grant = GrantChange(key: GrantKey(deploymentId: "d", workspaceId: "w", site: "https://example.com"), login: .saved(id: saved.id), deploymentName: "D", workspaceName: "W")
      _ = try unlocked.commit(VaultChanges(grant: [grant]))
    }
    let edited = try XCTUnwrap(fixture.items().first { $0.id == saved.id })
    XCTAssertEqual(try CanonicalJSON.encode(.array(edited.passkeys.map(\.json))), keys)
    try fixture.withUnlocked { unlocked in
      var item = try unlocked.item(id: saved.id)
      item.origins = ["https://example.org"]
      item.loginURL = "https://example.org/"
      XCTAssertThrowsError(try unlocked.update(item))
    }
  }

  func testNewerItemSkippedAndPreserved() throws {
    let fixture = try VaultFixture()
    let entry = try install(.object(["v": .integer(3), "future": .string("opaque")]), in: fixture.open(), owner: fixture.owner, store: fixture.protected)
    let bytes = try Data(contentsOf: fixture.objectsURL.appendingPathComponent(entry.hash))
    try fixture.withUnlocked { unlocked in
      XCTAssertTrue(try unlocked.items().isEmpty)
      XCTAssertTrue(try unlocked.items(withinSite: "https://example.com").isEmpty)
      XCTAssertThrowsError(try unlocked.commit(VaultChanges(replace: [CredentialReplacement(itemID: entry.id, password: "new", totp: nil)])))
      _ = try unlocked.add([draft()])
    }
    try fixture.withUnlocked { unlocked in
      XCTAssertTrue(unlocked.entries.contains(entry))
      XCTAssertEqual(try unlocked.items().count, 1)
    }
    XCTAssertEqual(try Data(contentsOf: fixture.objectsURL.appendingPathComponent(entry.hash)), bytes)
  }
}
