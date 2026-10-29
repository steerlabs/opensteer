import CryptoKit
import XCTest
import PasswordsTestSupport
@testable import PasswordsCore

final class CryptoTests: XCTestCase {
  private let binding: JSONValue = .object([
    "epoch": .integer(3), "itemId": .string("0f8fad5b-d9cb-469f-a165-70867728950e"),
    "purpose": .string("item"), "revision": .integer(2), "v": .integer(1),
    "vaultId": .string("7c9e6679-7425-40de-944b-e07fc1f90ae7"),
  ])

  func testAEADRoundTrip() throws {
    let key = SymmetricKey(size: .bits256)
    let box = try AEAD.seal(Data("secret".utf8), key: key, aad: binding)
    XCTAssertEqual(box.nonce.count, 12)
    XCTAssertEqual(box.ciphertext.count, 6 + 16)
    XCTAssertEqual(try AEAD.open(box, key: key, aad: binding), Data("secret".utf8))
  }

  func testAEADBindingIsAuthenticated() throws {
    let key = SymmetricKey(size: .bits256)
    let box = try AEAD.seal(Data("secret".utf8), key: key, aad: binding)
    guard case .object(let fields) = binding else { return XCTFail() }
    let changes: [(String, JSONValue)] = [
      ("epoch", .integer(4)), ("itemId", .string("6fa459ea-ee8a-3ca4-894e-db77e160355e")),
      ("purpose", .string("item-key")), ("revision", .integer(1)), ("v", .integer(2)),
      ("vaultId", .string("16fd2706-8baf-433b-82eb-8c7fada847da")),
    ]
    for (name, value) in changes {
      var changed = fields
      changed[name] = value
      XCTAssertThrowsError(try AEAD.open(box, key: key, aad: .object(changed)), name) { error in
        XCTAssertEqual(error as? CryptoError, .authenticationFailed, name)
      }
    }
    var tampered = box.ciphertext
    tampered[0] ^= 1
    XCTAssertThrowsError(try AEAD.open(AEAD.Box(nonce: box.nonce, ciphertext: tampered), key: key, aad: binding))
    XCTAssertThrowsError(try AEAD.open(box, key: SymmetricKey(size: .bits256), aad: binding))
  }

  func testAEADFreshNonce() throws {
    let key = SymmetricKey(size: .bits256)
    let nonces = try (0..<64).map { _ in try AEAD.seal(Data("same".utf8), key: key, aad: binding).nonce }
    XCTAssertEqual(Set(nonces).count, 64)
  }

  func testAEADRejectsMalformedInput() throws {
    let key = SymmetricKey(size: .bits256)
    let box = try AEAD.seal(Data("x".utf8), key: key, aad: binding)
    XCTAssertThrowsError(try AEAD.seal(Data(), key: SymmetricKey(size: .bits128), aad: binding)) {
      XCTAssertEqual($0 as? CryptoError, .invalidKeyLength)
    }
    XCTAssertThrowsError(try AEAD.open(AEAD.Box(nonce: Data(count: 11), ciphertext: box.ciphertext), key: key, aad: binding)) {
      XCTAssertEqual($0 as? CryptoError, .invalidNonce)
    }
    XCTAssertThrowsError(try AEAD.open(AEAD.Box(nonce: box.nonce, ciphertext: Data(count: 15)), key: key, aad: binding)) {
      XCTAssertEqual($0 as? CryptoError, .invalidCiphertext)
    }
    XCTAssertThrowsError(try AEAD.seal(Data(), key: key, aad: .array([]))) {
      XCTAssertEqual($0 as? CryptoError, .aadNotAnObject)
    }
  }

  func testHPKERoundTripAndSuite() throws {
    let recipient = P256.KeyAgreement.PrivateKey()
    let sealed = try HPKESeal.seal(Data(repeating: 7, count: 32), to: recipient.publicKey, info: HPKESeal.epochKeyInfo, aad: binding)
    XCTAssertEqual(sealed.encapsulatedKey.count, 65)
    XCTAssertEqual(sealed.ciphertext.count, 48)
    XCTAssertEqual(try HPKESeal.open(sealed, with: recipient, info: HPKESeal.epochKeyInfo, aad: binding), Data(repeating: 7, count: 32))
    XCTAssertEqual(String(decoding: HPKESeal.epochKeyInfo, as: UTF8.self), "opensteer-passwords/v1/epoch-key")
  }

