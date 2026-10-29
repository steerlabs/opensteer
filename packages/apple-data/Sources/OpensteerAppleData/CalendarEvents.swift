import Foundation

/// A calendar or a reminder list, in the catalog's output shape.
public struct ContainerView: Encodable, Sendable, Equatable {
  @Nullable public var account: String?
  public let id: String
  public let isDefault: Bool
  public let title: String
  public let writable: Bool
}

public enum EventStatus: String, Codable, Sendable {
  case confirmed, tentative, canceled, none
}

public enum AttendeeStatus: String, Codable, Sendable {
  case accepted, declined, tentative, pending, delegated, completed, unknown
  case inProcess = "in-process"
}

public struct AttendeeView: Encodable, Sendable, Equatable {
  @Nullable public var email: String?
  public let isMe: Bool
  @Nullable public var name: String?
  public let status: AttendeeStatus
}

/// One occurrence of an event as Calendar rules read it, apart from EventKit.
/// An all-day event runs from the start of its first day to anywhere in its
/// last day, as EventKit stores it.
public struct EventRecord: Sendable, Equatable {
  public let identifier: String
  public let calendarId: String
  public let title: String
  public let start: Date
  public let end: Date
  public let allDay: Bool
  public let timeZone: String?
  public let location: String?
  public let notes: String?
  public let url: String?
  public let recurring: Bool
  public let status: EventStatus
  public let attendees: [AttendeeView]
}

/// One occurrence in the catalog's output shape.
public struct EventView: Encodable, Sendable, Equatable {
  public let allDay: Bool
  public let attendees: [AttendeeView]
  public let calendarId: String
  public let end: String
  public let id: String
  @Nullable public var location: String?
  @Nullable public var notes: String?
  public let notesTruncated: Bool
  public let recurring: Bool
  public let start: String
  public let status: EventStatus
  @Nullable public var timeZone: String?
  public let title: String
  @Nullable public var url: String?
}

public struct EventsPage: Encodable, Sendable, Equatable {
  public let events: [EventView]
  @Nullable public var nextCursor: String?
}

/// What `list_calendars` answers.
public struct CalendarsResult: Encodable, Sendable {
  public let calendars: [ContainerView]
}

/// What `create_event` and `update_event` answer: the event as it is now.
public struct EventResult: Encodable, Sendable {
  public let event: EventView
}

/// What a delete answers once it is done.
public struct DeletedResult: Encodable, Sendable {
  public let deleted = true
}

/// One occurrence of an event: every occurrence of a repeating event shares
/// EventKit's identifier, so the id adds when this one starts, in whole
/// seconds. A moved occurrence has a new id, which the change returns.
public struct EventId: Equatable, Sendable {
  public let identifier: String
  public let start: Date

  public init(identifier: String, start: Date) {
    self.identifier = identifier
    self.start = Date(timeIntervalSince1970: start.timeIntervalSince1970.rounded(.down))
  }

  public var text: String { "\(identifier)@\(Int(start.timeIntervalSince1970))" }

  /// EventKit's identifier may itself hold `@`, so the start follows the last.
  public static func parse(_ text: String) throws -> EventId {
    guard
      let at = text.lastIndex(of: "@"),
      at != text.startIndex,
      case let seconds = text[text.index(after: at)...],
      !seconds.isEmpty,
      seconds.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-") }),
      let value = Int(seconds)
    else {
      throw HelperError(.failed, "That is not an event id from list_events.")
    }
    return EventId(
      identifier: String(text[..<at]), start: Date(timeIntervalSince1970: TimeInterval(value)))
  }
}

public enum EventSpan: String, Decodable, Sendable {
  case this, future
}

public struct ListEventsArguments: Decodable, Sendable {
  public let calendarIds: [String]?
  public let cursor: String?
  public let end: String
  public let limit: Int?
  public let query: String?
  public let start: String
}

public struct CreateEventArguments: Decodable, Sendable {
  public let allDay: Bool?
  public let calendarId: String?
  public let end: String
  public let location: String?
  public let notes: String?
  public let start: String
  public let title: String
  public let url: String?
}

