import Foundation

/// Bitwarden's unencrypted JSON export:
/// `{"encrypted":false,"items":[{"type":1,"name","login":{"uris":[{"match","uri"}],
/// "username","password","totp"}}]}`. Other keys are ignored.
///
/// A URI's `match` is Bitwarden's rule for where to fill: 0–3 (domain, host,
/// starts with, exact) and null (the default) become origins, since a login
/// is released only for its site anyway; 4 (a regular expression) cannot be
/// expressed as an origin and 5 means "never fill here", so both are left
/// out and listed.
enum BitwardenJSON {
  private static let loginType: Int64 = 1

  static func parse(_ data: Data) throws -> ImportResult {
    let value: JSONValue
    do {
      value = try CanonicalJSON.parse(Data(data), maxArrayCount: ImportLimits.maxRows, maxValues: ImportLimits.maxJSONValues)
    } catch JSONError.arrayTooLong {
      throw ImportError.tooManyRows
    } catch JSONError.tooManyValues {
      throw ImportError.tooManyCells
    } catch {
      throw ImportError.invalidJSON
    }
    guard case .object(let root) = value, case .bool(let encrypted)? = root["encrypted"] else {
      throw ImportError.unrecognizedJSON
    }
    guard !encrypted else { throw ImportError.bitwardenEncrypted }
    guard case .array(let items)? = root["items"] else { throw ImportError.unrecognizedJSON }
    guard items.count <= ImportLimits.maxRows else { throw ImportError.tooManyRows }

    var builder = CandidateBuilder()
    var ignored: [ImportSkip] = []
    for (index, item) in items.enumerated() {
      let row = index + 1
      guard case .object(let fields) = item else { throw ImportError.unrecognizedJSON }
      guard case .integer(loginType)? = fields["type"], case .object(let login)? = fields["login"] else {
        builder.skip(row, .notLogin)
        continue
      }
      var urls: [String] = []
      var left: [ImportSkip] = []
      if case .array(let uris)? = login["uris"] {
        for uri in uris {
          guard case .object(let entry) = uri, case .string(let text)? = entry["uri"] else { continue }
          switch entry["match"] {
          case nil, .null?, .integer(0...3)?: urls.append(text)
          case .integer(4)?: left.append(ImportSkip(row: row, reason: .regexMatch))
          case .integer(5)?: left.append(ImportSkip(row: row, reason: .neverMatch))
          default: throw ImportError.unrecognizedJSON
          }
        }
      }
      if urls.isEmpty, let first = left.first {
        builder.skip(row, first.reason)
        continue
      }
      let added = try builder.add(
        RawLogin(
          urls: urls,
          username: string(login["username"]),
          password: string(login["password"]),
          totp: string(login["totp"]),
          label: string(fields["name"])),
        row: row)
      if added { ignored += left }
    }
    return ImportResult(
      format: .bitwardenJSON, candidates: builder.candidates, skipped: builder.skipped, ignoredURLs: ignored)
  }

  private static func string(_ value: JSONValue?) -> String {
    if case .string(let text)? = value { return text }
    return ""
  }
}
