@testable import OpensteerAppleData
import XCTest

/// Every way reading or changing an event can go wrong, written before the
/// Calendar rules: from records rather than EventKit, so each rule holds
/// without a grant and only the store itself is left to a person's Mac.
final class CalendarEventsTests: XCTestCase {
  private let clock = DataClock(timeZone: TimeZone(identifier: "America/Los_Angeles")!)

  private func instant(_ text: String) -> Date {
    ISO8601DateFormatter().date(from: text)!
  }

  private func event(
    _ identifier: String = "E1", start: String = "2026-07-01T16:00:00Z",
    end: String = "2026-07-01T17:00:00Z", allDay: Bool = false, title: String = "Standup",
    location: String? = nil, notes: String? = nil, url: String? = nil, recurring: Bool = false
  ) -> EventRecord {
    EventRecord(
      identifier: identifier, calendarId: "C1", title: title, start: instant(start),
      end: instant(end), allDay: allDay, timeZone: allDay ? nil : "America/Los_Angeles",
      location: location, notes: notes, url: url, recurring: recurring, status: .confirmed,
      attendees: [])
  }

  /// An all-day event as EventKit stores it: from local midnight to the last
  /// second of its last day.
  private func allDay(_ identifier: String, first: String, last: String) -> EventRecord {
    let firstDay = clock.startOfDay(try! day(first))
    let lastEnd = clock.startOfDay(clock.adding(days: 1, to: try! day(last))).addingTimeInterval(-1)
    return EventRecord(
      identifier: identifier, calendarId: "C1", title: "Trip", start: firstDay, end: lastEnd,
      allDay: true, timeZone: nil, location: nil, notes: nil, url: nil, recurring: false,
      status: .confirmed, attendees: [])
  }

  private func day(_ text: String) throws -> DataDay {
    guard case .day(let day) = try clock.moment(text, field: "day") else {
      throw HelperError(.failed, "not a day")
    }
    return day
  }

