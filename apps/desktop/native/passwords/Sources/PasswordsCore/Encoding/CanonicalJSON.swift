import Foundation

/// RFC 8785 (JCS) for the integer-only subset, plus a strict parser.
///
/// Hashes and signatures are computed over these bytes, so there must be
/// exactly one encoding of each value.
public enum CanonicalJSON {
  public static let maxDepth = 32
  /// I-JSON's exact-integer range, so JavaScript reads the same numbers.
  public static let maxSafeInteger: Int64 = 9_007_199_254_740_991

  public static func encode(_ value: JSONValue) throws -> Data {
    var out: [UInt8] = []
    out.reserveCapacity(256)
    try write(value, into: &out)
    return Data(out)
  }

  /// Parses JSON strictly: valid UTF-8 without a BOM, no duplicate keys, only
  /// integers within ±(2^53−1), depth at most 32, nothing after the value.
  public static func parse(_ data: Data) throws -> JSONValue {
    try parse(data, maxArrayCount: .max, maxValues: .max)
  }

  /// `parse` that stops as soon as one array holds more than `maxArrayCount`
  /// elements or the document more than `maxValues` values, before the rest
  /// of a hostile document is built into a tree.
  public static func parse(_ data: Data, maxArrayCount: Int, maxValues: Int) throws -> JSONValue {
    let bytes = [UInt8](data)
    guard UTF8Text.decode(bytes) != nil else { throw JSONError.invalidUTF8 }
    var parser = Parser(bytes: bytes, maxArrayCount: maxArrayCount, maxValues: maxValues)
    parser.skipWhitespace()
    let value = try parser.parseValue(depth: 0)
    parser.skipWhitespace()
    guard parser.index == bytes.count else { throw JSONError.trailingData(offset: parser.index) }
    return value
  }

  /// Parses bytes that must already be canonical, as every stored vault file is.
  public static func parseCanonical(_ data: Data) throws -> JSONValue {
    let value = try parse(data)
    guard try encode(value) == data else { throw JSONError.notCanonical }
    return value
  }

  // MARK: Encoding

  private static func write(_ value: JSONValue, into out: inout [UInt8]) throws {
    switch value {
    case .null:
      out.append(contentsOf: Array("null".utf8))
    case .bool(let flag):
      out.append(contentsOf: Array((flag ? "true" : "false").utf8))
    case .integer(let number):
      guard number >= -maxSafeInteger, number <= maxSafeInteger else { throw JSONError.integerOutOfRange }
      out.append(contentsOf: Array(String(number).utf8))
    case .string(let text):
      writeString(text, into: &out)
    case .array(let elements):
      out.append(UInt8(ascii: "["))
      for (index, element) in elements.enumerated() {
        if index > 0 { out.append(UInt8(ascii: ",")) }
        try write(element, into: &out)
      }
      out.append(UInt8(ascii: "]"))
    case .object(let fields):
      out.append(UInt8(ascii: "{"))
      let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
      for (index, key) in keys.enumerated() {
        if index > 0 { out.append(UInt8(ascii: ",")) }
        writeString(key, into: &out)
        out.append(UInt8(ascii: ":"))
        try write(fields[key]!, into: &out)
      }
      out.append(UInt8(ascii: "}"))
    }
  }

  private static let hexDigits = Array("0123456789abcdef".utf8)

  private static func writeString(_ text: String, into out: inout [UInt8]) {
    out.append(UInt8(ascii: "\""))
    for byte in text.utf8 {
      switch byte {
      case 0x22: out.append(contentsOf: [0x5C, 0x22])
      case 0x5C: out.append(contentsOf: [0x5C, 0x5C])
      case 0x08: out.append(contentsOf: [0x5C, UInt8(ascii: "b")])
      case 0x09: out.append(contentsOf: [0x5C, UInt8(ascii: "t")])
      case 0x0A: out.append(contentsOf: [0x5C, UInt8(ascii: "n")])
      case 0x0C: out.append(contentsOf: [0x5C, UInt8(ascii: "f")])
      case 0x0D: out.append(contentsOf: [0x5C, UInt8(ascii: "r")])
      case 0x00..<0x20:
        out.append(contentsOf: Array("\\u00".utf8))
        out.append(hexDigits[Int(byte >> 4)])
        out.append(hexDigits[Int(byte & 0x0F)])
      default:
        out.append(byte)
      }
    }
    out.append(UInt8(ascii: "\""))
  }

