@testable import OpensteerAppleData
import XCTest

/// Every way reading or changing a reminder can go wrong, written before the
/// Reminders rules, from records rather than EventKit.
final class RemindersTests: XCTestCase {
  private let clock = DataClock(timeZone: TimeZone(identifier: "America/Los_Angeles")!)

  private func instant(_ text: String) -> Date {
    ISO8601DateFormatter().date(from: text)!
  }

  private func reminder(
    _ id: String, title: String = "Task", due: DataClock.Moment? = nil, notes: String? = nil,
    priority: Int = 0, completedAt: String? = nil, url: String? = nil
  ) -> ReminderRecord {
    ReminderRecord(
      id: id, listId: "L1", title: title, notes: notes, due: due, priority: priority,
      completed: completedAt != nil, completedAt: completedAt.map(instant), url: url,
      recurring: false)
  }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try DataArguments.decode(
      type, from: try JSONCoding.decoder.decode([String: OpensteerAppleData.JSONValue].self, from: Data(json.utf8)))
  }

  private func refusal(_ work: () throws -> Void) -> HelperError? {
    do {
      try work()
      return nil
    } catch {
      return error as? HelperError
    }
  }

  private func listing(_ json: String = "{}") throws -> ListRemindersArguments {
    try decode(ListRemindersArguments.self, json)
  }

  // MARK: - Reading

  /// A due day counts from the start of that day on this Mac, so an overdue
  /// time yesterday comes before anything due today.
  func testIncompleteRemindersComeSoonestDueFirstAndUndatedLast() throws {
    let records = [
      reminder("undated-b", title: "b"),
      reminder("today", due: .day(DataDay(year: 2026, month: 7, day: 2))),
      reminder("undated-a", title: "a"),
      reminder("yesterday-evening", due: .instant(instant("2026-07-02T02:00:00Z"))),
      reminder("today-noon", due: .instant(instant("2026-07-02T19:00:00Z"))),
    ]
    let page = try Reminders.page(records, arguments: listing(), clock: clock)
    XCTAssertEqual(
      page.reminders.map(\.id),
      ["yesterday-evening", "today", "today-noon", "undated-a", "undated-b"])
  }

  func testCompletedRemindersComeMostRecentlyCompletedFirst() throws {
    let records = [
      reminder("older", completedAt: "2026-07-01T10:00:00Z"),
      reminder("newer", completedAt: "2026-07-02T10:00:00Z"),
      reminder("open"),
    ]
    let page = try Reminders.page(
      records, arguments: listing(#"{"status":"completed"}"#), clock: clock)
    XCTAssertEqual(page.reminders.map(\.id), ["newer", "older"])
  }

  func testAQueryMatchesTitleAndNotesWhateverTheirAccents() throws {
    let records = [
      reminder("title", title: "Pay Café"), reminder("notes", notes: "cafe receipt"),
      reminder("neither", title: "Walk"),
    ]
    let page = try Reminders.page(records, arguments: listing(#"{"query":"CAFÉ"}"#), clock: clock)
    XCTAssertEqual(Set(page.reminders.map(\.id)), ["title", "notes"])
  }

  func testADueDayStaysADayAndADueTimeReadsWithItsOffset() {
    XCTAssertEqual(
      Reminders.view(reminder("d", due: .day(DataDay(year: 2026, month: 7, day: 2))), clock: clock)
        .due, "2026-07-02")
    XCTAssertEqual(
      Reminders.view(reminder("t", due: .instant(instant("2026-07-02T19:00:00Z"))), clock: clock)
        .due, "2026-07-02T12:00:00-07:00")
  }

  /// EventKit keeps 0 for none, 1 to 4 for high, 5 for medium, 6 to 9 for low.
  func testPriorityReadsInWordsAndWritesTheValueRemindersItselfUses() {
    let expected: [(Int, ReminderPriority)] = [
      (0, .none), (1, .high), (4, .high), (5, .medium), (6, .low), (9, .low),
    ]
    for (value, name) in expected {
      XCTAssertEqual(ReminderPriority(eventKit: value), name, "\(value)")
    }
    XCTAssertEqual(
      [ReminderPriority.none, .high, .medium, .low].map(\.eventKit), [0, 1, 5, 9])
  }

  func testAStatusIsIncompleteOrCompleted() {
    XCTAssertEqual(
      refusal { _ = try self.listing(#"{"status":"all"}"#) }?.code, .failed)
  }

  // MARK: - Creating and changing

  func testANewReminderNeedsATitleAndAReadableDue() throws {
    let fields = try Reminders.fields(
      creating: decode(
        CreateReminderArguments.self, #"{"title":" Call Ada ","due":"2026-07-02T09:00","priority":"high"}"#),
      clock: clock)
    XCTAssertEqual(fields.title, "Call Ada")
    XCTAssertEqual(fields.due, .instant(instant("2026-07-02T16:00:00Z")))
    XCTAssertEqual(fields.priority, ReminderPriority.high.eventKit)
    XCTAssertTrue(fields.dueChanged)
    XCTAssertFalse(fields.completed)

    for json in [#"{"title":"  "}"#, #"{"title":"x","due":"soon"}"#, #"{"title":"x","url":"nope"}"#] {
      let error = refusal {
        _ = try Reminders.fields(creating: self.decode(CreateReminderArguments.self, json), clock: self.clock)
      }
      XCTAssertEqual(error?.code, .failed, json)
    }
  }

  private func update(_ record: ReminderRecord, _ json: String) throws -> ReminderFields {
    try Reminders.fields(
      updating: record, with: decode(UpdateReminderArguments.self, json), clock: clock)
  }

  func testAChangeNamingNothingIsRefused() {
    XCTAssertEqual(refusal { _ = try self.update(self.reminder("r"), #"{"id":"r"}"#) }?.code, .failed)
  }

  func testCompletingTouchesNothingElse() throws {
    // 3 is high as Reminders shows it, and stays 3 rather than becoming 1.
    let record = reminder(
      "r", title: "Pay", due: .day(DataDay(year: 2026, month: 7, day: 2)), notes: "n", priority: 3,
      url: "x-apple-reminder://anything")
    let done = try update(record, #"{"id":"r","completed":true}"#)
    XCTAssertTrue(done.completed)
    XCTAssertFalse(done.dueChanged)
    XCTAssertEqual(done.due, record.due)
    XCTAssertEqual(done.priority, 3)
    XCTAssertEqual(done.notes, "n")
    XCTAssertEqual(done.url, "x-apple-reminder://anything")
  }

  func testNullClearsTheDueAndSaysItChanged() throws {
    let record = reminder("r", due: .instant(instant("2026-07-02T19:00:00Z")))
    let cleared = try update(record, #"{"id":"r","due":null}"#)
    XCTAssertNil(cleared.due)
    XCTAssertTrue(cleared.dueChanged)
  }

  func testNotesTooLongToHaveBeenReadWholeCannotBeRewritten() {
    let record = reminder("r", notes: String(repeating: "n", count: CalendarEvents.notesLimit + 1))
    XCTAssertEqual(refusal { _ = try self.update(record, #"{"id":"r","notes":"x"}"#) }?.code, .failed)
    XCTAssertNil(refusal { _ = try self.update(record, #"{"id":"r","completed":true}"#) })
  }
}