public struct UpdateEventArguments: Decodable, Sendable {
  public let allDay: Bool?
  public let end: String?
  public let id: String
  public let location: Patch<String>
  public let notes: Patch<String>
  public let span: EventSpan?
  public let start: String?
  public let title: String?
  public let url: Patch<String>
}

public struct DeleteEventArguments: Decodable, Sendable {
  public let id: String
  public let span: EventSpan?
}

/// What an event is made of, as creating or changing one sets it. An all-day
/// event's `start` and `end` are the starts of its first and last days.
public struct EventFields: Equatable, Sendable {
  public let title: String
  public let start: Date
  public let end: Date
  public let allDay: Bool
  public let location: String?
  public let notes: String?
  public let url: String?
}

/// Calendar's rules, apart from EventKit: which range a listing reads, how
/// events page and read, and what a change sets.
public enum CalendarEvents {
  public static let defaultLimit = 50
  public static let maxLimit = 200
  public static let maxRangeDays = 366
  /// Longer notes are cut when read, and then cannot be written back.
  public static let notesLimit = 100_000

  // MARK: - Reading

  /// The instants `list_events` reads between: an end date includes that
  /// whole day, and the range is at most `maxRangeDays` long.
  public static func window(_ arguments: ListEventsArguments, clock: DataClock) throws
    -> DateInterval
  {
    let start: Date
    switch try clock.moment(arguments.start, field: "start") {
    case .day(let day): start = clock.startOfDay(day)
    case .instant(let date): start = date
    }
    let end: Date
    switch try clock.moment(arguments.end, field: "end") {
    case .day(let day): end = clock.startOfDay(clock.adding(days: 1, to: day))
    case .instant(let date): end = date
    }
    guard end > start else { throw HelperError(.failed, "end must be after start.") }
    let longest = clock.calendar.date(byAdding: .day, value: maxRangeDays, to: start) ?? start
    guard end <= longest else {
      throw HelperError(
        .failed, "The range can be at most \(maxRangeDays) days; list a shorter one.")
    }
    return DateInterval(start: start, end: end)
  }

  public static func page(
    _ records: [EventRecord], arguments: ListEventsArguments, clock: DataClock
  ) throws -> EventsPage {
    let matching =
      records
      .filter { DataText.matches(arguments.query, in: [$0.title, $0.location, $0.notes]) }
      .sorted { ($0.start, $0.end, $0.identifier) < ($1.start, $1.end, $1.identifier) }
    let page = try Paging.page(
      matching.map { view($0, clock: clock) }, cursor: arguments.cursor, limit: arguments.limit,
      defaultLimit: defaultLimit, maxLimit: maxLimit,
      listing: [
        arguments.start, arguments.end, arguments.query,
        arguments.calendarIds.map { $0.sorted().joined(separator: "\n") },
      ])
    return EventsPage(events: page.items, nextCursor: page.nextCursor)
  }

  public static func view(_ record: EventRecord, clock: DataClock) -> EventView {
    let notes = DataText.notes(record.notes, limit: notesLimit)
    return EventView(
      allDay: record.allDay,
      attendees: record.attendees,
      calendarId: record.calendarId,
      end: record.allDay ? clock.text(lastDay(record, clock: clock)) : clock.text(record.end),
      id: EventId(identifier: record.identifier, start: record.start).text,
      location: record.location,
      notes: notes.text,
      notesTruncated: notes.truncated,
      recurring: record.recurring,
      start: record.allDay ? clock.text(clock.day(of: record.start)) : clock.text(record.start),
      status: record.status,
      timeZone: record.timeZone,
      title: record.title,
      url: record.url
    )
  }

  /// EventKit ends an all-day event within its last day, or at the midnight
  /// after it; either way the last day is the day before that instant.
  private static func lastDay(_ record: EventRecord, clock: DataClock) -> DataDay {
    clock.day(of: max(record.start, record.end.addingTimeInterval(-1)))
  }

  // MARK: - Changing

  public static func fields(creating arguments: CreateEventArguments, clock: DataClock) throws
    -> EventFields
  {
    let allDay = arguments.allDay ?? false
    let (start, end) = try range(
      start: clock.moment(arguments.start, field: "start"),
      end: clock.moment(arguments.end, field: "end"), allDay: allDay, clock: clock)
    return EventFields(
      title: try DataArguments.title(arguments.title),
      start: start,
      end: end,
      allDay: allDay,
      location: DataText.present(arguments.location),
      notes: DataText.present(arguments.notes),
      url: try DataArguments.url(arguments.url)
    )
  }

