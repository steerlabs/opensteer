import Foundation

/// Exact HTTPS origins and site membership.
///
/// Where Foundation and the WHATWG URL parser (used by Chromium and the Host)
/// could disagree, these functions refuse instead of guessing: an origin the
/// broker releases a password to must be the origin the browser connects to.
public enum Origins {
  /// `https://host[:port]` for an HTTPS URL whose host is a DNS name with a
  /// registrable domain, or nil.
  ///
  /// Refused: other schemes, userinfo, IP literals, `localhost` and
  /// `*.localhost`, public suffixes, trailing dots, `%` or backslashes, and
  /// any whitespace or control character. The host is lower-cased and IDN is
  /// converted to punycode; port 443 is dropped.
  public static func normalizeOrigin(_ url: String) -> String? {
    parse(url)?.origin
  }

  /// The URL with its path and query kept and its fragment dropped, under the
  /// same rules as `normalizeOrigin`. An empty path becomes `/`; non-ASCII
  /// and the characters WHATWG escapes are percent-encoded.
  public static func normalizeLoginURL(_ url: String) -> String? {
    guard let parsed = parse(url), let rest = parsed.pathAndQuery else { return nil }
    return parsed.origin + rest
  }

  /// Whether `origin`'s registrable domain is `site`'s host, with equal
  /// schemes. `site` is `https://<registrable domain>` as the Host sends it;
  /// ports are ignored for site membership.
  public static func isWithinSite(_ origin: String, site: String) -> Bool {
    guard let origin = parse(origin), let site = parse(site), site.port == nil else { return false }
    return registrableDomain(origin.host) == site.host
  }

  /// Whether `text` is exactly a site as the Host sends one,
  /// `https://<registrable domain>`.
  public static func isSite(_ text: String) -> Bool {
    guard let origin = normalizeOrigin(text), origin == text else { return false }
    let host = String(text.dropFirst("https://".count))
    return registrableDomain(host) == host
  }

  /// The registrable domain of an ASCII (punycode) host under the bundled
  /// Public Suffix List, private domains included. Nil for public suffixes,
  /// IP addresses and malformed hosts.
  public static func registrableDomain(_ host: String) -> String? {
    PublicSuffixList.bundled?.registrableDomain(host)
  }

  /// The registrable domain of an origin's host, or nil.
  static func site(ofOrigin origin: String) -> String? {
    parse(origin).flatMap { registrableDomain($0.host) }
  }

  /// The origin of a URL already accepted by `normalizeLoginURL`.
  static func origin(ofLoginURL url: String) -> String? {
    parse(url)?.origin
  }

  // MARK: Parsing

  struct Parsed {
    let host: String
    let port: Int?
    /// Nil when the path or query cannot be represented exactly.
    let pathAndQuery: String?

    var origin: String {
      port.map { "https://\(host):\($0)" } ?? "https://\(host)"
    }
  }

  static func parse(_ url: String) -> Parsed? {
    let bytes = Array(url.utf8)
    guard !bytes.contains(where: { $0 <= 0x20 || $0 == 0x7F || $0 == UInt8(ascii: "\\") }) else { return nil }
    let scheme = Array("https://".utf8)
    guard bytes.count > scheme.count, bytes.prefix(scheme.count).map(asciiLower) == scheme else { return nil }
    let afterScheme = bytes[scheme.count...]
    let authorityEnd = afterScheme.firstIndex { [UInt8(ascii: "/"), UInt8(ascii: "?"), UInt8(ascii: "#")].contains($0) } ?? bytes.count
    let authority = bytes[scheme.count..<authorityEnd]
    guard !authority.isEmpty,
      !authority.contains(UInt8(ascii: "@")),
      !authority.contains(UInt8(ascii: "[")),
      !authority.contains(UInt8(ascii: "]")),
      !authority.contains(UInt8(ascii: "%"))
    else { return nil }

    var hostBytes = authority
    var port: Int?
    if let colon = authority.firstIndex(of: UInt8(ascii: ":")) {
      let portBytes = authority[(colon + 1)...]
      guard let parsedPort = parsePort(portBytes) else { return nil }
      hostBytes = authority[..<colon]
      port = parsedPort == 443 ? nil : parsedPort
    }
    guard let rawHost = UTF8Text.decode(hostBytes), let host = Hosts.normalize(rawHost) else { return nil }
    return Parsed(host: host, port: port, pathAndQuery: pathAndQuery(bytes[authorityEnd...]))
  }

  private static func parsePort(_ bytes: ArraySlice<UInt8>) -> Int? {
    guard (1...5).contains(bytes.count),
      bytes.first != UInt8(ascii: "0"),
      bytes.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
      let value = Int(String(decoding: bytes, as: UTF8.self)),
      (1...65535).contains(value)
    else { return nil }
    return value
  }

