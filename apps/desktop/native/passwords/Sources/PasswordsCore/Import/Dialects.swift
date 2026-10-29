import Foundation

/// A CSV export dialect, recognised by its header names (lower-cased).
///
/// Several headers are subsets of others (Chrome's is inside many), so the
/// dialect with the most signature groups present wins; a dialect matches
/// only when every group has one of its names in the header.
struct CSVDialect {
  let format: ImportFormat
  /// Groups of alternative names; every group must be present.
  let signature: [[String]]
  let url: [String]
  let username: [String]
  let password: [String]
  let label: [String]
  let totp: [String]
  /// Bitwarden joins several URIs into one cell with commas.
  var splitsURLs = false
  /// The column and value that mark a login row, when the export mixes kinds.
  var loginType: (column: String, value: String)?

  static let all: [CSVDialect] = [
    CSVDialect(
      format: .chrome,
      signature: [["name"], ["url"], ["username"], ["password"]],
      url: ["url"], username: ["username"], password: ["password"], label: ["name"], totp: []),
    CSVDialect(
      format: .applePasswords,
      signature: [["title"], ["url"], ["username"], ["password"], ["otpauth"]],
      url: ["url"], username: ["username"], password: ["password"], label: ["title"], totp: ["otpauth"]),
    CSVDialect(
      format: .firefox,
      signature: [["url"], ["username"], ["password"], ["httprealm"], ["formactionorigin"], ["guid"]],
      url: ["url"], username: ["username"], password: ["password"], label: [], totp: []),
    CSVDialect(
      format: .onePassword,
      signature: [["title"], ["url", "website"], ["username"], ["password"], ["otpauth"], ["favorite", "archived", "tags"]],
      url: ["url", "website"], username: ["username"], password: ["password"], label: ["title"], totp: ["otpauth"]),
    CSVDialect(
      format: .bitwardenCSV,
      signature: [["type"], ["name"], ["login_uri"], ["login_username"], ["login_password"]],
      url: ["login_uri"], username: ["login_username"], password: ["login_password"], label: ["name"], totp: ["login_totp"],
      splitsURLs: true, loginType: (column: "type", value: "login")),
  ]

  static let generic = CSVDialect(
    format: .generic,
    signature: [["url", "website", "uri", "login_uri", "login url"], ["username", "login", "email", "user", "login_username"], ["password", "login_password"]],
    url: ["url", "website", "uri", "login_uri", "login url"],
    username: ["username", "login", "email", "user", "login_username"],
    password: ["password", "login_password"],
    label: ["name", "title"],
    totp: ["totp", "otpauth", "otp", "login_totp"])

  static func detect(_ header: [String]) -> CSVDialect? {
    let names = Set(header)
    let matching = all.filter { $0.matches(names) }
    if let best = matching.max(by: { $0.signature.count < $1.signature.count }) {
      return best
    }
    return generic.matches(names) ? generic : nil
  }

  private func matches(_ names: Set<String>) -> Bool {
    signature.allSatisfy { group in group.contains(where: names.contains) }
  }

  func resolve(_ header: [String]) -> ResolvedColumns {
    func column(_ alternatives: [String]) -> Int? {
      for name in alternatives {
        if let index = header.firstIndex(of: name) { return index }
      }
      return nil
    }
    return ResolvedColumns(
      url: column(url), username: column(username), password: column(password),
      label: column(label), totp: column(totp), splitsURLs: splitsURLs,
      loginType: loginType.flatMap { type in column([type.column]).map { ($0, type.value) } })
  }
}

struct ResolvedColumns {
  let url: Int?
  let username: Int?
  let password: Int?
  let label: Int?
  let totp: Int?
  let splitsURLs: Bool
  let loginType: (index: Int, value: String)?

  func login(from cells: [String]) -> RawLogin {
    func cell(_ index: Int?) -> String { index.map { cells[$0] } ?? "" }
    let urlCell = cell(url)
    let urls = splitsURLs ? Self.splitURIs(urlCell) : [urlCell]
    var raw = RawLogin(urls: urls, username: cell(username), password: cell(password), totp: cell(totp), label: cell(label))
    raw.urlsFromSplit = urls.count > 1
    if let loginType {
      raw.isLogin = ASCII.lowercased(cells[loginType.index].trimmingCharacters(in: .whitespaces)) == loginType.value
    }
    return raw
  }

  /// Bitwarden joins a login's URIs with commas, but one URI may hold a comma
  /// itself (`?return=/a,b`). A comma starts a new URI only when a scheme
  /// (`https://`, `androidapp://`, …) follows it directly.
  static func splitURIs(_ cell: String) -> [String] {
    let bytes = Array(cell.utf8)
    var parts: [String] = []
    var start = 0
    for index in bytes.indices where bytes[index] == UInt8(ascii: ",") && startsWithScheme(bytes, at: index + 1) {
      parts.append(String(decoding: bytes[start..<index], as: UTF8.self))
      start = index + 1
    }
    parts.append(String(decoding: bytes[start...], as: UTF8.self))
    return parts
  }

  /// RFC 3986 `scheme ":" "//"`: a letter, then letters, digits, `+`, `-` or `.`.
  private static func startsWithScheme(_ bytes: [UInt8], at start: Int) -> Bool {
    guard start < bytes.count, ASCII.isLetter(bytes[start]) else { return false }
    var index = start + 1
    while index < bytes.count,
      ASCII.isLetter(bytes[index]) || ASCII.isDigit(bytes[index]) || [UInt8(ascii: "+"), UInt8(ascii: "-"), UInt8(ascii: ".")].contains(bytes[index])
    {
      index += 1
    }
    return bytes[index...].starts(with: Array("://".utf8))
  }
}
