import CryptoKit
import Foundation
import PasswordsBrokerKit
import PasswordsCore
import PasswordsTestSupport

/// Software owner keys kept in the protected store, so a test can restart a
/// broker and find the same owner, and nothing can prompt.
struct SoftwareOwnerKeys: OwnerKeyProvider {
  var isAvailable = true

  func load(from store: any ProtectedStore) throws -> any OwnerKeyStore {
    guard let agreement = try store.read(.ownerAgreementKey), let signing = try store.read(.ownerSigningKey) else {
      throw OwnerKeyError.keysMissing
    }
    return SoftwareOwnerKeyStore(
      agreementKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: agreement),
      signingKey: try P256.Signing.PrivateKey(rawRepresentation: signing))
  }

  func create(in store: any ProtectedStore) throws -> any OwnerKeyStore {
    let keys = SoftwareOwnerKeyStore()
    try store.write(.ownerAgreementKey, keys.agreementKey.rawRepresentation)
    try store.write(.ownerSigningKey, keys.signingKey.rawRepresentation)
    return keys
  }
}
