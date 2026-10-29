import CryptoKit
import LocalAuthentication
import Security
import XCTest
import PasswordsTestSupport
@testable import PasswordsCore

/// Prompt-free checks of the production owner keys.
///
/// Every LocalAuthentication context here has `interactionNotAllowed`, so no
/// Touch ID or password prompt can appear. The production keys never need
/// the person; the old policy's keys, which did, fail instead of prompting.
final class SecureEnclaveTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    try XCTSkipUnless(SecureEnclaveOwnerKeyStore.isAvailable, "This Mac has no Secure Enclave")
    directory = try makeTemporaryDirectory()
  }

  override func tearDownWithError() throws {
    if let directory { try? FileManager.default.removeItem(at: directory) }
  }

  private func store() throws -> FileProtectedStore {
    try FileProtectedStore(directory: directory.appendingPathComponent("protected-\(UUID().uuidString)"))
  }

  private static func noInteraction() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
  }

  /// C7, C15: the production keys sign, open envelopes and run a vault with
  /// no person and no UI, after reloading from their stored representations.
  func testOwnerKeysWorkWithoutThePersonAndNeverPrompt() throws {
    let protected = try store()
    let owner = try SecureEnclaveOwnerKeyStore.create(in: protected)
    let reloaded = try SecureEnclaveOwnerKeyStore.load(from: protected)
    XCTAssertEqual(reloaded.agreementPublicKey.x963Representation, owner.agreementPublicKey.x963Representation)
    XCTAssertEqual(reloaded.signingPublicKey.x963Representation, owner.signingPublicKey.x963Representation)

    for keys in [owner, reloaded] {
      let message = Data("allowed sign-in".utf8)
      let signature = try P256.Signing.ECDSASignature(rawRepresentation: try keys.sign(message))
      XCTAssertTrue(keys.signingPublicKey.isValidSignature(signature, for: message))
      let aad: JSONValue = .object(["purpose": .string("epoch-key")])
      let secret = Data(repeating: 7, count: 32)
      let sealed = try HPKESeal.seal(secret, to: keys.agreementPublicKey, info: HPKESeal.epochKeyInfo, aad: aad)
      let opened = try keys.unwrap(envelope: KeyEnvelope(sealed: sealed, info: HPKESeal.epochKeyInfo, aad: aad))
      XCTAssertEqual(opened.withUnsafeBytes { Data($0) }, secret)
    }

    let root = directory.appendingPathComponent("Vault")
    _ = try Vault.create(root: root, protectedStore: protected, deviceName: "Test Mac", owner: owner)
    let unlocked = try Vault.open(root: root, protectedStore: protected).unlock(owner: reloaded)
    try unlocked.add([draft()])
    XCTAssertEqual(try unlocked.items().map(\.username), ["alice@example.com"])
    unlocked.close()
  }

  /// C9: keys made under the old policy (presence for every use) are loaded
  /// as the production store loads them, and fail with `notInteractive`
  /// instead of showing a prompt.
  func testPresenceKeysFailInsteadOfPrompting() throws {
    var error: Unmanaged<CFError>?
    let presence = try XCTUnwrap(
      SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage, .userPresence], &error))
    let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      accessControl: presence, authenticationContext: Self.noInteraction())
    let signing = try SecureEnclave.P256.Signing.PrivateKey(accessControl: presence, authenticationContext: Self.noInteraction())
    let protected = try store()
    try protected.write(.ownerAgreementKey, agreement.dataRepresentation)
    try protected.write(.ownerSigningKey, signing.dataRepresentation)

    let keys = try SecureEnclaveOwnerKeyStore.load(from: protected)
    XCTAssertThrowsError(try keys.sign(Data("approve".utf8))) { error in
      XCTAssertEqual((error as? LAError)?.code, .notInteractive, "\(error)")
    }
    let aad: JSONValue = .object(["purpose": .string("epoch-key")])
    let sealed = try HPKESeal.seal(Data(repeating: 1, count: 32), to: keys.agreementPublicKey, info: HPKESeal.epochKeyInfo, aad: aad)
    XCTAssertThrowsError(try keys.unwrap(envelope: KeyEnvelope(sealed: sealed, info: HPKESeal.epochKeyInfo, aad: aad))) { error in
      XCTAssertEqual((error as? LAError)?.code, .notInteractive, "\(error)")
    }
  }

  func testCreateRefusesExistingKeys() throws {
    let protected = try store()
    _ = try SecureEnclaveOwnerKeyStore.create(in: protected)
    let agreement = try protected.read(.ownerAgreementKey)
    XCTAssertThrowsError(try SecureEnclaveOwnerKeyStore.create(in: protected)) {
      XCTAssertEqual($0 as? OwnerKeyError, .keysAlreadyExist)
    }
    XCTAssertEqual(try protected.read(.ownerAgreementKey), agreement)

    try protected.delete(.ownerAgreementKey)
    XCTAssertThrowsError(try SecureEnclaveOwnerKeyStore.create(in: protected)) {
      XCTAssertEqual($0 as? OwnerKeyError, .keysAlreadyExist)
    }
    XCTAssertThrowsError(try SecureEnclaveOwnerKeyStore.load(from: protected)) {
      XCTAssertEqual($0 as? OwnerKeyError, .keysMissing)
    }
  }
}
