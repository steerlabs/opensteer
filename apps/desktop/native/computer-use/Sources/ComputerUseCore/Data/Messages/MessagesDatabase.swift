import Darwin
import Foundation
import SQLite3

/// One read-only connection to `chat.db`, closed when the call that opened it ends.
final class MessagesDatabase {
  enum Value {
    case integer(Int64)
    case text(String)
  }

  struct Row {
    fileprivate let values: [Any?]

    func isNull(_ index: Int) -> Bool { values[index] == nil }

    func integer(_ index: Int) -> Int64 { (values[index] as? Int64) ?? 0 }
    func text(_ index: Int) -> String? { values[index] as? String }
    func blob(_ index: Int) -> [UInt8]? { values[index] as? [UInt8] }
  }

  private let handle: OpaquePointer

  private init(handle: OpaquePointer) {
    self.handle = handle
  }

  /// Opens `chat.db` read-only, the file first: only `EPERM` there is the
  /// Full Disk Access this helper lacks (`MessagesReader.openFailure`).
  static func open(_ path: String) throws -> MessagesDatabase {
    let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC)
    guard descriptor >= 0 else { throw MessagesReader.openFailure(errno: errno) }
    Darwin.close(descriptor)
    var handle: OpaquePointer?
    guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let handle
    else {
      sqlite3_close(handle)
      throw MessagesReader.readFailure
    }
    return MessagesDatabase(handle: handle)
  }

  deinit {
    sqlite3_close_v2(handle)
  }

  func rows(_ sql: String, _ values: [Value]) throws -> [Row] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw MessagesReader.readFailure
    }
    defer { sqlite3_finalize(statement) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (offset, value) in values.enumerated() {
      switch value {
      case .integer(let number): sqlite3_bind_int64(statement, Int32(offset + 1), number)
      case .text(let text): sqlite3_bind_text(statement, Int32(offset + 1), text, -1, transient)
      }
    }
    var rows: [Row] = []
    while true {
      switch sqlite3_step(statement) {
      case SQLITE_ROW:
        rows.append(Row(values: (0..<sqlite3_column_count(statement)).map { column in
          switch sqlite3_column_type(statement, column) {
          case SQLITE_INTEGER: return sqlite3_column_int64(statement, column)
          case SQLITE_TEXT: return sqlite3_column_text(statement, column).map { String(cString: $0) }
          case SQLITE_BLOB:
            let count = Int(sqlite3_column_bytes(statement, column))
            guard let bytes = sqlite3_column_blob(statement, column), count > 0 else { return [UInt8]() }
            return [UInt8](UnsafeRawBufferPointer(start: bytes, count: count))
          default: return nil
          }
        }))
      case SQLITE_DONE:
        return rows
      default:
        throw MessagesReader.readFailure
      }
    }
  }
}
