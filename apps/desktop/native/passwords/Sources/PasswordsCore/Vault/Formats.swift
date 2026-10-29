import CryptoKit
import Foundation

/// A content-addressed encrypted object: a payload sealed under a fresh data
/// key, and that data key sealed under the epoch key.
///
/// Stored as canonical `{"ct","keyCt","keyNonce","nonce","v":1}`.
struct SealedObject {
  let payload: AEAD.Box
  let wrappedKey: AEAD.Box

  static func seal(_ plaintext: Data, epochKey: SymmetricKey, binding: JSONValue, keyBinding: JSONValue) throws -> Data {
    let dataKey = SymmetricKey(size: .bits256)
    let payload = try AEAD.seal(plaintext, key: dataKey, aad: binding)
    var keyBytes = dataKey.rawBytes
    defer { keyBytes.wipe() }
    let wrappedKey = try AEAD.seal(keyBytes, key: epochKey, aad: keyBinding)
    return try SealedObject(payload: payload, wrappedKey: wrappedKey).bytes()
  }

  static func open(_ bytes: Data, hash: String, epochKey: SymmetricKey, binding: JSONValue, keyBinding: JSONValue) throws -> Data {
    let object = try parse(bytes, hash: hash)
    do {
      var dataKey = try AEAD.open(object.wrappedKey, key: epochKey, aad: keyBinding)
      defer { dataKey.wipe() }
      guard dataKey.count == 32 else { throw VaultError.corruptObject(hash) }
      return try AEAD.open(object.payload, key: SymmetricKey(data: dataKey), aad: binding)
    } catch is CryptoError {
      throw VaultError.corruptObject(hash)
    }
  }

  /// Checks the structure only; decryption needs the epoch key.
  static func parse(_ bytes: Data, hash: String) throws -> SealedObject {
    do {
      let value = try CanonicalJSON.parseCanonical(bytes)
      if let version = formatVersion(of: value), version > 1 { throw VaultError.unsupportedVersion }
      guard formatVersion(of: value) == 1 else { throw VaultError.corruptObject(hash) }
      let object = try StrictObject(value, keys: ["ct", "keyCt", "keyNonce", "nonce", "v"], context: "object")
      let payload = AEAD.Box(nonce: try object.bytes("nonce"), ciphertext: try object.bytes("ct"))
      let wrappedKey = AEAD.Box(nonce: try object.bytes("keyNonce"), ciphertext: try object.bytes("keyCt"))
      guard payload.nonce.count == AEAD.nonceSize, wrappedKey.nonce.count == AEAD.nonceSize,
        payload.ciphertext.count >= AEAD.tagSize, wrappedKey.ciphertext.count == 32 + AEAD.tagSize
      else { throw VaultError.corruptObject(hash) }
      return SealedObject(payload: payload, wrappedKey: wrappedKey)
    } catch is JSONError {
      throw VaultError.corruptObject(hash)
    }
  }

  func bytes() throws -> Data {
    try CanonicalJSON.encode(.object([
      "ct": .string(Base64URL.encode(payload.ciphertext)),
      "keyCt": .string(Base64URL.encode(wrappedKey.ciphertext)),
      "keyNonce": .string(Base64URL.encode(wrappedKey.nonce)),
      "nonce": .string(Base64URL.encode(payload.nonce)),
      "v": .integer(1),
    ]))
  }
}

/// AAD bindings. Each names its purpose, so no ciphertext can stand in for
/// another kind, and binds the vault, epoch and position it belongs to.
enum Bindings {
  static func item(vaultId: String, epoch: Int64, itemId: String, revision: Int64, purpose: String) -> JSONValue {
    .object([
      "epoch": .integer(epoch), "itemId": .string(itemId), "purpose": .string(purpose),
      "revision": .integer(revision), "v": .integer(1), "vaultId": .string(vaultId),
    ])
  }

  static func manifest(vaultId: String, epoch: Int64, seq: Int64, purpose: String) -> JSONValue {
    .object([
      "epoch": .integer(epoch), "purpose": .string(purpose), "seq": .integer(seq),
      "v": .integer(1), "vaultId": .string(vaultId),
    ])
  }

  static func epochKey(vaultId: String, epoch: Int64) -> JSONValue {
    .object(["epoch": .integer(epoch), "purpose": .string("epoch-key"), "v": .integer(1), "vaultId": .string(vaultId)])
  }
}

struct ManifestEntry: Sendable, Equatable {
  let id: String
  let revision: Int64
  let hash: String
}

/// The encrypted list of current item revisions, sorted by ID, and the
/// grants, sorted by key. Version 2: version 1 had no grants.
struct Manifest {
  static let version: Int64 = 2

  let vaultId: String
  let seq: Int64
  let items: [ManifestEntry]
  let grants: [Grant]

