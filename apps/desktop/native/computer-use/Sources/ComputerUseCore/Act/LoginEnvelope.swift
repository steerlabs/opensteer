import CryptoKit
import Foundation

public enum LoginField: String, Codable, CaseIterable, Sendable {
  case username, password, code
}

/// Errors at this boundary deliberately contain no wire or decrypted values.
enum LoginEnvelopeCrypto {
  static let refusal = HelperError(
    .unsupported, "Saved login text is invalid or no longer available; request it again.")
  static let expired = HelperError(.unsupported, "Saved login text expired; request sign-in again.")

  static func base64(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func binary(_ value: String, count: Int? = nil) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil,
      let bytes = Data(
        base64Encoded: value.replacingOccurrences(of: "-", with: "+")
          .replacingOccurrences(of: "_", with: "/")
          + String(repeating: "=", count: (4 - value.count % 4) % 4)),
      base64(bytes) == value, count == nil || bytes.count == count
    else { throw refusal }
    return bytes
  }

  static func object(_ decoder: any Decoder, keys: Set<String>) throws -> [String: JSONValue] {
    guard case .object(let object) = try JSONValue(from: decoder), Set(object.keys) == keys
    else { throw refusal }
    return object
  }

  static func string(_ object: [String: JSONValue], _ key: String, pattern: String) throws -> String
  {
    guard case .string(let value) = object[key],
      value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    else { throw refusal }
    return value
  }

  static func integer(
    _ object: [String: JSONValue], _ key: String, min: Int, max: Int = 9_007_199_254_740_991
  ) throws -> Int {
    guard case .number(let value) = object[key], value.isFinite, value.rounded() == value,
      value >= Double(min), value <= Double(max)
    else { throw refusal }
    return Int(value)
  }

  static let runPattern =
    "(?i)^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  static let sessionPattern =
    "(?i)^cus_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  static let actPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"

  static func open(
    _ envelope: SealedLoginEnvelope, expected: LoginEnvelopeBinding,
    privateKey: String, now: Double
  ) throws -> String {
    do {
      let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: binary(privateKey, count: 32))
      return try open(envelope, expected: expected, privateKey: key, now: now)
    } catch let error as HelperError { throw error } catch { throw refusal }
  }

  static func open(
    _ envelope: SealedLoginEnvelope, expected: LoginEnvelopeBinding,
    privateKey: P256.KeyAgreement.PrivateKey, now: Double
  ) throws -> String {
    do {
      guard envelope.binding == expected else { throw refusal }
      // The issuer caps lifetime; the receiver only checks whether it has elapsed.
      guard Double(expected.expiresAt) > now else { throw expired }
      let sender = try P256.KeyAgreement.PublicKey(
        x963Representation: binary(envelope.senderPublicKey, count: 65))
      let shared = try privateKey.sharedSecretFromKeyAgreement(with: sender)
      let key = shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: try binary(envelope.salt, count: 32),
        sharedInfo: Data("opensteer/login-text/v1".utf8), outputByteCount: 32)
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: binary(envelope.nonce, count: 12)),
        ciphertext: binary(envelope.ciphertext), tag: binary(envelope.tag, count: 16))
      var plaintext = try AES.GCM.open(box, using: key, authenticating: expected.aad())
      defer { plaintext.resetBytes(in: 0..<plaintext.count) }
      guard plaintext.count <= 16_384, let text = exactText(plaintext), text.utf16.count <= 4_096
      else { throw refusal }
      return text
    } catch let error as HelperError { throw error } catch { throw refusal }
  }

  /// The text the bytes encode, every scalar kept, or nil when they are not
  /// UTF-8. `String(data:encoding:)` drops a leading U+FEFF, so a saved
  /// password starting with one went in without its first character.
  static func exactText(_ bytes: Data) -> String? {
    let text = String(decoding: bytes, as: UTF8.self)
    return text.utf8.elementsEqual(bytes) ? text : nil
  }
}

struct LoginActContext: Decodable, Sendable {
  let runId: String
  let actId: String

  init(runId: String, actId: String) {
    self.runId = runId
    self.actId = actId
  }

