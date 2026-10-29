import Foundation
import PasswordsCore

/// How the broker shows values it did not write itself.
public enum Display {
  /// The first character, `•••`, then the email domain: `t•••@example.com`.
  /// For the activity history only, which records what happened rather than
  /// asking which account to use.
  public static func maskedAccount(_ username: String) -> String {
    let trimmed = clean(username, limit: 1_024)
    guard let first = trimmed.first else { return "No username" }
    if let at = trimmed.lastIndex(of: "@"), at != trimmed.startIndex {
      let domain = trimmed[trimmed.index(after: at)...]
      if !domain.isEmpty { return "\(first)•••@\(clean(String(domain), limit: 80))" }
    }
    return "\(first)•••"
  }

  /// A whole username, cleaned like any text Opensteer did not write and
  /// never shortened: two usernames may differ only at their ends. The vault
  /// caps them at 1,024 bytes, so the limit never cuts one.
  public static func account(_ username: String) -> String {
    let cleaned = clean(username, limit: VaultLimits.maxUsernameBytes)
    return cleaned.isEmpty ? "No username" : cleaned
  }

  /// A Workspace or Deployment name the Host sent, as a grant stores it and
  /// the prompt that allows it says it: cleaned, and never empty. The vault
  /// refuses a grant whose names have control characters or nothing in
  /// them; the wire's 120 UTF-16 units keep a name well within its 512 bytes.
  public static func name(_ text: String, unnamed: String, limit: Int = 120) -> String {
    let cleaned = clean(text, limit: limit)
    return cleaned.isEmpty ? unnamed : cleaned
  }

  /// Text from the agent or the Host (reasons, Thread titles, names) as one
  /// line: line breaks and control characters become spaces, and format
  /// characters (bidirectional overrides, invisible marks) are removed, so it
  /// cannot reorder or hide what is around it. Capped at `limit` characters.
  public static func clean(_ text: String, limit: Int) -> String {
    var scalars = String.UnicodeScalarView()
    var lastWasSpace = false
    for scalar in text.unicodeScalars {
      let properties = scalar.properties
      // The zero-width joiners hold emoji and some scripts together and move nothing.
      if properties.generalCategory == .format, scalar.value != 0x200C, scalar.value != 0x200D { continue }
      if properties.generalCategory == .control || properties.generalCategory == .lineSeparator
        || properties.generalCategory == .paragraphSeparator || properties.isWhitespace
      {
        if !lastWasSpace, !scalars.isEmpty {
          scalars.append(" ")
          lastWasSpace = true
        }
        continue
      }
      scalars.append(scalar)
      lastWasSpace = false
    }
    var cleaned = String(scalars).trimmingCharacters(in: .whitespaces)
    if cleaned.count > limit {
      cleaned = String(cleaned.prefix(max(0, limit - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }
    return cleaned
  }
}
