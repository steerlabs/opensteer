import XCTest
@testable import PasswordsCore

/// Every fixture is fake data in the shape each manager exports.
final class ImportFixtureTests: XCTestCase {
  private static let nfdPassword = "pa\u{0308}ssw\u{006F}\u{0308}rd"

  private func importFixture(_ name: String) throws -> ImportResult {
    try PasswordImporter.parse(try fixtureData(name))
  }

  private func candidate(_ result: ImportResult, row: Int) throws -> ImportCandidate {
    try XCTUnwrap(result.candidates.first { $0.sourceRow == row }, "row \(row)")
  }

  private func assertBytes(_ actual: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(Array(actual.utf8), Array(expected.utf8), file: file, line: line)
  }

  func testChrome() throws {
    let result = try importFixture("chrome.csv")
    XCTAssertEqual(result.format, .chrome)
    XCTAssertEqual(result.candidates.map(\.sourceRow), [2, 3, 6, 8, 9, 10, 11, 14])
    XCTAssertEqual(result.skipped, [
      ImportSkip(row: 4, reason: .unsupportedURL), ImportSkip(row: 5, reason: .notHTTPS),
      ImportSkip(row: 7, reason: .noPassword), ImportSkip(row: 12, reason: .columnCount),
    ])
    let first = try candidate(result, row: 2)
    XCTAssertEqual(first.origins, ["https://example.com"])
    XCTAssertEqual(first.loginURL, "https://example.com/login")
    XCTAssertEqual(first.label, "example.com")
    XCTAssertNil(first.totp)

    let spaced = try candidate(result, row: 6)
    assertBytes(spaced.username, "carol, the admin")
    assertBytes(spaced.password, "  \(Self.nfdPassword) with spaces  ")

    let quoted = try candidate(result, row: 8)
    assertBytes(quoted.password, "quote\"comma,newline\nsecond line")
    XCTAssertEqual(quoted.origins, ["https://shop.example.com:8443"])
    XCTAssertEqual(quoted.loginURL, "https://shop.example.com:8443/account?tab=login")

    assertBytes(try candidate(result, row: 14).password, "\u{1F511}\u{00A0}key\t")
  }

  func testSemicolonExport() throws {
    let result = try importFixture("chrome-semicolon.csv")
    XCTAssertEqual(result.format, .chrome)
    XCTAssertEqual(result.candidates.count, 2)
    assertBytes(try candidate(result, row: 2).password, "test-password-123")
    assertBytes(try candidate(result, row: 3).password, "semi;colon")
    XCTAssertEqual(try candidate(result, row: 3).loginURL, "https://example.org/login")
  }

  func testApplePasswords() throws {
    let result = try importFixture("apple-passwords.csv")
    XCTAssertEqual(result.format, .applePasswords)
    XCTAssertEqual(result.candidates.map(\.sourceRow), [2, 3])
    XCTAssertEqual(result.skipped, [ImportSkip(row: 4, reason: .notHTTPS), ImportSkip(row: 5, reason: .invalidTOTP)])
    let first = try candidate(result, row: 2)
    XCTAssertEqual(first.label, "Example (alice@example.com)")
    XCTAssertEqual(first.totp?.secret, Base32.decode("JBSWY3DPEHPK3PXP"))
    XCTAssertEqual(try candidate(result, row: 3).origins, ["https://www.example.co.uk"])
  }

  func testFirefox() throws {
    let result = try importFixture("firefox.csv")
    XCTAssertEqual(result.format, .firefox)
    XCTAssertEqual(result.candidates.map(\.sourceRow), [2, 4])
    XCTAssertEqual(result.skipped, [ImportSkip(row: 3, reason: .unsupportedURL), ImportSkip(row: 5, reason: .unsupportedURL)])
    XCTAssertEqual(try candidate(result, row: 4).origins, ["https://intranet.example.net:8443"])
    XCTAssertNil(try candidate(result, row: 2).label)
  }

  func testOnePassword() throws {
    let result = try importFixture("1password.csv")
    XCTAssertEqual(result.format, .onePassword)
    XCTAssertEqual(result.candidates.map(\.sourceRow), [2, 3])
    XCTAssertEqual(result.skipped, [ImportSkip(row: 4, reason: .invalidTOTP)])
    let first = try candidate(result, row: 2)
    XCTAssertEqual(first.loginURL, "https://example.com/", "scheme-less URLs are HTTPS")
    let totp = try XCTUnwrap(first.totp)
    XCTAssertEqual(totp.algorithm, .sha256)
    XCTAssertEqual(totp.digits, 8)
    XCTAssertEqual(totp.period, 60)

    let variant = try importFixture("1password-website.csv")
    XCTAssertEqual(variant.format, .onePassword)
    XCTAssertEqual(variant.candidates.map(\.loginURL), ["https://example.com/"])
  }

