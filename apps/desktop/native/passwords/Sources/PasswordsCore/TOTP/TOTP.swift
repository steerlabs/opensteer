import CryptoKit
import Foundation

public enum TOTPAlgorithm: String, Sendable, Codable, CaseIterable {
  case sha1 = "SHA1"
  case sha256 = "SHA256"
  case sha512 = "SHA512"
}

public enum TOTPError: Error, Equatable, Sendable {
  case notTOTP
  case hotpNotSupported
  case malformedURI
  case unknownParameter(String)
  case duplicateParameter(String)
  case missingSecret
  case invalidSecret
  case unsupportedAlgorithm(String)
  case unsupportedDigits
  case unsupportedPeriod
  case timeBeforeEpoch
}

/// RFC 6238 parameters. Construction validates them, so every value of this
/// type can produce a code.
public struct TOTPParameters: Sendable, Equatable, Codable {
  public static let allowedDigits: Set<Int> = [6, 8]
  public static let periodRange = 15...120
  public static let secretByteRange = 1...128

  public let secret: Data
  public let algorithm: TOTPAlgorithm
  public let digits: Int
  public let period: Int

  public init(secret: Data, algorithm: TOTPAlgorithm = .sha1, digits: Int = 6, period: Int = 30) throws {
    guard Self.secretByteRange.contains(secret.count) else { throw TOTPError.invalidSecret }
    guard Self.allowedDigits.contains(digits) else { throw TOTPError.unsupportedDigits }
    guard Self.periodRange.contains(period) else { throw TOTPError.unsupportedPeriod }
    self.secret = secret
    self.algorithm = algorithm
    self.digits = digits
    self.period = period
  }

  /// Parses an `otpauth://totp/...` URI or a bare base32 secret (RFC 4648,
  /// any case, padding optional, spaces between groups allowed).
  ///
  /// A bare secret is always base32, as otpauth URIs and every exporter
  /// Opensteer reads write it. Hex is never guessed, even for text that is
  /// valid both ways (`deadbeef…` is base32 here): guessing would give a
  /// different secret, and codes that silently never work.
  ///
  /// HOTP and unknown query parameters are refused rather than ignored: a
  /// parameter this code does not understand may change the codes (for
  /// example `encoder=steam`). `issuer` and `image` are display-only.
  public init(parsing text: String) throws {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if ASCII.lowercased(trimmed).hasPrefix("otpauth://") {
      self = try Self.parseURI(trimmed)
    } else {
      guard trimmed.contains(where: { $0 != " " }), let secret = Base32.decode(trimmed.replacingOccurrences(of: " ", with: "")) else {
        throw TOTPError.invalidSecret
      }
      try self.init(secret: secret)
    }
  }

  public func code(at date: Date) throws -> String {
    let seconds = date.timeIntervalSince1970
    guard seconds >= 0 else { throw TOTPError.timeBeforeEpoch }
    let counter = UInt64(seconds) / UInt64(period)
    var message = Data(count: 8)
    for index in 0..<8 { message[index] = UInt8(truncatingIfNeeded: counter >> UInt64(56 - index * 8)) }
    let key = SymmetricKey(data: secret)
    let mac: [UInt8]
    switch algorithm {
    case .sha1: mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: key))
    case .sha256: mac = Array(HMAC<SHA256>.authenticationCode(for: message, using: key))
    case .sha512: mac = Array(HMAC<SHA512>.authenticationCode(for: message, using: key))
    }
    let offset = Int(mac[mac.count - 1] & 0x0F)
    let binary = (UInt32(mac[offset] & 0x7F) << 24) | (UInt32(mac[offset + 1]) << 16) | (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
    let modulus: UInt32 = digits == 8 ? 100_000_000 : 1_000_000
    let value = String(binary % modulus)
    return String(repeating: "0", count: digits - value.count) + value
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      secret: try container.decode(Data.self, forKey: .secret),
      algorithm: try container.decode(TOTPAlgorithm.self, forKey: .algorithm),
      digits: try container.decode(Int.self, forKey: .digits),
      period: try container.decode(Int.self, forKey: .period)
    )
  }

  // MARK: Vault encoding

  var json: JSONValue {
    .object([
      "algorithm": .string(algorithm.rawValue),
      "digits": .integer(Int64(digits)),
      "period": .integer(Int64(period)),
      "secret": .string(Base64URL.encode(secret)),
    ])
  }

  init(json: JSONValue) throws {
    let object = try StrictObject(json, keys: ["algorithm", "digits", "period", "secret"], context: "totp")
    guard let algorithm = TOTPAlgorithm(rawValue: try object.string("algorithm")) else {
      throw TOTPError.unsupportedAlgorithm(try object.string("algorithm"))
    }
    try self.init(
      secret: try object.bytes("secret"),
      algorithm: algorithm,
      digits: Int(try object.integer("digits")),
      period: Int(try object.integer("period"))
    )
  }

  // MARK: otpauth URIs

  private static let knownParameters: Set<String> = ["secret", "issuer", "algorithm", "digits", "period", "image"]

  private static func parseURI(_ uri: String) throws -> TOTPParameters {
    guard !uri.contains("#") else { throw TOTPError.malformedURI }
    let afterScheme = uri.dropFirst("otpauth://".count)
    guard let typeEnd = afterScheme.firstIndex(where: { $0 == "/" || $0 == "?" }) else { throw TOTPError.malformedURI }
    switch ASCII.lowercased(String(afterScheme[..<typeEnd])) {
    case "totp": break
    case "hotp": throw TOTPError.hotpNotSupported
    default: throw TOTPError.notTOTP
    }
    var parameters: [String: String] = [:]
    if let queryStart = afterScheme.firstIndex(of: "?") {
      for pair in afterScheme[afterScheme.index(after: queryStart)...].split(separator: "&", omittingEmptySubsequences: false) {
        guard let equals = pair.firstIndex(of: "="),
          let name = pair[..<equals].removingPercentEncoding.map(ASCII.lowercased),
          let value = pair[pair.index(after: equals)...].removingPercentEncoding
        else { throw TOTPError.malformedURI }
        guard knownParameters.contains(name) else {
          if name == "counter" { throw TOTPError.hotpNotSupported }
          throw TOTPError.unknownParameter(name)
        }
        guard parameters[name] == nil else { throw TOTPError.duplicateParameter(name) }
        parameters[name] = value
      }
    }
    guard let secretText = parameters["secret"], !secretText.isEmpty else { throw TOTPError.missingSecret }
    guard let secret = Base32.decode(secretText) else { throw TOTPError.invalidSecret }
    var algorithm = TOTPAlgorithm.sha1
    if let name = parameters["algorithm"] {
      guard let parsed = TOTPAlgorithm(rawValue: ASCII.uppercased(name)) else { throw TOTPError.unsupportedAlgorithm(name) }
      algorithm = parsed
    }
    var digits = 6
    if let text = parameters["digits"] {
      guard let parsed = Int(text), String(parsed) == text else { throw TOTPError.unsupportedDigits }
      digits = parsed
    }
    var period = 30
    if let text = parameters["period"] {
      guard let parsed = Int(text), String(parsed) == text else { throw TOTPError.unsupportedPeriod }
      period = parsed
    }
    return try TOTPParameters(secret: secret, algorithm: algorithm, digits: digits, period: period)
  }
}
