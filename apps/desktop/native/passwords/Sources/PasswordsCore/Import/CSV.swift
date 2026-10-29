import Foundation

/// An RFC 4180 table: the header and the records after it.
struct CSVTable {
  struct Record {
    /// 1-based record number, the header being 1. A quoted field with line
    /// breaks is one record, as in a spreadsheet.
    let row: Int
    let cells: [String]
    var widthMismatch = false
  }

  let header: [String]
  let records: [Record]
}

/// RFC 4180 CSV: UTF-8 with an optional BOM; `,` (or `;` when the header has
/// no `,`); quoted fields with embedded delimiters, line breaks and `""`;
/// CRLF or LF records. Fields are copied byte for byte.
enum CSVParser {
  static func parse(_ data: Data) throws -> CSVTable {
    guard data.count <= ImportLimits.maxInputBytes else { throw ImportError.tooLarge }
    var bytes = [UInt8](data)
    if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
    guard UTF8Text.decode(bytes) != nil else { throw ImportError.notUTF8 }
    let delimiter = detectDelimiter(bytes)

    // Rows are checked against the header's width as they end: a row of
    // another width keeps only its number (the importer skips it anyway), so
    // a file of empty cells cannot become millions of strings.
    var header: [String]?
    var body: [CSVTable.Record] = []
    var record: [String] = []
    var cellCount = 0
    var recordCount = 0
    var storedCells = 0
    var field: [UInt8] = []
    var index = 0
    var atFieldStart = true
    var quoted = false

    func endField() throws {
      cellCount += 1
      guard cellCount <= ImportLimits.maxColumns else { throw ImportError.tooManyColumns }
      if let width = header?.count, cellCount > width {
        field.removeAll(keepingCapacity: true)
        return
      }
      record.append(String(decoding: field, as: UTF8.self))
      field.removeAll(keepingCapacity: true)
    }
    func endRecord() throws {
      try endField()
      recordCount += 1
      guard recordCount <= ImportLimits.maxRows + 1 else { throw ImportError.tooManyRows }
      defer {
        record = []
        cellCount = 0
      }
      guard let width = header?.count else {
        header = record
        return
      }
      // Blank lines keep their row number but hold no record.
      if cellCount == 1, record == [""] { return }
      guard cellCount == width else {
        body.append(CSVTable.Record(row: recordCount, cells: [], widthMismatch: true))
        return
      }
      storedCells += record.count
      guard storedCells <= ImportLimits.maxCells else { throw ImportError.tooManyCells }
      body.append(CSVTable.Record(row: recordCount, cells: record))
    }

    while index < bytes.count {
      let byte = bytes[index]
      if quoted {
        if byte == UInt8(ascii: "\"") {
          if index + 1 < bytes.count, bytes[index + 1] == UInt8(ascii: "\"") {
            field.append(byte)
            index += 2
            continue
          }
          quoted = false
          index += 1
          guard index == bytes.count || bytes[index] == delimiter || bytes[index] == 0x0A
            || (bytes[index] == 0x0D && index + 1 < bytes.count && bytes[index + 1] == 0x0A)
          else { throw ImportError.malformedCSV(row: recordCount + 1) }
          continue
        }
        field.append(byte)
        index += 1
        continue
      }
      if atFieldStart, byte == UInt8(ascii: "\"") {
        quoted = true
        atFieldStart = false
        index += 1
        continue
      }
      atFieldStart = false
      if byte == delimiter {
        try endField()
        atFieldStart = true
        index += 1
      } else if byte == 0x0A {
        try endRecord()
        atFieldStart = true
        index += 1
      } else if byte == 0x0D, index + 1 < bytes.count, bytes[index + 1] == 0x0A {
        try endRecord()
        atFieldStart = true
        index += 2
      } else {
        field.append(byte)
        index += 1
      }
    }
    guard !quoted else { throw ImportError.malformedCSV(row: recordCount + 1) }
    if !atFieldStart || !record.isEmpty || !field.isEmpty || cellCount > 0 {
      try endRecord()
    }

    guard let header, header.contains(where: { !$0.isEmpty }) else { throw ImportError.emptyFile }
    return CSVTable(header: header, records: body)
  }

  /// `;` only when the header line has a `;` and no `,` outside quotes.
  private static func detectDelimiter(_ bytes: [UInt8]) -> UInt8 {
    var quoted = false
    var sawComma = false
    var sawSemicolon = false
    for byte in bytes {
      if byte == UInt8(ascii: "\"") { quoted.toggle() }
      if quoted { continue }
      if byte == 0x0A { break }
      if byte == UInt8(ascii: ",") { sawComma = true }
      if byte == UInt8(ascii: ";") { sawSemicolon = true }
    }
    return !sawComma && sawSemicolon ? UInt8(ascii: ";") : UInt8(ascii: ",")
  }
}