  private static func pathAndQuery(_ bytes: ArraySlice<UInt8>) -> String? {
    var rest = bytes
    if let hash = rest.firstIndex(of: UInt8(ascii: "#")) { rest = rest[..<hash] }
    var path = rest
    var query: ArraySlice<UInt8>?
    if let mark = rest.firstIndex(of: UInt8(ascii: "?")) {
      path = rest[..<mark]
      query = rest[(mark + 1)...]
    }
    // WHATWG resolves dot segments; refusing them keeps both sides identical.
    let segments = path.split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false)
    for segment in segments {
      let lowered = ASCII.lowercased(String(decoding: segment, as: UTF8.self))
      if [".", "..", "%2e", ".%2e", "%2e.", "%2e%2e"].contains(lowered) { return nil }
    }
    guard let encodedPath = percentEncode(path, escaping: pathEscapes) else { return nil }
    var out = encodedPath.isEmpty ? "/" : encodedPath
    if let query {
      guard let encodedQuery = percentEncode(query, escaping: queryEscapes) else { return nil }
      out += "?" + encodedQuery
    }
    return out
  }

  private static let pathEscapes: Set<UInt8> = Set("\"<>`{}".utf8)
  private static let queryEscapes: Set<UInt8> = Set("\"<>'".utf8)

  private static func percentEncode(_ bytes: ArraySlice<UInt8>, escaping: Set<UInt8>) -> String? {
    var out = ""
    var index = bytes.startIndex
    while index < bytes.endIndex {
      let byte = bytes[index]
      if byte == UInt8(ascii: "%") {
        guard index + 2 < bytes.endIndex,
          Hex.value(of: bytes[index + 1], allowUpper: true) != nil,
          Hex.value(of: bytes[index + 2], allowUpper: true) != nil
        else { return nil }
        out += String(decoding: bytes[index...(index + 2)], as: UTF8.self)
        index += 3
        continue
      }
      if byte >= 0x80 || escaping.contains(byte) {
        out += String(format: "%%%02X", byte)
      } else {
        out.unicodeScalars.append(Unicode.Scalar(byte))
      }
      index += 1
    }
    return out
  }

  private static func asciiLower(_ byte: UInt8) -> UInt8 {
    (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) ? byte + 32 : byte
  }
}

/// Host-name rules shared by origin parsing and the Public Suffix List.
enum Hosts {
  /// A lower-case ASCII DNS name with a registrable domain, or nil.
  static func normalize(_ raw: String) -> String? {
    guard !raw.isEmpty, !raw.hasSuffix(".") else { return nil }
    let ascii: String
    if raw.utf8.allSatisfy({ $0 < 0x80 }) {
      ascii = ASCII.lowercased(raw)
    } else {
      guard let converted = idnaToASCII(raw) else { return nil }
      ascii = converted
    }
    guard ascii.utf8.count <= 253 else { return nil }
    let labels = ascii.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard labels.count >= 2, labels.allSatisfy(isValidLabel), !endsInNumber(labels) else { return nil }
    // An ACE label must be exactly what the strict path below makes of the
    // text it decodes to, as UTS46 requires of `xn--` labels. Without this,
    // labels a browser refuses (controls, bidirectional overrides, upper
    // case, non-NFC text, dot lookalikes, a lone joiner, unassigned code
    // points) would be origins Opensteer saves and releases for.
    for label in labels where label.hasPrefix("xn--") {
      guard let decoded = decodedIDNLabel(label), idnaToASCII(decoded) == label else { return nil }
    }
    guard ascii != "localhost", !ascii.hasSuffix(".localhost") else { return nil }
    guard Origins.registrableDomain(ascii) != nil else { return nil }
    return ascii
  }

  /// Letters, digits, `-` and `_`; 1–63 bytes; no hyphen at either end.
  static func isValidLabel(_ label: String) -> Bool {
    let bytes = Array(label.utf8)
    guard (1...63).contains(bytes.count), bytes.first != UInt8(ascii: "-"), bytes.last != UInt8(ascii: "-") else {
      return false
    }
    return bytes.allSatisfy { byte in
      (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
        || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
        || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
    }
  }

  /// WHATWG parses a host whose last label is numeric as IPv4.
  static func endsInNumber(_ labels: [String]) -> Bool {
    guard let last = labels.last else { return false }
    if last.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }) { return true }
    if last.hasPrefix("0x") {
      return last.dropFirst(2).utf8.allSatisfy { Hex.value(of: $0, allowUpper: false) != nil }
    }
    return false
  }

  /// Foundation's IDNA conversion, accepted only when every converted label
  /// decodes back to exactly the label typed (NFC, ASCII letters lower-cased).
  /// Every other UTS46 mapping (non-ASCII case folding, full-width letters,
  /// ignored characters such as U+200B) is refused rather than applied, so
  /// the result cannot differ from what WHATWG produces.
  private static func idnaToASCII(_ raw: String) -> String? {
    let typed = ASCII.lowercased(raw.precomposedStringWithCanonicalMapping)
      .split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    let asciiAllowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-_".unicodeScalars)
    guard
      typed.allSatisfy({ !$0.isEmpty }),
      typed.allSatisfy({ label in label.unicodeScalars.allSatisfy { $0.value >= 0x80 || asciiAllowed.contains($0) } }),
      let converted = URLComponents(string: "https://\(raw)/")?.encodedHost,
      converted.utf8.allSatisfy({ $0 < 0x80 })
    else { return nil }
    let labels = ASCII.lowercased(converted).split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard labels.count == typed.count else { return nil }
    for (label, typedLabel) in zip(labels, typed) {
      if typedLabel.utf8.allSatisfy({ $0 < 0x80 }) {
        guard label == typedLabel else { return nil }
      } else {
        guard let decoded = decodedIDNLabel(label),
          decoded.unicodeScalars.elementsEqual(typedLabel.unicodeScalars)
        else { return nil }
      }
    }
    return labels.joined(separator: ".")
  }

  /// The Unicode form of an `xn--` label, if it is canonical punycode for a
  /// label that really needed it.
  static func decodedIDNLabel(_ label: String) -> String? {
    guard label.hasPrefix("xn--") else { return nil }
    let encoded = String(label.dropFirst(4))
    guard let decoded = Punycode.decode(encoded),
      !decoded.isEmpty,
      decoded.unicodeScalars.contains(where: { $0.value >= 0x80 }),
      Punycode.encode(decoded) == encoded
    else { return nil }
    return decoded
  }
}
