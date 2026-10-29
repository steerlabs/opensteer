import Contacts
import EventKit
import Foundation
import SwiftUI

@main
struct FixtureApp: App {
  @State private var report = "Waiting for fixture action"
  var body: some Scene {
    WindowGroup {
      ScrollView { Text(report).font(.system(.body, design: .monospaced)).padding() }
        .task {
          do {
            let answer = try await FixtureRunner.run(CommandLine.arguments)
            report = String(decoding: try JSONSerialization.data(withJSONObject: answer,
              options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
            try FixtureRunner.save(answer)
          } catch {
            report = "Fixture failed: \(error)"
            try? FixtureRunner.save(["kind": "failed", "error": "\(error)"])
          }
        }
    }
  }
}

/// Independent public API observer. Its bundle ID, permissions and process are
/// separate from Opensteer; it cannot read the production app's sandbox.
enum FixtureRunner {
  static func save(_ value: [String: Any]) throws {
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
      .write(to: directory.appendingPathComponent("fixture-result.json"), options: .atomic)
  }

  static func run(_ arguments: [String]) async throws -> [String: Any] {
    guard let command = arguments.dropFirst().first,
      let marker = arguments.dropFirst(2).first, marker.hasPrefix("iphone-apps-fixture-") else {
      return ["kind": "idle"]
    }
    let events = EKEventStore()
    let contacts = CNContactStore()
    switch command {
    case "seed":
      let eventAccess: Bool
      let reminderAccess: Bool
      if #available(iOS 17, *) {
        eventAccess = try await events.requestFullAccessToEvents()
        reminderAccess = try await events.requestFullAccessToReminders()
      } else {
        eventAccess = try await events.requestAccess(to: .event)
        reminderAccess = try await events.requestAccess(to: .reminder)
      }
      let contactAccess = try await contacts.requestAccess(for: .contacts)
      guard eventAccess, reminderAccess, contactAccess else {
        return ["kind": "permission-required", "event": eventAccess,
          "reminder": reminderAccess, "contact": contactAccess]
      }
      let writableEvents = events.calendars(for: .event).filter { $0.allowsContentModifications }
      let writableReminders = events.calendars(for: .reminder).filter { $0.allowsContentModifications }
      guard let calendar = writableEvents.first, let list = writableReminders.first else {
        return ["kind": "missing-writable-source", "eventSources": writableEvents.count,
          "reminderSources": writableReminders.count]
      }
      let event = EKEvent(eventStore: events)
      event.calendar = calendar
      event.title = marker + " event"
      event.startDate = Date(timeIntervalSince1970: 1_893_456_000)
      event.endDate = event.startDate.addingTimeInterval(3_600)
      try events.save(event, span: .thisEvent, commit: true)
      let reminder = EKReminder(eventStore: events)
      reminder.calendar = list
      reminder.title = marker + " reminder"
      try events.save(reminder, commit: true)
      for suffix in ["chosen", "hidden"] {
        let contact = CNMutableContact()
        contact.givenName = marker
        contact.familyName = suffix
        let save = CNSaveRequest()
        save.add(contact, toContainerWithIdentifier: nil)
        try contacts.execute(save)
      }
      return ["kind": "seeded", "calendarId": calendar.calendarIdentifier,
        "reminderListId": list.calendarIdentifier, "eventId": event.eventIdentifier ?? "",
        "reminderId": reminder.calendarItemIdentifier,
        "contactCount": 2, "marker": marker]
    case "snapshot":
      // These reads work only when the fixture itself has OS access. A fixture
      // grant does not grant Opensteer access to the same stores.
      let eventCalendar = Calendar(identifier: .gregorian)
      let start = eventCalendar.date(from: DateComponents(year: 2029, month: 1, day: 1))!
      let end = eventCalendar.date(from: DateComponents(year: 2031, month: 1, day: 1))!
      let foundEvents = events.events(matching: events.predicateForEvents(
        withStart: start, end: end, calendars: nil)).filter { $0.title?.hasPrefix(marker) == true }
      let foundReminders = await withCheckedContinuation { (continuation: CheckedContinuation<[EKReminder], Never>) in
        events.fetchReminders(matching: events.predicateForReminders(in: nil)) { rows in
          continuation.resume(returning: (rows ?? []).filter { $0.title?.hasPrefix(marker) == true })
        }
      }
      let request = CNContactFetchRequest(keysToFetch: [CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor])
      var names: [String] = []
      try contacts.enumerateContacts(with: request) { contact, _ in
        if contact.givenName == marker { names.append(contact.familyName) }
      }
      return ["kind": "snapshot", "marker": marker,
        "events": foundEvents.map { ["id": $0.eventIdentifier ?? "", "title": $0.title ?? "",
          "start": ISO8601DateFormatter().string(from: $0.startDate)] },
        "reminders": foundReminders.map { ["id": $0.calendarItemIdentifier, "title": $0.title ?? "",
          "completed": $0.isCompleted] }, "contacts": names.sorted()]
    default: return ["kind": "unsupported-command", "command": command]
    }
  }
}
