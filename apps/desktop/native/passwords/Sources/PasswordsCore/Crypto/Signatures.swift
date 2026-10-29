import CryptoKit
import Foundation

/// Key IDs name keys in commits: SHA-256 hex of the X9.63 public key.
public enum KeyID {
  public static func of(_ key: P256.KeyAgreement.PublicKey) -> String {
    Hex.sha256(key.x963Representation)
  }

  public static func of(_ key: P256.Signing.PublicKey) -> String {
    Hex.sha256(key.x963Representation)
  }
}

/// ECDSA P-256 over SHA-256 with raw 64-byte `r‖s` signatures, low-S only.
///
/// CryptoKit accepts both `s` and `n − s`. Commit hashes include the
/// signature, so accepting both would give one signed commit two hashes.
enum ECDSA {
  static let signatureSize = 64
  private static let order: [UInt8] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
  ]
  private static let halfOrder: [UInt8] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42, 0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8,
  ]

  static func isLowS(_ signature: Data) -> Bool {
    guard signature.count == signatureSize else { return false }
    let s = [UInt8](signature.suffix(32))
    return s == halfOrder || s.lexicographicallyPrecedes(halfOrder)
  }

  static func normalizedLowS(_ signature: Data) throws -> Data {
    guard signature.count == signatureSize else { throw CryptoError.invalidSignature }
    if isLowS(signature) { return Data(signature) }
    let s = [UInt8](signature.suffix(32))
    var negated = [UInt8](repeating: 0, count: 32)
    var borrow = 0
    for index in stride(from: 31, through: 0, by: -1) {
      var digit = Int(order[index]) - Int(s[index]) - borrow
      borrow = digit < 0 ? 1 : 0
      if digit < 0 { digit += 256 }
      negated[index] = UInt8(digit)
    }
    return Data(signature.prefix(32)) + Data(negated)
  }

  static func isValid(_ signature: Data, for message: Data, by key: P256.Signing.PublicKey) -> Bool {
    guard isLowS(signature), let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else {
      return false
    }
    return key.isValidSignature(parsed, for: message)
  }
}
