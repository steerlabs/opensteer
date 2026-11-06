import XCTest
@testable import ComputerUseCore

final class MessagesQueryTests: XCTestCase {
  func testAmbiguousContactKeysNeverGuessEmailsIgnoreCaseAndBusinessesUseTheirCompany() {
    let records = [
      ContactRecord(id: "one", name: "One", organization: nil,
        emails: [LabeledText(label: nil, value: "WORK@example.com")],
        phones: [LabeledText(label: nil, value: "5551234567")], birthday: nil),
      ContactRecord(id: "two", name: "Two", organization: nil,
        emails: [], phones: [LabeledText(label: nil, value: "+15551234567")], birthday: nil),
      ContactRecord(id: "shop", name: nil, organization: "Local Business",
        emails: [], phones: [LabeledText(label: nil, value: "555 000 1111")], birthday: nil),
    ]
    let names = MessagesContacts(records)
    XCTAssertNil(names.name(for: "+15551234567"))
    // Messages shows a business contact by its company name.
    XCTAssertEqual(names.name(for: "+15550001111"), "Local Business")
    // A contact with no name is still someone else sharing the number.
    let shared = MessagesContacts([
      ContactRecord(id: "mayank", name: "Mayank Patel", organization: nil, emails: [],
        phones: [LabeledText(label: nil, value: "+15551234567")], birthday: nil),
      ContactRecord(id: "unnamed", name: nil, organization: nil, emails: [],
        phones: [LabeledText(label: nil, value: "+445551234567")], birthday: nil),
    ])
    XCTAssertNil(shared.name(for: "+445551234567"))
    // The same person saved twice, say in iCloud and Google, is still one name.
    let duplicated = MessagesContacts(["icloud", "google"].map {
      ContactRecord(id: $0, name: "Mayank Patel", organization: nil, emails: [],
        phones: [LabeledText(label: nil, value: "(555) 123-4567")], birthday: nil)
    })
    XCTAssertEqual(duplicated.name(for: "+15551234567"), "Mayank Patel")
    XCTAssertEqual(names.name(for: "work@EXAMPLE.com"), "One")
    XCTAssertNil(names.name(for: "not a handle"))
  }


  func testOpenFailuresAndUndecodableBodies() throws {
    XCTAssertEqual(MessagesDatabase.openFailure(errno: EPERM).code, .permissionRequired)
    XCTAssertEqual(MessagesDatabase.openFailure(errno: EPERM).message,
      "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.")
    XCTAssertEqual(MessagesDatabase.openFailure(errno: EACCES).code, .failed)
    XCTAssertEqual(MessagesDatabase.openFailure(errno: EACCES).message, "Messages could not be opened.")
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    XCTAssertThrowsError(try MessagesQuery(path: missing, clock: .mac, contacts: { [] }).run("SELECT 1", budget: .unlimited)) {
      XCTAssertEqual(($0 as? HelperError)?.message, "Messages is not set up.")
    }
    let db = try MessagesFixture.create()
    defer { try? FileManager.default.removeItem(at: db.deletingLastPathComponent()) }
    let query = MessagesQuery(path: db.path, clock: .mac, contacts: {
      [ContactRecord(id: "mayank", name: "Mayank Patel", organization: nil, emails: [],
        phones: [LabeledText(label: nil, value: "(555) 123-4567")], birthday: nil)]
    })
    XCTAssertEqual(try query.run("SELECT message_text(text, attributedBody) AS body FROM message WHERE guid='msg-undecodable'", budget: .unlimited),
      .object(["columns": .array([.string("body")]), "rows": .array([.array([.null])]), "truncated": .bool(false)]))
    XCTAssertEqual(try query.run("SELECT contact_name('+15551234567') AS name", budget: .unlimited),
      .object(["columns": .array([.string("name")]), "rows": .array([.array([.string("Mayank Patel")])]), "truncated": .bool(false)]))
  }

