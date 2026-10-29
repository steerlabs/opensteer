import Foundation

/// Case folding for parsers: ASCII letters only. Unicode case mapping turns
/// `ſ` (long s) into `S` and `K` (Kelvin) into `k`, so a parser that folds
/// with it accepts spellings no other implementation would.
enum ASCII {
  static func lowercased(_ text: String) -> String {
    String(String.UnicodeScalarView(text.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 }))
  }

  static func uppercased(_ text: String) -> String {
    String(String.UnicodeScalarView(text.unicodeScalars.map { ("a"..."z").contains($0) ? Unicode.Scalar($0.value - 32)! : $0 }))
  }

  static func isLetter(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
  }

  static func isDigit(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
  }
}
