@preconcurrency import EventKit
import Foundation

/// Reminders on this device, through EventKit under the grant this process holds.
/// Everything but the store itself is `Reminders`, held to its rules without
/// a grant.
public actor RemindersProvider: DataProvider {
  private let clock: DataClock

  public init(clock: DataClock = .mac) {
    self.clock = clock
  }

  public func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    let store = EKEventStore()
    switch operation {
    case "list_reminder_lists":
      return try JSONValue(
        encoding: ReminderListsResult(
          lists: EventKitStore.containers(
            store.calendars(for: .reminder), default: store.defaultCalendarForNewReminders())))
    case "list_reminders":
      let parsed = try DataArguments.decode(ListRemindersArguments.self, from: arguments)
      let lists = try EventKitStore.named(
        parsed.listIds, in: store, kind: .reminder, noun: "list", lister: "list_reminder_lists")
      guard budget.remaining() > 0 else { throw EventKitStore.outOfTime("Reminders") }
      let predicate =
        parsed.status == .completed
        ? store.predicateForCompletedReminders(
          withCompletionDateStarting: nil, ending: nil, calendars: lists)
        : store.predicateForIncompleteReminders(
          withDueDateStarting: nil, ending: nil, calendars: lists)
      let records = await fetch(predicate, in: store)
      return try JSONValue(encoding: try Reminders.page(records, arguments: parsed, clock: clock))
    case "create_reminder":
      let parsed = try DataArguments.decode(CreateReminderArguments.self, from: arguments)
      let fields = try Reminders.fields(creating: parsed, clock: clock)
      let list: EKCalendar
      if let id = parsed.listId {
        list = try EventKitStore.named(
          [id], in: store, kind: .reminder, noun: "list", lister: "list_reminder_lists")![0]
      } else if let fallback = store.defaultCalendarForNewReminders() {
        list = fallback
      } else {
        throw HelperError(.failed, "This \(clock.deviceName) has no default reminder list; name one with listId.")
      }
      try EventKitStore.writable(list, noun: "list")
      let reminder = EKReminder(eventStore: store)
      reminder.calendar = list
      apply(fields, to: reminder, changing: nil)
      try budget.startWrite()
      try EventKitStore.saving("Reminders") { try store.save(reminder, commit: true) }
      return try answer(reminder)
    case "update_reminder":
      let parsed = try DataArguments.decode(UpdateReminderArguments.self, from: arguments)
      let (reminder, current) = try find(parsed.id, in: store)
      let fields = try Reminders.fields(updating: current, with: parsed, clock: clock)
      try EventKitStore.writable(reminder.calendar, noun: "list")
      apply(fields, to: reminder, changing: current)
      try budget.startWrite()
      try EventKitStore.saving("Reminders") { try store.save(reminder, commit: true) }
      return try answer(reminder)
    case "delete_reminder":
      let parsed = try DataArguments.decode(DeleteReminderArguments.self, from: arguments)
      let (reminder, _) = try find(parsed.id, in: store)
      try EventKitStore.writable(reminder.calendar, noun: "list")
      try budget.startWrite()
      try EventKitStore.saving("Reminders") { try store.remove(reminder, commit: true) }
      return try JSONValue(encoding: DeletedResult())
    default:
      throw HelperError(.unsupported, "This operation is not supported.")
    }
  }

  private func fetch(_ predicate: NSPredicate, in store: EKEventStore) async -> [ReminderRecord] {
    let clock = clock
    return await withCheckedContinuation { continuation in
      store.fetchReminders(matching: predicate) { reminders in
        continuation.resume(
          returning: (reminders ?? []).compactMap { Self.record($0, clock: clock) })
      }
    }
  }

  private func find(_ id: String, in store: EKEventStore) throws -> (EKReminder, ReminderRecord) {
    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder,
      let record = Self.record(reminder, clock: clock)
    else {
      throw HelperError(
        .failed, "That reminder was removed, or is not on this \(clock.deviceName); list reminders again.")
    }
    return (reminder, record)
  }

  private func answer(_ reminder: EKReminder) throws -> JSONValue {
    guard let record = Self.record(reminder, clock: clock) else {
      throw HelperError(.outcomeUnknown, "Reminders saved the reminder but did not say which it is.")
    }
    return try JSONValue(encoding: ReminderResult(reminder: Reminders.view(record, clock: clock)))
  }

  /// Sets what differs from `before`, so a change leaves the rest as EventKit
  /// holds it. Naming the due replaces the alerts: a due time alerts then.
  private func apply(_ fields: ReminderFields, to reminder: EKReminder, changing before: ReminderRecord?) {
    if fields.title != before?.title { reminder.title = fields.title }
    if fields.notes != before?.notes { reminder.notes = fields.notes }
    if fields.priority != before?.priority { reminder.priority = fields.priority }
    if fields.url != before?.url { reminder.url = fields.url.flatMap(URL.init(string:)) }
    if fields.completed != before?.completed { reminder.isCompleted = fields.completed }
    if fields.dueChanged {
      reminder.dueDateComponents = fields.due.map(components)
      for alarm in reminder.alarms ?? [] { reminder.removeAlarm(alarm) }
      if case .instant(let date)? = fields.due { reminder.addAlarm(EKAlarm(absoluteDate: date)) }
    }
  }

  /// A due day carries no time and no zone; a due time carries the device's zone.
  private func components(_ due: DataClock.Moment) -> DateComponents {
    switch due {
    case .day(let day):
      return DateComponents(calendar: clock.calendar, year: day.year, month: day.month, day: day.day)
    case .instant(let date):
      var components = clock.calendar.dateComponents(
        [.year, .month, .day, .hour, .minute, .second], from: date)
      components.calendar = clock.calendar
      components.timeZone = clock.timeZone
      return components
    }
  }

  private static func record(_ reminder: EKReminder, clock: DataClock) -> ReminderRecord? {
    guard let calendar = reminder.calendar else { return nil }
    return ReminderRecord(
      id: reminder.calendarItemIdentifier,
      listId: calendar.calendarIdentifier,
      title: reminder.title ?? "",
      notes: DataText.present(reminder.notes),
      due: reminder.dueDateComponents.flatMap { due($0, clock: clock) },
      priority: reminder.priority,
      completed: reminder.isCompleted,
      completedAt: reminder.completionDate,
      url: reminder.url?.absoluteString,
      recurring: reminder.hasRecurrenceRules
    )
  }

  /// A due with an hour is a time, read in the zone it was set in, or the
  /// device's for one set without; one without is a day.
  private static func due(_ components: DateComponents, clock: DataClock) -> DataClock.Moment? {
    guard let year = components.year, let month = components.month, let day = components.day
    else { return nil }
    guard let hour = components.hour else {
      return .day(DataDay(year: year, month: month, day: day))
    }
    var calendar = clock.calendar
    calendar.timeZone = components.timeZone ?? clock.timeZone
    let date = calendar.date(
      from: DateComponents(
        year: year, month: month, day: day, hour: hour, minute: components.minute ?? 0,
        second: components.second ?? 0))
    return date.map { .instant($0) }
  }
}
