import CryptoKit
import Foundation

/// An owner device as named in a commit's membership.
public struct VaultOwner: Sendable {
  public let deviceName: String
  public let agreementPublicKey: P256.KeyAgreement.PublicKey
  public let signingPublicKey: P256.Signing.PublicKey
  public var agreementKeyID: String { KeyID.of(agreementPublicKey) }
  public var signingKeyID: String { KeyID.of(signingPublicKey) }

  public init(deviceName: String, agreementPublicKey: P256.KeyAgreement.PublicKey, signingPublicKey: P256.Signing.PublicKey) {
    self.deviceName = deviceName
    self.agreementPublicKey = agreementPublicKey
    self.signingPublicKey = signingPublicKey
  }

  init(_ store: any OwnerKeyStore, deviceName: String) {
    self.init(deviceName: deviceName, agreementPublicKey: store.agreementPublicKey, signingPublicKey: store.signingPublicKey)
  }
}

/// The epoch key sealed to one owner's agreement key.
struct EpochEnvelope {
  let recipient: String
  let sealed: HPKESeal.Sealed

  static func seal(_ epochKey: SymmetricKey, to owner: VaultOwner, vaultId: String, epoch: Int64) throws -> EpochEnvelope {
    var keyBytes = epochKey.rawBytes
    defer { keyBytes.wipe() }
    let sealed = try HPKESeal.seal(
      keyBytes, to: owner.agreementPublicKey,
      info: HPKESeal.epochKeyInfo, aad: Bindings.epochKey(vaultId: vaultId, epoch: epoch))
    return EpochEnvelope(recipient: owner.agreementKeyID, sealed: sealed)
  }

  func keyEnvelope(vaultId: String, epoch: Int64) -> KeyEnvelope {
    KeyEnvelope(sealed: sealed, info: HPKESeal.epochKeyInfo, aad: Bindings.epochKey(vaultId: vaultId, epoch: epoch))
  }
}

/// A signed commit. Canonical JSON:
/// `{"createdAt","envelopes":[{"ct","enc","recipient"}],"epoch","manifest",
///   "membership":{"owners":[{"agreement","deviceName","signing"}]},
///   "parent","seq","signature","signer","v":1,"vaultId"}`.
/// The signature covers `signingContext` followed by the canonical bytes
/// without `signature`; the commit hash covers the full bytes.
struct Commit {
  var createdAt: Int64
  var envelopes: [EpochEnvelope]
  var epoch: Int64
  var manifest: String
  var owners: [VaultOwner]
  var parent: String?
  var seq: Int64
  var signer: String
  var vaultId: String
  var signature: Data

  static let maxBytes = 1 << 20
  /// Domain separation: an owner signing key signs nothing but commits, and
  /// a signature made for any other message can never pass as one.
  static let signingContext = Data("opensteer-passwords commit v1\n".utf8)

  func unsignedJSON() -> JSONValue {
    .object([
      "createdAt": .integer(createdAt),
      "envelopes": .array(envelopes.map {
        .object([
          "ct": .string(Base64URL.encode($0.sealed.ciphertext)),
          "enc": .string(Base64URL.encode($0.sealed.encapsulatedKey)),
          "recipient": .string($0.recipient),
        ])
      }),
      "epoch": .integer(epoch),
      "manifest": .string(manifest),
      "membership": .object([
        "owners": .array(owners.map {
          .object([
            "agreement": .string(Base64URL.encode($0.agreementPublicKey.x963Representation)),
            "deviceName": .string($0.deviceName),
            "signing": .string(Base64URL.encode($0.signingPublicKey.x963Representation)),
          ])
        })
      ]),
      "parent": parent.map(JSONValue.string) ?? .null,
      "seq": .integer(seq),
      "signer": .string(signer),
      "v": .integer(1),
      "vaultId": .string(vaultId),
    ])
  }

  func signedBytes() throws -> Data {
    Self.signingContext + (try CanonicalJSON.encode(unsignedJSON()))
  }

  func bytes() throws -> Data {
    guard case .object(var fields) = unsignedJSON() else { preconditionFailure("commit JSON is an object") }
    fields["signature"] = .string(Base64URL.encode(signature))
    return try CanonicalJSON.encode(.object(fields))
  }

