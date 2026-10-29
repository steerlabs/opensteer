import Foundation
import SQLite3
import XCTest

@testable import ComputerUseCore

/// A `chat.db` the tests build, and the byte-accurate `attributedBody`
/// archives that go in it, so no test ever reaches for the real Messages
/// database — which a test could not open, and must never read.
enum MessagesFixture {
  /// Archives produced by Apple, not by the builder below, so the parser is
  /// measured against the real format rather than against our reading of it:
  /// `NSArchiver.archivedData(withRootObject: NSAttributedString(string: …))`.
  static let appleArchives: [String: String] = [
    // "Lunch at one?" — one-byte length.
    "ascii":
      "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNT"
      + "dHJpbmcBlIQBKw1MdW5jaCBhdCBvbmU/hoQCaUkBDZKEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=",
    // "Café ☕️ — 😀 ok" — multi-byte UTF-8.
    "emoji":
      "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNT"
      + "dHJpbmcBlIQBKxhDYWbDqSDimJXvuI8g4oCUIPCfmIAgb2uGhAJpSQEPkoSEhAxOU0RpY3Rpb25hcnkAlIQB"
      + "aQCGhg==",
    // 192 bytes of "vacation photos " — the 0x81 two-byte length form.
    "long":
      "BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNT"
      + "dHJpbmcBlIQBK4HAAHZhY2F0aW9uIHBob3RvcyB2YWNhdGlvbiBwaG90b3MgdmFjYXRpb24gcGhvdG9zIHZh"
      + "Y2F0aW9uIHBob3RvcyB2YWNhdGlvbiBwaG90b3MgdmFjYXRpb24gcGhvdG9zIHZhY2F0aW9uIHBob3RvcyB2"
      + "YWNhdGlvbiBwaG90b3MgdmFjYXRpb24gcGhvdG9zIHZhY2F0aW9uIHBob3RvcyB2YWNhdGlvbiBwaG90b3Mg"
      + "dmFjYXRpb24gcGhvdG9zIIaEAmlJAYHAAJKEhIQMTlNEaWN0aW9uYXJ5AJSEAWkAhoY=",
    // NSMutableAttributedString(string: "Edited reply") — the mutable chain.
    "mutable":
      "BAtzdHJlYW10eXBlZIHoA4QBQISEhBlOU011dGFibGVBdHRyaWJ1dGVkU3RyaW5nAISEEk5TQXR0cmlidXRl"
      + "ZFN0cmluZwCEhAhOU09iamVjdACFkoSEhA9OU011dGFibGVTdHJpbmcBhIQITlNTdHJpbmcBlYQBKwxFZGl0"
      + "ZWQgcmVwbHmGhAJpSQEMkoSEhAxOU0RpY3Rpb25hcnkAlYQBaQCGhg==",
  ]

  static func appleArchive(_ name: String) -> [UInt8] {
    [UInt8](Data(base64Encoded: appleArchives[name]!)!)
  }

  private static func hex(_ text: String) -> [UInt8] {
    let digits = Array(text.replacingOccurrences(of: " ", with: ""))
    return stride(from: 0, to: digits.count, by: 2).map {
      UInt8(String(digits[$0...$0 + 1]), radix: 16)!
    }
  }

  private static func ascii(_ text: String) -> [UInt8] { Array(text.utf8) }

  /// Typedstream's length: one byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE.
  private static func encodedLength(_ length: Int) -> [UInt8] {
    if length < 0x81 { return [UInt8(length)] }
    if length <= 0xffff { return [0x81, UInt8(length & 0xff), UInt8((length >> 8) & 0xff)] }
    return [
      0x82, UInt8(length & 0xff), UInt8((length >> 8) & 0xff), UInt8((length >> 16) & 0xff),
      UInt8((length >> 24) & 0xff),
    ]
  }

  /// The archive `NSArchiver` writes for a plain attributed string, held
  /// byte for byte to `appleArchives` by the parser's tests.
  static func attributedBody(_ text: String, mutable: Bool = false) -> [UInt8] {
    let body = Array(text.utf8)
    let header = hex("04 0b") + ascii("streamtyped") + hex("81 e8 03 84 01 40")
    let classes =
      mutable
      ? hex("84 84 84 19") + ascii("NSMutableAttributedString") + hex("00 84 84 12")
        + ascii("NSAttributedString") + hex("00 84 84 08") + ascii("NSObject")
        + hex("00 85 92 84 84 84 0f") + ascii("NSMutableString") + hex("01 84 84 08")
        + ascii("NSString") + hex("01 95")
      : hex("84 84 84 12") + ascii("NSAttributedString") + hex("00 84 84 08") + ascii("NSObject")
        + hex("00 85 92 84 84 84 08") + ascii("NSString") + hex("01 94")
    // The trailing pair's second number is the length in UTF-16 units. Built
    // in typed steps: one expression of untyped literals is more than the
    // Swift 6.0 type checker can solve in time.
    var tail: [UInt8] = hex("86 84 02") + ascii("iI")
    tail += [0x01] + encodedLength(text.utf16.count)
    tail += hex("92 84 84 84 0c") + ascii("NSDictionary")
    tail += [0x00, mutable ? 0x95 : 0x94]
    tail += hex("84 01 69 00 86 86")
    return header + classes + hex("84 01 2b") + encodedLength(body.count) + body + tail
  }

