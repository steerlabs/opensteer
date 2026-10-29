import Foundation
import PasswordsCore

/// The value rules of `packages/protocol/src/passwords-broker.ts`, spelled the
/// way zod checks them, plus the broker's own stricter rules where a value
/// decides what is released.
enum WireRules {
  /// `z.string().max(n)` counts UTF-16 code units, as JavaScript does.
  static func length(_ text: String, within range: ClosedRange<Int>) -> Bool {
    range.contains(text.utf16.count)
  }

  /// `z.string().trim().min(1).max(n)`: the desktop sends values zod already
  /// trimmed, so one with JavaScript whitespace at either end is malformed.
  static func trimmedText(_ text: String, max: Int) -> Bool {
    guard let first = text.unicodeScalars.first, let last = text.unicodeScalars.last else { return false }
    return !isJavaScriptWhitespace(first) && !isJavaScriptWhitespace(last) && length(text, within: 1...max)
  }

  /// `String.prototype.trim`'s set: WhiteSpace and LineTerminator.
  static func isJavaScriptWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
      0xFEFF:
      return true
    default:
      return false
    }
  }

  /// zod 4's `z.uuid()`: RFC 9562 versions 1–8 with the RFC variant, or the
  /// nil and max UUIDs; either case.
  static func isUUID(_ text: String) -> Bool {
    let bytes = Array(text.utf8)
    guard bytes.count == 36 else { return false }
    for (index, byte) in bytes.enumerated() {
      if [8, 13, 18, 23].contains(index) {
        guard byte == UInt8(ascii: "-") else { return false }
      } else {
        guard Hex.isHexDigit(byte) else { return false }
      }
    }
    let lower = text.lowercased()
    if lower == "00000000-0000-0000-0000-000000000000" || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
      return true
    }
    let version = bytes[14]
    let variant = Character(Unicode.Scalar(bytes[19])).lowercased()
    return (UInt8(ascii: "1")...UInt8(ascii: "8")).contains(version) && ["8", "9", "a", "b"].contains(variant)
  }

  /// zod 4's `z.iso.datetime({ offset: true })`: a valid calendar date, `T`,
  /// `HH:MM` with optional seconds and fraction, then `Z` or `±HH:MM`.
  static func isoDate(_ text: String) -> Date? {
    let bytes = Array(text.utf8)
    var index = 0
    func digits(_ count: Int) -> Int? {
      guard index + count <= bytes.count else { return nil }
      var value = 0
      for byte in bytes[index..<(index + count)] {
        guard (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) else { return nil }
        value = value * 10 + Int(byte - UInt8(ascii: "0"))
      }
      index += count
      return value
    }
    func literal(_ character: Character) -> Bool {
      guard index < bytes.count, bytes[index] == character.asciiValue else { return false }
      index += 1
      return true
    }
    guard let year = digits(4), literal("-"), let month = digits(2), literal("-"), let day = digits(2),
      literal("T"), let hour = digits(2), literal(":"), let minute = digits(2)
    else { return nil }
    var second = 0
    var fraction = 0.0
    if literal(":") {
      guard let parsed = digits(2) else { return nil }
      second = parsed
      if literal(".") {
        let start = index
        while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
        guard index > start, let value = Double("0." + String(decoding: bytes[start..<index], as: UTF8.self)) else {
          return nil
        }
        fraction = value
      }
    }
    var offsetSeconds = 0
    if literal("Z") {
    } else if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
      let sign = bytes[index] == UInt8(ascii: "-") ? -1 : 1
      index += 1
      guard let offsetHour = digits(2), literal(":"), let offsetMinute = digits(2), offsetHour <= 23,
        offsetMinute <= 59
      else { return nil }
      offsetSeconds = sign * (offsetHour * 3_600 + offsetMinute * 60)
    } else {
      return nil
    }
    guard index == bytes.count, hour <= 23, minute <= 59, second <= 59 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    guard components.isValidDate(in: calendar), let date = calendar.date(from: components) else { return nil }
    return date.addingTimeInterval(fraction - Double(offsetSeconds))
  }

  /// The site a sign-in is for, as the Host sends it: exactly
  /// `https://<registrable domain>`. `BrowserSiteSchema` also admits `http:`,
  /// IP literals and subdomains; none of them is a site a saved password can
  /// be released for. Returns the host.
  static func site(_ text: String) -> String? {
    guard length(text, within: 1...300), Origins.isSite(text) else { return nil }
    return String(text.dropFirst("https://".count))
  }

  /// `WorkspaceIdSchema`: `wsp_` and an RFC 9562 UUID (versions 1–8, the RFC
  /// variant), matched case-insensitively as its regular expression is.
  static func workspaceId(_ text: String) -> Bool {
    let bytes = Array(text.utf8)
    guard bytes.count == 40, String(decoding: bytes[0..<4], as: UTF8.self).lowercased() == "wsp_" else { return false }
    let uuid = String(decoding: bytes[4...], as: UTF8.self).lowercased()
    guard isUUID(uuid), uuid != "00000000-0000-0000-0000-000000000000", uuid != "ffffffff-ffff-ffff-ffff-ffffffffffff"
    else { return false }
    return true
  }

  /// `PasswordsOriginSchema`, held to the vault's own origin rules.
  static func origin(_ text: String) -> Bool {
    length(text, within: 1...2_048) && Origins.normalizeOrigin(text) == text
  }
}

extension Hex {
  static func isHexDigit(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
      || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(byte)
  }
}