  func seal(epochKey: SymmetricKey, epoch: Int64) throws -> Data {
    let plaintext = try CanonicalJSON.encode(.object([
      "grants": .array(grants.map(\.json)),
      "items": .array(items.map { .object(["hash": .string($0.hash), "id": .string($0.id), "revision": .integer($0.revision)]) }),
      "seq": .integer(seq),
      "v": .integer(Self.version),
      "vaultId": .string(vaultId),
    ]))
    return try SealedObject.seal(
      plaintext,
      epochKey: epochKey,
      binding: Bindings.manifest(vaultId: vaultId, epoch: epoch, seq: seq, purpose: "manifest"),
      keyBinding: Bindings.manifest(vaultId: vaultId, epoch: epoch, seq: seq, purpose: "manifest-key")
    )
  }

  static func open(_ bytes: Data, hash: String, epochKey: SymmetricKey, vaultId: String, epoch: Int64, seq: Int64) throws -> Manifest {
    let plaintext: Data
    do {
      plaintext = try SealedObject.open(
        bytes, hash: hash, epochKey: epochKey,
        binding: Bindings.manifest(vaultId: vaultId, epoch: epoch, seq: seq, purpose: "manifest"),
        keyBinding: Bindings.manifest(vaultId: vaultId, epoch: epoch, seq: seq, purpose: "manifest-key")
      )
    } catch VaultError.corruptObject {
      throw VaultError.decryptionFailed
    }
    do {
      let value = try CanonicalJSON.parseCanonical(plaintext)
      if let found = formatVersion(of: value), found > version { throw VaultError.unsupportedVersion }
      guard formatVersion(of: value) == version else { throw VaultError.corruptObject(hash) }
      let object = try StrictObject(value, keys: ["grants", "items", "seq", "v", "vaultId"], context: "manifest")
      guard try object.string("vaultId") == vaultId, try object.integer("seq") == seq else { throw VaultError.corruptObject(hash) }
      let entries = try object.array("items").map { value -> ManifestEntry in
        let entry = try StrictObject(value, keys: ["hash", "id", "revision"], context: "manifest entry")
        let item = ManifestEntry(id: try entry.string("id"), revision: try entry.integer("revision"), hash: try entry.string("hash"))
        guard VaultIDs.isUUID(item.id), item.revision >= 1, Hex.isSHA256(item.hash) else { throw VaultError.corruptObject(hash) }
        return item
      }
      guard entries.count <= VaultLimits.maxItems else { throw VaultError.tooManyItems }
      for (previous, next) in zip(entries, entries.dropFirst()) where !previous.id.utf8.lexicographicallyPrecedes(next.id.utf8) {
        throw VaultError.corruptObject(hash)
      }
      let grants: [Grant]
      do {
        grants = try object.array("grants").map(Grant.init(json:))
        try checkGrants(grants, items: entries)
      } catch is VaultError {
        throw VaultError.corruptObject(hash)
      }
      return Manifest(vaultId: vaultId, seq: seq, items: entries, grants: grants)
    } catch is JSONError {
      throw VaultError.corruptObject(hash)
    }
  }

  /// What every manifest's grants hold to, written or read: at most
  /// `maxGrants`, strictly in key order (so one per key), each for a login
  /// the manifest lists.
  static func checkGrants(_ grants: [Grant], items: [ManifestEntry]) throws {
    guard grants.count <= VaultLimits.maxGrants else { throw VaultError.tooManyGrants }
    for (previous, next) in zip(grants, grants.dropFirst()) where !previous.key.precedes(next.key) {
      throw VaultError.invalidGrant("grants repeat or are out of order")
    }
    let ids = Set(items.map(\.id))
    for grant in grants where !ids.contains(grant.loginId) {
      throw VaultError.invalidGrant("a grant names a login that is not saved")
    }
  }
}

enum ItemCodec {
  static func seal(_ item: Item, vaultId: String, epoch: Int64, revision: Int64, epochKey: SymmetricKey) throws -> Data {
    var plaintext = try CanonicalJSON.encode(item.json)
    defer { plaintext.wipe() }
    return try SealedObject.seal(
      plaintext,
      epochKey: epochKey,
      binding: Bindings.item(vaultId: vaultId, epoch: epoch, itemId: item.id, revision: revision, purpose: "item"),
      keyBinding: Bindings.item(vaultId: vaultId, epoch: epoch, itemId: item.id, revision: revision, purpose: "item-key")
    )
  }

  static func open(_ bytes: Data, entry: ManifestEntry, vaultId: String, epoch: Int64, epochKey: SymmetricKey) throws -> Item {
    var plaintext = try SealedObject.open(
      bytes, hash: entry.hash, epochKey: epochKey,
      binding: Bindings.item(vaultId: vaultId, epoch: epoch, itemId: entry.id, revision: entry.revision, purpose: "item"),
      keyBinding: Bindings.item(vaultId: vaultId, epoch: epoch, itemId: entry.id, revision: entry.revision, purpose: "item-key")
    )
    defer { plaintext.wipe() }
    let item: Item
    do {
      item = try Item(json: try CanonicalJSON.parseCanonical(plaintext), revision: entry.revision)
    } catch VaultError.unsupportedVersion {
      throw VaultError.unsupportedVersion
    } catch {
      throw VaultError.corruptObject(entry.hash)
    }
    guard item.id == entry.id else { throw VaultError.corruptObject(entry.hash) }
    return item
  }
}
