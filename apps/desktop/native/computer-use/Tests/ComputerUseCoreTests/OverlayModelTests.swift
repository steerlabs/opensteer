import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

/// §2 "What the person sees": every state the pill, the pointers, the steady
/// outline can be in, and how they move from one to the next.
final class OverlayModelTests: XCTestCase {
  private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
  private let notes = OverlayModel.App(
    key: "com.apple.notes", name: "Notes", access: .readWrite,
    path: "/System/Applications/Notes.app")
  private let calendar = OverlayModel.App(
    key: "com.apple.ical", name: "Calendar", access: .readWrite,
    path: "/System/Applications/Calendar.app")
  private let mail = OverlayModel.App(
    key: "com.apple.mail", name: "Mail", access: .read, path: "/System/Applications/Mail.app")

  private func at(_ seconds: TimeInterval) -> Date { start + seconds }

  private func read(_ app: OverlayModel.App) -> OverlayModel.App {
    OverlayModel.App(key: app.key, name: app.name, access: .read, path: app.path)
  }

  private func session(
    _ id: String, _ title: String?, _ apps: [OverlayModel.App]
  ) -> OverlayModel.Session {
    OverlayModel.Session(id: id, threadTitle: title, apps: apps)
  }

  private func pill(_ model: OverlayModel, _ seconds: TimeInterval) -> OverlayModel.Pill? {
    model.presentation(at: at(seconds)).pill
  }

  private func icon(_ app: OverlayModel.App) -> OverlayModel.Pill.Icon {
    OverlayModel.Pill.Icon(key: app.key, path: app.path)
  }

  // MARK: - Live sessions

  func testNothingShowsWithoutASession() {
    let model = OverlayModel()
    XCTAssertEqual(
      model.presentation(at: start),
      OverlayModel.Presentation(pill: nil, cursors: [:], outlined: [], sweeping: []))
    XCTAssertNil(model.nextChange(after: start))
  }

