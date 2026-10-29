import CryptoKit
import Foundation

/// A field the catalog always names, written `null` when there is nothing.
/// Swift's own encoding leaves a nil field out, and the Host holds every
/// answer to the catalog's schema, where a missing key is a different shape.
@propertyWrapper
public struct Nullable<Value: Encodable & Sendable & Equatable>: Encodable, Sendable, Equatable {
  public var wrappedValue: Value?

  public init(wrappedValue: Value?) {
    self.wrappedValue = wrappedValue
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(wrappedValue)
  }
}

/// One page of a listing, and the cursor to the next when there is one.
public struct Page<Item: Sendable>: Sendable {
  public let items: [Item]
  public let nextCursor: String?
}

/// How a listing an app answers is cut into pages: at most `limit` items and
/// at most `byteBudget` bytes of them, so a page fits the integrations frame
/// (`computerAppMaxFrameBytes`, 1 MiB, with room for the frame around it)
/// whatever the items hold.
///
/// A cursor is `<listing fingerprint>.<offset>`: opaque to agents, the same
/// for the same page, and valid only for the listing that issued it. The
/// fingerprint stands for the listing's arguments without carrying them.
public enum Paging {
  public static let byteBudget = 512 * 1_024

  public static func page<Item: Encodable & Sendable>(
    _ items: [Item], cursor: String?, limit: Int?, defaultLimit: Int, maxLimit: Int,
    listing: [String?], byteBudget: Int = byteBudget
  ) throws -> Page<Item> {
    let limit = limit ?? defaultLimit
    guard (1...maxLimit).contains(limit) else {
      throw HelperError(.failed, "limit must be between 1 and \(maxLimit).")
    }
    let fingerprint = fingerprint(listing)
    let offset = try cursor.map { try self.offset(in: $0, fingerprint: fingerprint) } ?? 0
    var taken: [Item] = []
    var bytes = 0
    for item in items.dropFirst(offset) {
      guard taken.count < limit else { break }
      let size = (try? JSONCoding.encoder.encode(item))?.count ?? 0
      // The first item goes out however large, or the listing could never
      // get past it; each item bounds its own fields.
      if !taken.isEmpty && bytes + size > byteBudget { break }
      taken.append(item)
      bytes += size + 1
    }
    let next = offset + taken.count
    return Page(
      items: taken,
      nextCursor: next < items.count ? "\(fingerprint).\(next)" : nil
    )
  }

  /// Stands for a listing's arguments in its cursors, without carrying them.
  public static func fingerprint(_ listing: [String?]) -> String {
    let encoded = (try? JSONCoding.encoder.encode(listing)) ?? Data()
    return SHA256.hash(data: encoded).prefix(12).map { String(format: "%02x", $0) }.joined()
  }

  private static func offset(in cursor: String, fingerprint: String) throws -> Int {
    let parts = cursor.split(separator: ".", omittingEmptySubsequences: false)
    guard
      parts.count == 2,
      parts[0].count == fingerprint.count,
      parts[0].allSatisfy(\.isHexDigit),
      parts[1].allSatisfy(\.isASCII),
      let offset = Int(parts[1]),
      offset >= 0
    else {
      throw HelperError(.failed, "That cursor was not issued by this listing.")
    }
    guard parts[0] == fingerprint else {
      throw HelperError(
        .failed, "That cursor belongs to a listing with other arguments; start again without it.")
    }
    return offset
  }
}

/// Text as the apps the helper serves match it: whatever its case and accents.
public enum DataText {
  public static func folded(_ text: String) -> String {
    text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
  }

  /// Whether any of `texts` holds `query`; no query matches everything.
  public static func matches(_ query: String?, in texts: [String?]) -> Bool {
    guard let query, !query.isEmpty else { return true }
    let needle = folded(query)
    return texts.contains { $0.map { folded($0).contains(needle) } ?? false }
  }

  /// Empty text is no text.
  public static func present(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    return text
  }

  /// The most notes one record carries, in bytes: a page must fit its frame
  /// whatever the characters are.
  public static let notesMaxBytes = 128 * 1_024

  /// Notes as a record carries them — at most `limit` characters and
  /// `notesMaxBytes` bytes, cut on a whole character — and whether they were cut.
  public static func notes(_ text: String?, limit: Int) -> (text: String?, truncated: Bool) {
    guard let text else { return (nil, false) }
    var bytes = 0
    var count = 0
    var end = text.startIndex
    for character in text {
      let size = character.utf8.count
      guard count < limit, bytes + size <= notesMaxBytes else {
        return (String(text[..<end]), true)
      }
      bytes += size
      count += 1
      end = text.index(after: end)
    }
    return (text, false)
  }
}
