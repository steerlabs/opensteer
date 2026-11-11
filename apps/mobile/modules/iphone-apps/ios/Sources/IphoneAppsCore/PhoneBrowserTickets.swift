import CryptoKit
import Foundation

public struct PhoneBrowserVerifiedTicket {
  public let claims: [String: Any]
  public let digest: String
  public let nonce: String
  public let expiresAt: Int64
}

public enum PhoneBrowserTickets {
  public static func verify(_ token: String, keys: [[String: Any]], runtimeId: String, now: Int64) throws -> PhoneBrowserVerifiedTicket {
    guard token.utf8.count <= 16_384 else { throw PhoneBrowserFailure.forbidden }
    let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3 else { throw PhoneBrowserFailure.forbidden }
    let header = try object(decode(parts[0]))
    guard Set(header.keys) == Set(["alg", "kid", "typ"]), header["alg"] as? String == "EdDSA",
      header["typ"] as? String == "opensteer-browser-attach+jwt",
      let kid = header["kid"] as? String, (1...255).contains(kid.utf16.count),
      let key = keys.first(where: { $0["keyId"] as? String == kid }),
      let pem = key["publicKeyPem"] as? String else { throw PhoneBrowserFailure.forbidden }
    let signature = try decode(parts[2])
    let signed = Data((parts[0] + "." + parts[1]).utf8)
    guard signature.count == 64, try publicKey(pem).isValidSignature(signature, for: signed) else { throw PhoneBrowserFailure.forbidden }
    let claims = try object(decode(parts[1]))
    try validateClaims(claims)
    let issued = try PhoneBrowserAdmission.milliseconds(claims, "issuedAt")
    let expiry = try PhoneBrowserAdmission.milliseconds(claims, "expiresAt")
    guard claims["runtimeId"] as? String == runtimeId, issued <= now + 5000, expiry > now,
      expiry > issued, expiry - issued <= 300_000 else { throw PhoneBrowserFailure.forbidden }
    return PhoneBrowserVerifiedTicket(claims: claims, digest: IphoneProofs.tokenDigest(token),
      nonce: try WireField.string(claims, "nonce"), expiresAt: expiry)
  }