  // MARK: Parsing

  private struct Parser {
    let bytes: [UInt8]
    let maxArrayCount: Int
    let maxValues: Int
    var index = 0
    var values = 0

    init(bytes: [UInt8], maxArrayCount: Int, maxValues: Int) {
      self.bytes = bytes
      self.maxArrayCount = maxArrayCount
      self.maxValues = maxValues
    }

    mutating func skipWhitespace() {
      while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    func peek() throws -> UInt8 {
      guard index < bytes.count else { throw JSONError.syntax(offset: index) }
      return bytes[index]
    }

    mutating func expect(_ literal: String) throws {
      for byte in literal.utf8 {
        guard index < bytes.count, bytes[index] == byte else { throw JSONError.syntax(offset: index) }
        index += 1
      }
    }

    mutating func parseValue(depth: Int) throws -> JSONValue {
      values += 1
      guard values <= maxValues else { throw JSONError.tooManyValues }
      switch try peek() {
      case UInt8(ascii: "{"): return try parseObject(depth: depth + 1)
      case UInt8(ascii: "["): return try parseArray(depth: depth + 1)
      case UInt8(ascii: "\""): return .string(try parseString())
      case UInt8(ascii: "t"): try expect("true"); return .bool(true)
      case UInt8(ascii: "f"): try expect("false"); return .bool(false)
      case UInt8(ascii: "n"): try expect("null"); return .null
      case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .integer(try parseInteger())
      default: throw JSONError.syntax(offset: index)
      }
    }

    mutating func parseObject(depth: Int) throws -> JSONValue {
      guard depth <= CanonicalJSON.maxDepth else { throw JSONError.tooDeep }
      index += 1
      var fields: [String: JSONValue] = [:]
      skipWhitespace()
      if try peek() == UInt8(ascii: "}") {
        index += 1
        return .object(fields)
      }
      while true {
        skipWhitespace()
        guard try peek() == UInt8(ascii: "\"") else { throw JSONError.syntax(offset: index) }
        let key = try parseString()
        // Swift dictionaries compare keys up to canonical equivalence, so this
        // also refuses keys that differ only in Unicode normalisation.
        guard fields[key] == nil else { throw JSONError.duplicateKey(key) }
        skipWhitespace()
        try expect(":")
        skipWhitespace()
        fields[key] = try parseValue(depth: depth)
        skipWhitespace()
        let next = try peek()
        index += 1
        if next == UInt8(ascii: "}") { return .object(fields) }
        guard next == UInt8(ascii: ",") else { throw JSONError.syntax(offset: index - 1) }
      }
    }

    mutating func parseArray(depth: Int) throws -> JSONValue {
      guard depth <= CanonicalJSON.maxDepth else { throw JSONError.tooDeep }
      index += 1
      var elements: [JSONValue] = []
      skipWhitespace()
      if try peek() == UInt8(ascii: "]") {
        index += 1
        return .array(elements)
      }
      while true {
        skipWhitespace()
        elements.append(try parseValue(depth: depth))
        guard elements.count <= maxArrayCount else { throw JSONError.arrayTooLong }
        skipWhitespace()
        let next = try peek()
        index += 1
        if next == UInt8(ascii: "]") { return .array(elements) }
        guard next == UInt8(ascii: ",") else { throw JSONError.syntax(offset: index - 1) }
      }
    }

    mutating func parseInteger() throws -> Int64 {
      let start = index
      var negative = false
      if bytes[index] == UInt8(ascii: "-") {
        negative = true
        index += 1
      }
      let digitsStart = index
      while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
      let digits = bytes[digitsStart..<index]
      guard !digits.isEmpty else { throw JSONError.syntax(offset: start) }
      if index < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[index]) {
        throw JSONError.nonInteger(offset: start)
      }
      guard digits.count == 1 || digits.first != UInt8(ascii: "0") else { throw JSONError.syntax(offset: start) }
      guard digits.count <= 16 else { throw JSONError.integerOutOfRange }
      var value: Int64 = 0
      for digit in digits { value = value * 10 + Int64(digit - UInt8(ascii: "0")) }
      guard value <= CanonicalJSON.maxSafeInteger else { throw JSONError.integerOutOfRange }
      if negative {
        // `-0` is a second spelling of 0.
        guard value != 0 else { throw JSONError.nonInteger(offset: start) }
        return -value
      }
      return value
    }

