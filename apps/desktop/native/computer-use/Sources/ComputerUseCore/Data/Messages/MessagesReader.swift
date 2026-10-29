import Darwin
import Foundation
import OpensteerAppleData
import SQLite3

public struct ListConversationsArguments: Decodable, Sendable {
  public let cursor: String?
  public let limit: Int?
  public let query: String?
}

public struct ReadMessagesArguments: Decodable, Sendable {
  public let conversationId: String?
  public let cursor: String?
  public let limit: Int?
  public let query: String?
  public let since: String?
  public let until: String?
}

public struct ConversationView: Encodable, Sendable, Equatable {
  public let conversationId: String
  @Nullable public var displayName: String?
  public let isGroup: Bool
  @Nullable public var lastMessageAt: String?
  public let participants: [String]
  public let service: String
}

public struct MessageView: Encodable, Sendable, Equatable {
  public let conversationId: String
  public let hasAttachments: Bool
  public let id: String
  public let isFromMe: Bool
  public let sender: String
  public let sentAt: String
  public let service: String
  @Nullable public var text: String?
  public let truncated: Bool
  public let undecoded: Bool
}

public struct ConversationsPage: Encodable, Sendable, Equatable {
  public let conversations: [ConversationView]
  @Nullable public var nextCursor: String?
}

public struct MessagesPage: Encodable, Sendable, Equatable {
  public let messages: [MessageView]
  @Nullable public var nextCursor: String?
}

/// Messages' history, read from `chat.db` under the helper's Full Disk
/// Access, one read-only connection per call.
///
/// Pages are keyset pages — the last row's normalised date and row id — so a
/// message arriving mid-listing never makes a page repeat or skip a row, and
/// each page also stays within a byte budget, so it fits the integrations
/// frame whatever the messages hold.
struct MessagesReader {
  static let listLimit = (fallback: 25, maximum: 100)
  static let readLimit = (fallback: 50, maximum: 200)
  static let queryMaxLength = 200
  static let conversationIdMaxLength = 256
  static let maxTextBytes = 16 * 1_024
  static let maxBodyBytes = 256 * 1_024
  /// A text search cannot be pushed into SQL — a body only in
  /// `attributedBody` is invisible to `LIKE` — so it decodes at most this
  /// many rows per call, and hands back a cursor when it stops early.
  static let searchScanLimit = 5_000
  static let searchBatchRows = 500
  /// Dates are nanoseconds on modern macOS and whole seconds on old rows; no
  /// plausible count of either crosses 2^32, so magnitude tells them apart.
  private static let date =
    "(CASE WHEN m.date > 4294967296 THEN m.date ELSE m.date * 1000000000 END)"
  /// Reactions and conversation events are rows of `message` too, and
  /// neither is something a person wrote.
  private static let onlyMessages = "m.item_type = 0 AND m.associated_message_type = 0"

  let path: String
  let clock: DataClock
  var byteBudget = Paging.byteBudget

  // MARK: - Opening

  /// Without Full Disk Access macOS lets `stat` succeed on `chat.db` and fails
  /// the open with `EPERM`, which SQLite would report like a corrupt file; so
  /// the file is opened first, and only `EPERM` is the grant. `EACCES` is a
  /// POSIX mode no switch in System Settings fixes.
  static func openFailure(errno code: Int32) -> HelperError {
    switch code {
    case EPERM:
      return HelperError(.permissionRequired, DataPlane.permissionSentence(.fullDiskAccess))
    case ENOENT, ENOTDIR:
      return HelperError(.failed, "Messages is not set up.")
    default:
      return HelperError(.failed, "Messages could not be opened.")
    }
  }

  private func open() throws -> MessagesDatabase {
    try MessagesDatabase.open(path)
  }

  static let readFailure = HelperError(.failed, "Messages could not be read. Try again.")

  // MARK: - Conversations