  func testBitwardenCSV() throws {
    let result = try importFixture("bitwarden.csv")
    XCTAssertEqual(result.format, .bitwardenCSV)
    // Row 2's URIs span example.com and example.org: a CSV cell cannot say
    // whether that is two URIs or one with a comma in it (I22).
    XCTAssertEqual(result.candidates.map(\.sourceRow), [])
    XCTAssertEqual(result.skipped, [
      ImportSkip(row: 2, reason: .urlsSpanSites), ImportSkip(row: 3, reason: .notLogin),
      ImportSkip(row: 4, reason: .invalidTOTP), ImportSkip(row: 5, reason: .noPassword),
      ImportSkip(row: 6, reason: .notLogin),
    ])
  }

  func testBitwardenJSON() throws {
    let result = try importFixture("bitwarden.json")
    XCTAssertEqual(result.format, .bitwardenJSON)
    XCTAssertEqual(result.candidates.map(\.sourceRow), [1])
    XCTAssertEqual(result.skipped, [
      ImportSkip(row: 2, reason: .notLogin), ImportSkip(row: 3, reason: .noPassword),
      ImportSkip(row: 4, reason: .notHTTPS), ImportSkip(row: 5, reason: .notLogin),
    ])
    let login = try candidate(result, row: 1)
    XCTAssertEqual(login.origins, ["https://example.com", "https://accounts.example.org"])
    XCTAssertEqual(login.loginURL, "https://example.com/login")
    assertBytes(login.password, "  spaced \"quoted\" \(Self.nfdPassword)  ")
    XCTAssertNotNil(login.totp)
  }

