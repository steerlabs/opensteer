import XCTest

@testable import ComputerUseCore

/// Every way the iMessage channel's transport can go wrong on the Mac, written
/// before it: a row read before Messages finished writing it, a row that is
/// not a person texting the bot, a history rebuilt under the cursor, an Apple
/// account changed under the channel, two Opensteers on one Mac, and a send
/// repeated after its answer was lost.
final class IMessageChannelTests: XCTestCase {
  private let clock = DataClock(timeZone: TimeZone(identifier: "UTC")!)
  private let bot = IMessageAccount(
    handle: "bot@example.com", id: "A1B2C3D4-0000-4000-8000-000000000001")

  private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
      get { lock.withLock { stored } }
      set { lock.withLock { stored = newValue } }
    }
  }

  private struct Harness {
    let channel: IMessageChannel
    let database: URL
    let account: Box<IMessageAccount?>
    let sent: Box<[OsascriptRequest]>
    let now: Box<Date>
    let records: URL
  }

  private func harness(
    database: URL? = nil, records: URL? = nil,
    outcome: OsascriptOutcome = OsascriptOutcome(exitCode: 0)
  ) throws -> Harness {
    let database = try database ?? MessagesFixture.create()
    let records =
      records
      ?? database.deletingLastPathComponent().appendingPathComponent("imessage-sends.json")
    let account = Box<IMessageAccount?>(bot)
    let sent = Box<[OsascriptRequest]>([])
    // A day after the messages below were sent, unless a test says otherwise.
    let now = Box(ISO8601DateFormatter().date(from: "2026-09-23T00:00:00Z")!)
    let channel = IMessageChannel(
      databasePath: database.path, clock: clock,
      account: { account.value },
      outbox: MessagesOutbox(run: { request in
        sent.value.append(request)
        return outcome
      }),
      sendRecords: records, now: { now.value })
    return Harness(
      channel: channel, database: database, account: account, sent: sent, now: now,
      records: records)
  }

  private func poll(
    _ harness: Harness, owner: String = "cha_one", after: IMessagePosition? = nil,
    limit: Int = 50
  ) async throws -> IMessagePoll {
    let start: IMessagePosition
    if let after {
      start = after
    } else {
      start = try await harness.channel.account().end ?? IMessagePosition(guid: nil, rowId: 0)
    }
    return try await harness.channel.poll(
      owner: owner, accountId: bot.id, after: start, limit: limit)
  }

  /// A message someone texted the bot, as Messages writes it.
  @discardableResult
  private func text(
    _ database: URL, guid: String, from handle: String = "+15551230000",
    text: String? = "hello", body: [UInt8]? = nil, service: String = "iMessage",
    fromMe: Bool = false, associated: Int64 = 0, itemType: Int64 = 0, retracted: Int64 = 0,
    group: Bool = false, chat: Bool = true, date: Int64? = nil, account: String? = nil
  ) throws -> Int64 {
    try MessagesFixture.write(
      database, "INSERT OR IGNORE INTO handle (id, service) VALUES (?, 'iMessage')", [.text(handle)]
    )
    let chatGuid = group ? "iMessage;+;chat999" : "iMessage;-;\(handle)"
    try MessagesFixture.write(
      database,
      "INSERT OR IGNORE INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, ?)",
      [.text(chatGuid), .integer(group ? 43 : 45), .text(handle), .text(service)])
    try MessagesFixture.write(
      database,
      "INSERT INTO message (guid, text, handle_id, service, date, is_from_me, attributedBody,"
        + " item_type, associated_message_type, date_retracted, account_guid) VALUES (?, ?,"
        + " (SELECT ROWID FROM handle WHERE id = ? LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        .text(guid), text.map { .text($0) } ?? .null, .text(handle), .text(service),
        .integer(date ?? MessagesFixture.appleNanoseconds("2026-09-22T10:00:00Z")),
        .integer(fromMe ? 1 : 0), body.map { .blob($0) } ?? .null, .integer(itemType),
        .integer(associated), .integer(retracted), .text(account ?? bot.id),
      ])
    let row = try rowId(database, guid)
    if chat {
      try MessagesFixture.write(
        database,
        "INSERT INTO chat_message_join (chat_id, message_id) VALUES"
          + " ((SELECT ROWID FROM chat WHERE guid = ?), ?)", [.text(chatGuid), .integer(row)])
    }
    return row
  }

  private func rowId(_ database: URL, _ guid: String) throws -> Int64 {
    try MessagesFixture.integer(database, "SELECT ROWID FROM message WHERE guid = ?", [.text(guid)])
  }

  // MARK: - Reading new messages

  func testASetupStartsAfterTheWholeExistingHistory() async throws {
    let harness = try harness()
    let account = try await harness.channel.account()
    XCTAssertEqual(account.account, bot)
    let end = try XCTUnwrap(account.end)
    XCTAssertEqual(end.guid, "msg-latest")
    let first = try await poll(harness)
    XCTAssertEqual(first.rows.count, 0)
    XCTAssertEqual(first.claim, .held)
    XCTAssertEqual(first.cursor, .valid)
    XCTAssertEqual(first.account, .current)
  }

  func testAPersonTextingTheBotIsReadWithTheirHandleTextAndWhenTheySentIt() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "in-1", text: "What's on today?")
    try text(
      harness.database, guid: "in-2", text: nil, body: MessagesFixture.attributedBody("Edited body")
    )
    let polled = try await poll(harness, after: start)
    XCTAssertEqual(polled.rows.map(\.guid), ["in-1", "in-2"])
    XCTAssertEqual(
      polled.rows[0].message,
      IMessageInbound(
        handle: "+15551230000", sentAt: "2026-09-22T10:00:00Z", text: "What's on today?"))
    XCTAssertEqual(polled.rows[1].message?.text, "Edited body")
    XCTAssertLessThan(polled.rows[0].rowId, polled.rows[1].rowId)
  }

  /// Rows that are not a person texting the bot one to one over iMessage are
  /// passed over, so the cursor moves past them without anything being run.
  func testWhatIsNotAPersonTextingTheBotIsPassedOver() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "mine", fromMe: true)
    try text(harness.database, guid: "tapback", associated: 2000)
    try text(harness.database, guid: "event", text: nil, itemType: 2)
    try text(harness.database, guid: "unsent", retracted: 1)
    try text(harness.database, guid: "sms", from: "+15559990000", service: "SMS")
    try text(harness.database, guid: "group", from: "+15558880000", group: true)
    let picture = try text(harness.database, guid: "picture", text: nil)
    try MessagesFixture.write(
      harness.database, "INSERT INTO attachment (guid, filename) VALUES ('att-picture', 'a.heic')")
    try MessagesFixture.write(
      harness.database,
      "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES"
        + " (?, (SELECT ROWID FROM attachment WHERE guid = 'att-picture'))",
      [.integer(picture)])
    let polled = try await poll(harness, after: start)
    XCTAssertEqual(
      polled.rows.map(\.guid), ["mine", "tapback", "event", "unsent", "sms", "group", "picture"])
    XCTAssertTrue(polled.rows.allSatisfy { $0.message == nil })
  }

  /// Messages may write a row before its chat link or its text: the classified
  /// prefix stops there, so a later row is never read ahead of it.
  func testARowMessagesHasNotFinishedWritingHoldsBackEverythingAfterIt() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "ready-1")
    let unlinked = try text(harness.database, guid: "unlinked", chat: false)
    try text(harness.database, guid: "ready-2")
    let first = try await poll(harness, after: start)
    XCTAssertEqual(first.rows.map(\.guid), ["ready-1"])

    try MessagesFixture.write(
      harness.database,
      "INSERT INTO chat_message_join (chat_id, message_id) VALUES"
        + " ((SELECT ROWID FROM chat WHERE guid = 'iMessage;-;+15551230000'), ?)",
      [.integer(unlinked)])
    let last = try XCTUnwrap(first.rows.last)
    let second = try await poll(
      harness, after: IMessagePosition(guid: last.guid, rowId: last.rowId))
    XCTAssertEqual(second.rows.map(\.guid), ["unlinked", "ready-2"])
  }

  /// A just-written row with no text yet waits for it; one that stays empty
  /// for a minute is something else, and is passed over rather than holding
  /// the conversation back for good.
  func testATextlessRowWaitsBrieflyForItsText() async throws {
    let harness = try harness()
    harness.now.value = ISO8601DateFormatter().date(from: "2026-09-22T10:00:20Z")!
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "filling", text: nil)
    try text(harness.database, guid: "after")
    let waiting = try await poll(harness, after: start)
    XCTAssertEqual(waiting.rows.map(\.guid), [])
    harness.now.value = ISO8601DateFormatter().date(from: "2026-09-22T10:02:00Z")!
    let later = try await poll(harness, after: start)
    XCTAssertEqual(later.rows.map(\.guid), ["filling", "after"])
    XCTAssertNil(later.rows[0].message)
  }

  func testAPollReadsAtMostItsLimitInOrder() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    for index in 0..<5 { try text(harness.database, guid: "n-\(index)") }
    let limited = try await poll(harness, after: start, limit: 3)
    XCTAssertEqual(limited.rows.map(\.guid), ["n-0", "n-1", "n-2"])
  }

  // MARK: - The cursor

  func testADeletedCursorRowIsJustADeletion() async throws {
    let harness = try harness()
    let row = try text(harness.database, guid: "gone")
    try text(harness.database, guid: "next")
    try MessagesFixture.write(harness.database, "DELETE FROM message WHERE guid = 'gone'")
    let polled = try await poll(harness, after: IMessagePosition(guid: "gone", rowId: row))
    XCTAssertEqual(polled.cursor, .deleted)
    XCTAssertEqual(polled.rows.map(\.guid), ["next"])
  }

  /// A history rebuilt under the channel — a restored backup, iCloud
  /// downloading it again — can put other messages at the cursor's row id,
  /// or none that high: the channel stops rather than guessing.
  func testARebuiltHistoryIsNeverReadAsIfItWereTheSameOne() async throws {
    let harness = try harness()
    let row = try text(harness.database, guid: "original")
    let replaced = try await poll(
      harness, after: IMessagePosition(guid: "someone-else", rowId: row))
    XCTAssertEqual(replaced.cursor, .rebuilt)
    XCTAssertEqual(replaced.rows, [])
    let beyond = try await poll(harness, after: IMessagePosition(guid: "future", rowId: 1_000_000))
    XCTAssertEqual(beyond.cursor, .rebuilt)
    XCTAssertEqual(beyond.rows, [])
  }

  // MARK: - The account and the claim

  func testAnAccountChangedOrSignedOutUnderTheChannelIsReportedAndNothingIsRead() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "for-someone-else")
    harness.account.value = IMessageAccount(handle: "other@example.com", id: "OTHER")
    harness.now.value = harness.now.value.addingTimeInterval(120)
    let changed = try await poll(harness, after: start)
    XCTAssertEqual(changed.account, .changed)
    XCTAssertEqual(changed.rows, [])
    harness.account.value = nil
    harness.now.value = harness.now.value.addingTimeInterval(120)
    let signedOut = try await poll(harness, after: start)
    XCTAssertEqual(signedOut.account, .signedOut)
    XCTAssertEqual(signedOut.rows, [])
  }

  /// Stable and Beta on one Mac, pointed at two Deployments: the first to
  /// claim the Apple account keeps it while it keeps polling.
  func testOneOpensteerHoldsAnAppleAccountUntilItsLeaseLapses() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    let stable = try await poll(harness, owner: "cha_stable", after: start)
    XCTAssertEqual(stable.claim, .held)
    let refused = try await poll(harness, owner: "cha_beta", after: start)
    XCTAssertEqual(refused.claim, .busy)
    XCTAssertEqual(refused.rows, [])
    harness.now.value = harness.now.value.addingTimeInterval(59)
    let renewed = try await poll(harness, owner: "cha_stable", after: start)
    XCTAssertEqual(renewed.claim, .held)
    harness.now.value = harness.now.value.addingTimeInterval(61)
    let takenOver = try await poll(harness, owner: "cha_beta", after: start)
    XCTAssertEqual(takenOver.claim, .held)
  }

  // MARK: - Sending

  /// Messages keeps every account's history in one `chat.db`. A text another
  /// Apple account received — the Mac signed into a personal account for a
  /// while, then back — is never handed on as a text to the bot.
  func testARowAnotherAccountReceivedIsNeverHandedOn() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "personal", account: "F00DF00D-0000-4000-8000-000000000002")
    try text(harness.database, guid: "to-the-bot")
    let polled = try await poll(harness, after: start)
    XCTAssertEqual(polled.rows.map(\.guid), ["personal", "to-the-bot"])
    XCTAssertNil(polled.rows[0].message)
    XCTAssertEqual(polled.rows[1].message?.text, "hello")
  }

  /// A Mac that slept through a text reads it long after it was sent, and
  /// Messages may still be filling it in: the wait runs from when this first
  /// saw it unfinished, not from when it was sent.
  func testATextReadLongAfterItWasSentStillWaitsForItsBody() async throws {
    let harness = try harness()
    harness.now.value = ISO8601DateFormatter().date(from: "2026-09-24T10:00:00Z")!
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "synced", text: nil)
    let first = try await poll(harness, after: start)
    XCTAssertEqual(first.rows.map(\.guid), [])
    harness.now.value = ISO8601DateFormatter().date(from: "2026-09-24T10:00:30Z")!
    try MessagesFixture.write(
      harness.database, "UPDATE message SET text = 'woke up' WHERE guid = 'synced'")
    let second = try await poll(harness, after: start)
    XCTAssertEqual(second.rows.first?.message?.text, "woke up")
  }

  /// A row Messages never joined to a chat is abandoned, not late: after the
  /// same bounded wait it is passed over, so it cannot hold the channel back.
  func testARowNeverJoinedToAChatIsPassedOverAfterAWait() async throws {
    let harness = try harness()
    let start = try await harness.channel.account().end
    try text(harness.database, guid: "orphan", chat: false)
    try text(harness.database, guid: "after")
    let first = try await poll(harness, after: start)
    XCTAssertEqual(first.rows.map(\.guid), [])
    harness.now.value = harness.now.value.addingTimeInterval(61)
    let later = try await poll(harness, after: start)
    XCTAssertEqual(later.rows.map(\.guid), ["orphan", "after"])
    XCTAssertNil(later.rows[0].message)
    XCTAssertEqual(later.rows[1].message?.text, "hello")
  }

  private func send(
    _ harness: Harness, key: String = "cdl_one", owner: String = "cha_one",
    to: String = "+15551230000",
    text: String = "On it."
  ) async throws -> IMessageReceipt {
    try await harness.channel.send(
      owner: owner, accountId: bot.id, key: key, to: to, text: text, budget: .unlimited)
  }

  private func sendRefusal(_ harness: Harness, key: String = "cdl_one", owner: String = "cha_one")
    async -> HelperError?
  {
    do {
      _ = try await send(harness, key: key, owner: owner)
      return nil
    } catch {
      return error as? HelperError
    }
  }

  func testASendGoesFromTheBoundAccountWithTheValuesAsArguments() async throws {
    let harness = try harness()
    _ = try await poll(harness)
    let receipt = try await send(harness, text: "\"quoted\" do shell script")
    XCTAssertEqual(receipt.key, "cdl_one")
    let request = try XCTUnwrap(harness.sent.value.first)
    XCTAssertEqual(request.script, IMessageChannel.sendScript)
    XCTAssertEqual(request.arguments, [bot.id, "+15551230000", "\"quoted\" do shell script"])
  }

  /// The delivery id is the key: the same delivery asked again — its answer
  /// lost, its lease expired — is answered from the record, never sent twice,
  /// even by a helper that restarted in between.
  /// Two asks to send one delivery at once — a Runner that restarted while
  /// the first was still running — send it once, and both hear the receipt.
  func testTwoSendsOfOneDeliveryAtOnceSendItOnce() async throws {
    let database = try MessagesFixture.create()
    let sent = Box<[OsascriptRequest]>([])
    let channel = IMessageChannel(
      databasePath: database.path, clock: clock, account: { self.bot },
      outbox: MessagesOutbox(run: { request in
        sent.value.append(request)
        try? await Task.sleep(nanoseconds: 50_000_000)
        return OsascriptOutcome(exitCode: 0)
      }),
      sendRecords: database.deletingLastPathComponent().appendingPathComponent("records.json"))
    async let first = channel.send(
      owner: "cha_one", accountId: bot.id, key: "cdl_one", to: "+15551230000", text: "hi",
      budget: .unlimited)
    async let second = channel.send(
      owner: "cha_one", accountId: bot.id, key: "cdl_one", to: "+15551230000", text: "hi",
      budget: .unlimited)
    let receipts = try await [first, second]
    XCTAssertEqual(sent.value.count, 1)
    XCTAssertEqual(receipts[0], receipts[1])
  }

  func testTheSameDeliveryIsNeverSentTwiceEvenAcrossARestart() async throws {
    let harness = try harness()
    _ = try await poll(harness)
    let first = try await send(harness)
    let again = try await send(harness)
    XCTAssertEqual(first, again)
    XCTAssertEqual(harness.sent.value.count, 1)

    let restarted = try self.harness(database: harness.database, records: harness.records)
    _ = try await poll(restarted)
    let answered = try await send(restarted)
    XCTAssertEqual(answered, first)
    XCTAssertEqual(restarted.sent.value.count, 0)
    _ = try await send(restarted, key: "cdl_two")
    XCTAssertEqual(restarted.sent.value.count, 1)
  }

  func testASendThatDidNotHappenIsNotRecordedSoItCanBeSentAgain() async throws {
    let harness = try harness(
      outcome: OsascriptOutcome(exitCode: nil, spawnFailed: true, started: false))
    _ = try await poll(harness)
    let error = await sendRefusal(harness)
    XCTAssertEqual(error?.code, .failed)
    let records =
      (try? Data(contentsOf: harness.records)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    XCTAssertFalse(records.contains("cdl_one"))
  }

  // Failure cases written before the send-state fix: an uncertain outcome is
  // retried in-process or after restart; the helper crashes after starting;
  // unreadable evidence is treated as empty; persistence fails before or after
  // the effect; old receipts expire while the Host still has a pending reply.
  func testAnUnconfirmedAttemptIsNeverRepeatedEvenAfterRestart() async throws {
    let harness = try harness(outcome: OsascriptOutcome(exitCode: nil, signal: 9, stopped: true))
    let first = await sendRefusal(harness)
    let again = await sendRefusal(harness)
    XCTAssertEqual(first?.code, .deliveryUnconfirmed)
    XCTAssertEqual(again?.code, .deliveryUnconfirmed)
    XCTAssertEqual(harness.sent.value.count, 1)
    let restarted = try self.harness(database: harness.database, records: harness.records)
    let afterRestart = await sendRefusal(restarted)
    XCTAssertEqual(afterRestart?.code, .deliveryUnconfirmed)
    XCTAssertTrue(restarted.sent.value.isEmpty)
    _ = try await send(restarted, key: "cdl_other")
    XCTAssertEqual(restarted.sent.value.count, 1)
  }

  func testTheAttemptIsOnDiskBeforeMessagesCanSend() async throws {
    let database = try MessagesFixture.create()
    let records = database.deletingLastPathComponent().appendingPathComponent("records.json")
    let recordedBeforeSend = Box(false)
    let channel = IMessageChannel(
      databasePath: database.path, clock: clock, account: { self.bot },
      outbox: MessagesOutbox(run: { _ in
        recordedBeforeSend.value =
          (try? String(contentsOf: records, encoding: .utf8))?.contains("cdl_one") == true
        return OsascriptOutcome(exitCode: 0)
      }), sendRecords: records)
    _ = try await channel.send(
      owner: "cha_one", accountId: bot.id, key: "cdl_one", to: "+15551230000", text: "hi",
      budget: .unlimited)
    XCTAssertTrue(recordedBeforeSend.value)
  }

  func testCorruptOrUnwritableRecordsPreventSending() async throws {
    for corrupt in [true, false] {
      let harness = try harness()
      if corrupt {
        try Data("broken json".utf8).write(to: harness.records)
      } else {
        try FileManager.default.createDirectory(
          at: harness.records, withIntermediateDirectories: true)
      }
      do {
        _ = try await send(harness)
        XCTFail("Sending requires readable, writable evidence")
      } catch {}
      XCTAssertTrue(harness.sent.value.isEmpty)
    }
  }

  func testAReceiptSurvivesLongOfflinePeriodsAndTheOldFileFormat() async throws {
    let harness = try harness()
    let receipt = IMessageReceipt(key: "cdl_one", sentAt: "2025-01-01T00:00:00Z")
    try JSONCoding.encoder.encode(["cdl_one": receipt]).write(to: harness.records)
    _ = try await send(harness, key: "cdl_other")
    let restarted = try self.harness(database: harness.database, records: harness.records)
    let kept = try await send(restarted)
    XCTAssertEqual(kept, receipt)
    XCTAssertTrue(restarted.sent.value.isEmpty)
  }

  func testAFailedConfirmationWriteNeverMakesTheAttemptRetryable() async throws {
    let database = try MessagesFixture.create()
    let records = database.deletingLastPathComponent().appendingPathComponent("records.json")
    let sent = Box(0)
    let channel = IMessageChannel(
      databasePath: database.path, clock: clock, account: { self.bot },
      outbox: MessagesOutbox(run: { _ in
        sent.value += 1
        try? FileManager.default.removeItem(at: records)
        try? FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        return OsascriptOutcome(exitCode: 0)
      }), sendRecords: records)
    for _ in 0..<2 {
      do {
        _ = try await channel.send(
          owner: "cha_one", accountId: bot.id, key: "cdl_one", to: "+15551230000", text: "hi",
          budget: .unlimited)
        XCTFail("The confirmation could not be stored")
      } catch {
        XCTAssertEqual((error as? HelperError)?.code, .deliveryUnconfirmed)
      }
    }
    XCTAssertEqual(sent.value, 1)
  }

  func testADefiniteRefusalCanBeRetriedAfterRestart() async throws {
    for outcome in [
      OsascriptOutcome(exitCode: nil, spawnFailed: true, started: false),
      OsascriptOutcome(exitCode: 1, stderr: "Not authorized (-1743)"),
      OsascriptOutcome(exitCode: 1, stderr: "Not found (-1728)"),
    ] {
      let harness = try harness(outcome: outcome)
      let refused = await sendRefusal(harness)
      XCTAssertNotNil(refused)
      let restarted = try self.harness(database: harness.database, records: harness.records)
      _ = try await send(restarted)
      XCTAssertEqual(restarted.sent.value.count, 1)
    }
  }

  func testOnlyTheOpensteerHoldingTheAccountSendsAndOnlyFromThatAccount() async throws {
    let harness = try harness()
    _ = try await poll(harness, owner: "cha_stable")
    let busy = await sendRefusal(harness, owner: "cha_beta")
    XCTAssertEqual(busy?.code, .busy)
    harness.account.value = IMessageAccount(handle: "other@example.com", id: "OTHER")
    let changed = await sendRefusal(harness, owner: "cha_stable")
    XCTAssertEqual(changed?.code, .failed)
    XCTAssertTrue(
      changed?.message.contains("different Apple account") ?? false, changed?.message ?? "")
    XCTAssertTrue(harness.sent.value.isEmpty)
  }

  func testTheAccountLineMessagesPrintsIsReadBack() {
    XCTAssertEqual(
      IMessageAccount.parse("A1B2\nbot@example.com\n"),
      IMessageAccount(handle: "bot@example.com", id: "A1B2"))
    XCTAssertEqual(IMessageAccount.parse("A1B2\n\n"), IMessageAccount(handle: nil, id: "A1B2"))
    XCTAssertNil(IMessageAccount.parse(""))
    XCTAssertNil(IMessageAccount.parse("\n\n"))
  }
}
