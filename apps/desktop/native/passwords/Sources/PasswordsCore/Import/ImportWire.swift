import Foundation

/// The import worker's one answer on standard output, as canonical JSON:
///
///     {"result":{"candidates":[…],"format":"chrome","ignoredURLs":[…],"skipped":[…]},"v":1}
///     {"error":{"code":"malformedCSV","name":null,"row":12},"v":1}
///
/// The worker is sandboxed because it parses files the person did not write,
/// so the broker treats what it prints as hostile too: exact canonical bytes,
/// closed key sets, and every candidate validated as a vault draft. Anything
/// else is an unreadable answer, never a partial import.
public enum ImportWire {
  /// Larger than any answer a 16 MiB export can produce in practice; past it
  /// the worker is stopped.
  public static let maxOutputBytes = 64 << 20

  public enum DecodeError: Error, Equatable, Sendable {
    case unreadable
  }

  public static func encode(_ result: ImportResult) throws -> Data {
    try CanonicalJSON.encode(.object([
      "result": .object([
        "candidates": .array(result.candidates.map(candidateJSON)),
        "format": .string(result.format.rawValue),
        "ignoredURLs": .array(result.ignoredURLs.map(skipJSON)),
        "skipped": .array(result.skipped.map(skipJSON)),
      ]),
      "v": .integer(1),
    ]))
  }

  public static func encode(_ error: ImportError) throws -> Data {
    let (code, name, row) = errorFields(error)
    return try CanonicalJSON.encode(.object([
      "error": .object([
        "code": .string(code),
        "name": name.map(JSONValue.string) ?? .null,
        "row": row.map { .integer(Int64($0)) } ?? .null,
      ]),
      "v": .integer(1),
    ]))
  }

  /// The worker's answer, or `DecodeError.unreadable`.
  public static func decode(_ data: Data) throws -> Result<ImportResult, ImportError> {
    guard data.count <= maxOutputBytes else { throw DecodeError.unreadable }
    do {
      let value = try CanonicalJSON.parseCanonical(data)
      guard case .object(let top) = value, top["v"] == .integer(1) else { throw DecodeError.unreadable }
      if top["result"] != nil {
        let object = try StrictObject(value, keys: ["result", "v"], context: "answer")
        return .success(try result(from: try object.value("result")))
      }
      let object = try StrictObject(value, keys: ["error", "v"], context: "answer")
      return .failure(try importError(from: try object.value("error")))
    } catch {
      throw DecodeError.unreadable
    }
  }

  // MARK: Encoding

  private static func skipJSON(_ skip: ImportSkip) -> JSONValue {
    .object(["reason": .string(skip.reason.rawValue), "row": .integer(Int64(skip.row))])
  }

  private static func candidateJSON(_ candidate: ImportCandidate) -> JSONValue {
    .object([
      "label": candidate.label.map(JSONValue.string) ?? .null,
      "loginURL": .string(candidate.loginURL),
      "origins": .array(candidate.origins.map(JSONValue.string)),
      "password": .string(candidate.password),
      "sourceRow": .integer(Int64(candidate.sourceRow)),
      "totp": candidate.totp?.json ?? .null,
      "username": .string(candidate.username),
    ])
  }

  private static func errorFields(_ error: ImportError) -> (String, String?, Int?) {
    switch error {
    case .notUTF8: return ("notUTF8", nil, nil)
    case .tooLarge: return ("tooLarge", nil, nil)
    case .tooManyRows: return ("tooManyRows", nil, nil)
    case .tooManyColumns: return ("tooManyColumns", nil, nil)
    case .tooManyCandidates: return ("tooManyCandidates", nil, nil)
    case .tooManyCells: return ("tooManyCells", nil, nil)
    case .malformedCSV(let row): return ("malformedCSV", nil, row)
    case .emptyFile: return ("emptyFile", nil, nil)
    case .unrecognizedHeader: return ("unrecognizedHeader", nil, nil)
    case .duplicateHeader(let name): return ("duplicateHeader", name, nil)
    case .bitwardenEncrypted: return ("bitwardenEncrypted", nil, nil)
    case .unrecognizedJSON: return ("unrecognizedJSON", nil, nil)
    case .invalidJSON: return ("invalidJSON", nil, nil)
    }
  }

