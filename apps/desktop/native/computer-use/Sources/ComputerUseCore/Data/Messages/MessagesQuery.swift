import Darwin
import Foundation
import SQLite3
import OpensteerAppleData

struct MessagesQuery {
  let path: String
  let clock: DataClock
  var byteBudget = Paging.byteBudget
  let contacts: () throws -> [ContactRecord]

  /// Ordinary SQL only: the system library also exposes internals such as `fts3_tokenizer`.
  private static let functions = Set(
    "row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value abs avg char coalesce concat concat_ws count format glob group_concat hex ifnull iif instr length like likelihood likely lower ltrim max min nullif octet_length printf quote random replace round rtrim sign soundex sqlite_version strftime date time datetime julianday unixepoch timediff string_agg substr substring sum total trim typeof unhex unicode unlikely upper json json_array json_array_length json_error_position json_extract json_insert json_object json_patch json_quote json_remove json_replace json_set json_type json_valid json_group_array json_group_object message_text contact_name message_time"
      .split(separator: " ").map(String.init))

  private final class Context {
    var function = ""
    let clock: DataClock
    let load: () throws -> [ContactRecord]
    let budget: WorkBudget
    var contacts: MessagesContacts?
    var failure: Error?
    init(clock: DataClock, load: @escaping () throws -> [ContactRecord], budget: WorkBudget) {
      self.clock = clock
      self.load = load
      self.budget = budget
    }
  }