  func testAnOpenSessionWithNothingInFlightIsWaitingForTheAgent() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan the trip", [])], ending: .ended, at: at(0))
    XCTAssertEqual(
      pill(model, 0),
      OverlayModel.Pill(
        status: "opensteer is waiting for the agent", compactStatus: "Waiting for agent",
        detail: "Plan the trip",
        controls: .session, icons: [], badge: .pointer, activity: .thinking, expanded: true))
  }

  func testWorkOnAReadWriteAppIsUsingAndHoldsForAMomentAfter() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan the trip", [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is using Notes")
    XCTAssertEqual(pill(model, 1)?.compactStatus, "Using Notes")
    model.workEnded(app: notes.key, at: at(2))
    XCTAssertEqual(pill(model, 2.29)?.status, "opensteer is using Notes")
    XCTAssertEqual(model.nextChange(after: at(2)), at(2) + OverlayModel.holdAfterWork)
    XCTAssertEqual(pill(model, 2.31)?.status, "opensteer is waiting to use Notes")
    XCTAssertEqual(pill(model, 2.31)?.compactStatus, "Waiting · Notes")
    XCTAssertNil(model.nextChange(after: at(2.31)))
  }

  func testAReadConnectionIsViewing() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [read(notes)])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is viewing Notes")
    XCTAssertEqual(pill(model, 1)?.compactStatus, "Viewing Notes")
    XCTAssertNil(pill(model, 1)?.detail)
  }

  func testRaisingAccessTurnsViewingIntoUsing() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [read(notes)])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is using Notes")
  }

  func testTypingShowsOnlyWhileTheTypeActionRuns() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.typingStarted(app: notes.key)
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is typing in Notes")
    XCTAssertEqual(pill(model, 1)?.compactStatus, "Typing in Notes")
    model.typingEnded(app: notes.key)
    XCTAssertEqual(pill(model, 1.5)?.status, "opensteer is using Notes")
  }

  func testSeveralAppsInUseAreNamedTogetherWithTheirThreads() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", "Plan the trip", [notes]), session("b", "Book rooms", [calendar])],
      ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.workEnded(app: notes.key, at: at(1.5))
    model.workStarted(app: calendar.key, at: at(1.6))
    let both = pill(model, 1.6)
    // The most recently started app leads the status.
    XCTAssertEqual(both?.status, "opensteer is using Calendar and Notes")
    XCTAssertEqual(both?.compactStatus, "Using Calendar +1")
    XCTAssertEqual(both?.detail, "Book rooms · Plan the trip")
    // Once Notes has been quiet for the hold, only Calendar and its Thread.
    XCTAssertEqual(pill(model, 1.85)?.status, "opensteer is using Calendar")
    XCTAssertEqual(pill(model, 1.85)?.detail, "Book rooms")
  }

  func testThreeAppsAndViewingOnlyWhenEveryAppIsRead() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", "Plan the trip", [notes, calendar, mail])], ending: .ended, at: at(0))
    model.workStarted(app: mail.key, at: at(1))
    model.workStarted(app: calendar.key, at: at(2))
    model.workStarted(app: notes.key, at: at(3))
    XCTAssertEqual(pill(model, 3)?.status, "opensteer is using Notes, Calendar and Mail")
    XCTAssertEqual(pill(model, 3)?.detail, "Plan the trip")

    var viewing = OverlayModel()
    viewing.update(
      sessions: [session("a", nil, [read(notes)]), session("b", nil, [mail])], ending: .ended,
      at: at(0))
    viewing.workStarted(app: notes.key, at: at(1))
    viewing.workStarted(app: mail.key, at: at(1))
    XCTAssertEqual(pill(viewing, 1)?.status, "opensteer is viewing Notes and Mail")
  }

  func testWaitingNamesEveryOpenThreadOnceAndSkipsMissingTitles() {
    var model = OverlayModel()
    model.update(
      sessions: [
        session("a", "Plan the trip", []), session("b", nil, []), session("c", "  ", []),
        session("d", "Plan the trip", []), session("e", "Book rooms", []),
      ],
      ending: .ended, at: at(0))
    XCTAssertEqual(pill(model, 0)?.detail, "Plan the trip · Book rooms")
  }

  func testCompactWaitingNamesTheMostRecentlyUsedHeldApp() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [calendar])],
      ending: .ended, at: at(0))
    XCTAssertEqual(pill(model, 0)?.compactStatus, "Waiting · Notes +1")
    model.workStarted(app: calendar.key, at: at(1))
    model.workEnded(app: calendar.key, at: at(1.1))
    XCTAssertEqual(pill(model, 2)?.compactStatus, "Waiting · Calendar +1")
  }

  func testCompactWaitingKeepsTheTargetAppName() {
    let slack = OverlayModel.App(
      key: "com.tinyspeck.slackmacgap", name: "Slack", access: .readWrite,
      path: "/Applications/Slack.app")
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [slack])], ending: .ended, at: at(0))
    XCTAssertEqual(model.presentation(at: at(0)).pill?.compactStatus, "Waiting · Slack")
  }

  func testAnAppNoSessionHoldsIsNeverNamed() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is waiting for the agent")
  }

  // MARK: - The app and its badge

  func testTheAppMostRecentlyWorkedInLeadsTheIconsAndCarriesTheBadge() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [calendar])],
      ending: .ended, at: at(0))
    XCTAssertEqual(pill(model, 0)?.icons, [icon(notes), icon(calendar)])
    XCTAssertEqual(pill(model, 0)?.activity, .thinking)
    model.workStarted(app: calendar.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.icons, [icon(calendar), icon(notes)])
    XCTAssertEqual(pill(model, 1)?.badge, .pointer)
    XCTAssertEqual(pill(model, 1)?.activity, .working)
    model.workEnded(app: calendar.key, at: at(1.1))
    // Between calls the app last worked in stays in front, its pointer resting.
    XCTAssertEqual(pill(model, 2)?.icons, [icon(calendar), icon(notes)])
    XCTAssertEqual(pill(model, 2)?.activity, .thinking)
    XCTAssertEqual(pill(model, 2)?.compactStatus, "Waiting · Calendar +1")
  }

  func testAnAppTheAgentCanOnlySeeCarriesTheEyeNotThePointer() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [read(notes), calendar])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.icons.first, icon(notes))
    XCTAssertEqual(pill(model, 1)?.badge, .eye)
    model.workStarted(app: calendar.key, at: at(2))
    XCTAssertEqual(pill(model, 2)?.icons.first, icon(calendar))
    XCTAssertEqual(pill(model, 2)?.badge, .pointer)
  }

  func testAtMostTwoAppsAreDrawn() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [notes, calendar, mail])], ending: .ended, at: at(0))
    model.workStarted(app: mail.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.icons, [icon(mail), icon(notes)])
  }

  func testBeforeAnyAppIsHeldTheMarkCarriesThePointer() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.icons, [])
    XCTAssertEqual(pill(model, 1)?.badge, .pointer)
    XCTAssertEqual(pill(model, 1)?.activity, .thinking)
  }

  func testANoticeShowsTheAppsLastWorkedInFirst() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes, calendar])], ending: .ended, at: at(0))
    model.workStarted(app: calendar.key, at: at(1))
    model.workEnded(app: calendar.key, at: at(1.1))
    model.update(sessions: [], ending: .ended, at: at(2))
    XCTAssertEqual(pill(model, 2)?.icons, [icon(calendar), icon(notes)])
    XCTAssertNil(pill(model, 2)?.badge)
  }

  // MARK: - Minimized, and revealed for a moment

  func testThePillStartsExpanded() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    XCTAssertEqual(pill(model, 0)?.expanded, true)
    XCTAssertNil(model.nextChange(after: at(0)))
  }

  func testMinimizingLastsThroughNoticesAndLaterSessions() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(1))
    XCTAssertEqual(pill(model, 1)?.expanded, false)
    XCTAssertNil(model.nextChange(after: at(1)))
    // A notice always shows its words, and toggling it changes nothing.
    model.update(sessions: [], ending: .stopped, at: at(2))
    XCTAssertEqual(pill(model, 2)?.expanded, true)
    model.toggleExpanded(at: at(2.5))
    XCTAssertEqual(pill(model, 2.5)?.expanded, true)
    XCTAssertNil(pill(model, 4))
    // The next task is revealed for a moment, then minimized as the person left it.
    model.update(sessions: [session("b", nil, [])], ending: .ended, at: at(10))
    XCTAssertEqual(pill(model, 10)?.expanded, true)
    XCTAssertEqual(model.nextChange(after: at(10)), at(10) + OverlayModel.revealDuration)
    XCTAssertEqual(pill(model, 10 + OverlayModel.revealDuration)?.expanded, false)
  }

  func testANewTaskOrAppRevealsAMinimizedPillForAMoment() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan", [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    // The first observe claims the app: a new app is worth a look.
    model.update(sessions: [session("a", "Plan", [notes])], ending: .ended, at: at(5))
    XCTAssertEqual(pill(model, 5)?.expanded, true)
    XCTAssertEqual(pill(model, 7.99)?.expanded, true)
    XCTAssertEqual(pill(model, 8)?.expanded, false)
    // So is another task.
    model.update(
      sessions: [session("a", "Plan", [notes]), session("b", "Book", [])], ending: .ended,
      at: at(20))
    XCTAssertEqual(pill(model, 20)?.expanded, true)
    // And an app passing to another task.
    model.update(
      sessions: [session("a", "Plan", []), session("b", "Book", [notes])], ending: .ended,
      at: at(30))
    XCTAssertEqual(pill(model, 30)?.expanded, true)
    XCTAssertEqual(pill(model, 33)?.expanded, false)
  }

  func testWorkTypingTitlesAndRepeatsNeverReveal() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan", [notes])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.typingStarted(app: notes.key)
    model.update(sessions: [session("a", "Plan", [notes])], ending: .ended, at: at(1))
    model.update(sessions: [session("a", "Renamed", [notes])], ending: .ended, at: at(1))
    model.update(sessions: [session("a", "Renamed", [read(notes)])], ending: .ended, at: at(1))
    model.typingEnded(app: notes.key)
    model.workEnded(app: notes.key, at: at(2))
    XCTAssertEqual(pill(model, 1)?.expanded, false)
    XCTAssertEqual(pill(model, 2)?.expanded, false)
    XCTAssertEqual(model.nextChange(after: at(2)), at(2) + OverlayModel.holdAfterWork)
  }

  func testARevealWaitsForThePointerToLeave() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    model.pointerOverPill(true, at: at(2))
    XCTAssertEqual(pill(model, 60)?.expanded, true)
    XCTAssertNil(model.nextChange(after: at(2)), "Nothing to time while the pointer holds it.")
    model.pointerOverPill(false, at: at(60))
    XCTAssertEqual(pill(model, 60)?.expanded, true)
    XCTAssertEqual(model.nextChange(after: at(60)), at(60) + OverlayModel.revealAfterPointer)
    XCTAssertEqual(pill(model, 60 + OverlayModel.revealAfterPointer)?.expanded, false)
  }

  func testAPassingPointerNeverShortensAReveal() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    model.pointerOverPill(true, at: at(1.2))
    model.pointerOverPill(false, at: at(1.4))
    XCTAssertEqual(pill(model, 3.99)?.expanded, true)
    XCTAssertEqual(pill(model, 4)?.expanded, false)
  }

  func testNoRevealStartsUnderThePointer() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.pointerOverPill(true, at: at(1))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(2))
    XCTAssertEqual(pill(model, 2)?.expanded, false)
    model.pointerOverPill(false, at: at(3))
    XCTAssertEqual(pill(model, 3)?.expanded, false)
    XCTAssertNil(model.nextChange(after: at(3)))
  }

  /// Just outside the minimized pill is still where the expanded one would
  /// land.
  func testNoRevealStartsWhereTheExpandedPillWouldCoverThePointer() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(
      sessions: [session("a", nil, [notes])], ending: .ended, at: at(1), pointerNear: true)
    XCTAssertEqual(pill(model, 1)?.expanded, false)
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [])], ending: .ended, at: at(2))
    XCTAssertEqual(pill(model, 2)?.expanded, true)
  }

  func testTheAppBeingTypedInLeadsTheIconsAndTheWords() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes, calendar])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.typingStarted(app: notes.key)
    model.workStarted(app: calendar.key, at: at(2))
    XCTAssertEqual(pill(model, 2)?.icons.first, icon(notes))
    XCTAssertEqual(pill(model, 2)?.compactStatus, "Typing in Notes")
    XCTAssertEqual(pill(model, 2)?.status, "opensteer is typing in Notes")
  }

  func testAFinishedRevealStaysFinishedWhenThePointerComesAndGoes() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    model.pointerOverPill(true, at: at(10))
    XCTAssertEqual(pill(model, 10)?.expanded, false)
    model.pointerOverPill(false, at: at(11))
    XCTAssertEqual(pill(model, 11)?.expanded, false)
    XCTAssertNil(model.nextChange(after: at(11)))
  }

  func testTogglingFlipsWhatIsShownAndAnExpandedPillNeverCollapsesByItself() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    XCTAssertEqual(pill(model, 1.5)?.expanded, true)
    // Revealed, so a toggle minimizes it at once and ends the reveal.
    model.toggleExpanded(at: at(1.5))
    XCTAssertEqual(pill(model, 1.5)?.expanded, false)
    XCTAssertNil(model.nextChange(after: at(1.5)))
    model.toggleExpanded(at: at(2))
    XCTAssertEqual(pill(model, 2)?.expanded, true)
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [calendar])], ending: .ended,
      at: at(3))
    XCTAssertEqual(pill(model, 100)?.expanded, true)
    XCTAssertNil(model.nextChange(after: at(3)))
  }

  func testTheLastSessionEndingEndsItsReveal() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.toggleExpanded(at: at(0))
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(1))
    model.update(sessions: [], ending: .ended, at: at(1.5))
    XCTAssertEqual(model.nextChange(after: at(1.5)), at(1.5) + OverlayModel.noticeDuration)
    XCTAssertNil(pill(model, 1.5 + OverlayModel.noticeDuration))
    XCTAssertNil(model.nextChange(after: at(1.5 + OverlayModel.noticeDuration)))
  }

  // MARK: - Endings

  func testStopWithNothingInFlightIsStoppedForTwoSeconds() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", "Plan the trip", [notes]), session("b", "Book rooms", [calendar])],
      ending: .ended, at: at(0))
    // Stop ends every session at once and names every Thread it stopped.
    model.update(sessions: [], ending: .stopped, at: at(5))
    XCTAssertEqual(
      model.presentation(at: at(5)),
      OverlayModel.Presentation(
        pill: OverlayModel.Pill(
          status: "Computer use stopped", compactStatus: "Computer use stopped",
          detail: "Plan the trip · Book rooms",
          controls: .none, icons: [icon(notes), icon(calendar)], badge: nil,
          activity: .thinking, expanded: true),
        cursors: [:], outlined: [], sweeping: []))
    XCTAssertEqual(model.nextChange(after: at(5)), at(7))
    XCTAssertNotNil(pill(model, 6.99))
    XCTAssertNil(pill(model, 7))
  }

  func testStopWaitsForWorkUnderWayThenShowsStopped() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan the trip", [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.typingStarted(app: notes.key)
    model.update(sessions: [], ending: .stopped, at: at(2))
    XCTAssertEqual(
      pill(model, 2),
      OverlayModel.Pill(
        status: "Stopping…", compactStatus: "Stopping…", detail: "Plan the trip",
        controls: .none, icons: [icon(notes)], badge: nil, activity: .thinking,
        expanded: true))
    XCTAssertEqual(pill(model, 60)?.status, "Stopping…")
    XCTAssertNil(model.nextChange(after: at(2)))
    model.typingEnded(app: notes.key)
    model.workEnded(app: notes.key, at: at(3))
    XCTAssertEqual(pill(model, 3)?.status, "Computer use stopped")
    XCTAssertEqual(pill(model, 3)?.detail, "Plan the trip")
    XCTAssertNil(pill(model, 5))
  }

  func testTheLastSessionClosingIsEndedForTwoSeconds() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", "Plan the trip", [notes]), session("b", "Book rooms", [calendar])],
      ending: .ended, at: at(0))
    // One of two sessions ending leaves the other live, with no notice.
    model.update(sessions: [session("b", "Book rooms", [calendar])], ending: .ended, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is waiting to use Calendar")
    XCTAssertEqual(pill(model, 1)?.detail, "Book rooms")
    model.update(sessions: [], ending: .ended, at: at(2))
    XCTAssertEqual(
      pill(model, 2),
      OverlayModel.Pill(
        status: "Computer use ended", compactStatus: "Computer use ended", detail: "Book rooms",
        controls: .none, icons: [icon(calendar)], badge: nil, activity: .thinking,
        expanded: true))
    XCTAssertEqual(model.nextChange(after: at(2)), at(4))
    XCTAssertNil(pill(model, 4))
  }

  func testConnectionLostStaysUntilDismissed() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Plan the trip", [notes])], ending: .ended, at: at(0))
    model.update(sessions: [], ending: .connectionLost, at: at(1))
    let lost = OverlayModel.Pill(
      status: "Connection lost · last action unconfirmed",
      compactStatus: "Connection lost · last action unconfirmed", detail: "Plan the trip",
      controls: .dismiss, icons: [icon(notes)], badge: nil, activity: .thinking,
      expanded: true)
    XCTAssertEqual(pill(model, 1), lost)
    XCTAssertEqual(pill(model, 3_600), lost)
    XCTAssertNil(model.nextChange(after: at(1)))
    model.dismiss()
    XCTAssertNil(pill(model, 3_600))
  }

  func testDismissOnlyClearsConnectionLost() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    model.update(sessions: [], ending: .ended, at: at(1))
    model.dismiss()
    XCTAssertEqual(pill(model, 1)?.status, "Computer use ended")
  }

  func testANewSessionReplacesAnyEndingNotice() {
    for ending in [OverlayModel.Ending.stopped, .ended, .connectionLost] {
      var model = OverlayModel()
      model.update(sessions: [session("a", "Old", [notes])], ending: .ended, at: at(0))
      model.update(sessions: [], ending: ending, at: at(1))
      model.update(sessions: [session("b", "New", [])], ending: .ended, at: at(1.5))
      XCTAssertEqual(pill(model, 1.5)?.status, "opensteer is waiting for the agent", "\(ending)")
      XCTAssertEqual(pill(model, 1.5)?.detail, "New")
      model.update(sessions: [], ending: .ended, at: at(10))
      XCTAssertEqual(pill(model, 10)?.status, "Computer use ended")
      XCTAssertEqual(pill(model, 10)?.detail, "New")
    }
  }

  /// What the runtime hands the overlay: sessions in the order they opened,
  /// and only the apps each one has claimed.
  @MainActor
  func testTheRuntimeReportsOnlyHeldAppsInOpeningOrder() {
    func app(_ bundleId: String, _ name: String) -> AppSessionState {
      AppSessionState(
        identity: AppIdentity(bundleId: bundleId, displayName: name, teamId: nil),
        path: "/Applications/\(name).app")
    }
    let later = HelperSession(sessionId: "a-later", connectionID: 1, threadTitle: "Book rooms")
    later.openedAt = start + 10
    later.add(app("com.apple.iCal", "Calendar"), access: .read)
    let earlier = HelperSession(
      sessionId: "z-earlier", connectionID: 1, threadTitle: "Plan the trip")
    earlier.openedAt = start
    earlier.add(app("com.apple.Notes", "Notes"), access: .readWrite)
    earlier.add(app("com.apple.mail", "Mail"), access: .readWrite)

    let reported = OverlayController.sessions(
      [later, earlier], owners: ["com.apple.notes": "z-earlier", "com.apple.ical": "a-later"])
    XCTAssertEqual(
      reported,
      [
        session(
          "z-earlier", "Plan the trip",
          [
            OverlayModel.App(
              key: "com.apple.notes", name: "Notes",
              access: .readWrite, path: "/Applications/Notes.app")
          ]),
        session(
          "a-later", "Book rooms",
          [
            OverlayModel.App(
              key: "com.apple.ical", name: "Calendar",
              access: .read, path: "/Applications/Calendar.app")
          ]),
      ])
  }

  // MARK: - Pointer and outline

  func testThePointerAppearsTravelsAndStaysWhileTheSessionHoldsTheApp() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(model.presentation(at: at(1)).cursors, [:], "No pointer before its first point.")

    let first = model.movePointer(
      app: notes.key, to: CGPoint(x: 100, y: 100), at: at(1), reduceMotion: false)
    XCTAssertEqual(
      first,
      OverlayModel.PointerMove(
        kind: .appear, from: nil, to: CGPoint(x: 100, y: 100),
        duration: OverlayModel.appearDuration))
    let second = model.movePointer(
      app: notes.key, to: CGPoint(x: 400, y: 500), at: at(1.2), reduceMotion: false)
    XCTAssertEqual(second?.kind, .travel)
    XCTAssertEqual(second?.from, CGPoint(x: 100, y: 100))
    XCTAssertEqual(
      second?.duration,
      OverlayModel.travelDuration(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 400, y: 500)))
    XCTAssertEqual(
      model.presentation(at: at(1.2)).cursors,
      [notes.key: OverlayModel.Cursor(point: CGPoint(x: 400, y: 500), activity: .working)])

    // Thinking: the pointer stays where it was, for as long as the app is
    // held, and only its activity changes.
    model.workEnded(app: notes.key, at: at(2))
    XCTAssertEqual(model.presentation(at: at(2.29)).cursors[notes.key]?.activity, .working)
    XCTAssertEqual(
      model.presentation(at: at(2.31)).cursors,
      [notes.key: OverlayModel.Cursor(point: CGPoint(x: 400, y: 500), activity: .thinking)])
    XCTAssertEqual(
      model.presentation(at: at(600)).cursors[notes.key]?.point, CGPoint(x: 400, y: 500))
    XCTAssertNil(model.nextChange(after: at(2.31)), "Thinking needs no clock.")

    // The next action travels from there rather than appearing again.
    model.workStarted(app: notes.key, at: at(700))
    let again = model.movePointer(
      app: notes.key, to: CGPoint(x: 10, y: 10), at: at(700), reduceMotion: false)
    XCTAssertEqual(again?.kind, .travel)
    XCTAssertEqual(again?.from, CGPoint(x: 400, y: 500))
  }

  func testReleasingTheAppRemovesItsPointerAtOnceAndANewClaimAppearsAgain() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    _ = model.movePointer(app: notes.key, to: .zero, at: at(1), reduceMotion: false)
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(1.1))
    XCTAssertEqual(model.presentation(at: at(1.1)).cursors, [:])
    XCTAssertEqual(model.presentation(at: at(1.1)).outlined, [])

    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(2))
    XCTAssertEqual(
      model.movePointer(app: notes.key, to: .zero, at: at(2), reduceMotion: false)?.kind, .appear)
  }

  func testStopAndTheLastSessionEndingLeaveNoPointerOrOutline() {
    for ending in [OverlayModel.Ending.stopped, .ended, .connectionLost] {
      var model = OverlayModel()
      model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
      model.workStarted(app: notes.key, at: at(1))
      _ = model.movePointer(app: notes.key, to: .zero, at: at(1), reduceMotion: false)
      model.update(sessions: [], ending: ending, at: at(1.5))
      let presentation = model.presentation(at: at(1.5))
      XCTAssertEqual(presentation.cursors, [:], "\(ending)")
      XCTAssertEqual(presentation.outlined, [], "\(ending)")
    }
  }

  func testAnAppNoSessionHoldsGetsNoPointer() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [])], ending: .ended, at: at(0))
    XCTAssertNil(model.movePointer(app: notes.key, to: .zero, at: at(1), reduceMotion: false))
    XCTAssertEqual(model.presentation(at: at(1)).cursors, [:])
  }

  func testHeldAppsKeepBordersWhileOnlyWorkingAppsSweep() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes, calendar])], ending: .ended, at: at(0))
    XCTAssertEqual(model.presentation(at: at(0)).outlined, [notes.key, calendar.key])
    XCTAssertEqual(model.presentation(at: at(0)).sweeping, [])
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(model.presentation(at: at(1)).sweeping, [notes.key])
    model.workStarted(app: calendar.key, at: at(1.1))
    XCTAssertEqual(model.presentation(at: at(1.1)).outlined, [notes.key, calendar.key])
    XCTAssertEqual(model.presentation(at: at(1.1)).sweeping, [notes.key, calendar.key])
    model.workEnded(app: notes.key, at: at(2))
    XCTAssertEqual(model.presentation(at: at(2.29)).sweeping, [notes.key, calendar.key])
    XCTAssertEqual(model.presentation(at: at(2.31)).outlined, [notes.key, calendar.key])
    XCTAssertEqual(model.presentation(at: at(2.31)).sweeping, [calendar.key])
    // Two calls that overlap on one app end together.
    model.workStarted(app: calendar.key, at: at(3))
    model.workEnded(app: calendar.key, at: at(3.5))
    XCTAssertEqual(model.presentation(at: at(4)).sweeping, [calendar.key], "One is still running.")
    model.workEnded(app: calendar.key, at: at(4))
    XCTAssertEqual(model.presentation(at: at(4.31)).outlined, [notes.key, calendar.key])
    XCTAssertEqual(model.presentation(at: at(4.31)).sweeping, [])
    XCTAssertEqual(model.presentation(at: at(600)).outlined, [notes.key, calendar.key])
  }

  func testAReadOnlyAppIsOutlinedWhileItIsViewed() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [mail])], ending: .ended, at: at(0))
    model.workStarted(app: mail.key, at: at(1))
    XCTAssertEqual(pill(model, 1)?.status, "opensteer is viewing Mail")
    XCTAssertEqual(model.presentation(at: at(1)).outlined, [mail.key])
    model.workEnded(app: mail.key, at: at(2))
    XCTAssertEqual(pill(model, 3)?.status, "opensteer is waiting to view Mail")
    XCTAssertEqual(model.presentation(at: at(3)).outlined, [mail.key])
    XCTAssertEqual(model.presentation(at: at(3)).sweeping, [])
  }

  func testAClaimTransferredToAnotherSessionDropsTheOldActivity() {
    var model = OverlayModel()
    model.update(sessions: [session("a", "Old", [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    _ = model.movePointer(app: notes.key, to: .zero, at: at(1), reduceMotion: false)
    model.update(sessions: [session("b", "New", [notes])], ending: .ended, at: at(2))
    let newClaim = model.presentation(at: at(2))
    XCTAssertEqual(newClaim.outlined, [notes.key])
    XCTAssertEqual(newClaim.sweeping, [])
    XCTAssertEqual(newClaim.cursors, [:])
    XCTAssertEqual(newClaim.pill?.status, "opensteer is waiting to use Notes")
    XCTAssertEqual(newClaim.pill?.detail, "New")
    model.workEnded(app: notes.key, at: at(3))
    XCTAssertEqual(model.presentation(at: at(3)).sweeping, [])
  }

  func testOneSessionEndingRemovesOnlyItsOwnOutline() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [calendar])],
      ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    model.workStarted(app: calendar.key, at: at(1))
    model.update(sessions: [session("b", nil, [calendar])], ending: .ended, at: at(2))
    XCTAssertEqual(model.presentation(at: at(2)).outlined, [calendar.key])
    XCTAssertEqual(model.presentation(at: at(2)).sweeping, [calendar.key])
  }

  func testTravelStaysWithinItsDurations() {
    XCTAssertEqual(OverlayModel.travelDuration(from: .zero, to: .zero), 0)
    XCTAssertEqual(OverlayModel.travelDuration(from: .zero, to: CGPoint(x: 0.5, y: 0)), 0)
    XCTAssertEqual(
      OverlayModel.travelDuration(from: .zero, to: CGPoint(x: 1, y: 0)), 0.12,
      accuracy: 1e-9)
    XCTAssertEqual(
      OverlayModel.travelDuration(from: .zero, to: CGPoint(x: 3_000, y: 3_000)), 0.34,
      accuracy: 1e-9)
    let distances: [CGFloat] = [20, 100, 300, 900]
    let durations = distances.map {
      OverlayModel.travelDuration(from: .zero, to: CGPoint(x: $0, y: 0))
    }
    XCTAssertLessThan(durations[0], 0.16, "A short hop should not feel like waiting.")
    XCTAssertGreaterThan(durations[3], 0.3, "A long trip must remain easy to follow.")
    XCTAssertTrue(zip(durations, durations.dropFirst()).allSatisfy { $0 < $1 })
  }

  func testPointerTravelSpreadsMotionAcrossItsDurationWithoutOvershooting() {
    let duration = 0.3
    XCTAssertEqual(OverlayModel.travelProgress(-1, duration: duration), 0)
    XCTAssertEqual(OverlayModel.travelProgress(0, duration: duration), 0)
    XCTAssertEqual(
      OverlayModel.travelProgress(duration / 2, duration: duration), 0.5, accuracy: 1e-9)
    XCTAssertEqual(OverlayModel.travelProgress(duration, duration: duration), 1)
    XCTAssertEqual(OverlayModel.travelProgress(1, duration: duration), 1)
    XCTAssertEqual(OverlayModel.travelProgress(0, duration: 0), 1)
    let values = (0...100).map {
      OverlayModel.travelProgress(Double($0) / 100 * duration, duration: duration)
    }
    XCTAssertTrue(values.allSatisfy { $0 >= 0 && $0 <= 1 })
    XCTAssertTrue(zip(values, values.dropFirst()).allSatisfy { $0 <= $1 })
    XCTAssertLessThan(values[10], 0.02, "The pointer should accelerate gently.")
    XCTAssertGreaterThan(values[90], 0.98, "The pointer should settle gently.")
  }

  func testReduceMotionNeverTravels() {
    var model = OverlayModel()
    model.update(sessions: [session("a", nil, [notes])], ending: .ended, at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    XCTAssertEqual(
      model.movePointer(app: notes.key, to: .zero, at: at(1), reduceMotion: true),
      OverlayModel.PointerMove(
        kind: .appear, from: nil, to: .zero, duration: OverlayModel.crossfadeDuration))
    XCTAssertEqual(
      model.movePointer(
        app: notes.key, to: CGPoint(x: 900, y: 900), at: at(1), reduceMotion: true),
      OverlayModel.PointerMove(
        kind: .crossfade, from: .zero, to: CGPoint(x: 900, y: 900),
        duration: OverlayModel.crossfadeDuration))
  }

  func testOnePointerPerAppAndNoneForAReleasedApp() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", nil, [notes]), session("b", nil, [calendar])], ending: .ended,
      at: at(0))
    model.workStarted(app: notes.key, at: at(1))
    _ = model.movePointer(app: notes.key, to: CGPoint(x: 1, y: 1), at: at(1), reduceMotion: false)
    model.workEnded(app: notes.key, at: at(1.1))
    model.workStarted(app: calendar.key, at: at(1.2))
    _ = model.movePointer(
      app: calendar.key, to: CGPoint(x: 2, y: 2), at: at(1.2), reduceMotion: false)
    XCTAssertEqual(
      model.presentation(at: at(1.5)).cursors,
      [
        notes.key: OverlayModel.Cursor(point: CGPoint(x: 1, y: 1), activity: .thinking),
        calendar.key: OverlayModel.Cursor(point: CGPoint(x: 2, y: 2), activity: .working),
      ])

    // Session a closes while Calendar still works: Notes' pointer goes at once.
    model.update(sessions: [session("b", nil, [calendar])], ending: .ended, at: at(1.6))
    XCTAssertEqual(
      model.presentation(at: at(1.6)).cursors,
      [calendar.key: OverlayModel.Cursor(point: CGPoint(x: 2, y: 2), activity: .working)])
  }

  // MARK: - Pill corner

  func testThePillSettlesInTheNearestCornerOfTheActiveScreen() {
    let visible = CGRect(x: 0, y: 0, width: 1_000, height: 800)
    XCTAssertEqual(PillCorner.nearest(to: CGPoint(x: 900, y: 700), in: visible), .topRight)
    XCTAssertEqual(PillCorner.nearest(to: CGPoint(x: 100, y: 700), in: visible), .topLeft)
    XCTAssertEqual(PillCorner.nearest(to: CGPoint(x: 900, y: 100), in: visible), .bottomRight)
    XCTAssertEqual(PillCorner.nearest(to: CGPoint(x: 100, y: 100), in: visible), .bottomLeft)

    let size = CGSize(width: 300, height: 44)
    let screen = CGRect(x: 1_440, y: 0, width: 1_000, height: 800)
    XCTAssertEqual(
      PillCorner.topRight.frame(size: size, in: screen),
      CGRect(x: 2_128, y: 744, width: 300, height: 44))
    XCTAssertEqual(
      PillCorner.bottomLeft.frame(size: size, in: screen),
      CGRect(x: 1_452, y: 12, width: 300, height: 44))
  }

}

