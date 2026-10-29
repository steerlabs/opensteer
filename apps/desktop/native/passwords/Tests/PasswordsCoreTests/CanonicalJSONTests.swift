import XCTest
@testable import PasswordsCore

final class CanonicalJSONTests: XCTestCase {
  private func canonical(_ json: String) throws -> String {
    String(decoding: try CanonicalJSON.encode(try CanonicalJSON.parse(Data(json.utf8))), as: UTF8.self)
  }

  /// RFC 8785 §3.2.2 with the number array removed: this subset has no floats.
  func testRFC8785Vectors() throws {
    let input = #"{"string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}"#
    XCTAssertEqual(try canonical(input), #"{"literals":[null,true,false],"string":"€$\u000f\nA'B\"\\\\\"/"}"#)
    XCTAssertEqual(try canonical(#"{"b":[1,-2,{"z":0,"a":9007199254740991}],"a":"\b\f\t\r\u0001\u007f\u2028"}"#),
                   "{\"a\":\"\\b\\f\\t\\r\\u0001\u{7F}\u{2028}\",\"b\":[1,-2,{\"a\":9007199254740991,\"z\":0}]}")
    XCTAssertEqual(try canonical("  [ ]  "), "[]")
    XCTAssertEqual(try canonical("{ }"), "{}")
  }

  /// RFC 8785 §3.2.3: keys sort by UTF-16 code units, so U+1F600 (a
  /// surrogate pair starting D83D) sorts before U+FB33.
  func testKeysSortByUTF16CodeUnits() throws {
    let input = #"{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}"#
    let expected = "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u{80}\":\"Control\",\"\u{F6}\":\"Latin Small Letter O With Diaeresis\",\"\u{20AC}\":\"Euro Sign\",\"\u{1F600}\":\"Emoji: Grinning Face\",\"\u{FB33}\":\"Hebrew Letter Dalet With Dagesh\"}"
    XCTAssertEqual(try canonical(input), expected)
  }

  func testDuplicateKeysRejected() {
    XCTAssertThrowsError(try CanonicalJSON.parse(Data(#"{"a":1,"a":2}"#.utf8))) { error in
      XCTAssertEqual(error as? JSONError, .duplicateKey("a"))
    }
    XCTAssertThrowsError(try CanonicalJSON.parse(Data(#"{"a":{"b":1,"b":1}}"#.utf8)))
    // Escaped and literal spellings of one key are the same key.
    XCTAssertThrowsError(try CanonicalJSON.parse(Data(#"{"a":1,"\u0061":2}"#.utf8)))
  }

  func testNonIntegerNumbersRejected() {
    for text in ["1.0", "1e3", "1E3", "-0", "0.5", "[1.5]", "{\"a\":2e-3}"] {
      XCTAssertThrowsError(try CanonicalJSON.parse(Data(text.utf8)), text) { error in
        guard case .nonInteger = error as? JSONError else { return XCTFail("\(text): \(error)") }
      }
    }
    for text in ["01", "-", "+1", ".5", "0x10", "NaN", "Infinity"] {
      XCTAssertThrowsError(try CanonicalJSON.parse(Data(text.utf8)), text)
    }
  }

  func testIntegerRange() throws {
    XCTAssertEqual(try CanonicalJSON.parse(Data("9007199254740991".utf8)), .integer(9_007_199_254_740_991))
    XCTAssertEqual(try CanonicalJSON.parse(Data("-9007199254740991".utf8)), .integer(-9_007_199_254_740_991))
    for text in ["9007199254740992", "-9007199254740992", "123456789012345678901"] {
      XCTAssertThrowsError(try CanonicalJSON.parse(Data(text.utf8)), text) { error in
        XCTAssertEqual(error as? JSONError, .integerOutOfRange)
      }
    }
    XCTAssertThrowsError(try CanonicalJSON.encode(.integer(Int64.max)))
  }

  func testTrailingDataRejected() {
    for text in ["{} {}", "1 2", "[]x", "null,", "\"a\"\""] {
      XCTAssertThrowsError(try CanonicalJSON.parse(Data(text.utf8)), text)
    }
    XCTAssertNoThrow(try CanonicalJSON.parse(Data("{}\n".utf8)))
  }

  func testDepthLimit() {
    let ok = String(repeating: "[", count: 32) + String(repeating: "]", count: 32)
    let deep = String(repeating: "[", count: 33) + String(repeating: "]", count: 33)
    XCTAssertNoThrow(try CanonicalJSON.parse(Data(ok.utf8)))
    XCTAssertThrowsError(try CanonicalJSON.parse(Data(deep.utf8))) { error in
      XCTAssertEqual(error as? JSONError, .tooDeep)
    }
    let deepObjects = String(repeating: "{\"a\":", count: 33) + "1" + String(repeating: "}", count: 33)
    XCTAssertThrowsError(try CanonicalJSON.parse(Data(deepObjects.utf8)))
  }

  func testInvalidStringsRejected() {
    let cases: [(String, Data)] = [
      ("invalid UTF-8", Data([0x22, 0xC3, 0x28, 0x22])),
      ("overlong", Data([0x22, 0xC0, 0xAF, 0x22])),
      ("BOM", Data([0xEF, 0xBB, 0xBF]) + Data("{}".utf8)),
      ("lone high surrogate", Data(#""\ud800""#.utf8)),
      ("lone low surrogate", Data(#""\udc00""#.utf8)),
      ("raw newline", Data("\"a\nb\"".utf8)),
      ("raw tab", Data("\"a\tb\"".utf8)),
      ("bad escape", Data(#""\x""#.utf8)),
      ("short unicode escape", Data(#""\u12""#.utf8)),
      ("unterminated", Data(#""abc"#.utf8)),
    ]
    for (name, data) in cases {
      XCTAssertThrowsError(try CanonicalJSON.parse(data), name)
    }
  }

  func testParseCanonicalRejectsNonCanonical() throws {
    XCTAssertNoThrow(try CanonicalJSON.parseCanonical(Data(#"{"a":1,"b":[true]}"#.utf8)))
    for text in [#"{"b":1,"a":2}"#, #"{"a": 1}"#, #"{"a":"\u0041"}"#, #"{"a":"\/"}"#, "{\"a\":1}\n"] {
      XCTAssertThrowsError(try CanonicalJSON.parseCanonical(Data(text.utf8)), text) { error in
        XCTAssertEqual(error as? JSONError, .notCanonical, text)
      }
    }
  }

  func testStringBytesSurviveRoundTrip() throws {
    let nfd = "  pa\u{0308}ssword\u{0301} "
    let nfc = "  p\u{E4}ssword\u{301} "
    let encoded = try CanonicalJSON.encode(.object(["p": .string(nfd)]))
    guard case .object(let fields) = try CanonicalJSON.parseCanonical(encoded), case .string(let decoded)? = fields["p"] else {
      return XCTFail("shape")
    }
    XCTAssertTrue(decoded.utf8.elementsEqual(nfd.utf8))
    XCTAssertFalse(decoded.utf8.elementsEqual(nfc.utf8))
  }
}
