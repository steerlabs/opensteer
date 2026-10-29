import CryptoKit
import Foundation
import CoreFoundation

public enum IphoneProofError: Error { case nonJSONValue, invalidNumber }

public struct ProofChallenge {
  public let challengeId: String
  public let nonce: String
  public let hostSessionId: String
  public let expiresAt: String
  public init(challengeId: String, nonce: String, hostSessionId: String, expiresAt: String) {
    self.challengeId = challengeId
    self.nonce = nonce
    self.hostSessionId = hostSessionId
    self.expiresAt = expiresAt
  }
}

/// Swift signs the same canonical transcript that the Host verifies; no JS
/// proxy ever holds a signing key or supplies signature bytes.
public enum IphoneProofs {
  private static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

  public static func base64url(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  public static func tokenDigest(_ text: String) -> String {
    "sha256:" + base64url(Data(SHA256.hash(data: Data(text.utf8))))
  }

  public static func spki(_ key: Curve25519.Signing.PrivateKey) -> Data {
    spkiPrefix + key.publicKey.rawRepresentation
  }

  public static func keyId(_ key: Curve25519.Signing.PrivateKey) -> String {
    "sha256:" + base64url(Data(SHA256.hash(data: spki(key))))
  }

  public static func publicKeyPem(_ key: Curve25519.Signing.PrivateKey) -> String {
    "-----BEGIN PUBLIC KEY-----\n" + spki(key).base64EncodedString() + "\n-----END PUBLIC KEY-----\n"
  }

  public static func canonicalJSON(_ value: Any) throws -> Data {
    Data(try encode(value).utf8)
  }

  private static func encode(_ value: Any) throws -> String {
    if value is NSNull { return "null" }
    if let value = value as? String { return quote(value) }
    if let value = value as? NSNumber {
      if CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue ? "true" : "false" }
      let double = value.doubleValue
      guard double.isFinite else { throw IphoneProofError.invalidNumber }
      if double == 0 { return "0" }
      if double.rounded(.towardZero) == double && abs(double) <= 9_007_199_254_740_991 {
        return String(Int64(double))
      }
      return String(double).replacingOccurrences(of: ".0e", with: "e")
    }
    if let value = value as? [Any] { return "[" + (try value.map(encode)).joined(separator: ",") + "]" }
    if let value = value as? [String: Any] {
      let keys = value.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
      return "{" + (try keys.map { key in quote(key) + ":" + (try encode(value[key]!)) }).joined(separator: ",") + "}"
    }
    throw IphoneProofError.nonJSONValue
  }

  private static func quote(_ text: String) -> String {
    var result = "\""
    for scalar in text.unicodeScalars {
      switch scalar.value {
      case 0x22: result += "\\\""
      case 0x5c: result += "\\\\"
      case 0x08: result += "\\b"
      case 0x09: result += "\\t"
      case 0x0a: result += "\\n"
      case 0x0c: result += "\\f"
      case 0x0d: result += "\\r"
      case 0...0x1f: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }

  public static func descriptor(bootId: String, runnerId: String, name: String, runtimeVersion: String) -> [String: Any] {
    [
      "bootId": bootId, "capabilities": [String](),
      "device": ["form": "phone", "platform": "ios"],
      "modules": ["integrations": ["computerAppApprovals": true, "platform": "ios", "protocolVersion": 1] as [String: Any]],
      "name": name, "runnerId": runnerId, "runnerKind": "local", "runtimeVersion": runtimeVersion,
    ]
  }

  private static func challengePayload(_ challenge: ProofChallenge, descriptor: [String: Any]) -> [Any] {
    ["challengeId", challenge.challengeId, "challengeNonce", challenge.nonce,
     "hostSessionId", challenge.hostSessionId, "challengeExpiresAt", challenge.expiresAt,
     "descriptor", descriptor]
  }

  private static func sign(_ key: Curve25519.Signing.PrivateKey, domain: String, payload: [Any]) throws -> String {
    base64url(try key.signature(for: canonicalJSON([domain] + payload)))
  }

  public static func authenticate(_ key: Curve25519.Signing.PrivateKey, challenge: ProofChallenge, descriptor: [String: Any]) throws -> String {
    try sign(key, domain: "opensteer-runner-auth-v2", payload: challengePayload(challenge, descriptor: descriptor))
  }

  public static func enroll(_ key: Curve25519.Signing.PrivateKey, challenge: ProofChallenge, descriptor: [String: Any], token: String) throws -> String {
    try sign(key, domain: "opensteer-runner-enroll-v2", payload: challengePayload(challenge, descriptor: descriptor) +
      ["publicKeyFingerprint", keyId(key), "enrollmentTokenHash", tokenDigest(token)])
  }

  public static func auxiliary(_ key: Curve25519.Signing.PrivateKey, challenge: ProofChallenge, runnerId: String, bootId: String, ticket: String) throws -> String {
    try sign(key, domain: "opensteer-runner-auxiliary-v1", payload: [
      "challengeId", challenge.challengeId, "challengeNonce", challenge.nonce,
      "hostSessionId", challenge.hostSessionId, "challengeExpiresAt", challenge.expiresAt,
      "challengeModule", "integrations", "runnerId", runnerId, "bootId", bootId,
      "module", "integrations", "ticketDigest", tokenDigest(ticket),
    ])
  }

  public static func approvalTranscript(request: [String: Any], decision: String, expiresAt: String) throws -> Data {
    try canonicalJSON(["opensteer-computer-app-approval-v4", "decision", decision,
      "request", request, "app", request["app"] ?? NSNull(), "expiresAt", expiresAt])
  }

  public static func approval(_ key: Curve25519.Signing.PrivateKey, request: [String: Any], decision: String, expiresAt: String) throws -> String {
    base64url(try key.signature(for: approvalTranscript(request: request, decision: decision, expiresAt: expiresAt)))
  }

  public static func keyChallenge(_ key: Curve25519.Signing.PrivateKey, challenge: [String: Any]) throws -> String {
    guard challenge["keyId"] as? String == keyId(key) else { throw IphoneProofError.nonJSONValue }
    return try sign(key, domain: "opensteer-computer-app-approval-key-registration-v1", payload: ["challenge", challenge])
  }
}
