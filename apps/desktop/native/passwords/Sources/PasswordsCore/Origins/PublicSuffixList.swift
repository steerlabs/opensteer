import Foundation

/// The Public Suffix List, ICANN and private sections, matched the way the
/// Host's tldts (`allowPrivateDomains: true`) matches it.
///
/// The list is pinned to the snapshot tldts 6.1.86 embeds, so the broker and
/// the Host agree on what "the same site" means.
struct PublicSuffixList: Sendable {
  private let rules: Set<String>
  private let wildcards: Set<String>
  private let exceptions: Set<String>

  /// The list compiled into the binary (SwiftPM `embedInCode`), so no
  /// signed executable depends on a resource bundle being found at run time.
  /// Nil when it is not valid UTF-8 or not a list, so every origin is refused.
  static let bundled: PublicSuffixList? = {
    guard let text = UTF8Text.decode(Data(PackageResources.public_suffix_list_dat)) else { return nil }
    return PublicSuffixList(text: text)
  }()

  var ruleCount: Int { rules.count + wildcards.count + exceptions.count }

  init?(text: String) {
    var rules = Set<String>()
    var wildcards = Set<String>()
    var exceptions = Set<String>()
    for line in text.split(whereSeparator: \.isNewline) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard !trimmed.isEmpty, !trimmed.hasPrefix("//") else { continue }
      let token = String(trimmed.prefix { !$0.isWhitespace })
      if token.hasPrefix("!") {
        guard let rule = Self.asciiRule(token.dropFirst()) else { return nil }
        exceptions.insert(rule)
      } else if token.hasPrefix("*.") {
        guard let rule = Self.asciiRule(token.dropFirst(2)) else { return nil }
        wildcards.insert(rule)
      } else {
        guard let rule = Self.asciiRule(Substring(token)) else { return nil }
        rules.insert(rule)
      }
    }
    guard !rules.isEmpty else { return nil }
    self.rules = rules
    self.wildcards = wildcards
    self.exceptions = exceptions
  }

  /// The registrable domain (public suffix plus one label) of an ASCII host,
  /// or nil for public suffixes, IP addresses and malformed hosts. One
  /// trailing dot is ignored, as tldts does.
  func registrableDomain(_ host: String) -> String? {
    var host = host
    if host.hasSuffix(".") { host.removeLast() }
    guard !host.isEmpty, host.utf8.count <= 253, host.utf8.allSatisfy({ $0 < 0x80 }) else { return nil }
    let labels = ASCII.lowercased(host).split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard labels.allSatisfy(Hosts.isValidLabel), !Hosts.endsInNumber(labels) else { return nil }
    let suffixLength = publicSuffixLength(labels)
    guard labels.count > suffixLength else { return nil }
    return labels.suffix(suffixLength + 1).joined(separator: ".")
  }

  /// The number of labels in the prevailing rule, per publicsuffix.org's
  /// algorithm: an exception wins, else the longest match, else `*`.
  private func publicSuffixLength(_ labels: [String]) -> Int {
    var longest = 1
    for start in labels.indices {
      let candidate = labels[start...].joined(separator: ".")
      let length = labels.count - start
      if exceptions.contains(candidate) { return length - 1 }
      if length > longest {
        if rules.contains(candidate) {
          longest = length
        } else if length >= 2, wildcards.contains(labels[(start + 1)...].joined(separator: ".")) {
          longest = length
        }
      }
    }
    return longest
  }

  private static func asciiRule(_ rule: Substring) -> String? {
    var labels: [String] = []
    for label in ASCII.lowercased(String(rule)).split(separator: ".", omittingEmptySubsequences: false) {
      if label.utf8.allSatisfy({ $0 < 0x80 }) {
        guard !label.isEmpty else { return nil }
        labels.append(String(label))
      } else {
        guard let encoded = Punycode.encode(String(label)) else { return nil }
        labels.append("xn--" + encoded)
      }
    }
    return labels.joined(separator: ".")
  }
}
