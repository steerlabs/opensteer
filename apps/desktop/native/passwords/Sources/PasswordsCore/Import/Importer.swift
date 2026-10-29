import Foundation

/// Parses a password-manager export into bounded, normalised candidates.
///
/// Runs in the sandboxed import worker, which has no keys and no network.
/// The broker revalidates every candidate when it commits.
public enum PasswordImporter {
  /// Detects the format: a JSON object is a Bitwarden export, anything else
  /// is CSV whose dialect is the most specific matching header.
  public static func parse(_ data: Data) throws -> ImportResult {
    guard data.count <= ImportLimits.maxInputBytes else { throw ImportError.tooLarge }
    var start = data.startIndex
    if data.starts(with: [0xEF, 0xBB, 0xBF]) { start += 3 }
    let firstByte = data[start...].first { ![0x20, 0x09, 0x0A, 0x0D].contains($0) }
    if firstByte == UInt8(ascii: "{") {
      return try BitwardenJSON.parse(data[start...])
    }
    return try parseCSV(data)
  }

  static func parseCSV(_ data: Data) throws -> ImportResult {
    let table = try CSVParser.parse(data)
    let header = table.header.map { ASCII.lowercased($0.trimmingCharacters(in: .whitespaces)) }
    var seen = Set<String>()
    for name in header where !name.isEmpty {
      guard seen.insert(name).inserted else { throw ImportError.duplicateHeader(name) }
    }
    guard let dialect = CSVDialect.detect(header) else { throw ImportError.unrecognizedHeader }
    let columns = dialect.resolve(header)
    var builder = CandidateBuilder()
    for record in table.records {
      guard !record.widthMismatch, record.cells.count == header.count else {
        builder.skip(record.row, .columnCount)
        continue
      }
      try builder.add(columns.login(from: record.cells), row: record.row)
    }
    return ImportResult(format: dialect.format, candidates: builder.candidates, skipped: builder.skipped)
  }
}

/// A login as the export spelled it, before validation.
struct RawLogin {
  var urls: [String]
  /// The URLs came from splitting one cell, so none may gain a scheme and
  /// they must all be on one site.
  var urlsFromSplit = false
  var username: String
  var password: String
  var totp: String
  var label: String
  var isLogin = true
}

struct CandidateBuilder {
  private(set) var candidates: [ImportCandidate] = []
  private(set) var skipped: [ImportSkip] = []

  mutating func skip(_ row: Int, _ reason: ImportSkipReason) {
    skipped.append(ImportSkip(row: row, reason: reason))
  }

  /// Returns whether the row became a candidate.
  @discardableResult
  mutating func add(_ raw: RawLogin, row: Int) throws -> Bool {
    switch Self.candidate(raw, row: row) {
    case .success(let candidate):
      guard candidates.count < ImportLimits.maxCandidates else { throw ImportError.tooManyCandidates }
      candidates.append(candidate)
      return true
    case .failure(let reason):
      skip(row, reason.reason)
      return false
    }
  }

  private struct Skip: Error {
    let reason: ImportSkipReason
  }

  private static func candidate(_ raw: RawLogin, row: Int) -> Result<ImportCandidate, Skip> {
    guard raw.isLogin else { return .failure(Skip(reason: .notLogin)) }
    var origins: [String] = []
    var loginURL: String?
    var sawHTTP = false
    var sawUnsupported = false
    for rawURL in raw.urls {
      let url = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !url.isEmpty else { continue }
      switch classify(url, mayAddScheme: !raw.urlsFromSplit) {
      case .https(let login, let origin):
        if loginURL == nil { loginURL = login }
        if !origins.contains(origin), origins.count < VaultLimits.maxOrigins { origins.append(origin) }
      case .http:
        sawHTTP = true
      case .unsupported:
        sawUnsupported = true
      }
    }
    guard let loginURL else {
      if sawHTTP { return .failure(Skip(reason: .notHTTPS)) }
      return .failure(Skip(reason: sawUnsupported ? .unsupportedURL : .noURL))
    }
    if raw.urlsFromSplit, Set(origins.map(Origins.site(ofOrigin:))).count > 1 {
      return .failure(Skip(reason: .urlsSpanSites))
    }
    guard !raw.password.isEmpty else { return .failure(Skip(reason: .noPassword)) }
    let label = raw.label.isEmpty ? nil : raw.label
    guard raw.username.utf8.count <= VaultLimits.maxUsernameBytes,
      raw.password.utf8.count <= VaultLimits.maxPasswordBytes,
      (label?.utf8.count ?? 0) <= VaultLimits.maxLabelBytes,
      loginURL.utf8.count <= VaultLimits.maxLoginURLBytes
    else { return .failure(Skip(reason: .tooLarge)) }
    var totp: TOTPParameters?
    let totpText = raw.totp.trimmingCharacters(in: .whitespacesAndNewlines)
    if !totpText.isEmpty {
      guard let parsed = try? TOTPParameters(parsing: totpText) else { return .failure(Skip(reason: .invalidTOTP)) }
      totp = parsed
    }
    return .success(ImportCandidate(
      origins: origins, loginURL: loginURL, username: raw.username, password: raw.password,
      totp: totp, label: label, sourceRow: row))
  }

  private enum URLKind {
    case https(loginURL: String, origin: String)
    case http
    case unsupported
  }

  /// A value without a scheme (`example.com/login`, common in hand-made and
  /// 1Password rows) is read as HTTPS, unless it came from splitting a cell:
  /// there a bare tail may be the rest of the previous URL. Any other scheme
  /// is not a website login.
  private static func classify(_ url: String, mayAddScheme: Bool) -> URLKind {
    let lower = ASCII.lowercased(url)
    if lower.hasPrefix("http://") { return .http }
    guard lower.contains("://") || mayAddScheme else { return .unsupported }
    let candidate = lower.contains("://") ? url : "https://" + url
    guard ASCII.lowercased(candidate).hasPrefix("https://"),
      let login = Origins.normalizeLoginURL(candidate),
      let origin = Origins.normalizeOrigin(candidate)
    else { return .unsupported }
    return .https(loginURL: login, origin: origin)
  }
}
