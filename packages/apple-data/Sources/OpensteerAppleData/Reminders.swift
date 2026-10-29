import Foundation

/// A reminder's priority in words. EventKit keeps a number, as Reminders
/// itself sets it: 0 for none, 1 to 4 for high, 5 for medium, 6 to 9 for low.
public enum ReminderPriority: String, Codable, Sendable {
  case none, low, medium, high

  public init(eventKit value: Int) {
    switch value {
    case 1...4: self = .high
    case 5: self = .medium
    case 6...9: self = .low
    default: self = .none
    }
  }

  public var eventKit: Int {
    switch self {
    case .none: return 0
    case .high: return 1
    case .medium: return 5
    case .low: return 9
    }
  }
}

/// One reminder as Reminders' rules read it, apart from EventKit.
public struct ReminderRecord: Sendable, Equatable {
  public let id: String
  public let listId: String
  public let title: String
  public let notes: String?
  public let due: DataClock.Moment?
  public let priority: Int
  public let completed: Bool
  public let completedAt: Date?
  public let url: String?
  public let recurring: Bool
}

/// One reminder in the catalog's output shape.
public struct ReminderView: Encodable, Sendable, Equatable {
  public let completed: Bool
  @Nullable public var completedAt: String?
  @Nullable public var due: String?
  public let id: String
  public let listId: String
  @Nullable public var notes: String?
  public let notesTruncated: Bool
  public let priority: ReminderPriority
  public let recurring: Bool
  public let title: String
  @Nullable public var url: String?
}

public struct RemindersPage: Encodable, Sendable, Equatable {
  public let reminders: [ReminderView]
  @Nullable public var nextCursor: String?
}

/// What `list_reminder_lists` answers.
public struct ReminderListsResult: Encodable, Sendable {
  public let lists: [ContainerView]
}

/// What `create_reminder` and `update_reminder` answer: the reminder as it is now.
public struct ReminderResult: Encodable, Sendable {
  public let reminder: ReminderView
}

public enum ReminderStatus: String, Decodable, Sendable {
  case incomplete, completed
}

public struct ListRemindersArguments: Decodable, Sendable {
  public let cursor: String?
  public let limit: Int?
  public let listIds: [String]?
  public let query: String?
  public let status: ReminderStatus?
}

public struct CreateReminderArguments: Decodable, Sendable {
  public let due: String?
  public let listId: String?
  public let notes: String?
  public let priority: ReminderPriority?
  public let title: String
  public let url: String?
}

public struct UpdateReminderArguments: Decodable, Sendable {
  public let completed: Bool?
  public let due: Patch<String>
  public let id: String
  public let notes: Patch<String>
  public let priority: ReminderPriority?
  public let title: String?
  public let url: Patch<String>
}

public struct DeleteReminderArguments: Decodable, Sendable {
  public let id: String
}

/// What a reminder is made of, as creating or changing one sets it: what a
/// change does not name is carried as EventKit holds it. `dueChanged` says the
/// change named the due, which replaces the reminder's alerts.
public struct ReminderFields: Equatable, Sendable {
  public let title: String
  public let notes: String?
  public let due: DataClock.Moment?
  public let dueChanged: Bool
  /// EventKit's own value, 0 to 9.
  public let priority: Int
  public let completed: Bool
  public let url: String?
}

/// Reminders' rules, apart from EventKit: how reminders sort, page and read,
/// and what a change sets.
public enum Reminders {
  public static let defaultLimit = 50
  public static let maxLimit = 200

  public static func page(
    _ records: [ReminderRecord], arguments: ListRemindersArguments, clock: DataClock
  ) throws -> RemindersPage {
    let status = arguments.status ?? .incomplete
    let matching =
      records
      .filter { $0.completed == (status == .completed) }
      .filter { DataText.matches(arguments.query, in: [$0.title, $0.notes]) }
      .sorted(by: status == .completed ? completedFirst : { dueFirst($0, $1, clock: clock) })
    let page = try Paging.page(
      matching.map { view($0, clock: clock) }, cursor: arguments.cursor, limit: arguments.limit,
      defaultLimit: defaultLimit, maxLimit: maxLimit,
      listing: [
        status.rawValue, arguments.query,
        arguments.listIds.map { $0.sorted().joined(separator: "\n") },
      ])
    return RemindersPage(reminders: page.items, nextCursor: page.nextCursor)
  }

  /// Soonest due first, a due day counting from its start on this Mac; then
  /// the undated, by title.
  private static func dueFirst(_ a: ReminderRecord, _ b: ReminderRecord, clock: DataClock) -> Bool
  {
    switch (dueInstant(a, clock: clock), dueInstant(b, clock: clock)) {
    case (let x?, let y?) where x != y: return x < y
    case (.some, nil): return true
    case (nil, .some): return false
    default: return (DataText.folded(a.title), a.id) < (DataText.folded(b.title), b.id)
    }
  }

  private static func completedFirst(_ a: ReminderRecord, _ b: ReminderRecord) -> Bool {
    let (x, y) = (a.completedAt ?? .distantPast, b.completedAt ?? .distantPast)
    return x != y ? x > y : a.id < b.id
  }

  private static func dueInstant(_ record: ReminderRecord, clock: DataClock) -> Date? {
    switch record.due {
    case .day(let day)?: return clock.startOfDay(day)
    case .instant(let date)?: return date
    case nil: return nil
    }
  }

  public static func view(_ record: ReminderRecord, clock: DataClock) -> ReminderView {
    let notes = DataText.notes(record.notes, limit: CalendarEvents.notesLimit)
    return ReminderView(
      completed: record.completed,
      completedAt: record.completedAt.map { clock.text($0) },
      due: record.due.map { clock.text($0) },
      id: record.id,
      listId: record.listId,
      notes: notes.text,
      notesTruncated: notes.truncated,
      priority: ReminderPriority(eventKit: record.priority),
      recurring: record.recurring,
      title: record.title,
      url: record.url
    )
  }

  public static func fields(creating arguments: CreateReminderArguments, clock: DataClock) throws
    -> ReminderFields
  {
    ReminderFields(
      title: try DataArguments.title(arguments.title),
      notes: DataText.present(arguments.notes),
      due: try arguments.due.map { try clock.moment($0, field: "due") },
      dueChanged: arguments.due != nil,
      priority: (arguments.priority ?? .none).eventKit,
      completed: false,
      url: try DataArguments.url(arguments.url)
    )
  }

  public static func fields(
    updating record: ReminderRecord, with arguments: UpdateReminderArguments, clock: DataClock
  ) throws -> ReminderFields {
    guard
      arguments.completed != nil || arguments.due != .keep || arguments.notes != .keep
        || arguments.priority != nil || arguments.title != nil || arguments.url != .keep
    else {
      throw HelperError(.failed, "Name at least one thing to change.")
    }
    let due: DataClock.Moment?
    switch arguments.due {
    case .keep: due = record.due
    case .clear: due = nil
    case .set(let text): due = try clock.moment(text, field: "due")
    }
    return ReminderFields(
      title: try arguments.title.map(DataArguments.title) ?? record.title,
      notes: try DataArguments.notes(
        arguments.notes, current: record.notes, limit: CalendarEvents.notesLimit,
        noun: "reminder"),
      due: due,
      dueChanged: arguments.due != .keep,
      priority: arguments.priority?.eventKit ?? record.priority,
      completed: arguments.completed ?? record.completed,
      url: arguments.url == .keep
        ? record.url : try DataArguments.url(arguments.url.applied(to: nil))
    )
  }
}