  /// I24: Bitwarden's `match` 5 (never fill here) and 4 (a regular
  /// expression, which an origin cannot express) are left out, and listed.
  /// (Second review, finding 4.)
  func testBitwardenJSONLeavesOutNeverAndRegexURIs() throws {
    let json = """
      {"encrypted":false,"items":[
        {"type":1,"name":"Work","login":{"uris":[
          {"match":null,"uri":"https://work.example.com"},
          {"match":5,"uri":"https://shared-kiosk.example.org"},
          {"match":4,"uri":"^https://[a-z]+[.]example[.]net/.*$"},
          {"match":0,"uri":"https://sso.example.com"}
        ],"username":"alice","password":"synthetic","totp":null}},
        {"type":1,"name":"Kiosk","login":{"uris":[{"match":5,"uri":"https://kiosk.example.org"}],
          "username":"bob","password":"synthetic","totp":null}}
      ]}
      """
    let result = try PasswordImporter.parse(Data(json.utf8))
    XCTAssertEqual(result.candidates.first?.origins, ["https://work.example.com", "https://sso.example.com"])
    XCTAssertEqual(result.ignoredURLs, [ImportSkip(row: 1, reason: .neverMatch), ImportSkip(row: 1, reason: .regexMatch)])
    XCTAssertEqual(result.skipped, [ImportSkip(row: 2, reason: .neverMatch)], "nothing left to sign in to")
    XCTAssertThrowsError(try PasswordImporter.parse(Data(#"{"encrypted":false,"items":[{"type":1,"login":{"uris":[{"match":"5","uri":"https://a.example.com"}]}}]}"#.utf8)))
  }

  /// I23 for JSON: the item count is enforced while parsing, before the rest
  /// of a huge document becomes a tree. (Second review, finding 6.)
  func testBitwardenJSONStopsAtTheItemLimit() {
    var data = Data(#"{"encrypted":false,"items":["#.utf8)
    for _ in 0...ImportLimits.maxRows { data.append(Data("{},".utf8)) }
    // Garbage after the limit: a parser that read on would report it instead.
    data.append(Data("this is not JSON".utf8))
    XCTAssertThrowsError(try PasswordImporter.parse(data)) { XCTAssertEqual($0 as? ImportError, .tooManyRows) }
  }

  func testBitwardenEncryptedJSON() {
    XCTAssertThrowsError(try importFixture("bitwarden-encrypted.json")) { error in
      XCTAssertEqual(error as? ImportError, .bitwardenEncrypted)
      XCTAssertEqual("\(error)", "Export from Bitwarden without a password, then import.")
    }
    XCTAssertThrowsError(try PasswordImporter.parse(Data(#"{"items":[]}"#.utf8))) {
      XCTAssertEqual($0 as? ImportError, .unrecognizedJSON)
    }
    XCTAssertThrowsError(try PasswordImporter.parse(Data(#"{"encrypted":false,"items":[],"items":[]}"#.utf8))) {
      XCTAssertEqual($0 as? ImportError, .invalidJSON)
    }
  }

  func testGeneric() throws {
    let result = try importFixture("generic.csv")
    XCTAssertEqual(result.format, .generic)
    XCTAssertEqual(result.candidates.map(\.origins), [["https://example.com"], ["https://portal.example.org"]])
    assertBytes(try candidate(result, row: 3).password, "  leading and trailing  ")
    assertBytes(try candidate(result, row: 2).username, "alice@example.com")
  }

  func testWindows1252Rejected() {
    XCTAssertThrowsError(try importFixture("windows-1252.csv")) { error in
      XCTAssertEqual(error as? ImportError, .notUTF8)
      XCTAssertTrue("\(error)".contains("Save the export as UTF-8"))
    }
  }

  func testDialectSpecificity() {
    let cases: [(String, ImportFormat?)] = [
      ("name,url,username,password", .chrome),
      ("name,url,username,password,note", .chrome),
      ("title,url,username,password,notes,otpauth", .applePasswords),
      ("title,url,username,password,otpauth,favorite,archived,tags,notes", .onePassword),
      ("url,username,password,httprealm,formactionorigin,guid,timecreated,timelastused,timepasswordchanged", .firefox),
      ("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp", .bitwardenCSV),
      ("url,username,password,totp,extra,name,grouping,fav", .chrome),
      ("website,email,password", .generic),
      ("url,password", nil),
    ]
    for (header, expected) in cases {
      XCTAssertEqual(CSVDialect.detect(header.components(separatedBy: ","))?.format, expected, header)
    }
  }

  func testPasswordsPreservedByteForByte() throws {
    let expected: [(String, Int, String)] = [
      ("chrome.csv", 6, "  \(Self.nfdPassword) with spaces  "),
      ("chrome.csv", 8, "quote\"comma,newline\nsecond line"),
      ("chrome.csv", 14, "\u{1F511}\u{00A0}key\t"),
      ("bitwarden.json", 1, "  spaced \"quoted\" \(Self.nfdPassword)  "),
      ("generic.csv", 3, "  leading and trailing  "),
    ]
    let fixture = try VaultFixture()
    for (name, row, password) in expected {
      let imported = try candidate(try importFixture(name), row: row)
      assertBytes(imported.password, password)
      try fixture.withUnlocked { try $0.add([imported.draft]) }
      let stored = try XCTUnwrap(try fixture.items().first { $0.password.utf8.elementsEqual(password.utf8) }, "\(name) row \(row)")
      assertBytes(stored.password, password)
    }
    XCTAssertEqual(try fixture.items().count, expected.count)
  }

  func testCandidateCodableRoundTrip() throws {
    let result = try importFixture("chrome.csv")
    let decoded = try JSONDecoder().decode(ImportResult.self, from: try JSONEncoder().encode(result))
    XCTAssertEqual(decoded.format, result.format)
    XCTAssertEqual(decoded.skipped, result.skipped)
    for (original, copy) in zip(result.candidates, decoded.candidates) {
      assertBytes(copy.password, original.password)
      assertBytes(copy.username, original.username)
      XCTAssertEqual(copy.origins, original.origins)
      XCTAssertEqual(copy.sourceRow, original.sourceRow)
    }
    let badTOTP = #"{"secret":"AAAA","algorithm":"SHA1","digits":7,"period":30}"#
    XCTAssertThrowsError(try JSONDecoder().decode(TOTPParameters.self, from: Data(badTOTP.utf8)))
  }

  /// The whole import path: parse, plan against the vault, commit the
  /// selection as one action, then read it back.
  func testImportCommitsAsOneAction() throws {
    let fixture = try VaultFixture()
    let result = try importFixture("chrome.csv")
    let plan = try ImportPlan(candidates: result.candidates, existing: try fixture.items())
    let rows = Set(plan.entries.compactMap { entry -> Int? in
      switch entry.classification {
      case .new: return entry.candidate.sourceRow
      case .conflict: return entry.candidate.sourceRow == 10 ? 10 : nil
      default: return nil
      }
    })
    XCTAssertEqual(rows, [2, 3, 6, 8, 10, 14])
    let changes = try plan.changes(selecting: rows)
    let commit = try fixture.withUnlocked { try $0.commit(changes) }
    XCTAssertEqual(commit.head.seq, 1)
    XCTAssertEqual(commit.added.count, 6)
    XCTAssertEqual(try fixture.items().count, 6)

    let again = try ImportPlan(candidates: result.candidates, existing: try fixture.items())
    for entry in again.entries where rows.contains(entry.candidate.sourceRow) && entry.candidate.sourceRow != 10 {
      guard case .duplicate(of: .item) = entry.classification else {
        return XCTFail("row \(entry.candidate.sourceRow) should be saved already: \(entry.classification)")
      }
    }
  }
}