/// The pure geometry and motion the overlay's windows are placed and moved
/// by.
final class OverlayGeometryTests: XCTestCase {
  func testThePointerPanelPutsTheTipOnTheScreenPoint() {
    // A 900-point-tall primary display: CoreGraphics (100, 200) is AppKit
    // (100, 700), and the panel hangs from the tip.
    let frame = OverlayGeometry.pointerPanelFrame(tip: CGPoint(x: 100, y: 200), primaryHeight: 900)
    let tip = OverlayStyle.pointerTip
    let size = OverlayStyle.pointerPanelSize
    XCTAssertEqual(frame.size, size)
    XCTAssertEqual(frame.minX + tip.x, 100)
    XCTAssertEqual(frame.maxY - tip.y, 700)
  }

  func testThePointerKeepsItsPlaceInAWindowThatMoves() {
    let offset = CGPoint(x: 40, y: 12)
    let before = CGRect(x: 100, y: 100, width: 800, height: 600)
    let after = before.offsetBy(dx: 250, dy: -40)
    XCTAssertEqual(OverlayGeometry.tip(offset: offset, in: before), CGPoint(x: 140, y: 112))
    XCTAssertEqual(OverlayGeometry.tip(offset: offset, in: after), CGPoint(x: 390, y: 72))
  }

