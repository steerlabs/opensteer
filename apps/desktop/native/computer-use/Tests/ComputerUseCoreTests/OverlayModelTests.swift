import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// What the person sees: one chip per held app with one dot, working or
/// still, the amber notice and who may clear it, where the chip sits on its
/// window, when it hides, what a press on it does, and that the chip is on
/// an action's window before the action's first effect.
final class OverlayModelTests: XCTestCase {
  private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
  private let safari = OverlayModel.App(key: "com.apple.safari", name: "Safari")
  private let notes = OverlayModel.App(key: "com.apple.notes", name: "Notes")

  private func at(_ seconds: TimeInterval) -> Date { start + seconds }

  private func session(_ id: String, _ apps: [OverlayModel.App]) -> OverlayModel.Session {
    OverlayModel.Session(id: id, apps: apps)
  }

  private func holder(_ id: String, _ app: OverlayModel.App) -> OverlayModel.Holder {
    OverlayModel.Holder(session: id, app: app.key)
  }

  private func look(_ model: OverlayModel, _ app: OverlayModel.App, _ seconds: TimeInterval)
    -> OverlayModel.Chip.Look?
  {
    model.presentation(at: at(seconds)).chips[app.key]?.look
  }

  /// A model whose Safari agent lost its connection mid-action, while a Notes
  /// agent works on.
  private func lostSafari() -> OverlayModel {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari]), session("b", [notes])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [session("b", [notes])], ending: .connectionLost, at: at(1))
    return model
  }

  // MARK: - The dot

  func testNothingShowsWithoutASession() {
    let model = OverlayModel()
    XCTAssertEqual(model.presentation(at: start), OverlayModel.Presentation(chips: [:]))
    XCTAssertNil(model.nextChange(after: start))
  }

  func testASessionThatHoldsNoAppYetShowsNothing() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [])], ending: .ended, at: at(0))
    XCTAssertEqual(model.presentation(at: at(0)).chips, [:])
  }

  func testAHeldAppShowsOneStillDotAndNoWords() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    XCTAssertEqual(
      model.presentation(at: at(0)).chips,
      [safari.key: OverlayModel.Chip(app: safari, look: .agent(.still))])
  }

  func testWorkBreathesAndHoldsForAMomentAfter() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    XCTAssertEqual(look(model, safari, 1), .agent(.working))
    XCTAssertNil(model.nextChange(after: at(1)), "Nothing changes by itself while work is in flight.")
    model.workEnded(holder("a", safari), at: at(2))
    XCTAssertEqual(look(model, safari, 2.1), .agent(.working))
    XCTAssertEqual(model.nextChange(after: at(2)), at(2) + OverlayModel.holdAfterWork)
    XCTAssertEqual(look(model, safari, 2 + OverlayModel.holdAfterWork), .agent(.still))
  }

  func testOverlappingWorkStaysWorkingUntilTheLastEnds() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.workStarted(holder("a", safari))
    model.workEnded(holder("a", safari), at: at(1))
    XCTAssertEqual(look(model, safari, 5), .agent(.working))
    model.workEnded(holder("a", safari), at: at(5))
    XCTAssertEqual(look(model, safari, 6), .agent(.still))
  }

  func testEachHeldAppHasItsOwnChip() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari]), session("b", [notes])], ending: .ended, at: at(0))
    model.workStarted(holder("b", notes))
    XCTAssertEqual(look(model, safari, 0), .agent(.still))
    XCTAssertEqual(look(model, notes, 0), .agent(.working))
  }

  func testWorkForAnAppNoSessionHoldsChangesNothing() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", notes))
    model.workStarted(holder("b", safari))
    XCTAssertEqual(look(model, safari, 0), .agent(.still))
    XCTAssertNil(look(model, notes, 0))
  }

  func testReleasingAnAppRemovesItsChipAtOnce() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari, notes])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [session("a", [notes])], ending: .ended, at: at(1))
    XCTAssertNil(look(model, safari, 1))
    XCTAssertEqual(look(model, notes, 1), .agent(.still))
    model.update(sessions: [session("a", [safari, notes])], ending: .ended, at: at(2))
    XCTAssertEqual(look(model, safari, 2), .agent(.still), "A new claim starts still.")
  }

  // MARK: - The amber notice

  func testAConnectionLostWithAnActionUnderWayTurnsThatAppsChipAmber() {
    let model = lostSafari()
    XCTAssertEqual(look(model, safari, 1), .connectionLost)
    XCTAssertEqual(look(model, notes, 1), .agent(.still), "The other app keeps working.")
    XCTAssertEqual(look(model, safari, 3_600), .connectionLost, "It does not time out.")
    XCTAssertNil(model.nextChange(after: at(1)))
    XCTAssertEqual(model.shownApps, [safari.key, notes.key])
  }

  func testNothingWasUnderWaySoNothingTurnsAmber() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.workEnded(holder("a", safari), at: at(0.5))
    model.update(sessions: [], ending: .connectionLost, at: at(1))
    XCTAssertEqual(model.presentation(at: at(1)).chips, [:])
  }

  func testASessionClosedWithWorkUnderWayIsNotALostConnection() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [], ending: .ended, at: at(1))
    XCTAssertEqual(model.presentation(at: at(1)).chips, [:])
  }

  func testOnlyItsOwnAppClearsTheNotice() {
    var unrelated = lostSafari()
    unrelated.update(
      sessions: [session("b", [notes]), session("c", [notes]), session("d", [])],
      ending: .ended, at: at(2))
    XCTAssertEqual(look(unrelated, safari, 2), .connectionLost, "Sessions on other apps leave it.")
    XCTAssertFalse(unrelated.clearNotice(app: notes.key), "Another app's recovery clears nothing.")
    XCTAssertEqual(look(unrelated, safari, 2), .connectionLost)

    var reclaimed = lostSafari()
    reclaimed.update(sessions: [session("b", [notes]), session("new", [safari])], ending: .ended, at: at(2))
    XCTAssertEqual(look(reclaimed, safari, 2), .agent(.still), "A live agent in that app replaces it.")

    var cleared = lostSafari()
    XCTAssertTrue(cleared.clearNotice(app: safari.key))
    XCTAssertNil(look(cleared, safari, 2))
    XCTAssertFalse(cleared.clearNotice(app: safari.key), "A second dismissal changes nothing.")
  }

  // MARK: - What the runtime hands the overlay

  @MainActor
  private func app(_ bundleId: String, _ name: String) -> AppSessionState {
    hostApp(
      identity: AppIdentity(bundleId: bundleId, displayName: name, teamId: nil),
      path: "/Applications/\(name).app")
  }

  /// Sessions in the order they opened, and only the apps each one has
  /// claimed. The person's own viewing and typing is never among them.
  @MainActor
  func testTheRuntimeReportsOnlyHeldAppsInOpeningOrder() {
    let later = HelperSession(sessionId: "a-later", connectionID: 1)
    later.openedAt = start + 10
    later.add(app("com.apple.iCal", "Calendar"))
    let earlier = HelperSession(sessionId: "z-earlier", connectionID: 1)
    earlier.openedAt = start
    earlier.add(app("com.apple.Notes", "Notes"))
    earlier.add(app("com.apple.mail", "Mail"))

    let reported = OverlayController.sessions(
      [later, earlier], owners: ["com.apple.notes": "z-earlier", "com.apple.ical": "a-later"])
    XCTAssertEqual(
      reported,
      [
        session("z-earlier", [OverlayModel.App(key: "com.apple.notes", name: "Notes")]),
        session("a-later", [OverlayModel.App(key: "com.apple.ical", name: "Calendar")]),
      ])
  }

  /// A dismissal clears that app's notice once and stops nothing; `Stop`
  /// needs a live chip that is showing; the person reaching one app clears
  /// only that app's notice.
  @MainActor
  func testOnlyALiveChipStopsAndADismissalNeverDoes() {
    var stopped: [String] = []
    let overlay = OverlayController(drawsWindows: false, onStop: { stopped.append($0) })
    let safariState = app("com.apple.Safari", "Safari")
    let notesState = app("com.apple.Notes", "Notes")
    let a = HelperSession(sessionId: "a", connectionID: 1)
    a.add(safariState)
    let b = HelperSession(sessionId: "b", connectionID: 2)
    b.add(notesState)
    let owners = [safari.key: "a", notes.key: "b"]
    overlay.update(sessions: [a, b], owners: owners, ending: .ended)
    overlay.press(.stop, app: notes.key)
    XCTAssertEqual(stopped, [], "No chip is showing, so nothing is stopped.")

    overlay.workStarted(on: safariState)
    overlay.update(sessions: [b], owners: [notes.key: "b"], ending: .connectionLost)
    XCTAssertEqual(overlay.presentation(at: Date()).chips[safari.key]?.look, .connectionLost)
    overlay.connectionRestored(app: notes.key)
    XCTAssertEqual(
      overlay.presentation(at: Date()).chips[safari.key]?.look, .connectionLost,
      "Reaching Notes again says nothing about Safari.")
    overlay.press(.dismiss, app: safari.key)
    XCTAssertNil(overlay.presentation(at: Date()).chips[safari.key])
    overlay.press(.dismiss, app: safari.key)
    overlay.press(.stop, app: safari.key)
    XCTAssertEqual(stopped, [], "A duplicate press after dismissal never falls through to Stop.")
  }

  @MainActor
  func testReachingTheAppAgainClearsItsNotice() {
    let overlay = OverlayController(drawsWindows: false, onStop: { _ in })
    let safariState = app("com.apple.Safari", "Safari")
    let a = HelperSession(sessionId: "a", connectionID: 1)
    a.add(safariState)
    overlay.update(sessions: [a], owners: [safari.key: "a"], ending: .ended)
    overlay.workStarted(on: safariState)
    overlay.update(sessions: [], owners: [:], ending: .connectionLost)
    overlay.connectionRestored(app: safari.key)
    XCTAssertEqual(overlay.presentation(at: Date()).chips, [:])
  }

  /// The chip goes on an action's verified window before its first effect,
  /// and the Stop check comes after it: a Stop already pressed stops the
  /// action with the chip on the right window.
  @WorkActor
  func testTheChipIsOnTheActionsWindowBeforeTheStopCheck() async {
    let overlay = await OverlayController(drawsWindows: false, onStop: { _ in })
    let state = hostApp(
      identity: AppIdentity(bundleId: "com.apple.Safari", displayName: "Safari", teamId: nil),
      path: "/Applications/Safari.app")
    await overlay.bind(app: state.key, window: 2)
    let cancellation = SessionCancellation()
    let context = hostContext(
      app: state, cancellation: cancellation, monitor: WindowMonitor(), overlay: overlay,
      budget: .unlimited)
    let windowA = ActionRunner.Binding(
      processIdentifier: getpid(), windowID: 1, windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300))
    try? await ActionRunner.showStop(on: windowA, context)
    let afterFirst = await overlay.keyWindow(for: state.key)
    XCTAssertEqual(afterFirst, 1, "Window A, not the window bound before it.")

    cancellation.cancel(.stoppedByUser)
    let windowB = ActionRunner.Binding(
      processIdentifier: getpid(), windowID: 3, windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300))
    do {
      try await ActionRunner.showStop(on: windowB, context)
      XCTFail("The Stop check comes after the chip moves.")
    } catch {
      XCTAssertEqual((error as? HelperError)?.code, .stoppedByUser)
    }
    let afterStop = await overlay.keyWindow(for: state.key)
    XCTAssertEqual(afterStop, 3)
  }

  // MARK: - Where it sits

  /// A 1440 × 900 screen with a 33-point menu bar, and a second screen to its
  /// right whose own menu bar is 24 points.
  private let usable: [CGRect] = [
    CGRect(x: 0, y: 33, width: 1440, height: 900 - 33),
    CGRect(x: 1440, y: 24, width: 1920, height: 1080 - 24),
  ]

  private func anchor(_ window: CGRect) -> OverlayGeometry.ChipAnchor? {
    OverlayGeometry.chipAnchor(window: window, usable: usable)
  }

  func testTheChipSitsOnTheEdgeWhenItsUpperHalfClearsTheMenuBar() {
    XCTAssertEqual(anchor(CGRect(x: 200, y: 44, width: 800, height: 600))?.placement, .edge)
    XCTAssertEqual(anchor(CGRect(x: 200, y: 33 + 11, width: 800, height: 600))?.placement, .edge)
    XCTAssertEqual(anchor(CGRect(x: 200, y: 33 + 10, width: 800, height: 600))?.placement, .notch)
    XCTAssertEqual(anchor(CGRect(x: 200, y: 33, width: 800, height: 600))?.placement, .notch)
    XCTAssertEqual(anchor(CGRect(x: 0, y: 0, width: 1440, height: 900))?.placement, .notch)
    XCTAssertEqual(anchor(CGRect(x: 1600, y: 40, width: 800, height: 600))?.placement, .edge)
    XCTAssertNil(anchor(CGRect(x: -3000, y: 200, width: 800, height: 600)), "On no screen.")
  }

  func testAWindowPartlyOffItsScreenKeepsItsChipOnTheVisiblePart() {
    let left = anchor(CGRect(x: -600, y: 200, width: 800, height: 600))
    XCTAssertEqual(left?.midX, 100, "The middle of the 200 visible points.")
    XCTAssertEqual(left?.placement, .edge)
    let raised = anchor(CGRect(x: 200, y: 0, width: 800, height: 600))
    XCTAssertEqual(raised?.placement, .notch)
    XCTAssertEqual(raised?.top, 33, "Below the menu bar, not under it.")
    let narrow = OverlayGeometry.chipFrame(
      anchor: try! XCTUnwrap(anchor(CGRect(x: -790, y: 200, width: 820, height: 600))),
      size: CGSize(width: 28, height: 22), scale: 2)
    XCTAssertEqual(narrow.minX, 1, "Centred in the visible 30 points.")
  }

  func testTheChipIsCentredOnTheTopEdgeOnWholePixels() {
    let window = CGRect(x: 201, y: 100, width: 801, height: 600)
    let edge = try! XCTUnwrap(anchor(window))
    let size = CGSize(width: 28, height: 22)
    let oneX = OverlayGeometry.chipFrame(anchor: edge, size: size, scale: 1)
    XCTAssertEqual(oneX, CGRect(x: 588, y: 89, width: 28, height: 22), "Half above the edge.")
    let twoX = OverlayGeometry.chipFrame(anchor: edge, size: size, scale: 2)
    XCTAssertEqual(twoX.minX, 587.5, "Half a point is a whole pixel at 2x.")
    XCTAssertEqual(twoX.midY, window.minY)
    let notch = OverlayGeometry.chipFrame(
      anchor: try! XCTUnwrap(anchor(CGRect(x: 201, y: 33, width: 801, height: 600))),
      size: CGSize(width: 24, height: 9), scale: 2)
    XCTAssertEqual(notch.minY, 33, "A notch hangs from the edge.")
  }

  // MARK: - Never seen chasing the window

  func testTheChipHidesTheMomentItsWindowMovesAndReturnsOnceItSettles() {
    var settling = ChipSettling()
    var buttons = false
    let still = CGRect(x: 100, y: 100, width: 800, height: 600)
    let moved = still.offsetBy(dx: 30, dy: 0)
    func step(_ frame: CGRect?, showing: Bool, _ time: CFTimeInterval)
      -> (ChipSettling.Step, moved: Bool)
    {
      settling.step(frame: frame, showing: showing, at: time, buttonsDown: { buttons })
    }
    XCTAssertTrue(step(still, showing: false, 0) == (.reveal, false), "At once the first time.")
    XCTAssertTrue(step(still, showing: true, 0.25) == (.keep, false))
    XCTAssertTrue(step(moved, showing: true, 0.5) == (.conceal, true), "Gone on the first move.")
    let resting = moved.offsetBy(dx: 5, dy: 0)
    XCTAssertTrue(step(resting, showing: false, 0.52) == (.wait, true))
    XCTAssertTrue(step(resting, showing: false, 0.6) == (.wait, false))
    XCTAssertTrue(
      step(resting, showing: false, 0.52 + OverlayStyle.settleDelay) == (.reveal, false),
      "Back once still.")
    XCTAssertTrue(step(still, showing: false, 1) == (.wait, true))
    buttons = true
    XCTAssertTrue(step(still, showing: false, 2) == (.wait, false), "Held mid-drag.")
    buttons = false
    XCTAssertTrue(step(still, showing: false, 2.1) == (.reveal, false))
    XCTAssertTrue(
      step(CGRect(x: 100, y: 100, width: 700, height: 600), showing: true, 3) == (.conceal, true),
      "A resize is a move too.")
    XCTAssertTrue(step(nil, showing: true, 4) == (.conceal, false))
    XCTAssertTrue(step(still, showing: false, 5) == (.reveal, false))
  }

  // MARK: - A press

  /// What a press does is decided as it begins, from what the chip shows.
  func testAPressThatBeginsBeforeStopIsShownOnlyOpensIt() {
    var gesture = ChipGesture()
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 0.6, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .open, "Still widening: it opens, it never stops.")
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 0, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .open)
  }

  func testACleanClickOnTheShownStopStopsOnce() {
    var gesture = ChipGesture()
    gesture.down(ChipGesture.action(look: .agent(.working), expansion: 1, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .stop)
    gesture.down(ChipGesture.action(look: .agent(.working), expansion: 1, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .nothing, "The second click of a double click.")
  }

  func testAPressThatLeavesTheChipDoesNothingEvenIfItComesBack() {
    var gesture = ChipGesture()
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 1, inside: true))
    gesture.dragged(inside: false)
    gesture.dragged(inside: true)
    XCTAssertEqual(gesture.up(inside: true), .nothing)
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 1, inside: true))
    XCTAssertEqual(gesture.up(inside: false), .nothing, "Released outside.")
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 1, inside: false))
    XCTAssertEqual(gesture.up(inside: true), .nothing, "Began outside the shape.")
  }

  func testAPressTheChipLosesBeforeItsReleaseDoesNothing() {
    var gesture = ChipGesture()
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 1, inside: true))
    gesture.reset()
    XCTAssertEqual(gesture.up(inside: true), .nothing, "Concealed or moved to another window.")
    gesture.down(ChipGesture.action(look: .agent(.still), expansion: 1, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .stop, "A new showing acts again.")
  }

  func testOneClickDismissesTheNoticeOnceAndNeverStops() {
    var gesture = ChipGesture()
    gesture.down(ChipGesture.action(look: .connectionLost, expansion: 0, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .dismiss, "At rest, one click.")
    gesture.down(ChipGesture.action(look: .connectionLost, expansion: 0, inside: true))
    XCTAssertEqual(gesture.up(inside: true), .nothing)
    XCTAssertEqual(gesture.press(.connectionLost), .nothing)
    var spoken = ChipGesture()
    XCTAssertEqual(spoken.press(.agent(.still)), .stop, "VoiceOver presses the button it names.")
    XCTAssertEqual(spoken.press(.agent(.still)), .nothing)
  }

  // MARK: - The chip's drawing

  @MainActor
  private func view(
    _ look: OverlayModel.Chip.Look, placement: OverlayGeometry.ChipPlacement = .edge,
    reduceMotion: Bool = false
  ) -> ChipView {
    let view = ChipView()
    view.placement = placement
    view.configure(OverlayModel.Chip(app: safari, look: look), reduceMotion: reduceMotion)
    view.frame.size = view.chipSize(expansion: 0)
    view.layoutSubtreeIfNeeded()
    return view
  }

  @MainActor
  func testAtRestAShortCapsuleThatWidensToShowStop() {
    let chip = view(.agent(.still))
    XCTAssertEqual(chip.chipSize(expansion: 0), CGSize(width: 28, height: 22), "Wider than tall.")
    XCTAssertEqual(chip.word.opacity, 0, "No words at rest.")
    let open = chip.chipSize(expansion: 1)
    XCTAssertEqual(open.height, 22)
    XCTAssertGreaterThan(open.width, 50)
    XCTAssertEqual((chip.word.string as? NSAttributedString)?.string, "Stop")
    chip.expansion = 1
    chip.frame.size = open
    chip.layoutSubtreeIfNeeded()
    XCTAssertEqual(chip.word.opacity, 1)
    XCTAssertEqual(chip.body.cornerCurve, .continuous)
    XCTAssertEqual(chip.body.frame, chip.bounds, "The panel is the chip: no margin takes clicks.")
  }

  @MainActor
  func testAWorkingDotBreathesAndAStillOneDoesNot() {
    let working = view(.agent(.working))
    XCTAssertEqual(working.dot.animation(forKey: "breath")?.duration, OverlayStyle.breathPeriod / 2)
    let still = view(.agent(.still))
    XCTAssertNil(still.dot.animation(forKey: "breath"))
    XCTAssertEqual(still.dot.opacity, OverlayStyle.stillDotOpacity)
    let reduced = view(.agent(.working), reduceMotion: true)
    XCTAssertNil(reduced.dot.animation(forKey: "breath"))
    XCTAssertGreaterThan(reduced.dot.opacity, still.dot.opacity, "Still bright under Reduce Motion.")
  }

  @MainActor
  func testWithoutRoomAboveItIsASlimNotchThatOpensSidewaysAndShort() {
    let notch = view(.agent(.still), placement: .notch)
    XCTAssertEqual(notch.chipSize(expansion: 0), CGSize(width: 24, height: 9))
    XCTAssertEqual(notch.chipSize(expansion: 1).height, 16, "As short as the word allows.")
    XCTAssertGreaterThan(notch.chipSize(expansion: 1).width, 50)
    XCTAssertEqual(notch.dot.frame.height, 6)
    XCTAssertEqual(notch.body.maskedCorners, [.layerMinXMaxYCorner, .layerMaxXMaxYCorner])
    XCTAssertTrue(notch.shape().contains(CGPoint(x: 1, y: 1)), "Square where it meets the edge.")
    XCTAssertFalse(notch.shape().contains(CGPoint(x: 0.5, y: 8.5)), "Rounded below.")
  }

  @MainActor
  func testTheNoticeKeepsTheDarkBodyWithAnAmberDotAndRim() {
    let chip = view(.connectionLost)
    XCTAssertEqual(chip.body.backgroundColor, OverlayStyle.surface.cgColor)
    XCTAssertEqual(chip.dot.backgroundColor, OverlayStyle.amber.cgColor)
    XCTAssertEqual(chip.body.borderColor, OverlayStyle.amber.withAlphaComponent(0.9).cgColor)
    XCTAssertNil(chip.dot.animation(forKey: "breath"))
    XCTAssertEqual(
      (chip.word.string as? NSAttributedString)?.string, OverlayModel.connectionLostSentence)
    XCTAssertEqual(chip.accessibilityLabel(), OverlayModel.connectionLostSentence)
  }

  @MainActor
  func testTheChipIsAPlainlyNamedButton() {
    let chip = view(.agent(.still))
    XCTAssertEqual(chip.accessibilityRole(), .button)
    XCTAssertEqual(chip.accessibilityLabel(), "Stop the agent working in Safari")
    var pressed = 0
    chip.onPress = {
      pressed += 1
      return true
    }
    XCTAssertTrue(chip.accessibilityPerformPress())
    XCTAssertEqual(pressed, 1)
  }

  // MARK: - The click ring

  @MainActor
  func testTheClickRingIsOnAndSpreadsAndFadesInHalfASecond() {
    XCTAssertTrue(OverlayStyle.showsClickRing, "The one switch that removes it.")
    let center = CGPoint(x: 24, y: 24)
    let ring = ClickRing.animation(center: center, grows: true) as? CAAnimationGroup
    XCTAssertEqual(ring?.duration, 0.5)
    XCTAssertEqual(ring?.animations?.compactMap { ($0 as? CABasicAnimation)?.keyPath }, ["path", "opacity"])
    XCTAssertEqual(
      (ClickRing.animation(center: center, grows: false) as? CAAnimationGroup)?.animations?.count, 1,
      "Under Reduce Motion it only fades.")
    XCTAssertEqual(
      ClickRing.path(progress: 0, center: center).boundingBoxOfPath.width,
      OverlayStyle.ringRadii.from * 2)
    XCTAssertEqual(
      ClickRing.path(progress: 1, center: center).boundingBoxOfPath.width,
      OverlayStyle.ringRadii.to * 2)
  }

  func testTheBreathTakesAboutOnePointSixSecondsAtALowFrameRate() {
    let breath = Breath.animation(low: 0.4, high: 1)
    XCTAssertEqual(breath.duration * 2, 1.6, accuracy: 0.001)
    XCTAssertTrue(breath.autoreverses)
    XCTAssertLessThanOrEqual(breath.preferredFrameRateRange.maximum, 15)
  }
}
