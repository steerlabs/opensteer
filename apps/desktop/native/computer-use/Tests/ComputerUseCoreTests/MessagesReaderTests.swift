import XCTest

@testable import ComputerUseCore

/// Every way reading Messages can go wrong, written before the helper's
/// reader, on a `chat.db` the tests build: order, matching, decoding,
/// dates in both encodings, rows that are not messages, pages that repeat or
/// drop a row, searches that outrun their time, and a database macOS
/// withholds.
final class MessagesReaderTests: XCTestCase {
  private let clock = DataClock(timeZone: TimeZone(identifier: "UTC")!)
  /// Built once, on first use, and only read.
  private static let shared: URL = try! MessagesFixture.create()

  private func reader(_ url: URL? = nil) -> MessagesReader {
    MessagesReader(path: (url ?? Self.shared).path, clock: clock)
  }

  private func arguments<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try DataArguments.decode(
      type, from: try JSONCoding.decoder.decode([String: JSONValue].self, from: Data(json.utf8)))
  }

  private func conversations(_ json: String = "{}", in url: URL? = nil) throws -> ConversationsPage {
    try reader(url).listConversations(arguments(ListConversationsArguments.self, json))
  }

  private func messages(
    _ json: String = "{}", in url: URL? = nil, timeLeft: @escaping () -> TimeInterval = { 60 }
  ) throws -> MessagesPage {
    try reader(url).readMessages(arguments(ReadMessagesArguments.self, json), timeLeft: timeLeft)
  }

  private func refusal(_ work: () throws -> Void) -> HelperError? {
    do {
      try work()
      return nil
    } catch {
      return error as? HelperError
    }
  }

  // MARK: - Conversations

  func testTheMostRecentlyActiveConversationComesFirstAndEachIsDescribed() throws {
    let page = try conversations()
    XCTAssertEqual(
      page.conversations.map(\.conversationId),
      [MessagesFixture.Chat.direct, MessagesFixture.Chat.group, MessagesFixture.Chat.sms,
       MessagesFixture.Chat.quiet])
    XCTAssertNil(page.nextCursor)
    let (direct, group, sms, quiet) = (
      page.conversations[0], page.conversations[1], page.conversations[2], page.conversations[3]
    )
    XCTAssertNil(direct.displayName)
    XCTAssertFalse(direct.isGroup)
    XCTAssertEqual(direct.lastMessageAt, "2024-03-04T12:00:00Z")
    XCTAssertEqual(direct.participants, [MessagesFixture.Handle.friend])
    XCTAssertEqual(direct.service, "iMessage")
    XCTAssertEqual(group.displayName, "Weekend Trip")
    XCTAssertTrue(group.isGroup)
    // The rename at 08:30 is not a message, so it is not the last one.
    XCTAssertEqual(group.lastMessageAt, "2024-03-03T08:00:00Z")
    XCTAssertEqual(
      group.participants,
      [MessagesFixture.Handle.friend, MessagesFixture.Handle.neighbour,
       MessagesFixture.Handle.colleague])
    // Whole seconds and nanoseconds read as the same kind of instant.
    XCTAssertEqual(sms.lastMessageAt, "2013-05-01T17:45:00Z")
    XCTAssertEqual(sms.service, "SMS")
    XCTAssertNil(quiet.lastMessageAt)
  }

  func testAQueryMatchesTheChatNameOrAParticipantsHandleWhateverTheCase() throws {
    XCTAssertEqual(
      try conversations(#"{"query":"weekend"}"#).conversations.map(\.conversationId),
      [MessagesFixture.Chat.group])
    XCTAssertEqual(
      try conversations(#"{"query":"9876543"}"#).conversations.map(\.conversationId),
      [MessagesFixture.Chat.group, MessagesFixture.Chat.sms])
    XCTAssertEqual(
      try conversations(#"{"query":"WORK@example.com"}"#).conversations.map(\.conversationId),
      [MessagesFixture.Chat.group, MessagesFixture.Chat.quiet])
    // LIKE's own wildcards are the person's text, not patterns.
    XCTAssertEqual(try conversations(#"{"query":"%"}"#).conversations.map(\.conversationId), [])
    XCTAssertEqual(try conversations(#"{"query":"_"}"#).conversations.map(\.conversationId), [])
  }

  func testConversationsPageWithoutRepeatingOrDroppingOne() throws {
    let first = try conversations(#"{"limit":2}"#)
    XCTAssertEqual(first.conversations.count, 2)
    let cursor = try XCTUnwrap(first.nextCursor)
    let second = try conversations(#"{"limit":2,"cursor":"\#(cursor)"}"#)
    XCTAssertNil(second.nextCursor)
    XCTAssertEqual(
      (first.conversations + second.conversations).map(\.conversationId),
      [MessagesFixture.Chat.direct, MessagesFixture.Chat.group, MessagesFixture.Chat.sms,
       MessagesFixture.Chat.quiet])
  }

  func testALimitOutsideItsRangeAndACursorFromAnotherListingAreRefused() throws {
    for json in [#"{"limit":0}"#, #"{"limit":101}"#, #"{"cursor":"not-a-cursor"}"#] {
      XCTAssertEqual(refusal { _ = try self.conversations(json) }?.code, .failed, json)
    }
    let cursor = try XCTUnwrap(try conversations(#"{"limit":1}"#).nextCursor)
    // A cursor belongs to the operation and the arguments that issued it.
    XCTAssertEqual(refusal { _ = try self.messages(#"{"cursor":"\#(cursor)"}"#) }?.code, .failed)
    XCTAssertEqual(
      refusal { _ = try self.conversations(#"{"limit":1,"query":"a","cursor":"\#(cursor)"}"#) }?.code,
      .failed)
  }

  // MARK: - Messages

  func testOneConversationReadsNewestFirstDecodingBodiesThatAreNotPlainText() throws {
    let page = try messages(#"{"conversationId":"\#(MessagesFixture.Chat.direct)"}"#)
    XCTAssertEqual(page.messages.map(\.id), ["msg-latest", "msg-reply", "msg-lunch"])
    let (latest, reply, lunch) = (page.messages[0], page.messages[1], page.messages[2])
    XCTAssertEqual(latest.conversationId, MessagesFixture.Chat.direct)
    XCTAssertFalse(latest.hasAttachments)
    XCTAssertTrue(latest.isFromMe)
    XCTAssertEqual(latest.sender, "me")
    XCTAssertEqual(latest.sentAt, "2024-03-04T12:00:00Z")
    XCTAssertEqual(latest.text, "Later message with a picture")
    XCTAssertEqual(reply.text, "Sounds good, see you then")
    XCTAssertFalse(reply.undecoded)
    XCTAssertFalse(lunch.isFromMe)
    XCTAssertEqual(lunch.sender, MessagesFixture.Handle.friend)
    XCTAssertEqual(lunch.text, "Lunch at one?")
    XCTAssertNil(page.nextCursor)
  }

  func testReactionsAndConversationEventsAreNotMessages() throws {
    let everything = try messages(#"{"limit":200}"#).messages.map(\.id)
    XCTAssertFalse(everything.contains("msg-tapback"))
    XCTAssertFalse(everything.contains("msg-renamed"))
    XCTAssertEqual(try messages(#"{"query":"Loved"}"#).messages.map(\.id), [])
  }

  func testAMessageWhoseBodyCannotBeDecodedIsKeptWithItsAttachment() throws {
    let page = try messages(#"{"conversationId":"\#(MessagesFixture.Chat.group)"}"#)
    let undecodable = try XCTUnwrap(page.messages.first { $0.id == "msg-undecodable" })
    XCTAssertTrue(undecodable.hasAttachments)
    XCTAssertEqual(undecodable.sender, MessagesFixture.Handle.neighbour)
    XCTAssertNil(undecodable.text)
    XCTAssertFalse(undecodable.truncated)
    XCTAssertTrue(undecodable.undecoded)
  }

  func testAnOversizedBodyIsCutAndSaysSo() throws {
    let page = try messages(#"{"conversationId":"\#(MessagesFixture.Chat.group)"}"#)
    let oversized = try XCTUnwrap(page.messages.first { $0.id == "msg-oversized" })
    XCTAssertEqual(oversized.text?.utf8.count, 16 * 1_024)
    XCTAssertTrue(MessagesFixture.oversizedText.hasPrefix(oversized.text ?? "-"))
    XCTAssertTrue(oversized.truncated)
    XCTAssertFalse(try XCTUnwrap(page.messages.first { $0.id == "msg-emoji" }).truncated)
  }

  func testADateWindowReadsBothDateEncodingsAndAnInvertedOneIsRefused() throws {
    XCTAssertEqual(
      try messages(#"{"since":"2024-03-02T00:00:00Z","until":"2024-03-02T12:00:00Z"}"#)
        .messages.map(\.id),
      ["msg-oversized", "msg-emoji"])
    let legacy = try messages(#"{"until":"2014-01-01"}"#)
    XCTAssertEqual(legacy.messages.map(\.id), ["msg-legacy"])
    XCTAssertEqual(legacy.messages.first?.sentAt, "2013-05-01T17:45:00Z")
    XCTAssertEqual(legacy.messages.first?.service, "SMS")
    for json in [
      #"{"since":"2024-03-02T00:00:00Z","until":"2024-01-01T00:00:00Z"}"#,
      #"{"since":"last tuesday"}"#,
    ] {
      XCTAssertEqual(refusal { _ = try self.messages(json) }?.code, .failed, json)
    }
  }

  /// A bound past what `chat.db` can count in nanoseconds bounds nothing on
  /// that side; it never stops the helper.
  func testABoundBeyondWhatMessagesCanStoreBoundsNothing() throws {
    let all = try messages("{}").messages.map(\.id)
    XCTAssertEqual(try messages(#"{"until":"3000-01-01T00:00:00Z"}"#).messages.map(\.id), all)
    XCTAssertEqual(try messages(#"{"until":"3000-01-01"}"#).messages.map(\.id), all)
    XCTAssertEqual(try messages(#"{"since":"1500-01-01"}"#).messages.map(\.id), all)
  }

  func testASearchFindsTextThatExistsOnlyInsideAnAttributedBody() throws {
    XCTAssertEqual(try messages(#"{"query":"sounds good"}"#).messages.map(\.id), ["msg-reply"])
    XCTAssertEqual(try messages(#"{"query":"😀"}"#).messages.map(\.id), ["msg-emoji"])
    XCTAssertEqual(try messages(#"{"query":"CAFÉ"}"#).messages.map(\.id), ["msg-emoji"])
  }

  func testEveryMessagePagesOnACursorWithoutRepeatingOrDroppingOne() throws {
    var seen: [String] = []
    var cursor: String?
    repeat {
      let page = try messages(cursor.map { #"{"limit":2,"cursor":"\#($0)"}"# } ?? #"{"limit":2}"#)
      seen += page.messages.map(\.id)
      cursor = page.nextCursor
    } while cursor != nil
    XCTAssertEqual(
      seen,
      ["msg-latest", "msg-undecodable", "msg-oversized", "msg-emoji", "msg-reply", "msg-lunch",
       "msg-legacy"])
  }

  func testArgumentsOutsideTheirBoundsAreRefused() {
    for json in [#"{"limit":201}"#, #"{"conversationId":7}"#, #"{"limit":0}"#] {
      XCTAssertEqual(refusal { _ = try self.messages(json) }?.code, .failed, json)
    }
  }

  // MARK: - Searching within its time

  func testASearchStopsAtItsScanBoundAndHandsBackACursorToContinueFrom() throws {
    let large = try MessagesFixture.create(filler: 5_200)
    let first = try messages(#"{"query":"fence"}"#, in: large)
    // "fence" is in the oldest message of all, behind more rows than one
    // call may decode: an empty page that is not the end of the history.
    XCTAssertEqual(first.messages.map(\.id), [])
    let cursor = try XCTUnwrap(first.nextCursor)
    XCTAssertEqual(
      try messages(#"{"query":"fence","cursor":"\#(cursor)"}"#, in: large).messages.map(\.id),
      ["msg-legacy"])
  }

  func testASearchThatRanOutOfTimeBeforeReadingARowFailsRatherThanEndingTheHistory() {
    let error = refusal { _ = try self.messages(#"{"query":"lunch"}"#, timeLeft: { 0 }) }
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(
      error?.message, "Messages took too long to search. Narrow the dates or the conversation.")
  }

  func testASearchThatRanOutOfTimeAfterReadingRowsKeepsItsCursor() throws {
    let large = try MessagesFixture.create(filler: 800)
    var checks = 0
    let page = try messages(
      #"{"query":"absent from every message"}"#, in: large,
      timeLeft: {
        checks += 1
        return checks == 1 ? 60 : 0
      })
    XCTAssertEqual(page.messages.map(\.id), [])
    XCTAssertNotNil(page.nextCursor)
  }

  func testAPlainReadSpendsNoSearchTime() throws {
    let page = try messages(#"{"limit":1}"#, timeLeft: { 0 })
    XCTAssertEqual(page.messages.count, 1)
    XCTAssertNotNil(page.nextCursor)
  }

  // MARK: - Paging a search

  private func search(_ fixture: MessagesFixture.Search, limit: Int) throws -> (ids: [String], pages: [Int]) {
    let url = try MessagesFixture.create(search: fixture)
    var ids: [String] = []
    var pages: [Int] = []
    var cursor: String?
    for _ in 0..<20 {
      let base = #""conversationId":"\#(MessagesFixture.Chat.quiet)","query":"needle","limit":\#(limit)"#
      let page = try messages(cursor.map { "{\(base),\"cursor\":\"\($0)\"}" } ?? "{\(base)}", in: url)
      ids += page.messages.map(\.id)
      pages.append(page.messages.count)
      cursor = page.nextCursor
      if cursor == nil { return (ids, pages) }
    }
    XCTFail("The search never reached the end of the history")
    return (ids, pages)
  }

  func testASearchCarriesOnThroughTheRestOfTheBatchItFilledAPageFrom() throws {
    let (ids, pages) = try search(.init(needles: 100), limit: 50)
    XCTAssertEqual(pages, [50, 50])
    XCTAssertEqual(Set(ids).count, 100)
  }

  func testASearchKeepsMatchesInterleavedAcrossABatchBoundary() throws {
    let (ids, pages) = try search(.init(needles: 300, chaff: 2), limit: 200)
    XCTAssertEqual(pages, [200, 100])
    XCTAssertEqual(Set(ids).count, 300)
  }

  func testRowsSharingOneTimestampPageOnTheRowIdAlone() throws {
    let (ids, pages) = try search(.init(needles: 10, sameDate: true), limit: 4)
    XCTAssertEqual(pages, [4, 4, 2])
    XCTAssertEqual(Set(ids).count, 10)
  }

  func testASearchResumesExactlyWhereItsScanBoundStoppedIt() throws {
    let (ids, pages) = try search(.init(needles: 20, chaff: 300), limit: 50)
    XCTAssertEqual(pages.count, 2)
    XCTAssertGreaterThan(pages[0], 0)
    XCTAssertEqual(Set(ids).count, 20)
  }

  // MARK: - A page that fits the frame

  func testAPageOfLongMessagesStaysWithinTheByteBudgetAndLosesNone() throws {
    let url = try MessagesFixture.create(search: .init(needles: 60))
    var ids: [String] = []
    var cursor: String?
    repeat {
      let base = #""conversationId":"\#(MessagesFixture.Chat.quiet)","limit":200"#
      let page = try MessagesReader(path: url.path, clock: clock, byteBudget: 1_000)
        .readMessages(
          arguments(
            ReadMessagesArguments.self,
            cursor.map { "{\(base),\"cursor\":\"\($0)\"}" } ?? "{\(base)}"),
          timeLeft: { 60 })
      let bytes = try page.messages.reduce(0) { $0 + (try JSONCoding.encoder.encode($1).count) }
      XCTAssertLessThanOrEqual(bytes, 1_000)
      ids += page.messages.map(\.id)
      cursor = page.nextCursor
    } while cursor != nil
    XCTAssertEqual(Set(ids).count, 60)
    XCTAssertEqual(ids.count, 60)
  }

  // MARK: - A database macOS withholds

  func testWithoutFullDiskAccessTheReadSaysWhichGrant() {
    XCTAssertEqual(MessagesReader.openFailure(errno: EPERM).code, .permissionRequired)
    XCTAssertEqual(
      MessagesReader.openFailure(errno: EPERM).message,
      "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.")
  }

  func testAMacWithNoMessagesHistoryIsNotSetUpRatherThanUnauthorized() throws {
    let missing = FileManager.default.temporaryDirectory
      .appendingPathComponent("absent-\(UUID().uuidString)/chat.db")
    let error = refusal { _ = try self.conversations(in: missing) }
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(error?.message, "Messages is not set up.")
  }

  /// A POSIX refusal is no macOS grant, so no switch in System Settings is
  /// named for it, and no path reaches the sentence.
  func testAPOSIXRefusalIsKeptApartFromTheGrant() throws {
    let url = try MessagesFixture.create()
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: url.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
    let error = refusal { _ = try self.conversations(in: url) }
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(error?.message, "Messages could not be opened.")
  }
}