    mutating func parseString() throws -> String {
      let start = index
      index += 1
      var out: [UInt8] = []
      while true {
        guard index < bytes.count else { throw JSONError.syntax(offset: start) }
        let byte = bytes[index]
        index += 1
        switch byte {
        case UInt8(ascii: "\""):
          return String(decoding: out, as: UTF8.self)
        case UInt8(ascii: "\\"):
          guard index < bytes.count else { throw JSONError.syntax(offset: index) }
          let escape = bytes[index]
          index += 1
          switch escape {
          case UInt8(ascii: "\""): out.append(0x22)
          case UInt8(ascii: "\\"): out.append(0x5C)
          case UInt8(ascii: "/"): out.append(0x2F)
          case UInt8(ascii: "b"): out.append(0x08)
          case UInt8(ascii: "f"): out.append(0x0C)
          case UInt8(ascii: "n"): out.append(0x0A)
          case UInt8(ascii: "r"): out.append(0x0D)
          case UInt8(ascii: "t"): out.append(0x09)
          case UInt8(ascii: "u"):
            let scalar = try parseUnicodeEscape()
            out.append(contentsOf: Array(String(Character(scalar)).utf8))
          default:
            throw JSONError.syntax(offset: index - 1)
          }
        case 0x00..<0x20:
          throw JSONError.syntax(offset: index - 1)
        default:
          out.append(byte)
        }
      }
    }

    mutating func parseHex4() throws -> UInt32 {
      guard index + 4 <= bytes.count else { throw JSONError.syntax(offset: index) }
      var value: UInt32 = 0
      for byte in bytes[index..<index + 4] {
        guard let digit = Hex.value(of: byte, allowUpper: true) else { throw JSONError.syntax(offset: index) }
        value = value << 4 | UInt32(digit)
      }
      index += 4
      return value
    }

    mutating func parseUnicodeEscape() throws -> Unicode.Scalar {
      let first = try parseHex4()
      if (0xD800...0xDBFF).contains(first) {
        guard index + 2 <= bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") else {
          throw JSONError.syntax(offset: index)
        }
        index += 2
        let second = try parseHex4()
        guard (0xDC00...0xDFFF).contains(second) else { throw JSONError.syntax(offset: index) }
        let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
        guard let scalar = Unicode.Scalar(combined) else { throw JSONError.syntax(offset: index) }
        return scalar
      }
      guard let scalar = Unicode.Scalar(first) else { throw JSONError.syntax(offset: index) }
      return scalar
    }
  }
}

/// Strict UTF-8 decoding: Swift's decoder replaces invalid sequences, so a
/// lossless decode is one whose bytes come back unchanged.
enum UTF8Text {
  static func decode<Bytes: Collection>(_ bytes: Bytes) -> String? where Bytes.Element == UInt8 {
    let text = String(decoding: bytes, as: UTF8.self)
    return text.utf8.elementsEqual(bytes) ? text : nil
  }
}

extension String {
  /// Exact comparison of the stored bytes. `==` would treat NFC and NFD
  /// spellings of a password as the same, but a website does not.
  func sameBytes(as other: String) -> Bool {
    utf8.elementsEqual(other.utf8)
  }
}
