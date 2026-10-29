import XCTest
@testable import PasswordsCore

final class CSVTests: XCTestCase {
  private func parse(_ text: String) throws -> CSVTable {
    try CSVParser.parse(Data(text.utf8))
  }

  private func importCSV(_ text: String) throws -> ImportResult {
    try PasswordImporter.parse(Data(text.utf8))
  }

  func testQuotedFields() throws {
    let table = try parse("a,b,c,d\n\"x,1\",\"y\"\"2\",\"z\n3\",\"p\r\nq\"\n")
    XCTAssertEqual(table.header, ["a", "b", "c", "d"])
    XCTAssertEqual(table.records.map(\.cells), [["x,1", "y\"2", "z\n3", "p\r\nq"]])
    XCTAssertEqual(table.records.map(\.row), [2])
    // A quote inside an unquoted field is kept as text.
    XCTAssertEqual(try parse("a,b\nx\"y,z\n").records.first?.cells, ["x\"y", "z"])
    XCTAssertEqual(try parse("a,b\n\"\",\n").records.first?.cells, ["", ""])
  }

  func testLineEndingsAndRowNumbers() throws {
    let table = try parse("a,b\r\n1,2\n\n3,4\r\n\"5\n5\",6\n7,8")
    XCTAssertEqual(table.records.map(\.cells), [["1", "2"], ["3", "4"], ["5\n5", "6"], ["7", "8"]])
    XCTAssertEqual(table.records.map(\.row), [2, 4, 5, 6])
    XCTAssertEqual(try parse("a,b\n1,2\r\n").records.map(\.cells), [["1", "2"]])
    // A trailing delimiter is a third, empty cell, so the row is not the header's width.
    XCTAssertEqual(try parse("a,b\n1,2,\n").records.map(\.widthMismatch), [true])
  }

  func testUnterminatedQuote() {
    XCTAssertThrowsError(try parse("a,b\n\"x,y\n")) {
      XCTAssertEqual($0 as? ImportError, .malformedCSV(row: 2))
    }
    XCTAssertThrowsError(try parse("a\n\"x\"y\n")) {
      XCTAssertEqual($0 as? ImportError, .malformedCSV(row: 2))
    }
  }

  func testUTF16Rejected() {
    var utf16 = Data([0xFF, 0xFE])
    utf16.append("url,username,password\n".data(using: .utf16LittleEndian)!)
    XCTAssertThrowsError(try PasswordImporter.parse(utf16)) {
      XCTAssertEqual($0 as? ImportError, .notUTF8)
    }
  }

  func testColumnCountMismatchSkipped() throws {
    let result = try importCSV("url,username,password\nhttps://a.example.com/,alice,pass,word\nhttps://b.example.com/,bob\nhttps://c.example.com/,carol,ok\n")
    XCTAssertEqual(result.skipped, [ImportSkip(row: 2, reason: .columnCount), ImportSkip(row: 3, reason: .columnCount)])
    XCTAssertEqual(result.candidates.map(\.username), ["carol"])
  }

  func testUnknownHeaderRejected() {
    for (text, expected) in [
      ("foo,bar\n1,2\n", ImportError.unrecognizedHeader),
      ("url,password\nhttps://example.com,p\n", .unrecognizedHeader),
      ("", .emptyFile),
      ("\n\n", .emptyFile),
      ("url,URL,username,password\n", .duplicateHeader("url")),
    ] {
      XCTAssertThrowsError(try importCSV(text), text) { XCTAssertEqual($0 as? ImportError, expected, text) }
    }
  }

  func testLimits() throws {
    XCTAssertThrowsError(try PasswordImporter.parse(Data(count: ImportLimits.maxInputBytes + 1))) {
      XCTAssertEqual($0 as? ImportError, .tooLarge)
    }
    let manyRows = "url,username,password\n" + String(repeating: "x,y,z\n", count: ImportLimits.maxRows + 1)
    XCTAssertThrowsError(try importCSV(manyRows)) { XCTAssertEqual($0 as? ImportError, .tooManyRows) }
    XCTAssertNoThrow(try importCSV("url,username,password\n" + String(repeating: "x,y,z\n", count: ImportLimits.maxRows)))
    let wide = (0...ImportLimits.maxColumns).map { "c\($0)" }.joined(separator: ",")
    XCTAssertThrowsError(try parse(wide)) { XCTAssertEqual($0 as? ImportError, .tooManyColumns) }
    let manyLogins = "url,username,password\n" + (0...ImportLimits.maxCandidates).map { "https://s\($0).example.com/,u,p\n" }.joined()
    XCTAssertThrowsError(try importCSV(manyLogins)) { XCTAssertEqual($0 as? ImportError, .tooManyCandidates) }
  }

  func testOversizedFieldsSkipped() throws {
    let long = { (count: Int) in String(repeating: "x", count: count) }
    let text = "name,url,username,password\n"
      + "a,https://a.example.com/,\(long(1_025)),p\n"
      + "b,https://b.example.com/,u,\(long(4_097))\n"
      + "\(long(201)),https://c.example.com/,u,p\n"
      + "d,https://d.example.com/\(long(2_100)),u,p\n"
      + "ok,https://e.example.com/,\(long(1_024)),\(long(4_096))\n"
    let result = try importCSV(text)
    XCTAssertEqual(result.skipped.map(\.reason), [.tooLarge, .tooLarge, .tooLarge, .tooLarge])
    XCTAssertEqual(result.candidates.map(\.sourceRow), [6])
  }

