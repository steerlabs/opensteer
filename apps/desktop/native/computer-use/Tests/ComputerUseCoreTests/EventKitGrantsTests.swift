import EventKit
import XCTest

@testable import ComputerUseCore

/// Real Mac (the owner's trial guest): the person clicked Allow in macOS's Reminders question
/// and the row stayed "Setup unfinished" until the helper was a new process, about an hour and
/// a half later: EventKit kept reporting this process the status it read before the answer.
final class EventKitGrantsTests: XCTestCase {
  /// EventKit's status for this process, read once and never refreshed.
  private func stale(_ answer: Bool) -> EventKitGrants {
    EventKitGrants(status: { _ in .notDetermined }, requestEvents: { answer }, requestReminders: { answer })
  }

  func testAGrantThePersonAllowedIsReadyInTheSameProcess() async {
    for grant in [DataGrant.reminders, .calendars] {
      let grants = stale(true)
      XCTAssertEqual(grants.state(grant), .requestable, "\(grant)")
      await grants.request(grant)
      XCTAssertEqual(grants.state(grant), .granted, "\(grant)")
    }
  }

  func testAGrantThePersonDidNotAllowStaysAsMacOSReportsIt() async {
    let grants = stale(false)
    await grants.request(.reminders)
    XCTAssertEqual(grants.state(.reminders), .requestable)
    // An answer for one grant is not an answer for the other.
    let reminders = stale(true)
    await reminders.request(.reminders)
    XCTAssertEqual(reminders.state(.calendars), .requestable)
    // What macOS reports as refused stays refused, whatever was answered before.
    let refused = EventKitGrants(status: { _ in .denied }, requestEvents: { true }, requestReminders: { true })
    await refused.request(.reminders)
    XCTAssertEqual(refused.state(.reminders), .denied)
  }
}