  func listConversations(_ arguments: ListConversationsArguments) throws -> ConversationsPage {
    let limit = try Self.limit(arguments.limit, Self.listLimit)
    let query = try Self.query(arguments.query)
    let fingerprint = Paging.fingerprint(["list_conversations", query])
    let after = try arguments.cursor.map { try Self.key(in: $0, fingerprint: fingerprint) }
    let connection = try open()

    var conditions: [String] = []
    var values: [MessagesDatabase.Value] = []
    if let query {
      let pattern = Self.likePattern(query)
      conditions.append(
        "(LOWER(COALESCE(c.display_name, '')) LIKE ? ESCAPE '\\'"
          + " OR EXISTS (SELECT 1 FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id"
          + " WHERE chj.chat_id = c.ROWID AND LOWER(h.id) LIKE ? ESCAPE '\\'))")
      values += [.text(pattern), .text(pattern)]
    }
    var having = ""
    if let after {
      having = " HAVING (last_date < ? OR (last_date = ? AND c.ROWID < ?))"
      values += [.integer(after.date), .integer(after.date), .integer(after.rowId)]
    }
    values.append(.integer(Int64(limit + 1)))
    let rows = try connection.rows(
      "SELECT c.ROWID, c.guid, c.display_name, c.service_name, c.style,"
        + " COALESCE(MAX(\(Self.date)), -1) AS last_date FROM chat c"
        + " LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID"
        + " LEFT JOIN message m ON m.ROWID = cmj.message_id AND \(Self.onlyMessages)"
        + (conditions.isEmpty ? "" : " WHERE \(conditions.joined(separator: " AND "))")
        + " GROUP BY c.ROWID" + having + " ORDER BY last_date DESC, c.ROWID DESC LIMIT ?",
      values)
    let page = Array(rows.prefix(limit))
    let participants = try self.participants(page.map { $0.integer(0) }, in: connection)
    let entries = page.map { row -> (ConversationView, Key) in
      let chat = row.integer(0)
      let handles = participants[chat] ?? []
      let name = row.text(2)?.trimmingCharacters(in: .whitespacesAndNewlines)
      let lastDate = row.integer(5)
      return (
        ConversationView(
          conversationId: row.text(1) ?? "",
          displayName: DataText.present(name).map { Self.bounded($0).text },
          isGroup: row.integer(4) == 43 || handles.count > 1,
          lastMessageAt: lastDate > 0 ? clock.text(Self.instant(lastDate)) : nil,
          participants: handles,
          service: row.text(3) ?? "unknown"),
        Key(date: lastDate, rowId: chat)
      )
    }
    let (views, next) = fit(entries, more: rows.count > limit)
    return ConversationsPage(
      conversations: views, nextCursor: next.map { Self.cursor($0, fingerprint: fingerprint) })
  }

  private func participants(_ chats: [Int64], in connection: MessagesDatabase) throws -> [Int64: [String]] {
    guard !chats.isEmpty else { return [:] }
    let rows = try connection.rows(
      "SELECT chj.chat_id, h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id"
        + " WHERE chj.chat_id IN (\(chats.map { _ in "?" }.joined(separator: ","))) ORDER BY h.id",
      chats.map { .integer($0) })
    var byChat: [Int64: [String]] = [:]
    for row in rows {
      if let handle = DataText.present(row.text(1)) { byChat[row.integer(0), default: []].append(handle) }
    }
    return byChat
  }

  // MARK: - Messages

  /// `timeLeft` bounds a search, which decodes rows until it has a page, has
  /// read `searchScanLimit` rows, or runs out of time; a plain read is one
  /// indexed query and spends none of it.
  func readMessages(
    _ arguments: ReadMessagesArguments, timeLeft: () -> TimeInterval
  ) throws -> MessagesPage {
    let limit = try Self.limit(arguments.limit, Self.readLimit)
    let query = try Self.query(arguments.query)
    if let conversationId = arguments.conversationId,
      conversationId.isEmpty || conversationId.count > Self.conversationIdMaxLength
    {
      throw HelperError(.failed, "conversationId is not a conversation.")
    }
    let since = try arguments.since.map { try bound($0, field: "since", end: false) }
    let until = try arguments.until.map { try bound($0, field: "until", end: true) }
    if let since, let until, since > until {
      throw HelperError(.failed, "since must not be later than until.")
    }
    let fingerprint = Paging.fingerprint([
      "read_messages", arguments.conversationId, query, arguments.since, arguments.until,
    ])
    let after = try arguments.cursor.map { try Self.key(in: $0, fingerprint: fingerprint) }
    let filter = Filter(conversationId: arguments.conversationId, since: since, until: until)
    let connection = try open()

    guard let query else {
      let rows = try select(filter, after: after, take: limit + 1, in: connection)
      let (views, next) = fit(
        rows.prefix(limit).map { (message($0), Self.key(of: $0)) }, more: rows.count > limit)
      return MessagesPage(
        messages: views, nextCursor: next.map { Self.cursor($0, fingerprint: fingerprint) })
    }

    let needle = DataText.folded(query)
    var items: [MessageView] = []
    var bytes = 0
    var cursor = after
    var scanned = 0
    var exhausted = false
    var full = false
    var ranOut = false
    while !full && items.count < limit && scanned < Self.searchScanLimit && !exhausted {
      guard timeLeft() > 0 else {
        ranOut = true
        break
      }
      let take = min(Self.searchBatchRows, Self.searchScanLimit - scanned)
      let rows = try select(filter, after: cursor, take: take, in: connection)
      var consumed = 0
      for row in rows {
        let found = message(row)
        if let text = found.text, DataText.folded(text).contains(needle) {
          let size = Self.size(found)
          // A match that would not fit starts the next page instead.
          if !items.isEmpty && bytes + size > byteBudget {
            full = true
            break
          }
          items.append(found)
          bytes += size
        }
        consumed += 1
        scanned += 1
        cursor = Self.key(of: row)
        if items.count >= limit { break }
      }
      // A short batch is the end only when all of it was read.
      if !full && consumed == rows.count && rows.count < take { exhausted = true }
    }
    if ranOut && scanned == 0 {
      // Nothing was learned, and its cursor is the one it was given: an empty
      // page would read as the end of the history.
      throw HelperError(
        .failed, "Messages took too long to search. Narrow the dates or the conversation.")
    }
    return MessagesPage(
      messages: items,
      nextCursor: exhausted ? nil : cursor.map { Self.cursor($0, fingerprint: fingerprint) })
  }

