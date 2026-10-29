import Foundation

/// One labeled entry — an email address or a phone number — as the person
/// labeled it.
public struct LabeledText: Encodable, Sendable, Equatable {
  @Nullable public var label: String?
  public let value: String

  public init(label: String?, value: String) {
    self.label = label
    self.value = value
  }
}

/// One contact as the search reads it, apart from the Contacts framework, so
/// every rule of finding and writing contacts holds without a macOS grant.
public struct ContactRecord: Sendable, Equatable {
  public let id: String
  public let name: String?
  public let organization: String?
  public let emails: [LabeledText]
  public let phones: [LabeledText]
  public let birthday: DateComponents?

  public init(
    id: String, name: String?, organization: String?, emails: [LabeledText],
    phones: [LabeledText], birthday: DateComponents?
  ) {
    self.id = id
    self.name = name
    self.organization = organization
    self.emails = emails
    self.phones = phones
    self.birthday = birthday
  }
}

/// `search_contacts`'s arguments, which the Runner validated against the
/// catalog's schema; the bounds are checked again here all the same.
public struct ContactsSearchArguments: Codable, Sendable, Equatable {
  public let cursor: String?
  public let limit: Int?
  public let query: String?

  public init(cursor: String?, limit: Int?, query: String?) {
    self.cursor = cursor
    self.limit = limit
    self.query = query
  }
}

/// One contact in the catalog's output shape.
public struct ContactView: Encodable, Sendable, Equatable {
  @Nullable public var birthday: String?
  public let emails: [LabeledText]
  public let id: String
  @Nullable public var name: String?
  @Nullable public var organization: String?
  public let phones: [LabeledText]
}

public struct ContactsPage: Encodable, Sendable, Equatable {
  public let contacts: [ContactView]
  @Nullable public var nextCursor: String?
}

public enum ContactsSearch {
  public static let defaultLimit = 25
  public static let maxLimit = 100
  /// A name, a label or a value longer than this is cut: a contact is a few
  /// lines, and a page of a hundred must still fit the integrations frame.
  public static let maxTextLength = 256
  /// Emails and phone numbers kept per contact.
  public static let maxEntries = 20

  /// One page of the contacts matching `arguments`, in the order given, which
  /// is the Mac's own sort order.
  public static func page(
    _ records: [ContactRecord], arguments: ContactsSearchArguments
  ) throws -> ContactsPage {
    let page = try Paging.page(
      records.filter { matches($0, query: arguments.query) }.map(view),
      cursor: arguments.cursor, limit: arguments.limit, defaultLimit: defaultLimit,
      maxLimit: maxLimit, listing: [arguments.query])
    return ContactsPage(contacts: page.items, nextCursor: page.nextCursor)
  }

  // MARK: - Matching

  /// A name, an organization or an email address, whatever its case and
  /// accents; and a phone number by its digits, however either side is
  /// written, once the query is a phone number of at least three digits.
  static func matches(_ record: ContactRecord, query: String?) -> Bool {
    guard let query, !query.isEmpty else { return true }
    let texts = [record.name, record.organization] + record.emails.map(\.value)
    if DataText.matches(query, in: texts) { return true }
    guard isPhoneQuery(query) else { return false }
    let digits = onlyDigits(query)
    return record.phones.contains { onlyDigits($0.value).contains(digits) }
  }

  private static let phoneCharacters = CharacterSet(charactersIn: "0123456789+-(). ")

  private static func isPhoneQuery(_ query: String) -> Bool {
    query.unicodeScalars.allSatisfy(phoneCharacters.contains) && onlyDigits(query).count >= 3
  }

  private static func onlyDigits(_ text: String) -> String {
    String(text.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) })
  }

  // MARK: - Output

  private static func view(_ record: ContactRecord) -> ContactView {
    ContactView(
      birthday: birthday(record.birthday),
      emails: record.emails.prefix(maxEntries).map(bounded),
      id: record.id,
      name: record.name.map(bounded),
      organization: record.organization.map(bounded),
      phones: record.phones.prefix(maxEntries).map(bounded)
    )
  }

  private static func bounded(_ entry: LabeledText) -> LabeledText {
    LabeledText(label: entry.label.map(bounded), value: bounded(entry.value))
  }

  private static func bounded(_ text: String) -> String {
    String(text.prefix(maxTextLength))
  }

  /// `YYYY-MM-DD`, or `--MM-DD` when the year was never recorded.
  private static func birthday(_ components: DateComponents?) -> String? {
    guard let month = components?.month, let day = components?.day else { return nil }
    if let year = components?.year {
      return String(format: "%04d-%02d-%02d", year, month, day)
    }
    return String(format: "--%02d-%02d", month, day)
  }
}