  /// Parses canonical commit bytes and checks everything that needs no other
  /// commit: shape, key encodings, envelope recipients and limits.
  static func parse(_ bytes: Data, expectedSeq: Int64) throws -> Commit {
    func corrupt(_ reason: String) -> VaultError { .corruptCommit(seq: expectedSeq, reason: reason) }
    let value: JSONValue
    do {
      value = try CanonicalJSON.parseCanonical(bytes)
    } catch {
      throw corrupt("not canonical JSON")
    }
    guard formatVersion(of: value) == 1 else { throw VaultError.unsupportedVersion }
    do {
      let object = try StrictObject(
        value,
        keys: ["createdAt", "envelopes", "epoch", "manifest", "membership", "parent", "seq", "signature", "signer", "v", "vaultId"],
        context: "commit"
      )
      let membership = try StrictObject(try object.value("membership"), keys: ["owners"], context: "membership")
      let owners = try membership.array("owners").map { value -> VaultOwner in
        let owner = try StrictObject(value, keys: ["agreement", "deviceName", "signing"], context: "owner")
        guard let agreement = try? P256.KeyAgreement.PublicKey(x963Representation: try owner.bytes("agreement")),
          let signing = try? P256.Signing.PublicKey(x963Representation: try owner.bytes("signing"))
        else { throw corrupt("invalid owner key") }
        let deviceName = try owner.string("deviceName")
        guard Self.isValidDeviceName(deviceName) else { throw corrupt("invalid device name") }
        return VaultOwner(deviceName: deviceName, agreementPublicKey: agreement, signingPublicKey: signing)
      }
      let envelopes = try object.array("envelopes").map { value -> EpochEnvelope in
        let envelope = try StrictObject(value, keys: ["ct", "enc", "recipient"], context: "envelope")
        let sealed = HPKESeal.Sealed(encapsulatedKey: try envelope.bytes("enc"), ciphertext: try envelope.bytes("ct"))
        guard sealed.encapsulatedKey.count == 65, sealed.ciphertext.count == 32 + AEAD.tagSize else {
          throw corrupt("malformed envelope")
        }
        return EpochEnvelope(recipient: try envelope.string("recipient"), sealed: sealed)
      }
      let commit = Commit(
        createdAt: try object.integer("createdAt"),
        envelopes: envelopes,
        epoch: try object.integer("epoch"),
        manifest: try object.string("manifest"),
        owners: owners,
        parent: try object.optionalString("parent"),
        seq: try object.integer("seq"),
        signer: try object.string("signer"),
        vaultId: try object.string("vaultId"),
        signature: try object.bytes("signature")
      )
      try commit.checkWellFormed(expectedSeq: expectedSeq)
      return commit
    } catch let error as JSONError {
      throw corrupt("\(error)")
    }
  }

  func checkWellFormed(expectedSeq: Int64) throws {
    func corrupt(_ reason: String) -> VaultError { .corruptCommit(seq: expectedSeq, reason: reason) }
    guard seq == expectedSeq else { throw corrupt("sequence number does not match the file name") }
    guard VaultIDs.isUUID(vaultId) else { throw corrupt("vault ID is not a lower-case UUID") }
    guard createdAt >= 0, epoch >= 0 else { throw corrupt("negative time or epoch") }
    guard Hex.isSHA256(manifest), Hex.isSHA256(signer) else { throw corrupt("malformed hash") }
    if seq == 0 {
      guard parent == nil, epoch == 0 else { throw corrupt("genesis must have no parent and epoch 0") }
    } else {
      guard let parent, Hex.isSHA256(parent) else { throw corrupt("missing parent") }
    }
    guard signature.count == ECDSA.signatureSize else { throw corrupt("malformed signature") }
    guard (1...VaultLimits.maxOwners).contains(owners.count) else { throw corrupt("owner count out of range") }
    let agreementIDs = owners.map(\.agreementKeyID)
    let signingIDs = owners.map(\.signingKeyID)
    guard Set(agreementIDs).count == owners.count, Set(signingIDs).count == owners.count,
      Set(agreementIDs).isDisjoint(with: signingIDs)
    else { throw corrupt("owner keys repeat") }
    let recipients = envelopes.map(\.recipient)
    guard recipients == agreementIDs.sorted() else {
      throw corrupt("envelopes must be sealed to exactly the owners, sorted by recipient")
    }
  }

  static func isValidDeviceName(_ name: String) -> Bool {
    (1...VaultLimits.maxDeviceNameBytes).contains(name.utf8.count) && !name.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
  }

  func envelope(for agreementKeyID: String) -> EpochEnvelope? {
    envelopes.first { $0.recipient == agreementKeyID }
  }
}

/// A commit whose signature and authority have been checked.
struct VerifiedCommit {
  let commit: Commit
  let hash: String
}

enum History {
  /// Genesis must be signed by an owner listed in its own membership.
  static func verifyGenesis(_ bytes: Data) throws -> VerifiedCommit {
    let commit = try Commit.parse(bytes, expectedSeq: 0)
    guard let signer = commit.owners.first(where: { $0.signingKeyID == commit.signer }) else {
      throw VaultError.unauthorizedSigner(seq: 0)
    }
    guard ECDSA.isValid(commit.signature, for: try commit.signedBytes(), by: signer.signingPublicKey) else {
      throw VaultError.badSignature(seq: 0)
    }
    return VerifiedCommit(commit: commit, hash: Hex.sha256(bytes))
  }

  /// A later commit must extend `parent` and be signed by an owner in the
  /// parent's membership. Removing an owner's agreement key needs a new epoch.
  static func verifyChild(_ bytes: Data, of parent: VerifiedCommit) throws -> VerifiedCommit {
    let seq = parent.commit.seq + 1
    let commit = try Commit.parse(bytes, expectedSeq: seq)
    guard commit.vaultId == parent.commit.vaultId, commit.parent == parent.hash else {
      throw VaultError.brokenChain(seq: seq)
    }
    guard let signer = parent.commit.owners.first(where: { $0.signingKeyID == commit.signer }) else {
      throw VaultError.unauthorizedSigner(seq: seq)
    }
    guard ECDSA.isValid(commit.signature, for: try commit.signedBytes(), by: signer.signingPublicKey) else {
      throw VaultError.badSignature(seq: seq)
    }
    let previousEpoch = parent.commit.epoch
    guard commit.epoch == previousEpoch || commit.epoch == previousEpoch + 1 else {
      throw VaultError.corruptCommit(seq: seq, reason: "epoch must stay or advance by one")
    }
    let removed = Set(parent.commit.owners.map(\.agreementKeyID)).subtracting(commit.owners.map(\.agreementKeyID))
    guard removed.isEmpty || commit.epoch == previousEpoch + 1 else {
      throw VaultError.corruptCommit(seq: seq, reason: "removing an owner needs a new epoch")
    }
    return VerifiedCommit(commit: commit, hash: Hex.sha256(bytes))
  }
}
