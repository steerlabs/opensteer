import CryptoKit
import Foundation

/// Lower-case hex, the only spelling of hashes and key IDs.
public enum Hex {
  private static let digits = Array("0123456789abcdef".utf8)

  public static func encode<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
    var out: [UInt8] = []
    for byte in bytes {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0F)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Decodes lower-case, even-length hex only.
  public static func decode(_ text: String) -> Data? {
    let chars = Array(text.utf8)
    guard chars.count % 2 == 0 else { return nil }
    var out: [UInt8] = []
    out.reserveCapacity(chars.count / 2)
    var index = 0
    while index < chars.count {
      guard let high = value(of: chars[index], allowUpper: false), let low = value(of: chars[index + 1], allowUpper: false) else {
        return nil
      }
      out.append(high << 4 | low)
      index += 2
    }
    return Data(out)
  }

  static func value(of byte: UInt8, allowUpper: Bool) -> UInt8? {
    switch byte {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F") where allowUpper: return byte - UInt8(ascii: "A") + 10
    default: return nil
    }
  }

  /// A SHA-256 digest as 64 lower-case hex characters.
  public static func sha256(_ data: Data) -> String {
    encode(SHA256.hash(data: data))
  }

  static func isSHA256(_ text: String) -> Bool {
    text.utf8.count == 64 && decode(text) != nil
  }
}
