@preconcurrency import EventKit
import Foundation

/// What Calendar and Reminders share of EventKit: one store per call, so a
/// grant allowed since the last call is seen and nothing stale is kept; the
/// containers an agent may name; and what a save that EventKit refused means.
enum EventKitStore {
  static func containers(
    _ calendars: [EKCalendar], default fallback: EKCalendar?
  ) -> [ContainerView] {
    calendars
      .map { calendar in
        ContainerView(
          account: DataText.present(calendar.source?.title),
          id: calendar.calendarIdentifier,
          isDefault: calendar.calendarIdentifier == fallback?.calendarIdentifier,
          title: calendar.title,
          writable: calendar.allowsContentModifications
        )
      }
      .sorted {
        (DataText.folded($0.account ?? ""), DataText.folded($0.title), $0.id)
          < (DataText.folded($1.account ?? ""), DataText.folded($1.title), $1.id)
      }
  }

  /// The containers `ids` names, each of the given kind; nil for every one.
  static func named(
    _ ids: [String]?, in store: EKEventStore, kind: EKEntityType, noun: String, lister: String
  ) throws -> [EKCalendar]? {
    guard let ids else { return nil }
    return try ids.map { id in
      guard let calendar = store.calendar(withIdentifier: id),
        calendar.allowedEntityTypes.contains(kind == .event ? .event : .reminder)
      else {
        throw HelperError(.failed, "No \(noun) has the id \(id); \(lister) names them.")
      }
      return calendar
    }
  }

  static func writable(_ calendar: EKCalendar, noun: String) throws {
    guard calendar.allowsContentModifications else {
      throw HelperError(.failed, "The \(noun) \"\(calendar.title)\" cannot be changed.")
    }
  }

  /// EventKit checks a change before it commits it and refuses it with its
  /// own error, so such a refusal changed nothing. Its internal failure, and
  /// anything else, may have happened after the commit began, which the data
  /// plane reports as unknown.
  static func saving(_ what: String, _ work: () throws -> Void) throws {
    do {
      try work()
    } catch let error as EKError where error.code != .internalFailure {
      throw HelperError(.failed, "\(what) refused that change: \(error.localizedDescription)")
    }
  }

  static func outOfTime(_ noun: String) -> HelperError {
    HelperError(.failed, "\(noun) took too long to read; try a narrower listing.")
  }
}