  private struct Filter {
    let conversationId: String?
    let since: Int64?
    let until: Int64?
  }

  private func select(
    _ filter: Filter, after: Key?, take: Int, in connection: MessagesDatabase
  ) throws -> [MessagesDatabase.Row] {
    var values: [MessagesDatabase.Value] = []
    var chat =
      "(SELECT cmj.chat_id FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID"
      + " ORDER BY cmj.chat_id LIMIT 1)"
    if let conversationId = filter.conversationId {
      // Joining straight to the named chat is the filter and the answer: a
      // message in several chats reports the one asked about.
      chat =
        "(SELECT cmj.chat_id FROM chat_message_join cmj JOIN chat c2 ON c2.ROWID = cmj.chat_id"
        + " WHERE cmj.message_id = m.ROWID AND c2.guid = ? LIMIT 1)"
      values.append(.text(conversationId))
    }
    var conditions = [Self.onlyMessages]
    if let since = filter.since {
      conditions.append("\(Self.date) >= ?")
      values.append(.integer(since))
    }
    if let until = filter.until {
      conditions.append("\(Self.date) <= ?")
      values.append(.integer(until))
    }
    if let after {
      conditions.append("(\(Self.date) < ? OR (\(Self.date) = ? AND m.ROWID < ?))")
      values += [.integer(after.date), .integer(after.date), .integer(after.rowId)]
    }
    values.append(.integer(Int64(take)))
    return try connection.rows(
      "SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.is_from_me, m.service,"
        + " \(Self.date) AS sent_date, h.id, c.guid, c.chat_identifier,"
        + " EXISTS (SELECT 1 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID)"
        + " FROM message m JOIN chat c ON c.ROWID = \(chat)"
        + " LEFT JOIN handle h ON h.ROWID = m.handle_id"
        + " WHERE \(conditions.joined(separator: " AND "))"
        + " ORDER BY sent_date DESC, m.ROWID DESC LIMIT ?",
      values)
  }

  private func message(_ row: MessagesDatabase.Row) -> MessageView {
    var whole: String?
    var undecoded = false
    if let text = DataText.present(row.text(2)) {
      whole = text
    } else if let body = row.blob(3), !body.isEmpty {
      if body.count > Self.maxBodyBytes {
        undecoded = true
      } else if let decoded = TypedStream.text(body) {
        whole = decoded
      } else {
        undecoded = true
      }
    }
    let bounded = whole.map(Self.bounded)
    let isFromMe = row.integer(4) != 0
    return MessageView(
      conversationId: row.text(8) ?? "",
      hasAttachments: row.integer(10) != 0,
      id: row.text(1) ?? "",
      isFromMe: isFromMe,
      sender: isFromMe ? "me" : DataText.present(row.text(7)) ?? row.text(9) ?? "unknown",
      sentAt: clock.text(Self.instant(row.integer(6))),
      service: DataText.present(row.text(5)) ?? "unknown",
      text: bounded?.text,
      truncated: bounded?.cut ?? false,
      undecoded: undecoded)
  }

  // MARK: - Pages

