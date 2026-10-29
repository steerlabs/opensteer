import Foundation

/// RFC 4648 §6 base32, as TOTP secrets are written.
enum Base32 {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".utf8)

  /// Case-insensitive; padding optional but, when present, complete and only
  /// at the end. Non-zero trailing bits are accepted because authenticator
  /// apps accept them, and the bytes they decode to are what codes use.
  static func decode(_ text: String) -> Data? {
    var chars = Array(text.utf8)
    if let firstPad = chars.firstIndex(of: UInt8(ascii: "=")) {
      guard chars.count % 8 == 0, chars[firstPad...].allSatisfy({ $0 == UInt8(ascii: "=") }) else { return nil }
      let padding = chars.count - firstPad
      guard [1, 3, 4, 6].contains(padding) else { return nil }
      chars.removeLast(padding)
    }
    guard !chars.isEmpty, [0, 2, 4, 5, 7].contains(chars.count % 8) else { return nil }
    var out: [UInt8] = []
    var buffer: UInt32 = 0
    var bits = 0
    for char in chars {
      let upper = (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(char) ? char - 32 : char
      guard let value = alphabet.firstIndex(of: upper) else { return nil }
      buffer = buffer << 5 | UInt32(value)
      bits += 5
      if bits >= 8 {
        bits -= 8
        out.append(UInt8(buffer >> UInt32(bits) & 0xFF))
      }
    }
    return Data(out)
  }

  static func encode(_ data: Data) -> String {
    var out: [UInt8] = []
    var buffer: UInt32 = 0
    var bits = 0
    for byte in data {
      buffer = buffer << 8 | UInt32(byte)
      bits += 8
      while bits >= 5 {
        bits -= 5
        out.append(alphabet[Int(buffer >> UInt32(bits) & 31)])
      }
    }
    if bits > 0 { out.append(alphabet[Int(buffer << UInt32(5 - bits) & 31)]) }
    return String(decoding: out, as: UTF8.self)
  }
}