  private func list(
    start: String = "2026-07-01", end: String = "2026-07-01", query: String? = nil,
    cursor: String? = nil, limit: Int? = nil
  ) -> ListEventsArguments {
    ListEventsArguments(
      calendarIds: nil, cursor: cursor, end: end, limit: limit, query: query, start: start)
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

  // MARK: - The range list_events reads

  func testAnEndDateIncludesThatWholeDay() throws {
    let window = try CalendarEvents.window(list(), clock: clock)
    XCTAssertEqual(window.start, instant("2026-07-01T07:00:00Z"))
    XCTAssertEqual(window.end, instant("2026-07-02T07:00:00Z"))
  }

  func testARangeThatEndsBeforeItStartsIsRefused() {
    XCTAssertEqual(
      refusal { _ = try CalendarEvents.window(self.list(start: "2026-07-02", end: "2026-07-01"), clock: self.clock) }?
        .code, .failed)
    XCTAssertEqual(
      refusal {
        _ = try CalendarEvents.window(
          self.list(start: "2026-07-01T10:00", end: "2026-07-01T10:00"), clock: self.clock)
      }?.code, .failed)
  }

  func testARangeLongerThanAYearAndADayIsRefused() {
    XCTAssertNil(refusal { _ = try CalendarEvents.window(self.list(start: "2026-01-01", end: "2027-01-01"), clock: self.clock) })
    XCTAssertEqual(
      refusal { _ = try CalendarEvents.window(self.list(start: "2026-01-01", end: "2027-01-02"), clock: self.clock) }?
        .code, .failed)
  }

  // MARK: - Reading

  func testEventsComeEarliestFirstAndMatchTitleLocationAndNotesWhateverTheirAccents() throws {
    let records = [
      event("late", start: "2026-07-01T20:00:00Z", end: "2026-07-01T21:00:00Z", title: "Café"),
      event("early", title: "Review", location: "Room CAFE"),
      event("middle", start: "2026-07-01T18:00:00Z", end: "2026-07-01T19:00:00Z", notes: "bring café"),
      event("none", title: "Gym"),
    ]
    let page = try CalendarEvents.page(records, arguments: list(query: "cafe"), clock: clock)
    XCTAssertEqual(page.events.map(\.id), [
      EventId(identifier: "early", start: instant("2026-07-01T16:00:00Z")).text,
      EventId(identifier: "middle", start: instant("2026-07-01T18:00:00Z")).text,
      EventId(identifier: "late", start: instant("2026-07-01T20:00:00Z")).text,
    ])
  }

  func testATimedEventReadsInTheMacsTimeWithItsOffset() throws {
    let view = CalendarEvents.view(event(), clock: clock)
    XCTAssertEqual(view.start, "2026-07-01T09:00:00-07:00")
    XCTAssertEqual(view.end, "2026-07-01T10:00:00-07:00")
    XCTAssertFalse(view.allDay)
    XCTAssertEqual(view.timeZone, "America/Los_Angeles")
  }

  func testAnAllDayEventReadsAsItsFirstAndLastDay() throws {
    let view = CalendarEvents.view(allDay("trip", first: "2026-07-03", last: "2026-07-05"), clock: clock)
    XCTAssertEqual(view.start, "2026-07-03")
    XCTAssertEqual(view.end, "2026-07-05")
    // Some sources end an all-day event at the next midnight instead.
    var midnight = allDay("one", first: "2026-07-03", last: "2026-07-03")
    midnight = EventRecord(
      identifier: midnight.identifier, calendarId: "C1", title: "One", start: midnight.start,
      end: clock.startOfDay(DataDay(year: 2026, month: 7, day: 4)), allDay: true, timeZone: nil,
      location: nil, notes: nil, url: nil, recurring: false, status: .confirmed, attendees: [])
    XCTAssertEqual(CalendarEvents.view(midnight, clock: clock).end, "2026-07-03")
  }

  func testNotesLongerThanTheLimitAreCutAndSaySo() {
    let long = String(repeating: "n", count: CalendarEvents.notesLimit + 1)
    let view = CalendarEvents.view(event(notes: long), clock: clock)
    XCTAssertEqual(view.notes?.count, CalendarEvents.notesLimit)
    XCTAssertTrue(view.notesTruncated)
    XCTAssertFalse(CalendarEvents.view(event(notes: "short"), clock: clock).notesTruncated)
  }

  /// Characters are not bytes: notes under the character limit can still be
  /// larger than one frame carries, so they are cut by size too, on a whole
  /// character, and say so.
  func testNotesAreAlsoCutToASizeOneFrameCarries() throws {
    let family = "👨‍👩‍👧‍👦"
    let heavy = String(repeating: family, count: 50_000)
    XCTAssertLessThan(heavy.count, CalendarEvents.notesLimit)
    let view = CalendarEvents.view(event(notes: heavy), clock: clock)
    let notes = try XCTUnwrap(view.notes)
    XCTAssertLessThanOrEqual(notes.utf8.count, DataText.notesMaxBytes)
    XCTAssertTrue(notes.allSatisfy { $0 == Character(family) })
    XCTAssertTrue(view.notesTruncated)
    XCTAssertLessThan(try JSONCoding.encoder.encode(view).count, Paging.byteBudget)
  }

  // MARK: - Naming one occurrence

  func testAnEventIdNamesOneOccurrenceAndSurvivesAnAtInItsIdentifier() throws {
    let id = EventId(identifier: "abc@example.com:1", start: instant("2026-07-01T16:00:00Z"))
    XCTAssertEqual(try EventId.parse(id.text), id)
    for forged in ["", "abc", "abc@", "@123", "abc@12x", "abc@1.5"] {
      XCTAssertThrowsError(try EventId.parse(forged), forged) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
  }

  // MARK: - Creating

  func testATimedEventNeedsTimesEndingAfterTheyStart() throws {
    let fields = try CalendarEvents.fields(
      creating: decode(
        CreateEventArguments.self,
        #"{"title":" Lunch ","start":"2026-07-01T12:00","end":"2026-07-01T13:00","location":""}"#),
      clock: clock)
    XCTAssertEqual(fields.title, "Lunch")
    XCTAssertEqual(fields.start, instant("2026-07-01T19:00:00Z"))
    XCTAssertEqual(fields.end, instant("2026-07-01T20:00:00Z"))
    XCTAssertFalse(fields.allDay)
    XCTAssertNil(fields.location)

    for json in [
      #"{"title":"x","start":"2026-07-01T12:00","end":"2026-07-01T12:00"}"#,
      #"{"title":"x","start":"2026-07-01T12:00","end":"2026-07-01T11:00"}"#,
      #"{"title":"x","start":"2026-07-01","end":"2026-07-02"}"#,
      #"{"title":"   ","start":"2026-07-01T12:00","end":"2026-07-01T13:00"}"#,
      #"{"title":"x","start":"2026-07-01T12:00","end":"2026-07-01T13:00","url":"not a url"}"#,
    ] {
      let error = refusal {
        _ = try CalendarEvents.fields(creating: self.decode(CreateEventArguments.self, json), clock: self.clock)
      }
      XCTAssertEqual(error?.code, .failed, json)
    }
  }

  func testAnAllDayEventTakesDatesEndingOnItsLastDay() throws {
    let fields = try CalendarEvents.fields(
      creating: decode(
        CreateEventArguments.self,
        #"{"title":"Trip","allDay":true,"start":"2026-07-03","end":"2026-07-05"}"#),
      clock: clock)
    XCTAssertTrue(fields.allDay)
    XCTAssertEqual(fields.start, clock.startOfDay(DataDay(year: 2026, month: 7, day: 3)))
    XCTAssertEqual(fields.end, clock.startOfDay(DataDay(year: 2026, month: 7, day: 5)))
    XCTAssertNotNil(
      try? CalendarEvents.fields(
        creating: decode(
          CreateEventArguments.self,
          #"{"title":"Day","allDay":true,"start":"2026-07-03","end":"2026-07-03"}"#),
        clock: clock))

    for json in [
      #"{"title":"x","allDay":true,"start":"2026-07-03","end":"2026-07-02"}"#,
      #"{"title":"x","allDay":true,"start":"2026-07-03T09:00","end":"2026-07-04"}"#,
    ] {
      let error = refusal {
        _ = try CalendarEvents.fields(creating: self.decode(CreateEventArguments.self, json), clock: self.clock)
      }
      XCTAssertEqual(error?.code, .failed, json)
    }
  }

  // MARK: - Changing

  private func update(_ record: EventRecord, _ json: String) throws -> EventFields {
    try CalendarEvents.fields(
      updating: record, with: decode(UpdateEventArguments.self, json), clock: clock)
  }

  func testAChangeNamingNothingIsRefused() {
    XCTAssertEqual(refusal { _ = try self.update(self.event(), #"{"id":"E1@1"}"#) }?.code, .failed)
    XCTAssertEqual(
      refusal { _ = try self.update(self.event(), #"{"id":"E1@1","span":"future"}"#) }?.code,
      .failed)
  }

  func testANewStartAloneKeepsTheEventsLength() throws {
    let moved = try update(event(), #"{"id":"E1@1","start":"2026-07-01T15:00"}"#)
    XCTAssertEqual(moved.start, instant("2026-07-01T22:00:00Z"))
    XCTAssertEqual(moved.end, instant("2026-07-01T23:00:00Z"))

    let trip = allDay("trip", first: "2026-07-03", last: "2026-07-05")
    let movedTrip = try update(trip, #"{"id":"x@1","start":"2026-08-10"}"#)
    XCTAssertEqual(movedTrip.start, clock.startOfDay(DataDay(year: 2026, month: 8, day: 10)))
    XCTAssertEqual(movedTrip.end, clock.startOfDay(DataDay(year: 2026, month: 8, day: 12)))
  }

  func testANewEndAloneMustStillComeAfterTheStart() throws {
    XCTAssertEqual(
      try update(event(), #"{"id":"E1@1","end":"2026-07-01T11:00"}"#).end,
      instant("2026-07-01T18:00:00Z"))
    XCTAssertEqual(
      refusal { _ = try self.update(self.event(), #"{"id":"E1@1","end":"2026-07-01T08:00"}"#) }?.code,
      .failed)
  }

  func testSwitchingAllDayNeedsBothStartAndEnd() throws {
    XCTAssertEqual(
      refusal { _ = try self.update(self.event(), #"{"id":"E1@1","allDay":true}"#) }?.code, .failed)
    XCTAssertEqual(
      refusal { _ = try self.update(self.event(), #"{"id":"E1@1","allDay":true,"start":"2026-07-01"}"#) }?
        .code, .failed)
    let whole = try update(
      event(), #"{"id":"E1@1","allDay":true,"start":"2026-07-01","end":"2026-07-01"}"#)
    XCTAssertTrue(whole.allDay)
    XCTAssertEqual(whole.start, whole.end)
  }

  func testNullClearsAndAbsenceKeeps() throws {
    let record = event(location: "Room 1", notes: "Agenda", url: "https://example.com")
    let cleared = try update(record, #"{"id":"E1@1","location":null,"url":null}"#)
    XCTAssertNil(cleared.location)
    XCTAssertNil(cleared.url)
    XCTAssertEqual(cleared.notes, "Agenda")
    XCTAssertEqual(cleared.title, "Standup")
    XCTAssertEqual(cleared.start, record.start)
  }

  func testNotesTooLongToHaveBeenReadWholeCannotBeRewritten() {
    let record = event(notes: String(repeating: "n", count: CalendarEvents.notesLimit + 1))
    XCTAssertEqual(
      refusal { _ = try self.update(record, #"{"id":"E1@1","notes":"shorter"}"#) }?.code, .failed)
    XCTAssertEqual(
      refusal { _ = try self.update(record, #"{"id":"E1@1","notes":null}"#) }?.code, .failed)
    XCTAssertNil(refusal { _ = try self.update(record, #"{"id":"E1@1","title":"Renamed"}"#) })
  }

  func testASpanIsThisOrFuture() throws {
    XCTAssertEqual(try decode(DeleteEventArguments.self, #"{"id":"E1@1"}"#).span, nil)
    XCTAssertEqual(try decode(DeleteEventArguments.self, #"{"id":"E1@1","span":"future"}"#).span, .future)
    XCTAssertEqual(
      refusal { _ = try self.decode(DeleteEventArguments.self, #"{"id":"E1@1","span":"all"}"#) }?.code,
      .failed)
  }
}
