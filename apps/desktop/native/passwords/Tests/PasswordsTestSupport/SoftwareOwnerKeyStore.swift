import CryptoKit
import Foundation
import PasswordsCore

/// In-memory P-256 owner keys for tests. Never shipped: only test targets
/// link this module. It records each use so tests can count them. The
/// broker's tests call it from the vault queue while the test reads the
/// counts, so they are locked.
public final class SoftwareOwnerKeyStore: OwnerKeyStore, @unchecked Sendable {
  public let agreementKey: P256.KeyAgreement.PrivateKey
  public let signingKey: P256.Signing.PrivateKey
  private let lock = NSLock()
  private var unwraps = 0
  private var signatures = 0

  public init() {
    agreementKey = P256.KeyAgreement.PrivateKey()
    signingKey = P256.Signing.PrivateKey()
  }

  public init(agreementKey: P256.KeyAgreement.PrivateKey, signingKey: P256.Signing.PrivateKey) {
    self.agreementKey = agreementKey
    self.signingKey = signingKey
  }

  public var unwrapCount: Int { lock.withLock { unwraps } }
  public var signCount: Int { lock.withLock { signatures } }

  public var agreementPublicKey: P256.KeyAgreement.PublicKey { agreementKey.publicKey }
  public var signingPublicKey: P256.Signing.PublicKey { signingKey.publicKey }

  public func unwrap(envelope: KeyEnvelope) throws -> SymmetricKey {
    lock.withLock { unwraps += 1 }
    return try envelope.open(with: agreementKey)
  }

  public func sign(_ data: Data) throws -> Data {
    lock.withLock { signatures += 1 }
    return try signingKey.signature(for: data).rawRepresentation
  }
}
