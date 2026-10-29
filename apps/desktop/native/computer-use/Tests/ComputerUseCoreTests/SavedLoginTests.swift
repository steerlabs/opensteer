import Foundation
import XCTest

@testable import ComputerUseCore

final class SavedLoginTests: XCTestCase {
  static var vectorsURL: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("packages/protocol/fixtures/login-envelope-v1.json")
  }

  static func vectors() throws -> [[String: Any]] {
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: vectorsURL)) as? [String: Any])
    return try XCTUnwrap(object["vectors"] as? [[String: Any]])
  }

  /// Each vector's plaintext exactly as the file has it. `JSONSerialization`
  /// drops a leading U+FEFF from a string, which hid the same loss in `open`.
  static func plaintexts() throws -> [String: String] {
    struct File: Decodable {
      struct Vector: Decodable {
        let name: String
        let plaintext: String?
      }
      let vectors: [Vector]
    }
    let file = try JSONDecoder().decode(File.self, from: Data(contentsOf: vectorsURL))
    return Dictionary(
      file.vectors.compactMap { vector in vector.plaintext.map { (vector.name, $0) } },
      uniquingKeysWith: { first, _ in first })
  }

  func testSealedTextIsAcceptedAsDispatchInput() throws {
    let vector = try XCTUnwrap(Self.vectors().first)
    let data = try JSONSerialization.data(withJSONObject: [
      "type": "type", "text": ["sealed": vector["envelope"]!],
    ])
    XCTAssertNoThrow(try JSONDecoder().decode(ActionRequest.self, from: data))
  }

  func testSecureLabelsIgnoreEveryFallback() {
    for role in ["AXTextField", "AXSecureTextField"] {
      let attributes = ElementAttributes(
        role: role, subrole: "AXSecureTextField",
        title: "secret-title", value: "secret-value", roleDescription: "secret-role",
        help: "secret-help")
      XCTAssertEqual(TreeFormatter.label(attributes), "Secure text field")
    }
  }
}

final class LoginEnvelopeTests: XCTestCase {
  func testSharedVectorsWithoutRegeneration() throws {
    let plaintexts = try SavedLoginTests.plaintexts()
    for vector in try SavedLoginTests.vectors() {
      let name = try XCTUnwrap(vector["name"] as? String)
      let envelope = try? JSONDecoder().decode(
        SealedLoginEnvelope.self,
        from: JSONSerialization.data(withJSONObject: vector["envelope"]!))
      let binding = try? JSONDecoder().decode(
        LoginEnvelopeBinding.self,
        from: JSONSerialization.data(withJSONObject: vector["expectedBinding"]!))
      let privateKey = try XCTUnwrap(vector["receiverPrivateKey"] as? String)
      let now = try XCTUnwrap(vector["now"] as? Double)
      if vector["expected"] as? String == "open" {
        let envelope = try XCTUnwrap(envelope, name)
        let binding = try XCTUnwrap(binding, name)
        XCTAssertEqual(
          String(decoding: try binding.aad(), as: UTF8.self), vector["aad"] as? String, name)
        XCTAssertEqual(
          try LoginEnvelopeCrypto.open(
            envelope, expected: binding,
            privateKey: privateKey, now: now), plaintexts[name], name)
      } else if let envelope, let binding {
        XCTAssertThrowsError(
          try LoginEnvelopeCrypto.open(
            envelope, expected: binding,
            privateKey: privateKey, now: now), name)
      }
    }
  }

  /// The Passwords smoke's `unicode` value: a leading U+FEFF, an emoji, a
  /// combining accent and right-to-left text. Opened saved text must keep every
  /// scalar; `String(data:encoding:)` dropped the U+FEFF, so the field got the
  /// password without its first character.
  func testOpenedTextKeepsEveryScalarAndRefusesInvalidUTF8() {
    let unicode = "\u{FEFF}héllo 😀 e\u{0301} مرحبا"
    let opened = LoginEnvelopeCrypto.exactText(Data(unicode.utf8))
    XCTAssertEqual(opened.map { Array($0.unicodeScalars) }, Array(unicode.unicodeScalars))
    XCTAssertNil(LoginEnvelopeCrypto.exactText(Data([0x68, 0xC3, 0x28])))
  }

  func testRejectsUnknownKeysNoncanonicalBinaryAndEveryBindingMismatch() throws {
    let vector = try XCTUnwrap(SavedLoginTests.vectors().first)
    let object = try XCTUnwrap(vector["envelope"] as? [String: Any])
    for key in ["extra", "salt", "nonce", "senderPublicKey", "tag", "ciphertext"] {
      var malformed = object
      malformed[key] = key == "extra" ? "extra" : (object[key] as? String ?? "") + "="
      XCTAssertThrowsError(
        try JSONDecoder().decode(
          SealedLoginEnvelope.self,
          from: JSONSerialization.data(withJSONObject: malformed)), key)
    }
    let envelope = try JSONDecoder().decode(
      SealedLoginEnvelope.self,
      from: JSONSerialization.data(withJSONObject: object))
    let key = try XCTUnwrap(vector["receiverPrivateKey"] as? String)
    let expected = try XCTUnwrap(vector["expectedBinding"] as? [String: Any])
    let replacements: [String: Any] = [
      "version": 2, "connectionId": "other", "connectionGeneration": 8,
      "runId": "run_00000000-0000-4000-8000-000000000009",
      "sessionId": "cus_00000000-0000-4000-8000-000000000009", "actId": "other",
      "actionIndex": 1, "field": "username", "expiresAt": 1_800_000_045_001,
    ]
    for (field, replacement) in replacements {
      var changed = expected
      changed[field] = replacement
      if let binding = try? JSONDecoder().decode(
        LoginEnvelopeBinding.self,
        from: JSONSerialization.data(withJSONObject: changed))
      {
        XCTAssertThrowsError(
          try LoginEnvelopeCrypto.open(
            envelope, expected: binding,
            privateKey: key, now: 1_800_000_000_000), field)
      }
    }
    for now in [1800000045000.0, 1800000045001.0] {
      XCTAssertThrowsError(
        try LoginEnvelopeCrypto.open(
          envelope, expected: envelope.binding,
          privateKey: key, now: now))
    }
  }

  func testSavedLiteralValidationAndReceipts() throws {
    for text in ["\r", "\n", "\t", "a\r\nb", "a\tb"] {
      XCTAssertThrowsError(try SavedLoginInput.validate(text))
    }
    for text in ["", "雪😀e\u{301}\0", "\u{feff}text"] {
      XCTAssertNoThrow(try SavedLoginInput.validate(text))
      XCTAssertEqual(TextChunker.chunks(text).joined(), text)
    }
    for field in LoginField.allCases {
      XCTAssertEqual(SavedLoginInput.receipt(field), "Typed saved \(field.rawValue)")
    }
  }
}