  /// A real header and class name, then a payload marker cut in half.
  static let undecodableBody =
    hex("04 0b") + ascii("streamtyped") + hex("81 e8 03 84 01 40 84 84 84 08") + ascii("NSString")
    + hex("01 94 84 01")

  /// Nanoseconds since 2001, the encoding every modern row uses.
  static func appleNanoseconds(_ iso: String) -> Int64 {
    Int64((ISO8601DateFormatter().date(from: iso)!.timeIntervalSinceReferenceDate * 1_000).rounded())
      * 1_000_000
  }

  /// Whole seconds since 2001, the encoding rows written before macOS 10.13 use.
  static func appleSeconds(_ iso: String) -> Int64 {
    Int64(ISO8601DateFormatter().date(from: iso)!.timeIntervalSinceReferenceDate)
  }

  enum Handle {
    static let colleague = "work@example.com"
    static let friend = "+15551234567"
    static let neighbour = "+15559876543"
  }

  enum Chat {
    /// 1:1 iMessage with `friend`, and the most recent message overall.
    static let direct = "iMessage;-;+15551234567"
    /// Group named "Weekend Trip" with all three handles.
    static let group = "iMessage;+;chat483920"
    /// A chat nobody has written in, unless a search fixture writes to it.
    static let quiet = "iMessage;-;work@example.com"
    /// Legacy SMS thread whose dates are whole seconds.
    static let sms = "SMS;-;+15559876543"
  }

  /// 16 KiB is the reader's ceiling, so this row must come back cut.
  static let oversizedText = String(repeating: "x", count: 20_000) + "END"

  struct Search {
    /// Rows whose text contains "needle".
    var needles: Int
    /// Rows written after each needle that do not contain it.
    var chaff = 0
    /// Every row at one instant, so only the row id breaks the tie.
    var sameDate = false
  }

  /// A new database with the subset of the Messages schema the reader reads.
  static func create(filler: Int = 0, search: Search? = nil) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("messages-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("chat.db")
    var database: OpaquePointer?
    guard sqlite3_open(url.path, &database) == SQLITE_OK, let database else {
      throw HelperError(.failed, "The fixture database could not be created.")
    }
    defer { sqlite3_close(database) }
    try exec(
      database,
      """
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
        country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
        style INTEGER, state INTEGER, chat_identifier TEXT, service_name TEXT, room_name TEXT,
        display_name TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
        text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER,
        is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
        attributedBody BLOB, item_type INTEGER DEFAULT 0,
        associated_message_type INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
        date_retracted INTEGER DEFAULT 0, account_guid TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER,
        message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER,
        UNIQUE (chat_id, handle_id));
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT UNIQUE NOT NULL, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER,
        UNIQUE (message_id, attachment_id));
      INSERT INTO handle (id, service) VALUES ('\(Handle.friend)', 'iMessage'),
        ('\(Handle.colleague)', 'iMessage'), ('\(Handle.neighbour)', 'SMS');
      INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES
        ('\(Chat.direct)', 45, '\(Handle.friend)', 'iMessage', NULL),
        ('\(Chat.group)', 43, 'chat483920', 'iMessage', 'Weekend Trip'),
        ('\(Chat.sms)', 45, '\(Handle.neighbour)', 'SMS', NULL),
        ('\(Chat.quiet)', 45, '\(Handle.colleague)', 'iMessage', NULL);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES
        (1, 1), (2, 1), (2, 2), (2, 3), (3, 3), (4, 2);
      """)
    let (direct, group, sms, quiet) = (Int64(1), Int64(2), Int64(3), Int64(4))
    let (friend, colleague, neighbour) = (Int64(1), Int64(2), Int64(3))
    var row: Int64 = 0

    func post(
      chat: Int64, date: Int64, guid: String, handle: Int64, text: String? = nil,
      body: [UInt8]? = nil, fromMe: Bool = false, service: String = "iMessage",
      itemType: Int64 = 0, associatedType: Int64 = 0
    ) throws -> Int64 {
      try run(
        database,
        "INSERT INTO message (guid, text, handle_id, service, date, is_from_me, attributedBody,"
          + " item_type, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          .text(guid), text.map { .text($0) } ?? .null, .integer(handle), .text(service),
          .integer(date), .integer(fromMe ? 1 : 0), body.map { .blob($0) } ?? .null,
          .integer(itemType), .integer(associatedType),
        ])
      row += 1
      try run(
        database, "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
        [.integer(chat), .integer(row), .integer(date)])
      return row
    }

