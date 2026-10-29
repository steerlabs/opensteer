import Foundation
import OpensteerAppleData

/// A place in `chat.db`: a message row and the guid it held when it was read,
/// so a history rebuilt under the same row ids is told apart.
public struct IMessagePosition: Codable, Sendable, Equatable {
  @Nullable public var guid: String?
  public let rowId: Int64

  public init(guid: String?, rowId: Int64) {
    self.guid = guid
    self.rowId = rowId
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guid = try container.decodeIfPresent(String.self, forKey: .guid)
    rowId = try container.decode(Int64.self, forKey: .rowId)
    guard rowId >= 0 else {
      throw DecodingError.dataCorruptedError(
        forKey: .rowId, in: container, debugDescription: "A row id is never negative.")
    }
  }

  private enum CodingKeys: String, CodingKey { case guid, rowId }
}

/// The Apple account this Mac's Messages uses for iMessage.
public struct IMessageAccount: Codable, Sendable, Equatable {
  @Nullable public var handle: String?
  public let id: String

  public init(handle: String?, id: String) {
    self.handle = handle
    self.id = id
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    handle = try container.decodeIfPresent(String.self, forKey: .handle)
    id = try container.decode(String.self, forKey: .id)
  }

  private enum CodingKeys: String, CodingKey { case handle, id }