  init(from decoder: any Decoder) throws {
    let object = try LoginEnvelopeCrypto.object(decoder, keys: ["runId", "actId"])
    runId = try LoginEnvelopeCrypto.string(object, "runId", pattern: LoginEnvelopeCrypto.runPattern)
    actId = try LoginEnvelopeCrypto.string(object, "actId", pattern: LoginEnvelopeCrypto.actPattern)
  }
}

struct LoginReceiverKey: Encodable, Sendable {
  let version = 1
  let connectionId: String
  let connectionGeneration: Int
  let publicKey: String
}

public struct LoginEnvelopeBinding: Codable, Sendable, Equatable {
  let version: Int
  let connectionId: String
  let connectionGeneration: Int
  let runId: String
  let sessionId: String
  let actId: String
  let actionIndex: Int
  let field: LoginField
  let expiresAt: Int

  public init(from decoder: any Decoder) throws {
    let object = try LoginEnvelopeCrypto.object(
      decoder,
      keys: [
        "version", "connectionId", "connectionGeneration",
        "runId", "sessionId", "actId", "actionIndex", "field", "expiresAt",
      ])
    version = try LoginEnvelopeCrypto.integer(object, "version", min: 1, max: 1)
    connectionId = try LoginEnvelopeCrypto.string(
      object, "connectionId", pattern: "^[A-Za-z0-9._:-]{1,128}$")
    connectionGeneration = try LoginEnvelopeCrypto.integer(object, "connectionGeneration", min: 1)
    runId = try LoginEnvelopeCrypto.string(object, "runId", pattern: LoginEnvelopeCrypto.runPattern)
    sessionId = try LoginEnvelopeCrypto.string(
      object, "sessionId", pattern: LoginEnvelopeCrypto.sessionPattern)
    actId = try LoginEnvelopeCrypto.string(object, "actId", pattern: LoginEnvelopeCrypto.actPattern)
    actionIndex = try LoginEnvelopeCrypto.integer(object, "actionIndex", min: 0, max: 31)
    guard
      let field = LoginField(
        rawValue: try LoginEnvelopeCrypto.string(
          object, "field", pattern: "^(username|password|code)$"))
    else { throw LoginEnvelopeCrypto.refusal }
    self.field = field
    expiresAt = try LoginEnvelopeCrypto.integer(object, "expiresAt", min: 1)
  }

  func aad() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  /// Field and deadline cannot create a second claim for the same input slot.
  var replayIdentity: String {
    "\(connectionId)/\(connectionGeneration)/\(runId)/\(sessionId)/\(actId)/\(actionIndex)"
  }
}

public struct SealedLoginEnvelope: Decodable, Sendable {
  let binding: LoginEnvelopeBinding
  let senderPublicKey: String
  let salt: String
  let nonce: String
  let ciphertext: String
  let tag: String

  public init(from decoder: any Decoder) throws {
    let object = try LoginEnvelopeCrypto.object(
      decoder,
      keys: ["binding", "senderPublicKey", "salt", "nonce", "ciphertext", "tag"])
    guard let binding = object["binding"] else { throw LoginEnvelopeCrypto.refusal }
    self.binding = try binding.decoded(as: LoginEnvelopeBinding.self)
    func binary(_ name: String, count: Int? = nil) throws -> String {
      let value = try LoginEnvelopeCrypto.string(object, name, pattern: "^[A-Za-z0-9_-]*$")
      let data = try LoginEnvelopeCrypto.binary(value, count: count)
      guard data.count <= 16_384 else { throw LoginEnvelopeCrypto.refusal }
      return value
    }
    senderPublicKey = try binary("senderPublicKey", count: 65)
    guard try LoginEnvelopeCrypto.binary(senderPublicKey).first == 4 else {
      throw LoginEnvelopeCrypto.refusal
    }
    _ = try P256.KeyAgreement.PublicKey(
      x963Representation: LoginEnvelopeCrypto.binary(senderPublicKey))
    salt = try binary("salt", count: 32)
    nonce = try binary("nonce", count: 12)
    ciphertext = try binary("ciphertext")
    tag = try binary("tag", count: 16)
  }
}

enum SavedLoginInput {
  static func validate(_ text: String) throws {
    guard !text.unicodeScalars.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\t" })
    else {
      throw HelperError(
        .unsupported, "Saved login text containing a line break or tab cannot be typed on this Mac."
      )
    }
  }

  static func receipt(_ field: LoginField) -> String { "Typed saved \(field.rawValue)" }
}
