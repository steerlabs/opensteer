import AppKit
import CoreGraphics
import Foundation
import QuartzCore
import XCTest

@testable import ComputerUseCore

/// What the person sees: one chip per held app, a dot per agent session,
/// working or still, the amber notice, where the chip sits on its window,
/// when it hides, and what its `Stop` stops.
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

  // MARK: - Dots

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
      [safari.key: OverlayModel.Chip(app: safari, look: .agents(dots: [.still], more: 0))])
  }

  func testWorkBreathesAndHoldsForAMomentAfter() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    XCTAssertEqual(look(model, safari, 1), .agents(dots: [.working], more: 0))
    XCTAssertNil(model.nextChange(after: at(1)), "Nothing changes by itself while work is in flight.")
    model.workEnded(holder("a", safari), at: at(2))
    XCTAssertEqual(look(model, safari, 2.1), .agents(dots: [.working], more: 0))
    XCTAssertEqual(model.nextChange(after: at(2)), at(2) + OverlayModel.holdAfterWork)
    XCTAssertEqual(look(model, safari, 2 + OverlayModel.holdAfterWork), .agents(dots: [.still], more: 0))
  }

  func testOverlappingWorkStaysWorkingUntilTheLastEnds() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.workStarted(holder("a", safari))
    model.workEnded(holder("a", safari), at: at(1))
    XCTAssertEqual(look(model, safari, 5), .agents(dots: [.working], more: 0))
    model.workEnded(holder("a", safari), at: at(5))
    XCTAssertEqual(look(model, safari, 6), .agents(dots: [.still], more: 0))
  }

  func testEachAgentInAnAppHasItsOwnDotInOpeningOrder() {
    var model = OverlayModel()
    model.update(
      sessions: [session("a", [safari]), session("b", [safari]), session("c", [safari])],
      ending: .ended, at: at(0))
    model.workStarted(holder("b", safari))
    XCTAssertEqual(look(model, safari, 0), .agents(dots: [.still, .working, .still], more: 0))
  }

  func testMoreThanThreeAgentsShowThreeDotsThenACount() {
    var model = OverlayModel()
    model.update(
      sessions: (1...5).map { session("s\($0)", [safari]) }, ending: .ended, at: at(0))
    XCTAssertEqual(look(model, safari, 0), .agents(dots: [.still, .still, .still], more: 2))
  }

  func testEachHeldAppHasItsOwnChip() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari]), session("b", [notes])], ending: .ended, at: at(0))
    model.workStarted(holder("b", notes))
    XCTAssertEqual(look(model, safari, 0), .agents(dots: [.still], more: 0))
    XCTAssertEqual(look(model, notes, 0), .agents(dots: [.working], more: 0))
  }

  func testWorkForAnAppNoSessionHoldsChangesNothing() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
    model.workStarted(holder("a", notes))
    model.workStarted(holder("b", safari))
    XCTAssertEqual(look(model, safari, 0), .agents(dots: [.still], more: 0))
    XCTAssertNil(look(model, notes, 0))
  }

  func testReleasingAnAppRemovesItsChipAtOnce() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari, notes])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [session("a", [notes])], ending: .ended, at: at(1))
    XCTAssertNil(look(model, safari, 1))
    XCTAssertEqual(look(model, notes, 1), .agents(dots: [.still], more: 0))
    model.update(sessions: [session("a", [safari, notes])], ending: .ended, at: at(2))
    XCTAssertEqual(look(model, safari, 2), .agents(dots: [.still], more: 0), "A new claim starts still.")
  }

  // MARK: - The amber notice

  func testAConnectionLostWithAnActionUnderWayTurnsThatAppsChipAmber() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari]), session("b", [notes])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [session("b", [notes])], ending: .connectionLost, at: at(1))
    XCTAssertEqual(look(model, safari, 1), .connectionLost)
    XCTAssertEqual(look(model, notes, 1), .agents(dots: [.still], more: 0), "The other app keeps working.")
    XCTAssertEqual(look(model, safari, 3_600), .connectionLost, "It does not time out.")
    XCTAssertNil(model.nextChange(after: at(1)))
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

  func testTheNoticeGoesWhenTheConnectionIsBackOrThePersonDismissesIt() {
    func lost() -> OverlayModel {
      var model = OverlayModel()
      model.update(sessions: [session("a", [safari])], ending: .ended, at: at(0))
      model.workStarted(holder("a", safari))
      model.update(sessions: [], ending: .connectionLost, at: at(1))
      return model
    }
    var restored = lost()
    XCTAssertTrue(restored.connectionRestored())
    XCTAssertNil(look(restored, safari, 2))
    XCTAssertFalse(restored.connectionRestored(), "Nothing left to restore.")

    var dismissed = lost()
    XCTAssertFalse(dismissed.dismiss(app: notes.key))
    XCTAssertTrue(dismissed.dismiss(app: safari.key))
    XCTAssertNil(look(dismissed, safari, 2))

    var reconnected = lost()
    reconnected.update(sessions: [session("new", [])], ending: .ended, at: at(2))
    XCTAssertNil(look(reconnected, safari, 2), "An agent connection back with a live session.")

    var reclaimed = lost()
    reclaimed.update(sessions: [session("new", [safari])], ending: .ended, at: at(2))
    XCTAssertEqual(look(reclaimed, safari, 2), .agents(dots: [.still], more: 0))
  }

  func testAppsWhoseChipsNeedAWindow() {
    var model = OverlayModel()
    model.update(sessions: [session("a", [safari]), session("b", [notes])], ending: .ended, at: at(0))
    model.workStarted(holder("a", safari))
    model.update(sessions: [session("b", [notes])], ending: .connectionLost, at: at(1))
    XCTAssertEqual(model.shownApps, [safari.key, notes.key])
  }

  // MARK: - What the runtime hands the overlay

  /// Sessions in the order they opened, and only the apps each one has
  /// claimed. The person's own viewing and typing is never among them.
  @MainActor
  func testTheRuntimeReportsOnlyHeldAppsInOpeningOrder() {
    func app(_ bundleId: String, _ name: String) -> AppSessionState {
      AppSessionState(
        identity: AppIdentity(bundleId: bundleId, displayName: name, teamId: nil),
        path: "/Applications/\(name).app")
    }
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

  /// The chip's `Stop` names its app; on an amber chip the press only
  /// dismisses the notice.
  @MainActor
  func testThePressStopsThatAppOrDismissesItsNotice() {
    var stopped: [String] = []
    let overlay = OverlayController(drawsWindows: false, onStop: { stopped.append($0) })
    let a = OverlayModel.Holder(session: "a", app: safari.key)
    overlay.present([session("a", [safari]), session("b", [notes])], ending: .ended)
    overlay.press(app: notes.key)
    XCTAssertEqual(stopped, [notes.key])

    overlay.workStarted(a)
    overlay.present([session("b", [notes])], ending: .connectionLost)
    XCTAssertEqual(overlay.presentation(at: Date()).chips[safari.key]?.look, .connectionLost)
    overlay.press(app: safari.key)
    XCTAssertEqual(stopped, [notes.key], "Dismissing stops nothing.")
    XCTAssertNil(overlay.presentation(at: Date()).chips[safari.key])
  }

  // MARK: - Where it sits

  /// A 1440 × 900 screen with a 33-point menu bar, and a second screen to its
  /// right whose own menu bar is 24 points.
  private let screens: [(screen: CGRect, top: CGFloat)] = [
    (CGRect(x: 0, y: 0, width: 1440, height: 900), 33),
    (CGRect(x: 1440, y: 0, width: 1920, height: 1080), 24),
  ]

  func testTheChipSitsOnTheEdgeWhenItsUpperHalfClearsTheMenuBar() {
    let place = { (window: CGRect) in
      OverlayGeometry.chipPlacement(window: window, usableTops: self.screens)
    }
    XCTAssertEqual(place(CGRect(x: 200, y: 44, width: 800, height: 600)), .edge)
    XCTAssertEqual(place(CGRect(x: 200, y: 33 + 11, width: 800, height: 600)), .edge, "Exactly room.")
    XCTAssertEqual(place(CGRect(x: 200, y: 33 + 10, width: 800, height: 600)), .notch)
    XCTAssertEqual(place(CGRect(x: 200, y: 33, width: 800, height: 600)), .notch, "Under the menu bar.")
    XCTAssertEqual(place(CGRect(x: 0, y: 0, width: 1440, height: 900)), .notch, "Full screen.")
    XCTAssertEqual(place(CGRect(x: 1600, y: 24, width: 800, height: 600)), .notch)
    XCTAssertEqual(place(CGRect(x: 1600, y: 40, width: 800, height: 600)), .edge, "Its own screen's menu bar.")
    XCTAssertEqual(place(CGRect(x: -3000, y: 200, width: 800, height: 600)), .notch, "On no screen.")
  }

  func testTheChipIsCentredOnTheTopEdgeOnWholePixels() {
    let window = CGRect(x: 201, y: 100, width: 801, height: 600)
    let size = CGSize(width: 22, height: 22)
    let oneX = OverlayGeometry.chipFrame(window: window, size: size, placement: .edge, scale: 1)
    XCTAssertEqual(oneX, CGRect(x: 591, y: 89, width: 22, height: 22), "Half above the edge.")
    let twoX = OverlayGeometry.chipFrame(window: window, size: size, placement: .edge, scale: 2)
    XCTAssertEqual(twoX.minX, 590.5, "Half a point is a whole pixel at 2x.")
    XCTAssertEqual(twoX.midY, window.minY)
    let notch = OverlayGeometry.chipFrame(
      window: window, size: CGSize(width: 22, height: 12), placement: .notch, scale: 2)
    XCTAssertEqual(notch.minY, window.minY, "A notch hangs from the edge.")
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
    XCTAssertTrue(step(moved.offsetBy(dx: 5, dy: 0), showing: false, 0.52) == (.wait, true))
    let resting = moved.offsetBy(dx: 5, dy: 0)
    XCTAssertTrue(step(resting, showing: false, 0.6) == (.wait, false))
    XCTAssertTrue(
      step(resting, showing: false, 0.52 + OverlayStyle.settleDelay) == (.reveal, false),
      "Back once still.")
    // Held still mid-drag: back only once the person lets go.
    XCTAssertTrue(step(still, showing: false, 1) == (.wait, true))
    buttons = true
    XCTAssertTrue(step(still, showing: false, 2) == (.wait, false))
    buttons = false
    XCTAssertTrue(step(still, showing: false, 2.1) == (.reveal, false))
    // Resized in place is a move too.
    XCTAssertTrue(
      step(CGRect(x: 100, y: 100, width: 700, height: 600), showing: true, 3) == (.conceal, true))
    // Out of sight and back: shown at once.
    XCTAssertTrue(step(nil, showing: true, 4) == (.conceal, false))
    XCTAssertTrue(step(still, showing: false, 5) == (.reveal, false))
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
    view.layoutSubtreeIfNeeded()
    return view
  }

  @MainActor
  func testOneAgentIsARoundChipThatWidensToShowStop() {
    let chip = view(.agents(dots: [.still], more: 0))
    XCTAssertEqual(chip.chipSize(expansion: 0), CGSize(width: 22, height: 22))
    XCTAssertEqual(chip.dots.count, 1)
    XCTAssertEqual(chip.word.opacity, 0, "No words at rest.")
    let open = chip.chipSize(expansion: 1)
    XCTAssertEqual(open.height, 22)
    XCTAssertGreaterThan(open.width, 44)
    XCTAssertEqual((chip.word.string as? NSAttributedString)?.string, "Stop")
    chip.expansion = 1
    chip.layoutSubtreeIfNeeded()
    XCTAssertEqual(chip.word.opacity, 1)
    XCTAssertEqual(chip.body.cornerCurve, .continuous)
  }

  @MainActor
  func testMoreAgentsAddDotsThenACount() {
    let three = view(.agents(dots: [.still, .working, .still], more: 0))
    let five = view(.agents(dots: [.still, .still, .still], more: 2))
    XCTAssertEqual(three.dots.count, 3)
    XCTAssertEqual(three.chipSize(expansion: 0).width, 7 * 2 + 8 * 3 - 2 * 2)
    XCTAssertEqual((five.count.string as? NSAttributedString)?.string, "+2")
    XCTAssertGreaterThan(five.chipSize(expansion: 0).width, three.chipSize(expansion: 0).width)
  }

  @MainActor
  func testAWorkingDotBreathesAndAStillOneDoesNot() {
    let chip = view(.agents(dots: [.working, .still], more: 0))
    XCTAssertNotNil(chip.dots[0].animation(forKey: "breath"))
    XCTAssertEqual(chip.dots[0].animation(forKey: "breath")?.duration, OverlayStyle.breathPeriod / 2)
    XCTAssertNil(chip.dots[1].animation(forKey: "breath"))
    XCTAssertEqual(chip.dots[1].opacity, OverlayStyle.stillDotOpacity)
    let reduced = view(.agents(dots: [.working, .still], more: 0), reduceMotion: true)
    XCTAssertNil(reduced.dots[0].animation(forKey: "breath"))
    XCTAssertGreaterThan(reduced.dots[0].opacity, reduced.dots[1].opacity, "Still bright under Reduce Motion.")
  }

  @MainActor
  func testWithoutRoomAboveItIsASlimNotchThatGrowsDownward() {
    let notch = view(.agents(dots: [.still], more: 0), placement: .notch)
    XCTAssertEqual(notch.chipSize(expansion: 0).height, OverlayStyle.notchHeight)
    XCTAssertEqual(notch.chipSize(expansion: 1).height, OverlayStyle.chipHeight)
    XCTAssertEqual(notch.body.maskedCorners, [.layerMinXMaxYCorner, .layerMaxXMaxYCorner])
  }

  @MainActor
  func testTheNoticeIsAmberStillAndSaysItsSentence() {
    let chip = view(.connectionLost)
    XCTAssertEqual(chip.body.backgroundColor, OverlayStyle.amber.cgColor)
    XCTAssertEqual(chip.dots.count, 1)
    XCTAssertNil(chip.dots[0].animation(forKey: "breath"))
    XCTAssertEqual(
      (chip.word.string as? NSAttributedString)?.string, OverlayModel.connectionLostSentence)
    XCTAssertEqual(chip.accessibilityLabel(), OverlayModel.connectionLostSentence)
  }

  @MainActor
  func testTheChipIsAPlainlyNamedButtonThatPressesAtOnce() {
    let chip = view(.agents(dots: [.still], more: 0))
    XCTAssertEqual(chip.accessibilityRole(), .button)
    XCTAssertEqual(chip.accessibilityLabel(), "Stop the agent working in Safari")
    XCTAssertEqual(view(.agents(dots: [.still, .still], more: 0)).accessibilityLabel(),
      "Stop the agents working in Safari")
    var pressed = 0
    chip.onPress = { pressed += 1 }
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
    let small = ClickRing.path(progress: 0, center: center).boundingBoxOfPath
    let wide = ClickRing.path(progress: 1, center: center).boundingBoxOfPath
    XCTAssertEqual(small.width, OverlayStyle.ringRadii.from * 2)
    XCTAssertEqual(wide.width, OverlayStyle.ringRadii.to * 2)
  }

  func testTheBreathTakesAboutOnePointSixSecondsAtALowFrameRate() {
    let breath = Breath.animation(low: 0.5, high: 1)
    XCTAssertEqual(breath.duration * 2, 1.6, accuracy: 0.001)
    XCTAssertTrue(breath.autoreverses)
    XCTAssertLessThanOrEqual(breath.preferredFrameRateRange.maximum, 15)
  }
}