  /// What `IMessageChannel.accountScript` prints: the id, then the handle.
  static func parse(_ output: String) -> IMessageAccount? {
    let lines = output.split(separator: "\n", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let id = lines.first, !id.isEmpty else { return nil }
    return IMessageAccount(handle: DataText.present(lines.count > 1 ? lines[1] : nil), id: id)
  }
}

/// One person's text to the bot, as the channel hands it on.
public struct IMessageInbound: Codable, Sendable, Equatable {
  public let handle: String
  public let sentAt: String
  public let text: String
}

/// A row read past; `message` is null for one that is not a person texting the
/// bot one to one over iMessage.
public struct IMessageRow: Encodable, Sendable, Equatable {
  public let guid: String
  @Nullable public var message: IMessageInbound?
  public let rowId: Int64
}

public enum IMessageAccountState: String, Codable, Sendable {
  case current, changed
  case signedOut = "signed-out"
}

public enum IMessageClaim: String, Codable, Sendable {
  case held, busy
}

public enum IMessageCursorState: String, Codable, Sendable {
  case valid, deleted, rebuilt
}

public struct IMessagePoll: Encodable, Sendable, Equatable {
  public let account: IMessageAccountState
  public let claim: IMessageClaim
  public let cursor: IMessageCursorState
  public let rows: [IMessageRow]
}

public struct IMessageAccountResult: Encodable, Sendable, Equatable {
  @Nullable public var account: IMessageAccount?
  @Nullable public var end: IMessagePosition?
}

public struct IMessageReceipt: Codable, Sendable, Equatable {
  public let key: String
  public let sentAt: String
}

/// A missing confirmation is an attempt whose effect cannot be established.
/// Existing receipt files decode as confirmed attempts without a migration.
private struct IMessageSendRecord: Codable {
  let key: String
  let sentAt: String?
}

/// The iMessage channel's transport on this Mac: new texts to the bot read
/// from `chat.db`, and replies sent through Messages from the bound account.
///
/// It keeps no position of its own: the Runner's adapter carries the cursor
/// and asks for what comes after it, and only a row this reads whole is ever
/// handed out, so nothing is read ahead of a row Messages is still writing.
/// Two things it does keep. A claim per Apple account, a lease renewed by
/// every poll, so a second Opensteer on this Mac — Stable and Beta pointed at
/// two Deployments — gets `busy` instead of answering the same texts. And the
/// deliveries it attempted, by id, before asking Messages to send. A lost
/// confirmation is never permission to send that delivery again.
public actor IMessageChannel {
  static let leaseSeconds: TimeInterval = 60
  /// How often a poll asks Messages which account it uses.
  static let accountCheckSeconds: TimeInterval = 30
  /// How long a row may wait for its text before it is taken to have none.
  static let textWaitSeconds: TimeInterval = 60
  static let maxTextBytes = 16 * 1_024

  static let accountScript = [
    "tell application \"Messages\"",
    "set theAccounts to (every account whose service type is iMessage and enabled is true)",
    "if theAccounts is {} then return \"\"",
    "set theAccount to item 1 of theAccounts",
    "return (id of theAccount) & linefeed & (description of theAccount)",
    "end tell",
  ]

  /// Sent from the bound account, so a Mac signed into another one never
  /// speaks for it.
  static let sendScript = [
    "on run argv",
    "set theAccountId to item 1 of argv",
    "set theAddress to item 2 of argv",
    "set theText to item 3 of argv",
    "tell application \"Messages\"",
    "set theAccount to account id theAccountId",
    "send theText to participant theAddress of theAccount",
    "end tell",
    "end run",
  ]

  private let path: String
  private let clock: DataClock
  private let accountSource: @Sendable () async throws -> IMessageAccount?
  private let outbox: MessagesOutbox
  private let recordsURL: URL
  private let now: @Sendable () -> Date
  private var claims: [String: (owner: String, expiresAt: Date)] = [:]
  private var checkedAccount: (account: IMessageAccount?, at: Date)?
  private var records: [String: IMessageSendRecord]?
  /// When each row still being written was first seen so; a wait is counted
  /// from then, never from when the text was sent, which a Mac asleep while it
  /// arrived may have missed by hours.
  private var unfinishedSince: [Int64: Date] = [:]
  /// Sends under way, by delivery: a second ask for one waits for the first.
  private var sending: [String: Task<IMessageReceipt, Error>] = [:]

  init(
    databasePath: String, clock: DataClock,
    account: @escaping @Sendable () async throws -> IMessageAccount?,
    outbox: MessagesOutbox, sendRecords: URL, now: @escaping @Sendable () -> Date = { Date() }
  ) {
    path = databasePath
    self.clock = clock
    accountSource = account
    self.outbox = outbox
    recordsURL = sendRecords
    self.now = now
  }

  public static func standard() -> IMessageChannel {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return IMessageChannel(
      databasePath: home.appendingPathComponent("Library/Messages/chat.db").path,
      clock: .mac,
      account: {
        // Every script the channel runs asks Messages which account it uses
        // first, so this one check keeps them all from ever becoming the
        // consent prompt in front of the person, whenever a poll comes.
        switch await MessagesAutomation.shared.stateForSending() {
        case .granted:
          return try await Self.messagesAccount()
        case .requestable, .denied:
          throw HelperError(.permissionRequired, DataPlane.permissionSentence(.automation))
        case .unknown:
          throw HelperError(.failed, "Messages could not be reached.")
        }
      },
      outbox: .shared,
      sendRecords: home.appendingPathComponent(
        "Library/Application Support/Opensteer/Computer Use/imessage-sends.json"))
  }

  /// Asks Messages which account it uses for iMessage, without sending anything.
  static func messagesAccount() async throws -> IMessageAccount? {
    let outcome = await MessagesSender.runOsascript(
      OsascriptRequest(script: accountScript, arguments: [], timeout: 15))
    guard outcome.started, outcome.signal == nil, let exitCode = outcome.exitCode else {
      throw HelperError(.failed, "Messages did not say which account it uses.")
    }
    guard exitCode == 0 else {
      if outcome.stderr.contains("(-1743)") {
        throw HelperError(.permissionRequired, DataPlane.permissionSentence(.automation))
      }
      throw HelperError(.failed, "Messages did not say which account it uses.")
    }
    return IMessageAccount.parse(outcome.stdout)
  }

  // MARK: - Setup

  /// The account and the newest row: a channel set up now starts after it.
  func account() async throws -> IMessageAccountResult {
    let account = try await accountSource()
    checkedAccount = (account, now())
    let database = try MessagesDatabase.open(path)
    let newest = try database.rows(
      "SELECT ROWID, guid FROM message ORDER BY ROWID DESC LIMIT 1", [])
    return IMessageAccountResult(
      account: account,
      end: newest.first.map { IMessagePosition(guid: $0.text(1), rowId: $0.integer(0)) })
  }

  // MARK: - Reading

  func poll(owner: String, accountId: String, after: IMessagePosition, limit: Int) async throws
    -> IMessagePoll
  {
    guard (1...500).contains(limit) else {
      throw HelperError(.failed, "limit must be between 1 and 500.")
    }
    let state = try await accountState(accountId)
    guard claim(accountId, for: owner) else {
      return IMessagePoll(account: state, claim: .busy, cursor: .valid, rows: [])
    }
    guard state == .current else {
      return IMessagePoll(account: state, claim: .held, cursor: .valid, rows: [])
    }
    let database = try MessagesDatabase.open(path)
    let cursor = try self.cursor(after, in: database)
    guard cursor != .rebuilt else {
      return IMessagePoll(account: state, claim: .held, cursor: cursor, rows: [])
    }
    let rows = try database.rows(
      "SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.is_from_me, m.item_type,"
        + " m.associated_message_type, m.service, m.date, m.date_retracted, h.id,"
        + " (SELECT c.style FROM chat_message_join cmj JOIN chat c ON c.ROWID = cmj.chat_id"
        + " WHERE cmj.message_id = m.ROWID LIMIT 1),"
        + " EXISTS (SELECT 1 FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID),"
        + " EXISTS (SELECT 1 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID),"
        + " m.account_guid"
        + " FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id"
        + " WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?",
      [.integer(after.rowId), .integer(Int64(limit))])
    // Rows the cursor already passed are no longer waited on.
    unfinishedSince = unfinishedSince.filter { $0.key > after.rowId }
    var read: [IMessageRow] = []
    for row in rows {
      guard let classified = classify(row, accountId: accountId) else { break }
      read.append(classified)
    }
    return IMessagePoll(account: state, claim: .held, cursor: cursor, rows: read)
  }

  /// A row as the channel takes it, or nil while Messages is still writing it:
  /// the prefix of whole rows stops there.
  private func classify(_ row: MessagesDatabase.Row, accountId: String) -> IMessageRow? {
    let guid = row.text(1) ?? ""
    let rowId = row.integer(0)
    let passed = IMessageRow(guid: guid, message: nil, rowId: rowId)
    // Messages links a row to its conversation after writing it. One it never
    // links was abandoned, not delayed, so the wait for it is bounded too.
    guard row.integer(12) != 0 else { return waited(rowId) ? passed : nil }
    if row.integer(4) != 0 || row.integer(5) != 0 || row.integer(6) != 0 || row.integer(9) != 0 {
      return passed
    }
    // v1 is one-to-one iMessage: SMS senders can be spoofed, and groups wait.
    guard row.text(7) == "iMessage", row.integer(11) == 45,
      let handle = DataText.present(row.text(10))
    else { return passed }
    // One `chat.db` holds every account this Mac's Messages was ever signed
    // into; only what the bot's account received is a text to the bot.
    guard row.text(14) == accountId else { return passed }
    let sent = Date(timeIntervalSinceReferenceDate: Double(row.integer(8)) / 1e9)
    var text = DataText.present(row.text(2))
    if text == nil, let body = row.blob(3), !body.isEmpty, body.count <= 256 * 1_024 {
      text = DataText.present(TypedStream.text(body))
    }
    guard let text else {
      if row.integer(13) != 0 { return passed }
      return waited(rowId) ? passed : nil
    }
    unfinishedSince[rowId] = nil
    return IMessageRow(
      guid: guid,
      message: IMessageInbound(handle: handle, sentAt: clock.text(sent), text: bounded(text)),
      rowId: rowId)
  }

  /// Whether a row Messages has not finished has waited long enough to be
  /// taken as it is, counted from when this first saw it unfinished.
  private func waited(_ rowId: Int64) -> Bool {
    let current = now()
    let first = unfinishedSince[rowId] ?? current
    unfinishedSince[rowId] = first
    guard current.timeIntervalSince(first) >= Self.textWaitSeconds else { return false }
    unfinishedSince[rowId] = nil
    return true
  }

  private func bounded(_ text: String) -> String {
    guard text.utf8.count > Self.maxTextBytes else { return text }
    var end = text.utf8.index(text.utf8.startIndex, offsetBy: Self.maxTextBytes)
    while end > text.startIndex && end.samePosition(in: text.unicodeScalars) == nil {
      end = text.utf8.index(before: end)
    }
    return String(text[..<end])
  }

  /// A cursor past the table's counter, or on a row holding another guid, is
  /// in a history rebuilt since it was read; one on a missing row was deleted.
  private func cursor(_ after: IMessagePosition, in database: MessagesDatabase) throws
    -> IMessageCursorState
  {
    let sequence =
      try database.rows("SELECT seq FROM sqlite_sequence WHERE name = 'message'", []).first?
      .integer(0) ?? 0
    if after.rowId > sequence { return .rebuilt }
    guard let guid = after.guid else { return .valid }
    let found = try database.rows(
      "SELECT guid FROM message WHERE ROWID = ?", [.integer(after.rowId)]
    ).first
    guard let found else { return .deleted }
    return found.text(0) == guid ? .valid : .rebuilt
  }

  // MARK: - Sending

  func send(
    owner: String, accountId: String, key: String, to handle: String, text: String,
    budget: WorkBudget
  ) async throws -> IMessageReceipt {
    guard claim(accountId, for: owner) else {
      throw HelperError(
        .busy, "Another Opensteer on this Mac is using this Apple account's iMessage.")
    }
    // Decided before any suspension, so two asks for one delivery at once —
    // a Runner restarted while its first ask still ran — send it once.
    if let running = sending[key] { return try await running.value }
    if let record = try recorded()[key] {
      guard let sentAt = record.sentAt else { throw Self.unconfirmedSend() }
      return IMessageReceipt(key: record.key, sentAt: sentAt)
    }
    let task = Task {
      try await self.sendOnce(
        accountId: accountId, key: key, to: handle, text: text, budget: budget)
    }
    sending[key] = task
    defer { sending[key] = nil }
    return try await task.value
  }

  private func sendOnce(
    accountId: String, key: String, to handle: String, text: String, budget: WorkBudget
  ) async throws -> IMessageReceipt {
    // Checked fresh: a reply never goes out from an account the channel was
    // not set up with.
    let account = try await accountSource()
    checkedAccount = (account, now())
    guard let account else {
      throw HelperError(.failed, "Messages on this Mac is not signed in to iMessage.")
    }
    guard account.id == accountId else {
      throw HelperError(
        .failed,
        "Messages on this Mac is signed in to a different Apple account than this channel's.")
    }
    let request = try MessagesSender.request(
      MessagesSender.Arguments(
        text: text, to: .init(address: handle, conversationId: nil)))
    try budget.startWrite()
    // Persist before crossing the side-effect boundary. After a crash even a
    // queued attempt is uncertain; only a definite non-send removes it.
    try record(key, sentAt: nil)
    do {
      let outcome = try await outbox.run(
        OsascriptRequest(
          script: Self.sendScript, arguments: [accountId] + request.arguments,
          timeout: request.timeout),
        budget: budget)
      try MessagesSender.check(outcome)
    } catch {
      if (error as? HelperError)?.code == .outcomeUnknown {
        throw Self.unconfirmedSend()
      }
      var all = try recorded()
      all[key] = nil
      try save(all)
      throw error
    }
    let receipt = IMessageReceipt(key: key, sentAt: clock.text(now()))
    do {
      try record(key, sentAt: receipt.sentAt)
    } catch {
      throw Self.unconfirmedSend()
    }
    return receipt
  }

  // MARK: - Claims and the account

  /// Takes or renews `owner`'s lease on the account; false while another
  /// owner's lease is live.
  private func claim(_ accountId: String, for owner: String) -> Bool {
    let current = now()
    if let held = claims[accountId], held.owner != owner, held.expiresAt > current { return false }
    claims[accountId] = (owner, current.addingTimeInterval(Self.leaseSeconds))
    return true
  }

  private func accountState(_ accountId: String) async throws -> IMessageAccountState {
    if checkedAccount == nil
      || now().timeIntervalSince(checkedAccount!.at) >= Self.accountCheckSeconds
    {
      checkedAccount = (try await accountSource(), now())
    }
    guard let account = checkedAccount?.account else { return .signedOut }
    return account.id == accountId ? .current : .changed
  }

  // MARK: - The send record

  private static func unconfirmedSend() -> HelperError {
    HelperError(
      .deliveryUnconfirmed,
      "This reply may already have been sent. Check Messages on this Mac; Opensteer will not send it again."
    )
  }

  private func recorded() throws -> [String: IMessageSendRecord] {
    if let records { return records }
    do {
      let loaded = try JSONCoding.decoder.decode(
        [String: IMessageSendRecord].self, from: Data(contentsOf: recordsURL))
      guard loaded.allSatisfy({ $0.key == $0.value.key }) else {
        throw HelperError(.failed, "The iMessage send history is unreadable. No reply was sent.")
      }
      records = loaded
      return loaded
    } catch let error as NSError
      where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError
    {
      records = [:]
      return [:]
    }
  }

  private func record(_ key: String, sentAt: String?) throws {
    var all = try recorded()
    all[key] = IMessageSendRecord(key: key, sentAt: sentAt)
    try save(all)
  }

  private func save(_ all: [String: IMessageSendRecord]) throws {
    // Pending Host deliveries can outlive any offline period, so their
    // duplicate protection must not expire on a local timer.
    try FileManager.default.createDirectory(
      at: recordsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONCoding.encoder.encode(all).write(to: recordsURL, options: .atomic)
    records = all
  }
}
