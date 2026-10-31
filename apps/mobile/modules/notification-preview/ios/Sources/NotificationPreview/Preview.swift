import Foundation
import CoreFoundation
import CryptoKit

public enum PreviewError: Error { case invalid }
public struct PreviewText: Decodable { public let version: Int; public let title: String; public let body: String }
public enum Preview {
  public static func decode(_ value: String, count: ClosedRange<Int>) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
      let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)),
      count.contains(data.count), encode(data) == value else { throw PreviewError.invalid }
    return data
  }
  public static func encode(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
  public static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) }
  public static func aad(_ fields: [String: String], keyId: String) throws -> Data {
    try json(["opensteer-notification-preview-v1"] + ["deploymentId", "notificationId", "installationId"].map { fields[$0] ?? "" } + [keyId] + ["kind", "deepLink", "expiresAt"].map { fields[$0] ?? "" })
  }
  public static func validateRoute(_ f: [String: String], now: Date = Date()) throws {
    guard f.values.allSatisfy({ $0.utf8.count <= 4096 }),
      let dep = f["deploymentId"], let thread = f["threadId"], let kind = f["kind"],
      dep.range(of: "^dep_[0-9a-f-]{36}$", options: .regularExpression) != nil,
      thread.range(of: "^thr_[0-9a-f-]{36}$", options: .regularExpression) != nil,
      let link = f["deepLink"], let url = URLComponents(string: link), url.scheme == "com.opensteer.mobile", url.host == nil,
      url.path == "/deployments/\(dep)/threads/\(thread)", url.fragment == nil,
      let expiry = f["expiresAt"], expiry.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil else { throw PreviewError.invalid }
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: expiry), date > now, formatter.string(from: date) == expiry else { throw PreviewError.invalid }
    let name: String?
    switch kind { case "reply-published": name = "messageId"; case "request-opened": name = "requestId"; case "run-failed": name = nil; default: throw PreviewError.invalid }
    if let name {
      let prefix = name == "messageId" ? "msg" : "req"
      guard let anchor = f[name], anchor.range(of: "^\(prefix)_[0-9a-f-]{36}$", options: .regularExpression) != nil, url.queryItems == [URLQueryItem(name: name, value: anchor)] else { throw PreviewError.invalid }
    } else if url.query != nil { throw PreviewError.invalid }
  }
  public static func open(_ fields: [String: String], key: String?, marker: String, recordMarker: String, now: Date = Date()) throws -> PreviewText {
    try validateRoute(fields, now: now)
    guard marker == recordMarker, !marker.isEmpty, let key, let raw = fields["preview"], raw.utf8.count <= 4096,
      let data = raw.data(using: .utf8), let env = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(env.keys) == Set(["version", "keyId", "nonce", "ciphertext"]), (env["version"] as? NSNumber) == 1,
      CFGetTypeID(env["version"] as CFTypeRef) != CFBooleanGetTypeID(), let keyId = env["keyId"] as? String, let nonce = env["nonce"] as? String, let cipher = env["ciphertext"] as? String else { throw PreviewError.invalid }
    _ = try decode(keyId, count: 16...16)
    let sealed = try decode(cipher, count: 17...2064)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: decode(nonce, count: 12...12)), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
    let plain = try AES.GCM.open(box, using: SymmetricKey(data: decode(key, count: 32...32)), authenticating: aad(fields, keyId: keyId))
    guard plain.count <= 2048, String(data: plain, encoding: .utf8) != nil,
      let object = try JSONSerialization.jsonObject(with: plain) as? [String: Any], Set(object.keys) == Set(["version", "title", "body"]),
      let title = object["title"] as? String, let body = object["body"] as? String,
      (1...120).contains(title.utf16.count), (1...180).contains(body.utf16.count), CFGetTypeID(object["version"] as CFTypeRef) != CFBooleanGetTypeID() else { throw PreviewError.invalid }
    let text = try JSONDecoder().decode(PreviewText.self, from: plain)
    guard text.version == 1 else { throw PreviewError.invalid }; return text
  }
}
