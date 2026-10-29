import Foundation

/// Just enough of Apple's `typedstream` (NSArchiver) format to recover the
/// text of a Messages row whose `text` column is null.
///
/// Modern Messages writes the body into `attributedBody`, an NSArchiver
/// archive of an `NSAttributedString`:
///
/// ```
/// 04 0b "streamtyped" 81 e8 03 84 01 40
/// 84 84 84 12 "NSAttributedString" 00 84 84 08 "NSObject" 00 85
/// 92 84 84 84 08 "NSString" 01 94 84 01 2b <length> <utf8 bytes> ...
/// ```
///
/// `84 01 2b` is the type encoding `"+"`, the char array carrying the string's
/// bytes; `<length>` is one byte below 0x81, or 0x81 and a little-endian
/// uint16, or 0x82 and a little-endian uint32. An edited message's chain reads
/// `NSMutableString` → `NSString`, which changes only the bytes before the
/// marker. This reads that one payload and nothing else, and never throws: a
/// variant nobody anticipated costs a body, never a row.
enum TypedStream {
  private static let header: [UInt8] = [0x04, 0x0b] + Array("streamtyped".utf8)
  /// The payload follows this class name whether the string is mutable or not.
  private static let className = Array("NSString".utf8)
  /// How far past the class name the `"+"` marker may sit.
  private static let markerWindow = 32

  static func text(_ bytes: [UInt8]) -> String? {
    guard bytes.count >= header.count + className.count, bytes.starts(with: header) else {
      return nil
    }
    guard let classIndex = find(className, in: bytes, from: header.count) else { return nil }
    let markerFrom = classIndex + className.count
    let markerLimit = min(bytes.count, markerFrom + markerWindow)
    var cursor: Int?
    var index = markerFrom
    while index + 2 < markerLimit {
      if bytes[index] == 0x84 && bytes[index + 1] == 0x01 && bytes[index + 2] == 0x2b {
        cursor = index + 3
        break
      }
      index += 1
    }
    guard var at = cursor, at < bytes.count else { return nil }
    let length: Int
    switch bytes[at] {
    case 0..<0x81:
      length = Int(bytes[at])
      at += 1
    case 0x81:
      guard at + 2 < bytes.count else { return nil }
      length = Int(bytes[at + 1]) | Int(bytes[at + 2]) << 8
      at += 3
    case 0x82:
      guard at + 4 < bytes.count else { return nil }
      length =
        Int(bytes[at + 1]) | Int(bytes[at + 2]) << 8 | Int(bytes[at + 3]) << 16
        | Int(bytes[at + 4]) << 24
      at += 5
    default:
      // 0x83 is a 64-bit length, which no message body has.
      return nil
    }
    guard length <= bytes.count - at else { return nil }
    // Lenient, so one truncated code point costs a character, not the body.
    return String(decoding: bytes[at..<(at + length)], as: UTF8.self)
  }

  private static func find(_ needle: [UInt8], in bytes: [UInt8], from start: Int) -> Int? {
    guard needle.count <= bytes.count else { return nil }
    var index = start
    while index + needle.count <= bytes.count {
      if bytes[index..<(index + needle.count)].elementsEqual(needle) { return index }
      index += 1
    }
    return nil
  }
}
