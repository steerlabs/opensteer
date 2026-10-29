import CryptoKit
import Foundation

public enum CryptoError: Error, Equatable, Sendable {
  case invalidKeyLength
  case invalidNonce
  case invalidCiphertext
  /// Authentication failed: wrong key, wrong binding, or tampered bytes.
  case authenticationFailed
  case aadNotAnObject
  case invalidSignature
  case invalidPublicKey
}

/// AES-256-GCM with a fresh random 96-bit nonce per seal.
///
/// The AAD is always a canonical JSON binding object, taken as a `JSONValue`
/// so no caller can pass hand-built bytes.
public enum AEAD {
  public static let nonceSize = 12
  public static let tagSize = 16

  public struct Box: Sendable, Equatable {
    public let nonce: Data
    /// Ciphertext followed by the 16-byte tag.
    public let ciphertext: Data

    public init(nonce: Data, ciphertext: Data) {
      self.nonce = nonce
      self.ciphertext = ciphertext
    }
  }

  public static func seal(_ plaintext: Data, key: SymmetricKey, aad: JSONValue) throws -> Box {
    guard key.bitCount == 256 else { throw CryptoError.invalidKeyLength }
    let binding = try bindingBytes(aad)
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(), authenticating: binding)
    // CryptoKit's fields are slices of one buffer; copy so indices start at 0.
    var ciphertext = Data(sealed.ciphertext)
    ciphertext.append(contentsOf: sealed.tag)
    return Box(nonce: Data(sealed.nonce), ciphertext: ciphertext)
  }

  public static func open(_ box: Box, key: SymmetricKey, aad: JSONValue) throws -> Data {
    guard key.bitCount == 256 else { throw CryptoError.invalidKeyLength }
    guard box.nonce.count == nonceSize else { throw CryptoError.invalidNonce }
    guard box.ciphertext.count >= tagSize else { throw CryptoError.invalidCiphertext }
    let binding = try bindingBytes(aad)
    let sealed = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: box.nonce),
      ciphertext: box.ciphertext.prefix(box.ciphertext.count - tagSize),
      tag: box.ciphertext.suffix(tagSize)
    )
    do {
      // Returned as CryptoKit made it: a copy would leave one more buffer of
      // plaintext behind, unzeroed.
      return try AES.GCM.open(sealed, using: key, authenticating: binding)
    } catch CryptoKitError.authenticationFailure {
      throw CryptoError.authenticationFailed
    }
  }

  static func bindingBytes(_ aad: JSONValue) throws -> Data {
    guard case .object = aad else { throw CryptoError.aadNotAnObject }
    return try CanonicalJSON.encode(aad)
  }
}

extension SymmetricKey {
  /// A copy of the key's bytes, which the caller wipes when done with it.
  var rawBytes: Data { withUnsafeBytes { Data($0) } }
}

extension Data {
  /// Zeroes the bytes in place. Key and plaintext copies core makes are
  /// wiped before they are released; CryptoKit's own key storage wipes
  /// itself, and Swift strings (a decrypted password) cannot be wiped.
  mutating func wipe() {
    resetBytes(in: startIndex..<endIndex)
  }
}
