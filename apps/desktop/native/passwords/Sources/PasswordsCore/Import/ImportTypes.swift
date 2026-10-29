import Foundation

public enum ImportLimits {
  public static let maxInputBytes = 16 << 20
  public static let maxRows = 20_000
  public static let maxColumns = 1_024
  public static let maxCandidates = 10_000
  /// Cells a CSV may hold in rows of the header's width: 20,000 rows of 50
  /// columns. Each is a `String`, so 16 MiB of empty cells is not.
  public static let maxCells = 1_000_000
  /// JSON values a Bitwarden export may hold, counted while parsing.
  public static let maxJSONValues = 2_000_000
}

public enum ImportFormat: String, Sendable, Codable, CaseIterable {
  /// Chrome, Edge and Brave: `name,url,username,password[,note]`.
  case chrome
  /// Apple Passwords and Safari: `Title,URL,Username,Password,Notes,OTPAuth`.
  case applePasswords
  case firefox
  case onePassword
  case bitwardenCSV
  case bitwardenJSON
  /// Any CSV with URL, username and password columns.
  case generic
}

/// One login read from an export. Fields are exactly the file's bytes;
/// origins and the login URL are normalised.
public struct ImportCandidate: Sendable, Codable {
  public let origins: [String]
  public let loginURL: String
  public let username: String
  public let password: String
  public let totp: TOTPParameters?
  public let label: String?
  /// CSV record number (the header is 1) or 1-based Bitwarden item index.
  public let sourceRow: Int

  public var draft: ItemDraft {
    ItemDraft(origins: origins, loginURL: loginURL, username: username, password: password, totp: totp, label: label)
  }
}

public enum ImportSkipReason: String, Sendable, Codable {
  case notHTTPS
  case noPassword
  case noURL
  /// `android://`, `chrome://`, IP addresses, `localhost` and the like.
  case unsupportedURL
  case invalidTOTP
  case tooLarge
  /// Not a login (a Bitwarden note or card).
  case notLogin
  /// The row has a different number of cells than the header, so its
  /// columns cannot be trusted (for example an unquoted comma in a password).
  case columnCount
  /// A Bitwarden CSV cell whose URIs belong to more than one site: a comma
  /// inside one URI and a comma between two cannot be told apart there. The
  /// JSON export keeps each URI separate.
  case urlsSpanSites
  /// A Bitwarden URI marked "Never" (never fill on it).
  case neverMatch
  /// A Bitwarden URI matched by a regular expression, which an origin cannot express.
  case regexMatch
}

public struct ImportSkip: Sendable, Equatable, Codable {
  public let row: Int
  public let reason: ImportSkipReason
}

public struct ImportResult: Sendable, Codable {
  public let format: ImportFormat
  public let candidates: [ImportCandidate]
  public let skipped: [ImportSkip]
  /// Web addresses left out of logins that were imported, with why
  /// (Bitwarden's "Never" and regular-expression URIs).
  public let ignoredURLs: [ImportSkip]

  init(format: ImportFormat, candidates: [ImportCandidate], skipped: [ImportSkip], ignoredURLs: [ImportSkip] = []) {
    self.format = format
    self.candidates = candidates
    self.skipped = skipped
    self.ignoredURLs = ignoredURLs
  }
}

public enum ImportError: Error, Equatable, Sendable, CustomStringConvertible {
  case notUTF8
  case tooLarge
  case tooManyRows
  case tooManyColumns
  case tooManyCandidates
  case tooManyCells
  case malformedCSV(row: Int)
  case emptyFile
  case unrecognizedHeader
  case duplicateHeader(String)
  case bitwardenEncrypted
  case unrecognizedJSON
  case invalidJSON

  public var description: String {
    switch self {
    case .notUTF8: return "This file isn't UTF-8 text. Save the export as UTF-8."
    case .tooLarge: return "The file is larger than 16 MB."
    case .tooManyRows: return "The file has more than \(ImportLimits.maxRows) rows."
    case .tooManyColumns: return "A row has more than \(ImportLimits.maxColumns) columns."
    case .tooManyCandidates: return "The file has more than \(ImportLimits.maxCandidates) logins."
    case .tooManyCells: return "The file holds more than a password export does. Export only your passwords."
    case .malformedCSV(let row): return "Row \(row) isn't valid CSV."
    case .emptyFile: return "The file is empty."
    case .unrecognizedHeader: return "The file needs URL, username and password columns."
    case .duplicateHeader(let name): return "The column \(name) appears twice."
    case .bitwardenEncrypted: return "Export from Bitwarden without a password, then import."
    case .unrecognizedJSON: return "This JSON file isn't a Bitwarden export."
    case .invalidJSON: return "The JSON file is malformed."
    }
  }
}
