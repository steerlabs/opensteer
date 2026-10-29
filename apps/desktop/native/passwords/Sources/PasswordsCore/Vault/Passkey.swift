import CryptoKit
import Foundation

/// A stored credential. Only the reader constructs these until a writer ships.
public struct Passkey: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
  public let credentialId: Data
  public let rpId: String
  public let userHandle: Data
  public let userName: String
  public let userDisplayName: String
  public let createdAt: Int64
  private let privateKey: String

  public var description: String { "Passkey(<redacted>)" }
  public var debugDescription: String { description }

  init(json: JSONValue) throws {
    let object = try StrictObject(json, keys: ["algorithm", "createdAt", "credentialId", "privateKey", "rpId", "userDisplayName", "userHandle", "userName", "v"], context: "passkey")
    guard try object.integer("v") == 1, try object.integer("algorithm") == -7 else {
      throw VaultError.invalidItem("unsupported passkey version or algorithm")
    }
    credentialId = try object.bytes("credentialId")
    userHandle = try object.bytes("userHandle")
    rpId = try object.string("rpId")
    userName = try object.string("userName")
    userDisplayName = try object.string("userDisplayName")
    createdAt = try object.integer("createdAt")
    privateKey = try object.string("privateKey")
    var bytes = try object.bytes("privateKey")
    defer { bytes.wipe() }
    do { _ = try P256.Signing.PrivateKey(derRepresentation: bytes) } catch {
      throw VaultError.invalidItem("invalid passkey private key")
    }
  }

  func validate(origins: [String]) throws {
    guard (16...1023).contains(credentialId.count), (1...64).contains(userHandle.count),
      userName.utf8.count <= 1024, userDisplayName.utf8.count <= 1024
    else { throw VaultError.invalidItem("passkey fields exceed their limits") }
    let origin = "https://" + rpId
    guard Origins.normalizeOrigin(origin)?.sameBytes(as: origin) == true,
      !rpId.contains(":"), !rpId.contains("/"), !rpId.contains("?"), !rpId.contains("#"),
      let site = Origins.site(ofOrigin: origin), origins.contains(where: { Origins.site(ofOrigin: $0) == site })
    else { throw VaultError.invalidPasskeyOrigins }
  }

  var json: JSONValue {
    .object([
      "algorithm": .integer(-7), "createdAt": .integer(createdAt),
      "credentialId": .string(Base64URL.encode(credentialId)), "privateKey": .string(privateKey),
      "rpId": .string(rpId), "userDisplayName": .string(userDisplayName),
      "userHandle": .string(Base64URL.encode(userHandle)), "userName": .string(userName), "v": .integer(1),
    ])
  }
}
