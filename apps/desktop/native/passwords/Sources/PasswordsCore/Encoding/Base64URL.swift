import Foundation

/// RFC 4648 §5 base64url without padding. Decoding accepts exactly one
/// spelling per value: no padding, no foreign characters, zero trailing bits.
public enum Base64URL {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
  private static let reverse: [UInt8: UInt8] = {
    var table: [UInt8: UInt8] = [:]
    for (index, byte) in alphabet.enumerated() { table[byte] = UInt8(index) }
    return table
  }()

  public static func encode(_ data: Data) -> String {
    let bytes = [UInt8](data)
    var out: [UInt8] = []
    out.reserveCapacity((bytes.count * 4 + 2) / 3)
    var index = 0
    while index + 3 <= bytes.count {
      let chunk = UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2])
      out.append(alphabet[Int(chunk >> 18 & 63)])
      out.append(alphabet[Int(chunk >> 12 & 63)])
      out.append(alphabet[Int(chunk >> 6 & 63)])
      out.append(alphabet[Int(chunk & 63)])
      index += 3
    }
    switch bytes.count - index {
    case 1:
      let chunk = UInt32(bytes[index]) << 16
      out.append(alphabet[Int(chunk >> 18 & 63)])
      out.append(alphabet[Int(chunk >> 12 & 63)])
    case 2:
      let chunk = UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8
      out.append(alphabet[Int(chunk >> 18 & 63)])
      out.append(alphabet[Int(chunk >> 12 & 63)])
      out.append(alphabet[Int(chunk >> 6 & 63)])
    default:
      break
    }
    return String(decoding: out, as: UTF8.self)
  }

  public static func decode(_ text: String) -> Data? {
    let chars = Array(text.utf8)
    guard chars.count % 4 != 1 else { return nil }
    var values: [UInt8] = []
    values.reserveCapacity(chars.count)
    for char in chars {
      guard let value = reverse[char] else { return nil }
      values.append(value)
    }
    var out: [UInt8] = []
    out.reserveCapacity(chars.count * 3 / 4)
    var index = 0
    while index + 4 <= values.count {
      let chunk = UInt32(values[index]) << 18 | UInt32(values[index + 1]) << 12 | UInt32(values[index + 2]) << 6 | UInt32(values[index + 3])
      out.append(UInt8(chunk >> 16 & 0xFF))
      out.append(UInt8(chunk >> 8 & 0xFF))
      out.append(UInt8(chunk & 0xFF))
      index += 4
    }
    switch values.count - index {
    case 2:
      guard values[index + 1] & 0x0F == 0 else { return nil }
      out.append(values[index] << 2 | values[index + 1] >> 4)
    case 3:
      guard values[index + 2] & 0x03 == 0 else { return nil }
      out.append(values[index] << 2 | values[index + 1] >> 4)
      out.append((values[index + 1] & 0x0F) << 4 | values[index + 2] >> 2)
    default:
      break
    }
    return Data(out)
  }
}