    _ = try post(
      chat: direct, date: appleNanoseconds("2024-03-01T10:00:00Z"), guid: "msg-lunch",
      handle: friend, text: "Lunch at one?")
    _ = try post(
      chat: direct, date: appleNanoseconds("2024-03-01T10:05:00Z"), guid: "msg-reply", handle: 0,
      body: attributedBody("Sounds good, see you then"), fromMe: true)
    // Neither of these is a message: a heart on "Lunch at one?", and the
    // group being renamed. Messages keeps both in the same table.
    _ = try post(
      chat: direct, date: appleNanoseconds("2024-03-01T10:06:00Z"), guid: "msg-tapback",
      handle: friend, text: "Loved \u{201C}Lunch at one?\u{201D}", associatedType: 2000)
    _ = try post(
      chat: group, date: appleNanoseconds("2024-03-02T08:30:00Z"), guid: "msg-renamed",
      handle: colleague, itemType: 2)
    _ = try post(
      chat: group, date: appleNanoseconds("2024-03-02T09:00:00Z"), guid: "msg-emoji",
      handle: colleague, body: appleArchive("emoji"))
    _ = try post(
      chat: group, date: appleNanoseconds("2024-03-02T09:30:00Z"), guid: "msg-oversized",
      handle: 0, text: oversizedText, fromMe: true)
    let undecodable = try post(
      chat: group, date: appleNanoseconds("2024-03-03T08:00:00Z"), guid: "msg-undecodable",
      handle: neighbour, body: undecodableBody)
    _ = try post(
      chat: sms, date: appleSeconds("2013-05-01T17:45:00Z"), guid: "msg-legacy",
      handle: neighbour, text: "Old school SMS about the fence", service: "SMS")
    _ = try post(
      chat: direct, date: appleNanoseconds("2024-03-04T12:00:00Z"), guid: "msg-latest",
      handle: 0, text: "Later message with a picture", fromMe: true)
    try exec(
      database,
      """
      INSERT INTO attachment (guid, filename, mime_type)
        VALUES ('att-1', '~/Library/Messages/Attachments/IMG_0001.HEIC', 'image/heic');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (\(undecodable), 1);
      """)

    if filler > 0 {
      try exec(database, "BEGIN")
      let base = appleNanoseconds("2024-04-01T00:00:00Z")
      for index in 0..<filler {
        _ = try post(
          chat: direct, date: base + Int64(index) * 60_000_000_000, guid: "msg-filler-\(index)",
          handle: friend, text: "Filler chatter number \(index)")
      }
      try exec(database, "COMMIT")
    }
    if let search {
      try exec(database, "BEGIN")
      let base = appleNanoseconds("2025-01-01T00:00:00Z")
      let stride = 1 + search.chaff
      for index in 0..<(search.needles * stride) {
        _ = try post(
          chat: quiet, date: search.sameDate ? base : base + Int64(index) * 60_000_000_000,
          guid: "msg-search-\(index)", handle: colleague,
          text: index % stride == 0 ? "A needle in row \(index)" : "Only hay in row \(index)")
      }
      try exec(database, "COMMIT")
    }
    return url
  }

  enum Value {
    case null
    case integer(Int64)
    case text(String)
    case blob([UInt8])
  }

  /// The one integer a query answers.
  static func integer(_ url: URL, _ sql: String, _ values: [Value]) throws -> Int64 {
    var database: OpaquePointer?
    guard sqlite3_open(url.path, &database) == SQLITE_OK, let database else {
      throw HelperError(.failed, "The fixture database could not be opened.")
    }
    defer { sqlite3_close(database) }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
      throw HelperError(.failed, String(cString: sqlite3_errmsg(database)))
    }
    defer { sqlite3_finalize(statement) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (offset, value) in values.enumerated() {
      if case .text(let text) = value {
        sqlite3_bind_text(statement, Int32(offset + 1), text, -1, transient)
      }
    }
    guard sqlite3_step(statement) == SQLITE_ROW else {
      throw HelperError(.failed, "The fixture query found nothing.")
    }
    return sqlite3_column_int64(statement, 0)
  }

  /// Runs statements against a fixture, as Messages would write to it.
  static func write(_ url: URL, _ sql: String, _ values: [Value] = []) throws {
    var database: OpaquePointer?
    guard sqlite3_open(url.path, &database) == SQLITE_OK, let database else {
      throw HelperError(.failed, "The fixture database could not be opened.")
    }
    defer { sqlite3_close(database) }
    if values.isEmpty { try exec(database, sql) } else { try run(database, sql, values) }
  }

  private static func exec(_ database: OpaquePointer, _ sql: String) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
      throw HelperError(.failed, String(cString: sqlite3_errmsg(database)))
    }
  }

  private static func run(_ database: OpaquePointer, _ sql: String, _ values: [Value]) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
      throw HelperError(.failed, String(cString: sqlite3_errmsg(database)))
    }
    defer { sqlite3_finalize(statement) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      switch value {
      case .null: sqlite3_bind_null(statement, index)
      case .integer(let number): sqlite3_bind_int64(statement, index, number)
      case .text(let text): sqlite3_bind_text(statement, index, text, -1, transient)
      case .blob(let bytes):
        bytes.withUnsafeBytes {
          _ = sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(bytes.count), transient)
        }
      }
    }
    guard sqlite3_step(statement) == SQLITE_DONE else {
      throw HelperError(.failed, String(cString: sqlite3_errmsg(database)))
    }
  }
}
