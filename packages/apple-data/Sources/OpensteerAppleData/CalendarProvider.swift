@preconcurrency import EventKit
import Foundation

/// Calendar on this device, through EventKit under the grant this process holds.
/// Everything but the store itself — which events a listing reads, how they
/// read, what a change sets — is `CalendarEvents`, held to its rules without
/// a grant.
public actor CalendarProvider: DataProvider {
  private let clock: DataClock

  public init(clock: DataClock = .mac) {
    self.clock = clock
  }

  public func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    let store = EKEventStore()
    switch operation {
    case "list_calendars":
      return try JSONValue(
        encoding: CalendarsResult(
          calendars: EventKitStore.containers(
            store.calendars(for: .event), default: store.defaultCalendarForNewEvents)))
    case "list_events":
      let parsed = try DataArguments.decode(ListEventsArguments.self, from: arguments)
      let window = try CalendarEvents.window(parsed, clock: clock)
      let calendars = try EventKitStore.named(
        parsed.calendarIds, in: store, kind: .event, noun: "calendar", lister: "list_calendars")
      guard budget.remaining() > 0 else { throw EventKitStore.outOfTime("Calendar") }
      let events = store.events(
        matching: store.predicateForEvents(
          withStart: window.start, end: window.end, calendars: calendars))
      return try JSONValue(
        encoding: try CalendarEvents.page(events.compactMap(record), arguments: parsed, clock: clock)
      )
    case "create_event":
      let parsed = try DataArguments.decode(CreateEventArguments.self, from: arguments)
      let fields = try CalendarEvents.fields(creating: parsed, clock: clock)
      let calendar: EKCalendar
      if let id = parsed.calendarId {
        calendar = try EventKitStore.named(
          [id], in: store, kind: .event, noun: "calendar", lister: "list_calendars")![0]
      } else if let fallback = store.defaultCalendarForNewEvents {
        calendar = fallback
      } else {
        throw HelperError(.failed, "This \(clock.deviceName) has no default calendar; name one with calendarId.")
      }
      try EventKitStore.writable(calendar, noun: "calendar")
      let event = EKEvent(eventStore: store)
      event.calendar = calendar
      apply(fields, to: event, changing: nil)
      try budget.startWrite()
      try EventKitStore.saving("Calendar") {
        try store.save(event, span: .thisEvent, commit: true)
      }
      return try answer(event)
    case "update_event":
      let parsed = try DataArguments.decode(UpdateEventArguments.self, from: arguments)
      let (event, current) = try occurrence(parsed.id, in: store)
      let fields = try CalendarEvents.fields(updating: current, with: parsed, clock: clock)
      try EventKitStore.writable(event.calendar, noun: "calendar")
      apply(fields, to: event, changing: CalendarEvents.fields(of: current, clock: clock))
      try budget.startWrite()
      try EventKitStore.saving("Calendar") {
        try store.save(event, span: span(parsed.span), commit: true)
      }
      return try answer(event)
    case "delete_event":
      let parsed = try DataArguments.decode(DeleteEventArguments.self, from: arguments)
      let (event, _) = try occurrence(parsed.id, in: store)
      try EventKitStore.writable(event.calendar, noun: "calendar")
      try budget.startWrite()
      try EventKitStore.saving("Calendar") {
        try store.remove(event, span: span(parsed.span), commit: true)
      }
      return try JSONValue(encoding: DeletedResult())
    default:
      throw HelperError(.unsupported, "This operation is not supported.")
    }
  }

  private func span(_ span: EventSpan?) -> EKSpan {
    span == .future ? .futureEvents : .thisEvent
  }

  private func answer(_ event: EKEvent) throws -> JSONValue {
    guard let record = record(event) else {
      throw HelperError(.outcomeUnknown, "Calendar saved the event but did not say which it is.")
    }
    return try JSONValue(encoding: EventResult(event: CalendarEvents.view(record, clock: clock)))
  }

  /// The occurrence an id names, found where it starts. One moved or removed
  /// since it was listed is not found rather than guessed at.
  private func occurrence(_ id: String, in store: EKEventStore) throws -> (EKEvent, EventRecord) {
    let named = try EventId.parse(id)
    let around = store.predicateForEvents(
      withStart: named.start.addingTimeInterval(-1), end: named.start.addingTimeInterval(1),
      calendars: nil)
    for event in store.events(matching: around) {
      if let record = record(event), record.identifier == named.identifier,
        EventId(identifier: record.identifier, start: record.start) == named
      {
        return (event, record)
      }
    }
    throw HelperError(
      .failed, "That event was changed or removed since it was listed; list events again.")
  }

  /// Sets what differs from `before`, so a change leaves the rest as EventKit
  /// holds it.
  private func apply(_ fields: EventFields, to event: EKEvent, changing before: EventFields?) {
    if fields.title != before?.title { event.title = fields.title }
    if fields.allDay != before?.allDay {
      event.isAllDay = fields.allDay
      // An all-day event floats; a timed one keeps the device's zone, so it
      // stays at the same instant wherever it is read.
      event.timeZone = fields.allDay ? nil : clock.timeZone
    }
    if fields.start != before?.start || fields.allDay != before?.allDay {
      event.startDate = fields.start
    }
    if fields.end != before?.end || fields.allDay != before?.allDay { event.endDate = fields.end }
    if fields.location != before?.location { event.location = fields.location }
    if fields.notes != before?.notes { event.notes = fields.notes }
    if fields.url != before?.url { event.url = fields.url.flatMap(URL.init(string:)) }
  }

  private func record(_ event: EKEvent) -> EventRecord? {
    guard let identifier = event.eventIdentifier, let calendar = event.calendar else { return nil }
    return EventRecord(
      identifier: identifier,
      calendarId: calendar.calendarIdentifier,
      title: event.title ?? "",
      start: event.startDate,
      end: event.endDate,
      allDay: event.isAllDay,
      timeZone: event.isAllDay ? nil : event.timeZone?.identifier,
      location: DataText.present(event.location),
      notes: DataText.present(event.notes),
      url: event.url?.absoluteString,
      recurring: event.hasRecurrenceRules || event.isDetached,
      status: Self.status(event.status),
      attendees: (event.attendees ?? []).map(Self.attendee)
    )
  }

  private static func status(_ status: EKEventStatus) -> EventStatus {
    switch status {
    case .confirmed: return .confirmed
    case .tentative: return .tentative
    case .canceled: return .canceled
    default: return .none
    }
  }

  private static func attendee(_ participant: EKParticipant) -> AttendeeView {
    let address = participant.url.absoluteString
    let email =
      address.lowercased().hasPrefix("mailto:") ? String(address.dropFirst("mailto:".count)) : nil
    return AttendeeView(
      email: DataText.present(email),
      isMe: participant.isCurrentUser,
      name: DataText.present(participant.name),
      status: status(participant.participantStatus)
    )
  }

  private static func status(_ status: EKParticipantStatus) -> AttendeeStatus {
    switch status {
    case .accepted: return .accepted
    case .declined: return .declined
    case .tentative: return .tentative
    case .pending: return .pending
    case .delegated: return .delegated
    case .completed: return .completed
    case .inProcess: return .inProcess
    default: return .unknown
    }
  }
}