  func testTheOutlinePanelHoldsTheWindowAndItsGlow() {
    let window = CGRect(x: 100, y: 50, width: 800, height: 600)
    let frame = OverlayGeometry.outlinePanelFrame(window: window, primaryHeight: 1_000)
    let margin = OverlayStyle.outlineMargin
    XCTAssertEqual(
      frame,
      CGRect(
        x: 100 - margin, y: 1_000 - 650 - margin, width: 800 + margin * 2,
        height: 600 + margin * 2))
  }

  func testTheWindowCornerFollowsTheMacOSRelease() {
    XCTAssertEqual(OverlayStyle.windowCornerRadius(majorVersion: 15), 10)
    XCTAssertEqual(OverlayStyle.windowCornerRadius(majorVersion: 26), 16)
  }

  func testTravelLeavesAtRestAndArrivesWithoutOvershoot() {
    let duration = 0.3
    XCTAssertEqual(Spring.critical(0, duration: duration), 0, accuracy: 1e-9)
    var previous = 0.0
    for step in 1...30 {
      let value = Spring.critical(Double(step) / 100, duration: duration)
      XCTAssertGreaterThanOrEqual(value, previous)
      XCTAssertLessThanOrEqual(value, 1)
      previous = value
    }
    XCTAssertGreaterThan(Spring.critical(duration * 0.99, duration: duration), 0.99)
    XCTAssertEqual(Spring.critical(duration, duration: duration), 1)
    // The first frame barely moves: it gathers speed rather than jumping.
    XCTAssertLessThan(Spring.critical(1.0 / 120, duration: duration), 0.05)
    XCTAssertEqual(
      OverlayGeometry.interpolate(.zero, CGPoint(x: 100, y: -50), 0.5), CGPoint(x: 50, y: -25))
  }

  func testThePillSettlesWithASmallOvershoot() {
    let values = (0...100).map { Spring.settle(Double($0) / 100 * 0.42, duration: 0.42) }
    XCTAssertEqual(values.first ?? -1, 0, accuracy: 1e-9)
    XCTAssertEqual(values.last, 1)
    let peak = values.max() ?? 0
    XCTAssertGreaterThan(peak, 1, "It overshoots a little…")
    XCTAssertLessThan(peak, 1.05, "…and only a little.")
  }

  func testCornersKnowTheirSides() {
    XCTAssertTrue(PillCorner.topRight.isTop && PillCorner.topRight.isRight)
    XCTAssertTrue(PillCorner.topLeft.isTop && !PillCorner.topLeft.isRight)
    XCTAssertTrue(!PillCorner.bottomRight.isTop && PillCorner.bottomRight.isRight)
    XCTAssertTrue(!PillCorner.bottomLeft.isTop && !PillCorner.bottomLeft.isRight)
  }
}