  public static func publicKey(_ pem: String) throws -> Curve25519.Signing.PublicKey {
    guard (64...2048).contains(pem.utf8.count), pem.hasPrefix("-----BEGIN PUBLIC KEY-----"),
      pem.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("-----END PUBLIC KEY-----") else { throw PhoneBrowserFailure.forbidden }
    let text = pem.replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "").filter { !$0.isWhitespace }
    let prefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
    guard let bytes = Data(base64Encoded: text), bytes.count == 44, bytes.prefix(12) == prefix else { throw PhoneBrowserFailure.forbidden }
    return try Curve25519.Signing.PublicKey(rawRepresentation: bytes.suffix(32))
  }

  private static func decode(_ text: String) throws -> Data {
    guard !text.isEmpty, text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw PhoneBrowserFailure.forbidden }
    let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)
    guard let result = Data(base64Encoded: padded), IphoneProofs.base64url(result) == text else { throw PhoneBrowserFailure.forbidden }
    return result
  }

  private static func object(_ bytes: Data) throws -> [String: Any] {
    guard !bytes.starts(with: [0xef, 0xbb, 0xbf]), String(data: bytes, encoding: .utf8) != nil,
      let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw PhoneBrowserFailure.forbidden }
    return object
  }

  private static func validateClaims(_ claims: [String: Any]) throws {
    let required = ["access", "audience", "wireVersion", "operationExpiresAt", "remainingBudgetMs", "expiresAt", "identity", "issuedAt", "nonce", "runtimeId", "sessionId", "subject"]
    let optional = ["passkeys", "navigationVersion", "initialNavigation", "navigationAttributionVersion", "editingVersion", "basicInput", "surfaceState", "clipboard", "workspaceTabRestoreVersion", "popupFollowVersion", "initialSurfaceId", "dormantSurfaceIds", "viewport"]
    guard Set(required).isSubset(of: Set(claims.keys)), Set(claims.keys).isSubset(of: Set(required + optional)),
      ["read", "read-write"].contains(claims["access"] as? String ?? ""),
      claims["audience"] as? String == "opensteer-browser-runtime" else { throw PhoneBrowserFailure.forbidden }
    _ = try WireField.int(claims, "wireVersion", range: 2...2)
    _ = try WireField.int(claims, "remainingBudgetMs", range: 1...20_000)
    _ = try WireField.date(claims, "operationExpiresAt")
    for name in ["nonce", "runtimeId", "sessionId", "subject"] {
      let value = try WireField.string(claims, name)
      guard value.utf16.count <= 255, name != "nonce" || value.utf16.count >= 16 else { throw PhoneBrowserFailure.forbidden }
    }
    guard PhoneBrowserValidation.identifier(try WireField.string(claims, "sessionId"), prefix: "bsn") else { throw PhoneBrowserFailure.forbidden }
    for name in ["passkeys", "navigationVersion", "navigationAttributionVersion", "basicInput", "surfaceState", "workspaceTabRestoreVersion", "popupFollowVersion"] where claims[name] != nil {
      _ = try WireField.int(claims, name, range: 1...1)
    }
    if claims["editingVersion"] != nil { _ = try WireField.int(claims, "editingVersion", range: 1...2) }
    if (claims["editingVersion"] as? Int) == 2 {
      guard PhoneBrowserValidation.boolean(claims["clipboard"]) else { throw PhoneBrowserFailure.forbidden }
    } else if claims["clipboard"] != nil { throw PhoneBrowserFailure.forbidden }
    let identity = try WireField.object(claims, "identity")
    switch identity["kind"] as? String {
    case "fresh": guard identity.count == 1 else { throw PhoneBrowserFailure.forbidden }
    case "profile-local":
      guard Set(identity.keys) == Set(["kind", "binding", "initialized", "readyUrl"]), PhoneBrowserValidation.boolean(identity["initialized"]),
        let url = identity["readyUrl"] as? String, url.utf16.count <= 8192,
        URLComponents(string: url)?.scheme != nil else { throw PhoneBrowserFailure.forbidden }
      try PhoneBrowserValidation.binding(WireField.object(identity, "binding"))
    default: throw PhoneBrowserFailure.forbidden
    }
    if let navigation = claims["initialNavigation"] as? [String: Any] {
      guard Set(navigation.keys).isSubset(of: Set(["operationKey", "url", "navigationId"])) else { throw PhoneBrowserFailure.forbidden }
      guard try WireField.string(navigation, "operationKey").utf16.count <= 255 else { throw PhoneBrowserFailure.forbidden }
      if let raw = navigation["url"] as? String {
        guard raw.utf16.count <= 8192, let url = URLComponents(string: raw), ["http", "https"].contains(url.scheme),
          url.host != nil, url.user == nil, url.password == nil else { throw PhoneBrowserFailure.forbidden }
      } else if navigation["url"] != nil { throw PhoneBrowserFailure.forbidden }
      if navigation["navigationId"] != nil, !PhoneBrowserValidation.uuid(navigation["navigationId"]) { throw PhoneBrowserFailure.forbidden }
    } else if claims["initialNavigation"] != nil { throw PhoneBrowserFailure.forbidden }
    if claims["initialSurfaceId"] != nil, !PhoneBrowserValidation.surface(claims["initialSurfaceId"]) { throw PhoneBrowserFailure.forbidden }
    if claims["dormantSurfaceIds"] != nil {
      guard let surfaces = claims["dormantSurfaceIds"] as? [String], surfaces.count <= 63,
        surfaces.allSatisfy({ PhoneBrowserValidation.surface($0) }) else { throw PhoneBrowserFailure.forbidden }
    }
    if claims["viewport"] != nil {
      let viewport = try WireField.object(claims, "viewport")
      let width = try WireField.int(viewport, "width", range: 1...7680)
      let height = try WireField.int(viewport, "height", range: 1...4320)
      guard viewport.count == 2, width * height <= 16_777_216 else { throw PhoneBrowserFailure.forbidden }
    }
  }
}