  func testReadBoundaryAndSQLiteErrors() throws {
    let db = try MessagesFixture.create()
    defer { try? FileManager.default.removeItem(at: db.deletingLastPathComponent()) }
    let query = MessagesQuery(path: db.path, clock: .mac, contacts: { XCTFail("Contacts must load lazily"); return [] })
    for sql in ["ATTACH ':memory:' AS other", "DETACH main", "DELETE FROM message", "SELECT 1; SELECT 2", "PRAGMA user_version", "PRAGMA journal_mode=WAL", "SELECT load_extension('bad')", "SELECT randomblob(10)", "SELECT zeroblob(10)", "SELECT fts3_tokenizer('simple')"] {
      XCTAssertThrowsError(try query.run(sql, budget: .unlimited), sql)
    }
    _ = try query.run("SELECT strftime('%Y', '2024-01-01'), datetime('2024-01-01'), json_extract('{\"a\":1}', '$.a'), hex(x'AB'), substr('abc',1,2), group_concat(id), printf('%s','ok'), coalesce(NULL,'ok'), 'abc' LIKE 'a%', 'abc' GLOB 'a*' FROM handle", budget: .unlimited)
    let value = try query.run("PRAGMA table_info(message)", budget: .unlimited)
    guard case .object(let result) = value, case .array(let rows) = result["rows"] else { return XCTFail() }
    XCTAssertFalse(rows.isEmpty)
    XCTAssertThrowsError(try query.run("SELECT missing_column FROM message", budget: .unlimited)) { error in
      XCTAssertTrue((error as? HelperError)?.message.contains("missing_column") == true)
    }
  }

  func testCellsAndFunctions() throws {
    let db = try MessagesFixture.create()
    defer { try? FileManager.default.removeItem(at: db.deletingLastPathComponent()) }
    var loads = 0
    let query = MessagesQuery(path: db.path, clock: DataClock(timeZone: TimeZone(identifier: "UTC")!), contacts: { loads += 1; return [ContactRecord(id: "one", name: "Alice", organization: nil, emails: [LabeledText(label: nil, value: MessagesFixture.Handle.colleague)], phones: [], birthday: nil)] })
    let result = try query.run("SELECT 9007199254740993, -9007199254740993, 42, x'1234', NULL, 1.5, message_text(text, attributedBody), message_time(date) FROM message WHERE guid='msg-reply'", budget: .unlimited)
    XCTAssertEqual(loads, 0)
    guard case .object(let object) = result, case .array(let rows) = object["rows"], case .array(let row) = rows.first else { return XCTFail() }
    XCTAssertEqual(Array(row.prefix(7)), [.string("9007199254740993"), .string("-9007199254740993"), .number(42), .string("[blob 2 bytes]"), .null, .number(1.5), .string("Sounds good, see you then")])
    XCTAssertTrue(row[7].stringValue?.hasPrefix("2024-03-01T10:05:00") == true)
    let old = try query.run("SELECT message_time(100)", budget: .unlimited)
    guard case .object(let oldObject) = old, case .array(let oldRows) = oldObject["rows"], case .array(let oldRow) = oldRows.first else { return XCTFail() }
    XCTAssertTrue(oldRow[0].stringValue?.hasPrefix("2001-01-01T00:01:40") == true)
    let names = try query.run("SELECT contact_name(id) FROM handle WHERE id = 'work@example.com'", budget: .unlimited)
    XCTAssertEqual(names, .object(["columns": .array([.string("contact_name(id)")]), "rows": .array([.array([.string("Alice")])]), "truncated": .bool(false)]))
    XCTAssertEqual(loads, 1)
  }

  func testCustomFunctionsCannotRunFromViewsAndBoundTheirInputs() throws {
    let db = try MessagesFixture.create()
    defer { try? FileManager.default.removeItem(at: db.deletingLastPathComponent()) }
    try MessagesFixture.write(db, "CREATE VIEW names AS SELECT contact_name(id) FROM handle")
    let query = MessagesQuery(path: db.path, clock: .mac, contacts: { XCTFail("Contacts must not load"); return [] })
    for sql in ["SELECT * FROM names", "SELECT contact_name(printf('%2048s','x'))", "SELECT message_text(printf('%270000s','x'),NULL)"] {
      XCTAssertThrowsError(try query.run(sql, budget: .unlimited))
    }
  }

  func testTimeoutAndByteBudget() throws {
    let db = try MessagesFixture.create()
    defer { try? FileManager.default.removeItem(at: db.deletingLastPathComponent()) }
    var query = MessagesQuery(path: db.path, clock: .mac, contacts: { [] })
    XCTAssertThrowsError(try query.run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n", budget: WorkBudget(requestEnd: Date().addingTimeInterval(2.05)))) { error in
      XCTAssertTrue((error as? HelperError)?.message.contains("WHERE") == true)
    }
    query.byteBudget = 100
    let result = try query.run("SELECT 'abcdefghijk' FROM message", budget: .unlimited)
    guard case .object(let object) = result else { return XCTFail() }
    XCTAssertEqual(object["truncated"], .bool(true))
    XCTAssertLessThanOrEqual(try JSONCoding.encoder.encode(result).count, 100)
    XCTAssertThrowsError(try query.run("SELECT text FROM message WHERE guid='msg-oversized'", budget: .unlimited))
  }
}
