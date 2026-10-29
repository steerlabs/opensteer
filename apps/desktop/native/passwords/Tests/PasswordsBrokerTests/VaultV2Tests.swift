import CryptoKit
import XCTest
@testable import PasswordsCore
@testable import PasswordsBrokerKit

@MainActor
final class VaultV2Tests: BrokerTestCase {
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


  func seed(manifestVersion: Int64 = 2) async throws {
    try await harness.ready()
    let owner = try harness.keys.load(from: harness.protected)
    let vault = try Vault.open(root: harness.paths.vault, protectedStore: harness.protected)
    _ = try install(payload(), in: vault, owner: owner, store: harness.protected, manifestVersion: manifestVersion)
    await broker.reload()
  }

  func testPasswordlessExcludedFromAgentSignIn() async throws {
    try await seed()
    XCTAssertEqual(broker.condition, .ready)
    let client = try await harness.client()
    same(try await client.call("signin.probe", Fixtures.probe()).result,
      .object(["passwords": .string("no-login")]))
    let result = try await client.call("signin.request", Fixtures.request()).result
    same(result?["decision"], .string("approve"))
    same(result?["accounts"], .array([]))
    let summaries = try await harness.vault.summaries(Authentication(reason: "test"))
    XCTAssertEqual(summaries.count, 1)
    let key = GrantKey(deploymentId: "d", workspaceId: "w", site: "https://example.com")
    let lookup = try await harness.vault.lookUp(withinSite: "https://example.com", grant: key, permissionVersion: 4)
    guard case .choose(let accounts) = lookup else { return XCTFail("passwordless login granted") }
    XCTAssertTrue(accounts.isEmpty)
  }

  func testNewerManifestRequiresUpdateWithoutReset() async throws {
    try await seed(manifestVersion: 3)
    XCTAssertEqual(String(describing: broker.condition), "updateRequired")
    XCTAssertNil(broker.status)
    let client = try await harness.client()
    same(try await client.call("signin.probe", Fixtures.probe()).result,
      .object(["passwords": .string("unavailable")]))
    same(try await client.call("status"), .error(code: "unavailable", message: "Update Opensteer to use the passwords saved by a newer version."))
    do { try await broker.startFresh(); XCTFail("reset offered") } catch {}
    XCTAssertTrue(Vault.exists(at: harness.paths.vault))
  }
}
