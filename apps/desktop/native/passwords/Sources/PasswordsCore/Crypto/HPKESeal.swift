import CryptoKit
import Foundation

/// RFC 9180 HPKE base mode through CryptoKit, one fixed ciphersuite.
public enum HPKESeal {
  public static let ciphersuite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
  /// The info string for sealing a vault epoch key to an owner.
  public static let epochKeyInfo = Data("opensteer-passwords/v1/epoch-key".utf8)

  public struct Sealed: Sendable, Equatable {
    /// The 65-byte uncompressed P-256 encapsulated key.
    public let encapsulatedKey: Data
    public let ciphertext: Data

    public init(encapsulatedKey: Data, ciphertext: Data) {
      self.encapsulatedKey = encapsulatedKey
      self.ciphertext = ciphertext
    }
  }

  public static func seal(
    _ plaintext: Data,
    to recipient: P256.KeyAgreement.PublicKey,
    info: Data,
    aad: JSONValue
  ) throws -> Sealed {
    let binding = try AEAD.bindingBytes(aad)
    var sender = try HPKE.Sender(recipientKey: recipient, ciphersuite: ciphersuite, info: info)
    let ciphertext = try sender.seal(plaintext, authenticating: binding)
    return Sealed(encapsulatedKey: Data(sender.encapsulatedKey), ciphertext: Data(ciphertext))
  }

  /// Generic over the private key so a Secure Enclave key can be the recipient.
  public static func open<PrivateKey: HPKEDiffieHellmanPrivateKey>(
    _ sealed: Sealed,
    with privateKey: PrivateKey,
    info: Data,
    aad: JSONValue
  ) throws -> Data {
    let binding = try AEAD.bindingBytes(aad)
    var recipient = try HPKE.Recipient(
      privateKey: privateKey,
      ciphersuite: ciphersuite,
      info: info,
      encapsulatedKey: sealed.encapsulatedKey
    )
    do {
      return try recipient.open(sealed.ciphertext, authenticating: binding)
    } catch CryptoKitError.authenticationFailure {
      throw CryptoError.authenticationFailed
    }
  }
}

/// A 32-byte symmetric key sealed to one recipient, with the info and AAD it
/// was bound to. `OwnerKeyStore.unwrap` opens it.
public struct KeyEnvelope: Sendable {
  public let sealed: HPKESeal.Sealed
  public let info: Data
  public let aad: JSONValue

  public init(sealed: HPKESeal.Sealed, info: Data, aad: JSONValue) {
    self.sealed = sealed
    self.info = info
    self.aad = aad
  }

  public func open<PrivateKey: HPKEDiffieHellmanPrivateKey>(with privateKey: PrivateKey) throws -> SymmetricKey {
    var bytes = try HPKESeal.open(sealed, with: privateKey, info: info, aad: aad)
    defer { bytes.wipe() }
    guard bytes.count == 32 else { throw CryptoError.invalidKeyLength }
    return SymmetricKey(data: bytes)
  }
}
