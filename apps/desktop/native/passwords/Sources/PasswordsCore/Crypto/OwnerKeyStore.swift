import CryptoKit
import Foundation

/// One owner device's keys: an agreement key that opens epoch-key envelopes
/// and a signing key that signs commits.
///
/// The keys never wait for the person: when the person must authenticate is
/// the broker's own policy, so an account allowed for a Workspace signs in
/// without a prompt. An implementation must never show UI for a key
/// operation; it fails instead.
public protocol OwnerKeyStore {
  var agreementPublicKey: P256.KeyAgreement.PublicKey { get }
  var signingPublicKey: P256.Signing.PublicKey { get }

  /// Opens an epoch-key envelope sealed to `agreementPublicKey`.
  func unwrap(envelope: KeyEnvelope) throws -> SymmetricKey

  /// ECDSA P-256 over SHA-256 of `data`, as a raw 64-byte `r‖s` signature.
  func sign(_ data: Data) throws -> Data
}

/// How the owner keys in a protected store were made, recorded beside them
/// as `ProtectedName.ownerKeyPolicy`, canonical `{"policy":2,"v":1}`.
///
/// Policy 2: Secure Enclave keys usable without the person
/// (`.privateKeyUsage`), after the Mac's first unlock. Vaults made before it
/// have no record; their keys needed the person for every use. They are not
/// migrated: the person sets Passwords up again.
public enum OwnerKeyPolicy {
  public static let current: Int64 = 2

  public static func record() throws -> Data {
    try CanonicalJSON.encode(.object(["policy": .integer(current), "v": .integer(1)]))
  }

  /// Whether `data` is the record of the current policy.
  public static func isCurrent(_ data: Data?) -> Bool {
    guard let data, let value = try? CanonicalJSON.parseCanonical(data),
      let object = try? StrictObject(value, keys: ["policy", "v"], context: "owner key policy")
    else { return false }
    return (try? object.integer("v")) == 1 && (try? object.integer("policy")) == current
  }
}