  func testURLHandling() throws {
    let text = "url,username,password\n"
      + " example.com/login ,a,p\n"
      + "javascript:alert(1),b,p\n"
      + "https://localhost:3000/,c,p\n"
      + "HTTP://example.org/,d,p\n"
      + ",e,p\n"
      + "https://github.io/,f,p\n"
    let result = try importCSV(text)
    XCTAssertEqual(result.candidates.map(\.loginURL), ["https://example.com/login"])
    XCTAssertEqual(result.skipped, [
      ImportSkip(row: 3, reason: .unsupportedURL), ImportSkip(row: 4, reason: .unsupportedURL),
      ImportSkip(row: 5, reason: .notHTTPS), ImportSkip(row: 6, reason: .noURL), ImportSkip(row: 7, reason: .unsupportedURL),
    ])
  }

  func testAtMostEightOrigins() throws {
    let uris = (0..<10).map { "https://s\($0).example.com/" }.joined(separator: ",")
    let text = "type,name,login_uri,login_username,login_password\nlogin,Many,\"\(uris)\",alice,p\n"
    let candidate = try XCTUnwrap(try importCSV(text).candidates.first)
    XCTAssertEqual(candidate.origins, (0..<8).map { "https://s\($0).example.com" })
    XCTAssertEqual(candidate.loginURL, "https://s0.example.com/")
    XCTAssertNoThrow(try candidate.draft.validate())
  }

  private static let bitwardenHeader =
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n"

  private func bitwarden(_ uriCell: String) throws -> ImportResult {
    try importCSV(Self.bitwardenHeader + ",,login,Login,,,0,\"\(uriCell)\",alice,synthetic-password,\n")
  }

  /// I22: Bitwarden joins a login's URIs with commas, and a URI may hold a
  /// comma itself (a query string). Splitting at every comma, and reading a
  /// bare tail as `https://`, made `attacker.example` an origin of the bank
  /// login. (Second review, finding 1.)
  func testBitwardenCommaSplitsOnlyBeforeAScheme() throws {
    let query = try bitwarden("https://bank.example.com/login?return=/home,attacker.example")
    XCTAssertEqual(query.candidates.first?.origins, ["https://bank.example.com"])
    XCTAssertEqual(query.candidates.first?.loginURL, "https://bank.example.com/login?return=/home,attacker.example")
    let fixture = try VaultFixture()
    try fixture.withUnlocked { unlocked in
      let plan = try ImportPlan(candidates: query.candidates, existing: try unlocked.items())
      _ = try unlocked.commit(try plan.changes(selecting: [2]))
    }
    XCTAssertEqual(try fixture.withUnlocked { try $0.items(withinSite: "https://attacker.example") }.count, 0)

    // Several URIs on one site stay one login.
    let sameSite = try bitwarden("https://example.com/,androidapp://com.example,https://login.example.com/sso")
    XCTAssertEqual(sameSite.candidates.first?.origins, ["https://example.com", "https://login.example.com"])
    // A part that came from a split never gains a scheme.
    let bare = try bitwarden("example.com,https://login.example.com/")
    XCTAssertEqual(bare.candidates.first?.origins, ["https://login.example.com"])
    // URIs that span sites cannot be told apart from one URI with a comma in it.
    for cell in [
      "https://sso.example.com/?targets=https://a.example.com,https://evil.example.net/",
      "https://example.com,https://login.example.org/sso",
    ] {
      let spanning = try bitwarden(cell)
      XCTAssertTrue(spanning.candidates.isEmpty, cell)
      XCTAssertEqual(spanning.skipped, [ImportSkip(row: 2, reason: .urlsSpanSites)], cell)
    }
  }

  /// I23: a CSV of empty cells held one `String` per cell before any limit
  /// applied. Rows of the wrong width keep no cells, and the cells kept are
  /// capped. (Second review, finding 6.)
  func testCellsAreBounded() throws {
    let wide = String(repeating: ",", count: 1_023)
    var mismatched = "url,username,password" + String(repeating: ",", count: 1_020) + "\n"
    for _ in 0..<50 { mismatched += wide + "\n" }
    let table = try parse(mismatched)
    XCTAssertEqual(table.records.count, 50)
    XCTAssertTrue(table.records.allSatisfy { $0.cells.isEmpty && $0.widthMismatch }, "a wrong-width row keeps no cells")
    XCTAssertEqual(try importCSV(mismatched).skipped.first, ImportSkip(row: 2, reason: .columnCount))

    var matching = "url,username,password" + String(repeating: ",", count: 1_021) + "\n"
    let row = String(repeating: ",", count: 1_023) + "\n"
    while matching.utf8.count + row.utf8.count <= ImportLimits.maxInputBytes { matching += row }
    XCTAssertThrowsError(try parse(matching)) { XCTAssertEqual($0 as? ImportError, .tooManyCells) }
  }
}
