import CryptoKit
import Foundation
import LocalAuthentication
import Security

public enum OwnerKeyError: Error, Equatable, Sendable {
  case secureEnclaveUnavailable
  case keysAlreadyExist
  case keysMissing
  case accessControlUnavailable
}

/// Production owner keys: two Secure Enclave P-256 keys, usable by this Mac's
/// Secure Enclave after its first unlock and never needing the person
/// (policy 2, `OwnerKeyPolicy`).
///
/// Only their encrypted `dataRepresentation`s are stored, through a
/// `ProtectedStore` that only the broker can read. A copied representation is
/// useless without this Mac's Secure Enclave.
public final class SecureEnclaveOwnerKeyStore: OwnerKeyStore, Sendable {
  public static var isAvailable: Bool { SecureEnclave.isAvailable }

  public let agreementPublicKey: P256.KeyAgreement.PublicKey
  public let signingPublicKey: P256.Signing.PublicKey
  private let agreementRepresentation: Data
  private let signingRepresentation: Data

  /// Creates both keys and stores them. Refuses if either already exists.
  public static func create(in store: any ProtectedStore) throws -> SecureEnclaveOwnerKeyStore {
    guard isAvailable else { throw OwnerKeyError.secureEnclaveUnavailable }
    guard try store.read(.ownerAgreementKey) == nil, try store.read(.ownerSigningKey) == nil else {
      throw OwnerKeyError.keysAlreadyExist
    }
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage], &error)
    else {
      throw OwnerKeyError.accessControlUnavailable
    }
    let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access, authenticationContext: noInteraction())
    let signing = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: noInteraction())
    try store.write(.ownerAgreementKey, agreement.dataRepresentation)
    do {
      try store.write(.ownerSigningKey, signing.dataRepresentation)
    } catch {
      try? store.delete(.ownerAgreementKey)
      throw error
    }
    return SecureEnclaveOwnerKeyStore(
      agreementPublicKey: agreement.publicKey,
      signingPublicKey: signing.publicKey,
      agreementRepresentation: agreement.dataRepresentation,
      signingRepresentation: signing.dataRepresentation
    )
  }

  /// Loads stored keys. Reading their public halves never asks anyone.
  public static func load(from store: any ProtectedStore) throws -> SecureEnclaveOwnerKeyStore {
    guard isAvailable else { throw OwnerKeyError.secureEnclaveUnavailable }
    guard let agreementData = try store.read(.ownerAgreementKey), let signingData = try store.read(.ownerSigningKey) else {
      throw OwnerKeyError.keysMissing
    }
    let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: agreementData, authenticationContext: noInteraction())
    let signing = try SecureEnclave.P256.Signing.PrivateKey(
      dataRepresentation: signingData, authenticationContext: noInteraction())
    return SecureEnclaveOwnerKeyStore(
      agreementPublicKey: agreement.publicKey,
      signingPublicKey: signing.publicKey,
      agreementRepresentation: agreementData,
      signingRepresentation: signingData
    )
  }

  private init(
    agreementPublicKey: P256.KeyAgreement.PublicKey,
    signingPublicKey: P256.Signing.PublicKey,
    agreementRepresentation: Data,
    signingRepresentation: Data
  ) {
    self.agreementPublicKey = agreementPublicKey
    self.signingPublicKey = signingPublicKey
    self.agreementRepresentation = agreementRepresentation
    self.signingRepresentation = signingRepresentation
  }

  public func unwrap(envelope: KeyEnvelope) throws -> SymmetricKey {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: agreementRepresentation, authenticationContext: Self.noInteraction())
    return try envelope.open(with: key)
  }

  public func sign(_ data: Data) throws -> Data {
    let key = try SecureEnclave.P256.Signing.PrivateKey(
      dataRepresentation: signingRepresentation, authenticationContext: Self.noInteraction())
    return try key.signature(for: data).rawRepresentation
  }

  /// A key that would need the person (one made under the old policy) fails
  /// with `notInteractive` here rather than showing a prompt.
  private static func noInteraction() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
  }
}