  public static func fields(of record: EventRecord, clock: DataClock) -> EventFields {
    EventFields(
      title: record.title,
      start: record.allDay ? clock.startOfDay(clock.day(of: record.start)) : record.start,
      end: record.allDay ? clock.startOfDay(lastDay(record, clock: clock)) : record.end,
      allDay: record.allDay,
      location: record.location,
      notes: record.notes,
      url: record.url
    )
  }

  public static func fields(
    updating record: EventRecord, with arguments: UpdateEventArguments, clock: DataClock
  ) throws -> EventFields {
    guard
      arguments.allDay != nil || arguments.start != nil || arguments.end != nil
        || arguments.title != nil || arguments.location != .keep || arguments.notes != .keep
        || arguments.url != .keep
    else {
      throw HelperError(.failed, "Name at least one thing to change.")
    }
    let current = fields(of: record, clock: clock)
    let allDay = arguments.allDay ?? current.allDay
    if allDay != current.allDay, arguments.start == nil || arguments.end == nil {
      throw HelperError(.failed, "Switching allDay needs both start and end.")
    }
    let start: Date
    let end: Date
    switch (arguments.start, arguments.end) {
    case (let newStart?, let newEnd?):
      (start, end) = try range(
        start: clock.moment(newStart, field: "start"), end: clock.moment(newEnd, field: "end"),
        allDay: allDay, clock: clock)
    case (let newStart?, nil):
      // A new start alone moves the event, keeping its length.
      let moment = try clock.moment(newStart, field: "start")
      if allDay {
        let length = clock.days(
          from: clock.day(of: current.start), to: clock.day(of: current.end))
        let first = try day(moment, field: "start")
        (start, end) = (
          clock.startOfDay(first), clock.startOfDay(clock.adding(days: length, to: first))
        )
      } else {
        start = try instant(moment, field: "start")
        end = start.addingTimeInterval(current.end.timeIntervalSince(current.start))
      }
    case (nil, let newEnd?):
      (start, end) = try range(
        start: allDay ? .day(clock.day(of: current.start)) : .instant(current.start),
        end: clock.moment(newEnd, field: "end"), allDay: allDay, clock: clock)
    case (nil, nil):
      (start, end) = (current.start, current.end)
    }
    return EventFields(
      title: try arguments.title.map(DataArguments.title) ?? current.title,
      start: start,
      end: end,
      allDay: allDay,
      location: DataText.present(arguments.location.applied(to: current.location)),
      notes: try DataArguments.notes(
        arguments.notes, current: record.notes, limit: notesLimit, noun: "event"),
      url: arguments.url == .keep
        ? current.url : try DataArguments.url(arguments.url.applied(to: nil))
    )
  }

  /// An all-day event takes days, its end being its last day; any other
  /// takes times, its end after its start.
  private static func range(
    start: DataClock.Moment, end: DataClock.Moment, allDay: Bool, clock: DataClock
  ) throws -> (Date, Date) {
    if allDay {
      let first = try day(start, field: "start")
      let last = try day(end, field: "end")
      guard last >= first else { throw HelperError(.failed, "end must not be before start.") }
      return (clock.startOfDay(first), clock.startOfDay(last))
    }
    let from = try instant(start, field: "start")
    let to = try instant(end, field: "end")
    guard to > from else { throw HelperError(.failed, "end must be after start.") }
    return (from, to)
  }

  private static func day(_ moment: DataClock.Moment, field: String) throws -> DataDay {
    guard case .day(let day) = moment else {
      throw HelperError(.failed, "An all-day event takes dates: \(field) must be YYYY-MM-DD.")
    }
    return day
  }

  private static func instant(_ moment: DataClock.Moment, field: String) throws -> Date {
    guard case .instant(let date) = moment else {
      throw HelperError(
        .failed, "\(field) must be a time (YYYY-MM-DDTHH:MM); set allDay for an all-day event.")
    }
    return date
  }
}
