import XCTest
@testable import PasswordsCore

final class TOTPTests: XCTestCase {
  /// RFC 6238 Appendix B, 8 digits, 30-second steps.
  func testRFC6238Vectors() throws {
    let sha1 = try TOTPParameters(secret: Data("12345678901234567890".utf8), algorithm: .sha1, digits: 8, period: 30)
    let sha256 = try TOTPParameters(secret: Data("12345678901234567890123456789012".utf8), algorithm: .sha256, digits: 8, period: 30)
    let sha512 = try TOTPParameters(
      secret: Data("1234567890123456789012345678901234567890123456789012345678901234".utf8), algorithm: .sha512, digits: 8, period: 30)
    let vectors: [(TimeInterval, String, String, String)] = [
      (59, "94287082", "46119246", "90693936"),
      (1_111_111_109, "07081804", "68084774", "25091201"),
      (1_111_111_111, "14050471", "67062674", "99943326"),
      (1_234_567_890, "89005924", "91819424", "93441116"),
      (2_000_000_000, "69279037", "90698825", "38618901"),
      (20_000_000_000, "65353130", "77737706", "47863826"),
    ]
    for (time, one, two, five) in vectors {
      let date = Date(timeIntervalSince1970: time)
      XCTAssertEqual(try sha1.code(at: date), one, "SHA1 at \(time)")
      XCTAssertEqual(try sha256.code(at: date), two, "SHA256 at \(time)")
      XCTAssertEqual(try sha512.code(at: date), five, "SHA512 at \(time)")
    }
    let sixDigits = try TOTPParameters(secret: Data("12345678901234567890".utf8))
    XCTAssertEqual(try sixDigits.code(at: Date(timeIntervalSince1970: 59)), "287082")
  }

  func testParsesURIs() throws {
    let plain = try TOTPParameters(parsing: "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example")
    XCTAssertEqual(plain.secret, Base32.decode("JBSWY3DPEHPK3PXP"))
    XCTAssertEqual(plain.algorithm, .sha1)
    XCTAssertEqual(plain.digits, 6)
    XCTAssertEqual(plain.period, 30)

    let custom = try TOTPParameters(parsing: "OTPAUTH://TOTP/x?SECRET=jbswy3dpehpk3pxp&algorithm=sha512&digits=8&period=60&image=https%3A%2F%2Fexample.com%2Fi.png")
    XCTAssertEqual(custom.algorithm, .sha512)
    XCTAssertEqual(custom.digits, 8)
    XCTAssertEqual(custom.period, 60)

    let bare = try TOTPParameters(parsing: " jbsw y3dp ehpk 3pxp ")
    XCTAssertEqual(bare.secret, plain.secret)
    XCTAssertEqual(try TOTPParameters(parsing: "MZXW6YQ=").secret, Data("foob".utf8))
  }

  func testHOTPRejected() {
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1")) {
      XCTAssertEqual($0 as? TOTPError, .hotpNotSupported)
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=1")) {
      XCTAssertEqual($0 as? TOTPError, .hotpNotSupported)
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://yaotp/x?secret=JBSWY3DPEHPK3PXP")) {
      XCTAssertEqual($0 as? TOTPError, .notTOTP)
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "steam://ABCDEFGHIJKLMNOP"))
  }

  func testUnknownParametersRejected() {
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/Steam:alice?secret=JBSWY3DPEHPK3PXP&encoder=steam")) {
      XCTAssertEqual($0 as? TOTPError, .unknownParameter("encoder"))
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&secret=MZXW6YQ")) {
      XCTAssertEqual($0 as? TOTPError, .duplicateParameter("secret"))
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&&issuer=a")) {
      XCTAssertEqual($0 as? TOTPError, .malformedURI)
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/x?issuer=a")) {
      XCTAssertEqual($0 as? TOTPError, .missingSecret)
    }
    XCTAssertThrowsError(try TOTPParameters(parsing: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP#frag"))
  }

  func testParameterRanges() {
    let base = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"
    for (suffix, expected) in [
      ("&digits=7", TOTPError.unsupportedDigits), ("&digits=06", .unsupportedDigits), ("&digits=10", .unsupportedDigits),
      ("&period=14", .unsupportedPeriod), ("&period=121", .unsupportedPeriod), ("&period=abc", .unsupportedPeriod),
      ("&algorithm=MD5", .unsupportedAlgorithm("MD5")),
    ] {
      XCTAssertThrowsError(try TOTPParameters(parsing: base + suffix), suffix) {
        XCTAssertEqual($0 as? TOTPError, expected, suffix)
      }
    }
    XCTAssertNoThrow(try TOTPParameters(parsing: base + "&period=15&digits=8&algorithm=SHA256"))
    XCTAssertNoThrow(try TOTPParameters(parsing: base + "&period=120"))
    XCTAssertThrowsError(try TOTPParameters(secret: Data(), digits: 6, period: 30))
    XCTAssertThrowsError(try TOTPParameters(secret: Data(count: 129)))
  }

  /// T7: case is folded in ASCII only, so `ſha256` (long s, which Unicode
  /// upper-cases to S) is not SHA256 and Unicode-cased parameter names are
  /// unknown. (Second review, finding 11.)
  func testCaseFoldingIsASCIIOnly() throws {
    for uri in [
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=\u{17F}ha256",
      "otpauth://totp/x?\u{17F}ecret=JBSWY3DPEHPK3PXP",
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&%C5%BFecret=A",
    ] {
      XCTAssertThrowsError(try TOTPParameters(parsing: uri), uri)
    }
    XCTAssertEqual(try TOTPParameters(parsing: "OTPAUTH://TOTP/x?SECRET=JBSWY3DPEHPK3PXP&Algorithm=sha256").algorithm, .sha256)
  }

  /// T8: a bare secret is always base32 (RFC 4648), as otpauth URIs and every
  /// exporter Opensteer reads write it; hex is never guessed, even when the
  /// text is also valid hex. (Second review, finding 11.)
  /// The second review's refusals, which must stay refusals.
  func testReviewRefusals() {
    // Refusals that must stay refusals.
    for uri in [
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&encoder=steam", "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1",
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0",
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&secret=AAAAAAAA", "otpauth://totp/x?SECRET=JBSWY3DPEHPK3PXP&secret=A",
      "otpauth://totp/x?secret=JBSW%20Y3DP", "steam://ABCDEFGHIJKLMNOP", "otpauth-migration://offline?data=abc",
    ] {
      XCTAssertThrowsError(try TOTPParameters(parsing: uri), uri)
    }
  }

  func testBareSecretsAreBase32() throws {
    let both = try TOTPParameters(parsing: "deadbeefcafe2345")
    XCTAssertEqual(both.secret, Base32.decode("DEADBEEFCAFE2345"))
    XCTAssertEqual(both.secret.count, 10)
    XCTAssertThrowsError(try TOTPParameters(parsing: "0123456789abcdef"), "0, 1, 8 and 9 are not base32")
  }

  func testBase32() {
    for invalid in ["JBSWY3DPEHPK3PX1", "JBSWY3DPEHPK3P", "JBSW=Y3DP", "", "   "] {
      XCTAssertThrowsError(try TOTPParameters(parsing: invalid), invalid) {
        XCTAssertEqual($0 as? TOTPError, .invalidSecret, invalid)
      }
    }
  }

  func testNegativeTime() throws {
    let totp = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    XCTAssertThrowsError(try totp.code(at: Date(timeIntervalSince1970: -1))) {
      XCTAssertEqual($0 as? TOTPError, .timeBeforeEpoch)
    }
  }
}