  func testHPKEBindsInfoAndAAD() throws {
    let recipient = P256.KeyAgreement.PrivateKey()
    let sealed = try HPKESeal.seal(Data(repeating: 7, count: 32), to: recipient.publicKey, info: HPKESeal.epochKeyInfo, aad: binding)
    XCTAssertThrowsError(try HPKESeal.open(sealed, with: recipient, info: Data("opensteer-passwords/v2/epoch-key".utf8), aad: binding))
    XCTAssertThrowsError(try HPKESeal.open(sealed, with: recipient, info: HPKESeal.epochKeyInfo, aad: .object(["purpose": .string("epoch-key")])))
    var tampered = sealed.ciphertext
    tampered[5] ^= 0x80
    XCTAssertThrowsError(try HPKESeal.open(
      HPKESeal.Sealed(encapsulatedKey: sealed.encapsulatedKey, ciphertext: tampered),
      with: recipient, info: HPKESeal.epochKeyInfo, aad: binding))
  }

  func testHPKEWrongRecipient() throws {
    let sealed = try HPKESeal.seal(Data(repeating: 7, count: 32), to: P256.KeyAgreement.PrivateKey().publicKey, info: HPKESeal.epochKeyInfo, aad: binding)
    XCTAssertThrowsError(try HPKESeal.open(sealed, with: P256.KeyAgreement.PrivateKey(), info: HPKESeal.epochKeyInfo, aad: binding))
  }

  func testEnvelopeRejectsWrongKeyLength() throws {
    let recipient = P256.KeyAgreement.PrivateKey()
    for length in [16, 31, 33] {
      let sealed = try HPKESeal.seal(Data(repeating: 1, count: length), to: recipient.publicKey, info: HPKESeal.epochKeyInfo, aad: binding)
      XCTAssertThrowsError(try KeyEnvelope(sealed: sealed, info: HPKESeal.epochKeyInfo, aad: binding).open(with: recipient)) {
        XCTAssertEqual($0 as? CryptoError, .invalidKeyLength)
      }
    }
  }

  func testHighSRejected() throws {
    let key = P256.Signing.PrivateKey()
    let message = Data("commit".utf8)
    for _ in 0..<32 {
      let raw = try key.signature(for: message).rawRepresentation
      let low = try ECDSA.normalizedLowS(raw)
      XCTAssertTrue(ECDSA.isLowS(low))
      XCTAssertTrue(ECDSA.isValid(low, for: message, by: key.publicKey))
      let high = try Self.negateS(low)
      XCTAssertFalse(ECDSA.isLowS(high))
      // CryptoKit accepts the malleated form; the vault must not.
      XCTAssertTrue(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: high), for: message))
      XCTAssertFalse(ECDSA.isValid(high, for: message, by: key.publicKey))
      XCTAssertEqual(try ECDSA.normalizedLowS(high), low)
    }
    XCTAssertThrowsError(try ECDSA.normalizedLowS(Data(count: 63)))
  }

  func testKeyIDIsSHA256OfX963() {
    let key = P256.KeyAgreement.PrivateKey().publicKey
    XCTAssertEqual(KeyID.of(key), Hex.sha256(key.x963Representation))
  }

  static func negateS(_ signature: Data) throws -> Data {
    let order: [UInt8] = [
      0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
    ]
    let s = [UInt8](signature.suffix(32))
    var out = [UInt8](repeating: 0, count: 32)
    var borrow = 0
    for index in stride(from: 31, through: 0, by: -1) {
      var digit = Int(order[index]) - Int(s[index]) - borrow
      borrow = digit < 0 ? 1 : 0
      if digit < 0 { digit += 256 }
      out[index] = UInt8(digit)
    }
    return signature.prefix(32) + Data(out)
  }
}