  // MARK: Decoding

  private static func result(from value: JSONValue) throws -> ImportResult {
    let object = try StrictObject(value, keys: ["candidates", "format", "ignoredURLs", "skipped"], context: "result")
    guard let format = ImportFormat(rawValue: try object.string("format")) else { throw DecodeError.unreadable }
    let candidateValues = try object.array("candidates")
    let skippedValues = try object.array("skipped")
    let ignoredValues = try object.array("ignoredURLs")
    guard candidateValues.count <= ImportLimits.maxCandidates, skippedValues.count <= ImportLimits.maxRows,
      ignoredValues.count <= ImportLimits.maxRows
    else { throw DecodeError.unreadable }
    let candidates = try candidateValues.map(candidate)
    // Rows are selected by number, so one number names one candidate.
    guard Set(candidates.map(\.sourceRow)).count == candidates.count else { throw DecodeError.unreadable }
    return ImportResult(
      format: format, candidates: candidates, skipped: try skippedValues.map(skip), ignoredURLs: try ignoredValues.map(skip))
  }

  private static func skip(_ value: JSONValue) throws -> ImportSkip {
    let skip = try StrictObject(value, keys: ["reason", "row"], context: "skip")
    guard let reason = ImportSkipReason(rawValue: try skip.string("reason")) else { throw DecodeError.unreadable }
    return ImportSkip(row: try row(skip.integer("row")), reason: reason)
  }

  private static func candidate(_ value: JSONValue) throws -> ImportCandidate {
    let object = try StrictObject(
      value, keys: ["label", "loginURL", "origins", "password", "sourceRow", "totp", "username"], context: "candidate")
    let origins = try object.array("origins").map { origin -> String in
      guard case .string(let text) = origin else { throw DecodeError.unreadable }
      return text
    }
    let totpValue = try object.value("totp")
    let candidate = ImportCandidate(
      origins: origins,
      loginURL: try object.string("loginURL"),
      username: try object.string("username"),
      password: try object.string("password"),
      totp: totpValue == .null ? nil : try TOTPParameters(json: totpValue),
      label: try object.optionalString("label"),
      sourceRow: try row(object.integer("sourceRow"))
    )
    // The same rules a commit applies, so a worker cannot hand over a
    // candidate the vault would later refuse halfway through an import.
    try candidate.draft.validate()
    return candidate
  }

  private static func importError(from value: JSONValue) throws -> ImportError {
    let object = try StrictObject(value, keys: ["code", "name", "row"], context: "error")
    let name = try object.optionalString("name")
    let rowValue = try object.value("row")
    let row: Int?
    switch rowValue {
    case .null: row = nil
    case .integer(let number): row = try Self.row(number)
    default: throw DecodeError.unreadable
    }
    let error: ImportError
    switch try object.string("code") {
    case "notUTF8": error = .notUTF8
    case "tooLarge": error = .tooLarge
    case "tooManyRows": error = .tooManyRows
    case "tooManyColumns": error = .tooManyColumns
    case "tooManyCandidates": error = .tooManyCandidates
    case "tooManyCells": error = .tooManyCells
    case "malformedCSV":
      guard let row else { throw DecodeError.unreadable }
      error = .malformedCSV(row: row)
    case "emptyFile": error = .emptyFile
    case "unrecognizedHeader": error = .unrecognizedHeader
    case "duplicateHeader":
      guard let name, name.utf8.count <= 1_024 else { throw DecodeError.unreadable }
      error = .duplicateHeader(name)
    case "bitwardenEncrypted": error = .bitwardenEncrypted
    case "unrecognizedJSON": error = .unrecognizedJSON
    case "invalidJSON": error = .invalidJSON
    default: throw DecodeError.unreadable
    }
    // The fields an error does not carry must be null, so one error has one spelling.
    guard errorFields(error) == (try object.string("code"), name, row) else { throw DecodeError.unreadable }
    return error
  }

  private static func row(_ value: Int64) throws -> Int {
    guard (1...Int64(ImportLimits.maxRows + 1)).contains(value) else { throw DecodeError.unreadable }
    return Int(value)
  }
}