  func run(_ sql: String, budget: WorkBudget) throws -> JSONValue {
    guard !sql.utf8.contains(0) else { throw HelperError(.failed, "SQL must contain one statement.") }
    let database = try MessagesDatabase.open(path)
    let db = database.handle
    for (category, limit): (Int32, Int32) in [
      (SQLITE_LIMIT_LENGTH, 16 * 1_024 * 1_024), (SQLITE_LIMIT_SQL_LENGTH, 512 * 1_024),
      (SQLITE_LIMIT_COLUMN, 256), (SQLITE_LIMIT_EXPR_DEPTH, 100), (SQLITE_LIMIT_COMPOUND_SELECT, 50),
      (SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 4096), (SQLITE_LIMIT_VDBE_OP, 100_000),
      (SQLITE_LIMIT_FUNCTION_ARG, 100), (SQLITE_LIMIT_ATTACHED, 0)
    ] { sqlite3_limit(db, category, limit) }
    // Apple's SQLite omits extension loading, so a statement can never load one.
    guard sqlite3_compileoption_used("OMIT_LOAD_EXTENSION") != 0 else {
      throw HelperError(.failed, "Messages requires SQLite without extension loading.")
    }
    // Before the authorizer exists, which refuses every other pragma.
    guard sqlite3_exec(db, "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON", nil, nil, nil) == SQLITE_OK
    else { throw MessagesReader.readFailure }
    let context = Context(clock: clock, load: contacts, budget: budget)
    let pointer = Unmanaged.passUnretained(context).toOpaque()
    sqlite3_progress_handler(db, 1000, { raw in
      let context = Unmanaged<Context>.fromOpaque(raw!).takeUnretainedValue()
      return context.budget.remaining() <= 2 ? 1 : 0
    }, pointer)
    defer { sqlite3_progress_handler(db, 0, nil, nil) }
    var functions: [Context] = []
    defer { withExtendedLifetime(functions) {} }
    for (name, count) in [("message_text", 2), ("contact_name", 1), ("message_time", 1)] {
      let function = Context(clock: clock, load: contacts, budget: budget)
      function.function = name
      functions.append(function)
      sqlite3_create_function_v2(db, name, Int32(count), SQLITE_UTF8 | SQLITE_DIRECTONLY | (name == "message_text" ? SQLITE_DETERMINISTIC : 0), Unmanaged.passUnretained(function).toOpaque(), { ctx, count, values in
        let state = Unmanaged<Context>.fromOpaque(sqlite3_user_data(ctx)!).takeUnretainedValue()
        func text(_ index: Int) -> String? {
          guard let value = values?[index], sqlite3_value_type(value) != SQLITE_NULL,
            let bytes = sqlite3_value_text(value) else { return nil }
          return String(decoding: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_value_bytes(value))), as: UTF8.self)
        }
        let name = state.function
        var result: String?
        if name == "message_text" {
          guard sqlite3_value_bytes(values?[0]) <= MessagesReader.maxBodyBytes,
            sqlite3_value_bytes(values?[1]) <= MessagesReader.maxBodyBytes else {
            sqlite3_result_error(ctx, "Message body is too large; use substr() to bound it.", -1)
            return
          }
          result = DataText.present(text(0))
          if result == nil, let value = values?[1], let bytes = sqlite3_value_blob(value) {
            result = TypedStream.text(Array(UnsafeRawBufferPointer(start: bytes, count: Int(sqlite3_value_bytes(value)))))
          }
        } else if name == "message_time" {
          // Modern rows count nanoseconds and old ones seconds; no plausible count of either crosses 2^32.
          let stamp = sqlite3_value_int64(values?[0])
          let seconds = stamp.magnitude > 4_294_967_296 ? Double(stamp) / 1e9 : Double(stamp)
          result = state.clock.text(Date(timeIntervalSinceReferenceDate: seconds))
        } else {
          do {
            guard sqlite3_value_bytes(values?[0]) <= 1024 else {
              sqlite3_result_error(ctx, "Contact handle is too long.", -1); return
            }
            if state.contacts == nil { state.contacts = MessagesContacts(try state.load()) }
            result = text(0).flatMap { state.contacts?.name(for: $0) }
          } catch { state.failure = error; sqlite3_result_error(ctx, "Contacts could not be read.", -1); return }
        }
        if let result { sqlite3_result_text(ctx, result, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        else { sqlite3_result_null(ctx) }
      }, nil, nil, nil)
    }
    sqlite3_set_authorizer(db, { _, action, first, second, database, _ in
      switch action {
      case SQLITE_SELECT, SQLITE_RECURSIVE: return SQLITE_OK
      case SQLITE_READ:
        // SQLite supplies no database for CTEs and column-free table scans.
        return database.map { String(cString: $0) == "main" } != false ? SQLITE_OK : SQLITE_DENY
      case SQLITE_FUNCTION:
        return second.map { Self.functions.contains(String(cString: $0).lowercased()) } == true ? SQLITE_OK : SQLITE_DENY
      case SQLITE_PRAGMA:
        let allowed = ["table_info", "table_xinfo", "index_list", "index_info", "index_xinfo", "foreign_key_list"]
        return first.map { allowed.contains(String(cString: $0).lowercased()) } == true ? SQLITE_OK : SQLITE_DENY
      default: return SQLITE_DENY
      }
    }, nil)
    func failure() -> HelperError {
      if budget.remaining() <= 2 { return HelperError(.failed, "Messages query ran out of time. Add a WHERE clause or LIMIT and try again.") }
      let message = String(cString: sqlite3_errmsg(db))
      return HelperError(.failed, message.contains("/") || message.contains("\\") ? "Messages query failed. Check the SQL and try again." : String(message.prefix(512)))
    }
    guard budget.remaining() > 2 else { throw failure() }
    var statement: OpaquePointer?
    let valid = sql.withCString { source -> Bool in
      var tail: UnsafePointer<CChar>?
      guard sqlite3_prepare_v2(db, source, -1, &statement, &tail) == SQLITE_OK else { return false }
      return tail.map { String(cString: $0).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? true
    }
    defer { sqlite3_finalize(statement) }
    guard valid else {
      if sqlite3_errcode(db) != SQLITE_OK { throw failure() }
      throw HelperError(.failed, "SQL must contain exactly one statement.")
    }
    guard let statement, sqlite3_stmt_readonly(statement) != 0 else { throw failure() }
    let columns = (0..<sqlite3_column_count(statement)).map { JSONValue.string(String(cString: sqlite3_column_name(statement, $0))) }
    var rows: [JSONValue] = []
    var bytes = try JSONCoding.encoder.encode(JSONValue.object(["columns": .array(columns), "rows": .array([]), "truncated": .bool(false)])).count
    guard bytes <= byteBudget else { throw HelperError(.failed, "Query columns exceed the result budget. Select fewer columns.") }
    while true {
      let status = sqlite3_step(statement)
      if let error = functions.compactMap(\.failure).first { throw error }
      if status == SQLITE_DONE { return .object(["columns": .array(columns), "rows": .array(rows), "truncated": .bool(false)]) }
      guard status == SQLITE_ROW else { throw failure() }
      func cell(_ column: Int32) -> JSONValue {
        switch sqlite3_column_type(statement, column) {
        case SQLITE_INTEGER:
          let value = sqlite3_column_int64(statement, column)
          return (-9_007_199_254_740_992...9_007_199_254_740_992).contains(value) ? .number(Double(value)) : .string(String(value))
        case SQLITE_FLOAT:
          let value = sqlite3_column_double(statement, column)
          return value.isFinite ? .number(value) : .null
        case SQLITE_TEXT:
          return .string(String(decoding: UnsafeBufferPointer(start: sqlite3_column_text(statement, column), count: Int(sqlite3_column_bytes(statement, column))), as: UTF8.self))
        case SQLITE_BLOB: return .string("[blob \(sqlite3_column_bytes(statement, column)) bytes]")
        default: return .null
        }
      }
      var cells: [JSONValue] = []
      var rowBytes = 2
      for column in 0..<sqlite3_column_count(statement) {
        let value = cell(column)
        rowBytes += try JSONCoding.encoder.encode(value).count + 1
        if bytes + rowBytes > byteBudget {
          guard !rows.isEmpty else { throw HelperError(.failed, "The first row exceeds the result budget. Select fewer columns or use substr().") }
          return .object(["columns": .array(columns), "rows": .array(rows), "truncated": .bool(true)])
        }
        cells.append(value)
      }
      let row = JSONValue.array(cells)
      let size = try JSONCoding.encoder.encode(row).count + 1
      bytes += size
      rows.append(row)
    }
  }
}