  struct Key: Equatable {
    let date: Int64
    let rowId: Int64
  }

  private static func key(of row: MessagesDatabase.Row) -> Key {
    Key(date: row.integer(6), rowId: row.integer(0))
  }

  /// The entries that fit the byte budget, at least one, and the key to
  /// continue after the last of them when any are left.
  private func fit<View: Encodable>(_ entries: [(View, Key)], more: Bool) -> ([View], Key?) {
    var views: [View] = []
    var bytes = 0
    for (view, _) in entries {
      let size = Self.size(view)
      if !views.isEmpty && bytes + size > byteBudget { break }
      views.append(view)
      bytes += size
    }
    let cut = views.count < entries.count
    return (views, (cut || more) && !views.isEmpty ? entries[views.count - 1].1 : nil)
  }

  private static func size(_ view: some Encodable) -> Int {
    ((try? JSONCoding.encoder.encode(view))?.count ?? 0) + 1
  }

  /// `<listing fingerprint>.<date>.<row id>`.
  private static func cursor(_ key: Key, fingerprint: String) -> String {
    "\(fingerprint).\(key.date).\(key.rowId)"
  }

  private static func key(in cursor: String, fingerprint: String) throws -> Key {
    let parts = cursor.split(separator: ".", omittingEmptySubsequences: false)
    guard
      parts.count == 3, parts[0] == fingerprint,
      parts[1].allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-") }),
      parts[2].allSatisfy({ $0.isASCII && $0.isNumber }),
      let date = Int64(parts[1]), let rowId = Int64(parts[2])
    else {
      throw HelperError(.failed, "cursor is not one this listing issued; start again without it.")
    }
    return Key(date: date, rowId: rowId)
  }

  // MARK: - Arguments

  private static func limit(_ value: Int?, _ bounds: (fallback: Int, maximum: Int)) throws -> Int {
    let limit = value ?? bounds.fallback
    guard (1...bounds.maximum).contains(limit) else {
      throw HelperError(.failed, "limit must be between 1 and \(bounds.maximum).")
    }
    return limit
  }

  private static func query(_ value: String?) throws -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    guard value.count <= queryMaxLength else {
      throw HelperError(.failed, "query must be at most \(queryMaxLength) characters.")
    }
    return value
  }

  /// A time on the Mac's clock as Apple nanoseconds, the bound inclusive: a
  /// date given as an end includes that whole day.
  private func bound(_ text: String, field: String, end: Bool) throws -> Int64 {
    switch try clock.moment(text, field: field) {
    case .instant(let date):
      return Self.nanoseconds(date)
    case .day(let day) where end:
      let next = Self.nanoseconds(clock.startOfDay(clock.adding(days: 1, to: day)))
      return next == .min ? .min : next - 1
    case .day(let day):
      return Self.nanoseconds(clock.startOfDay(day))
    }
  }

  /// A nanosecond count since 2001 is past a `Double`'s exact range, so the
  /// conversion goes through microseconds. A date `chat.db` cannot count to
  /// — past about the year 2293 either way — is the farthest it can, so a
  /// bound there bounds nothing rather than stopping the helper.
  private static func nanoseconds(_ date: Date) -> Int64 {
    let microseconds = (date.timeIntervalSinceReferenceDate * 1_000_000).rounded()
    guard microseconds.magnitude < Double(Int64.max / 1_000) else {
      return microseconds < 0 ? .min : .max
    }
    return Int64(microseconds) * 1_000
  }

  private static func instant(_ nanoseconds: Int64) -> Date {
    Date(timeIntervalSinceReferenceDate: Double(nanoseconds) / 1e9)
  }

  /// Cut on a scalar boundary so a truncated body stays readable text.
  private static func bounded(_ text: String) -> (text: String, cut: Bool) {
    guard text.utf8.count > maxTextBytes else { return (text, false) }
    var end = text.utf8.index(text.utf8.startIndex, offsetBy: maxTextBytes)
    while end > text.startIndex && end.samePosition(in: text.unicodeScalars) == nil {
      end = text.utf8.index(before: end)
    }
    return (String(text[..<end]), true)
  }

  /// SQLite's `LOWER` folds ASCII only, the alphabet handles and chat names
  /// are matched in; message text is matched here, whatever its alphabet.
  private static func likePattern(_ value: String) -> String {
    let escaped =
      value.lowercased()
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "%", with: "\\%")
      .replacingOccurrences(of: "_", with: "\\_")
    return "%\(escaped)%"
  }
}
