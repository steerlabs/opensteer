import AppKit
import XCTest

@testable import ComputerUseCore

@MainActor
final class PillWindowTests: XCTestCase {
  private typealias Pill = OverlayModel.Pill

  private let notes = Pill.Icon(key: "com.apple.notes", path: "/System/Applications/Notes.app")
  private let calendar = Pill.Icon(
    key: "com.apple.ical", path: "/System/Applications/Calendar.app")
  private var priorCorner = PillWindow.corner
  private var priorMouse = PillWindow.mouseLocation
  private var priorNow = PillWindow.now

  override func setUp() async throws {
    _ = NSApplication.shared
    priorCorner = PillWindow.corner
    priorMouse = PillWindow.mouseLocation
    priorNow = PillWindow.now
  }

  override func tearDown() async throws {
    PillWindow.corner = priorCorner
    PillWindow.mouseLocation = priorMouse
    PillWindow.now = priorNow
  }

  private func pill(
    expanded: Bool, icons: [Pill.Icon]? = nil, badge: Pill.Badge? = .pointer,
    detail: String? = "Review today's notes", controls: Pill.Controls = .session
  ) -> Pill {
    Pill(
      status: "opensteer is using Notes", compactStatus: "Using Notes", detail: detail,
      controls: controls, icons: icons ?? [notes], badge: badge, activity: .working,
      expanded: expanded)
  }

  private final class Count {
    var value = 0
  }

  private func window(toggles: Count = Count(), stops: Count = Count()) -> PillWindow {
    PillWindow(
      onStop: { stops.value += 1 }, onDismiss: {}, onToggle: { toggles.value += 1 },
      onPointer: { _ in })
  }

  func testMinimizedItIsOnlyTheAppAndStop() {
    let window = window()
    XCTAssertFalse(window.panel.canBecomeKey)
    XCTAssertFalse(window.panel.canBecomeMain)
    XCTAssertTrue(window.panel.styleMask.contains(.nonactivatingPanel))

    let expanded = window.render(pill(expanded: true))
    XCTAssertEqual(window.frame.height, OverlayStyle.pillHeight)
    XCTAssertGreaterThanOrEqual(window.frame.width, 330)
    XCTAssertTrue(visible(field("Review today's notes", in: expanded)))
    XCTAssertTrue(visible(minimize(in: expanded)))
    XCTAssertEqual(minimize(in: expanded)?.frame.size, CGSize(width: 34, height: 34))
    XCTAssertTrue(visible(stop(in: expanded)))
    XCTAssertFalse(window.app.isEnabled, "Expanded, only minimize minimizes.")
    XCTAssertFalse(window.app.isAccessibilityElement())

    let minimized = window.render(pill(expanded: false))
    XCTAssertEqual(window.frame.height, OverlayStyle.minimizedPillHeight)
    XCTAssertLessThanOrEqual(window.frame.width, 120)
    XCTAssertFalse(visible(field("opensteer is using Notes", in: minimized)))
    XCTAssertNil(minimize(in: minimized).flatMap(visibleButton))
    XCTAssertTrue(visible(stop(in: minimized)))
    XCTAssertEqual(stop(in: minimized)?.accessibilityLabel(), "Stop all computer use on this Mac")
    XCTAssertTrue(visible(button("Expand computer use status", in: minimized)))
    XCTAssertEqual(
      window.app.accessibilityHelp(), "opensteer is using Notes. Review today's notes")
    XCTAssertFalse(window.app.mark.pointer.isHidden)
  }

  func testTheAppAndMinimizeAskToToggleAndStopStops() {
    let toggles = Count()
    let stops = Count()
    let window = window(toggles: toggles, stops: stops)
    let expanded = window.render(pill(expanded: true))
    minimize(in: expanded)?.performClick(nil)
    window.app.performClick(nil)
    XCTAssertEqual(toggles.value, 1)
    let minimized = window.render(pill(expanded: false))
    button("Expand computer use status", in: minimized)?.performClick(nil)
    XCTAssertEqual(toggles.value, 2)
    stop(in: minimized)?.performClick(nil)
    XCTAssertEqual(stops.value, 1)
    XCTAssertEqual(toggles.value, 2)
  }

  /// A click that changes the size must never leave `Stop` under the
  /// pointer, or a second click would end every session. Anywhere on the
  /// control, not just its middle.
  func testAToggleNeverLeavesStopUnderThePointer() {
    for corner in PillCorner.allCases {
      PillWindow.corner = corner
      for icons in [[notes], [notes, calendar]] {
        let window = window()
        let expanded = window.render(pill(expanded: true, icons: icons))
        let minimize = screenRect(minimize(in: expanded), window)
        let minimized = window.render(pill(expanded: false, icons: icons))
        let stopMinimized = screenRect(stop(in: minimized), window)
        let minimizedApp = screenRect(window.app, window)
        XCTAssertFalse(stopMinimized.intersects(minimize), "\(corner) minimize")
        // Clicking where minimize was expands it again.
        XCTAssertTrue(minimizedApp.contains(minimize.center), "\(corner) toggles back")
        _ = window.render(pill(expanded: true, icons: icons))
        let stopExpanded = screenRect(stop(in: window.surface), window)
        XCTAssertFalse(stopExpanded.intersects(minimizedApp), "\(corner) app, minimized")
      }
    }
  }

  func testThePillKeepsToItsCornerWhateverItsSize() throws {
    let visible = try XCTUnwrap(NSScreen.main ?? NSScreen.screens.first).visibleFrame
    for corner in PillCorner.allCases {
      PillWindow.corner = corner
      let window = window()
      for expanded in [true, false] {
        _ = window.render(pill(expanded: expanded))
        let frame = window.frame
        if corner.isRight {
          XCTAssertEqual(frame.maxX, visible.maxX - PillCorner.margin, accuracy: 0.5)
        } else {
          XCTAssertEqual(frame.minX, visible.minX + PillCorner.margin, accuracy: 0.5)
        }
        if corner.isTop {
          XCTAssertEqual(frame.maxY, visible.maxY - PillCorner.margin, accuracy: 0.5)
        } else {
          XCTAssertEqual(frame.minY, visible.minY + PillCorner.margin, accuracy: 0.5)
        }
      }
    }
  }

  func testTheMinimizedPillDragsFromItsAppAndAClickStillToggles() throws {
    let toggles = Count()
    let window = window(toggles: toggles)
    PillWindow.corner = .topRight
    _ = window.render(pill(expanded: false))
    let surface = window.surface
    let app = try XCTUnwrap(window.app.superview).convert(window.app.frame.center, to: nil)
    var mouse = window.panel.convertPoint(toScreen: app)
    PillWindow.mouseLocation = { mouse }

    let nudged = NSPoint(x: app.x + 1, y: app.y)
    surface.mouseDown(with: event(.leftMouseDown, at: app, window))
    mouse.x += 1
    surface.mouseDragged(with: event(.leftMouseDragged, at: nudged, window))
    surface.mouseUp(with: event(.leftMouseUp, at: nudged, window))
    XCTAssertEqual(toggles.value, 1, "A press that barely moves is a click.")

    let origin = window.frame.origin
    surface.mouseDown(with: event(.leftMouseDown, at: app, window))
    mouse.x -= 60
    mouse.y -= 40
    surface.mouseDragged(
      with: event(.leftMouseDragged, at: NSPoint(x: app.x - 60, y: app.y - 40), window))
    XCTAssertTrue(surface.isDragging)
    XCTAssertEqual(window.frame.origin.x, origin.x - 60, accuracy: 0.5)
    surface.mouseUp(with: event(.leftMouseUp, at: app, window))
    XCTAssertEqual(toggles.value, 1, "A drag that starts on the app moves the pill instead.")
    XCTAssertFalse(surface.isDragging)
  }

  /// Grabbing `Stop` to move the small pill must move it and stop nothing.
  func testAPressOnStopThatMovesIsADragNotAStop() throws {
    let stops = Count()
    let window = window(stops: stops)
    PillWindow.corner = .topRight
    let view = window.render(pill(expanded: false))
    let surface = window.surface
    let button = try XCTUnwrap(stop(in: view))
    let center = try XCTUnwrap(button.superview).convert(button.frame.center, to: nil)
    var mouse = window.panel.convertPoint(toScreen: center)
    PillWindow.mouseLocation = { mouse }

    let moved = NSPoint(x: center.x - 30, y: center.y)
    surface.mouseDown(with: event(.leftMouseDown, at: center, window))
    mouse.x -= 30
    surface.mouseDragged(with: event(.leftMouseDragged, at: moved, window))
    surface.mouseUp(with: event(.leftMouseUp, at: moved, window))
    XCTAssertEqual(stops.value, 0, "Released after a drag: still no stop.")

    // Queued events: the pointer is already where the press ended when they
    // are handled, so only the events themselves show the movement — here a
    // drag that stays on Stop, with and without a drag event in between.
    let along = NSPoint(x: center.x + 20, y: center.y)
    XCTAssertTrue(button.frame.insetBy(dx: -1, dy: -1).contains(button.superview!.convert(along, from: nil)))
    let settled = window.panel.convertPoint(toScreen: along)
    PillWindow.mouseLocation = { settled }
    surface.mouseDown(with: event(.leftMouseDown, at: center, window))
    surface.mouseDragged(with: event(.leftMouseDragged, at: along, window))
    surface.mouseUp(with: event(.leftMouseUp, at: along, window))
    surface.mouseDown(with: event(.leftMouseDown, at: center, window))
    surface.mouseUp(with: event(.leftMouseUp, at: along, window))
    XCTAssertEqual(stops.value, 0, "Movement the events show is a drag, however late.")
    PillWindow.mouseLocation = { mouse }

    let outside = NSPoint(x: center.x, y: center.y + 40)
    surface.mouseDown(with: event(.leftMouseDown, at: center, window))
    surface.mouseUp(with: event(.leftMouseUp, at: outside, window))
    XCTAssertEqual(stops.value, 0, "Pressed on Stop, released off it.")

    surface.mouseDown(with: event(.leftMouseDown, at: center, window))
    surface.mouseUp(with: event(.leftMouseUp, at: center, window))
    XCTAssertEqual(stops.value, 1, "A plain click stops.")
  }

  /// While the pill grows or shrinks `Stop` stays where it is, whole and
  /// clickable: it never sweeps across the pill or slips off its edge.
  func testStopKeepsItsPlaceWhileThePillResizes() throws {
    for corner in PillCorner.allCases {
      PillWindow.corner = corner
      let window = window()
      let minimized = window.render(pill(expanded: false))
      let small = window.frame
      let stopSmall = screenRect(stop(in: minimized), window)
      let expanded = window.render(pill(expanded: true))
      let large = window.frame
      let stopLarge = screenRect(stop(in: expanded), window)

      // The expanded layout in the minimized frame, as growing begins.
      window.panel.setFrame(small, display: false)
      window.surface.layoutSubtreeIfNeeded()
      XCTAssertEqual(
        window.surface.frame.width, small.width, "\(corner): content must not widen the window")
      let growing = screenRect(stop(in: expanded), window)
      XCTAssertEqual(growing.minX, stopLarge.minX, accuracy: 0.5, "\(corner) growing")
      XCTAssertEqual(growing.maxX, stopLarge.maxX, accuracy: 0.5, "\(corner) growing")
      XCTAssertTrue(small.contains(growing), "\(corner): Stop stays inside the pill")

      // The minimized layout in the expanded frame, as shrinking begins.
      _ = window.render(pill(expanded: false))
      window.panel.setFrame(large, display: false)
      window.surface.layoutSubtreeIfNeeded()
      let shrinking = screenRect(stop(in: window.surface), window)
      XCTAssertEqual(shrinking.minX, stopSmall.minX, accuracy: 0.5, "\(corner) shrinking")
      XCTAssertEqual(shrinking.maxX, stopSmall.maxX, accuracy: 0.5, "\(corner) shrinking")
    }
  }

  /// Nothing the agent does — another app, longer or shorter words — moves
  /// `Stop` under a still pointer.
  func testStopsPlaceDependsOnlyOnTheCornerAndTheSize() {
    let long = "opensteer is waiting to use Calendar, Notes and Mail"
    for corner in PillCorner.allCases {
      PillWindow.corner = corner
      for expanded in [false, true] {
        let window = window()
        var places: [NSRect] = []
        for (icons, status) in [
          ([notes], "opensteer is using Notes"), ([notes, calendar], long),
          ([calendar], "Stopping"),
        ] {
          let view = window.render(
            Pill(
              status: status, compactStatus: "Using Notes", detail: "Review", controls: .session,
              icons: icons, badge: .pointer, activity: .working, expanded: expanded))
          places.append(screenRect(stop(in: view), window))
        }
        XCTAssertEqual(Set(places.map { "\($0)" }).count, 1, "\(corner) expanded: \(expanded)")
      }
    }
  }

  /// A notice gives way to the next task's pill under a pointer that never
  /// moved: the new `Stop` must not take a click aimed at the notice.
  func testStopIgnoresPressesThatBeginAsItAppears() throws {
    for corner in PillCorner.allCases {
      PillWindow.corner = corner
      var now: TimeInterval = 100
      PillWindow.now = { now }
      let stops = Count()
      let window = window(stops: stops)
      _ = window.render(pill(expanded: true, badge: nil, controls: .none))
      let view = window.render(pill(expanded: false))
      let button = try XCTUnwrap(stop(in: view))
      let center = try XCTUnwrap(button.superview).convert(button.frame.center, to: nil)
      let mouse = window.panel.convertPoint(toScreen: center)
      PillWindow.mouseLocation = { mouse }
      func click() {
        window.surface.mouseDown(with: event(.leftMouseDown, at: center, window))
        window.surface.mouseUp(with: event(.leftMouseUp, at: center, window))
      }
      click()
      now += OverlayStyle.stopArmDelay - 0.01
      click()
      XCTAssertEqual(stops.value, 0, "\(corner): too soon after Stop appeared")
      now += 0.02
      click()
      XCTAssertEqual(stops.value, 1, "\(corner): a deliberate click stops")
    }
  }

  /// Hidden between tasks, the pill still knows where it would expand.
  func testAHiddenPillStillGuardsWhereItWouldExpand() throws {
    PillWindow.corner = .topRight
    let window = window()
    XCTAssertFalse(window.isShown)
    let visible = try XCTUnwrap(NSScreen.main ?? NSScreen.screens.first).visibleFrame
    var mouse = NSPoint(x: visible.maxX - 300, y: visible.maxY - 30)
    PillWindow.mouseLocation = { mouse }
    XCTAssertTrue(window.pointerIsNear())
    mouse = NSPoint(x: visible.midX - 400, y: visible.midY)
    XCTAssertFalse(window.pointerIsNear())
  }

  func testTheStatusSitsInTheMiddleOfThePill() throws {
    let window = window()
    for detail in ["Review today's notes", nil] {
      let view = window.render(pill(expanded: true, detail: detail))
      let status = try XCTUnwrap(field("opensteer is using Notes", in: view))
      var block = status.convert(status.bounds, to: view)
      if let detail, let line = field(detail, in: view) {
        block = block.union(line.convert(line.bounds, to: view))
      }
      XCTAssertEqual(block.midY, view.bounds.midY, accuracy: 1.5, "\(detail ?? "no detail")")
    }
  }

  /// A short status must not cut a long Thread title short while the pill
  /// still has room to grow.
  func testWordsTruncateOnlyAtTheWidestPill() throws {
    let window = window()
    let title = "Plan the Lisbon offsite and book venues"
    for (status, controls) in [
      ("Stopping…", Pill.Controls.none), ("Computer use ended", .none),
      ("opensteer is using Notes", .session),
    ] {
      let view = window.render(
        Pill(
          status: status, compactStatus: status, detail: title, controls: controls,
          icons: [notes], badge: controls == .session ? .pointer : nil, activity: .thinking,
          expanded: true))
      let detail = try XCTUnwrap(field(title, in: view))
      XCTAssertGreaterThanOrEqual(
        detail.frame.width, detail.intrinsicContentSize.width - 0.5, status)
    }
    let long = String(repeating: "A very long Thread title ", count: 8)
    let view = window.render(pill(expanded: true, detail: long))
    XCTAssertEqual(window.frame.width, 500, "As wide as it gets, then it truncates.")
    XCTAssertTrue(visible(stop(in: view)))
  }

  func testAnAppTheAgentCanOnlySeeShowsTheEyeAndANoticeShowsNoBadge() {
    let window = window()
    _ = window.render(pill(expanded: false, badge: .eye))
    XCTAssertTrue(window.app.mark.pointer.isHidden)
    // Between calls the eye breathes as the pointer would; working, it is still.
    let mark = window.app.mark
    mark.setActivity(.thinking)
    XCTAssertEqual(
      OverlayMotion.reduced, mark.root.sublayers?.last?.animation(forKey: "breathe.opacity") == nil)
    mark.setActivity(.working)
    XCTAssertNil(mark.root.sublayers?.last?.animation(forKey: "breathe.opacity"))
    _ = window.render(pill(expanded: true, badge: nil, controls: .none))
    XCTAssertTrue(window.app.mark.pointer.isHidden)
    XCTAssertFalse(window.app.isEnabled, "A notice has nothing to toggle.")
    XCTAssertNil(stop(in: window.surface).flatMap(visibleButton))
  }

  func testThePeekHangsOffThePillsOuterSideAndStaysOnScreen() {
    let visible = NSRect(x: 0, y: 0, width: 1440, height: 875)
    let size = CGSize(width: 220, height: 25)
    let gap = OverlayStyle.peekGap
    let topRight = NSRect(x: 1324, y: 823, width: 104, height: 40)
    let below = PillPeek.frame(size: size, beside: topRight, corner: .topRight, in: visible)
    XCTAssertEqual(below.maxX, topRight.maxX)
    XCTAssertEqual(below.maxY, topRight.minY - gap)
    let bottomLeft = NSRect(x: 12, y: 12, width: 104, height: 40)
    let above = PillPeek.frame(size: size, beside: bottomLeft, corner: .bottomLeft, in: visible)
    XCTAssertEqual(above.minX, bottomLeft.minX)
    XCTAssertEqual(above.minY, bottomLeft.maxY + gap)
    // A pill dragged half off a screen still has its label on it.
    let narrow = NSRect(x: 0, y: 0, width: 300, height: 875)
    let clamped = PillPeek.frame(size: size, beside: topRight, corner: .topLeft, in: narrow)
    XCTAssertEqual(clamped.maxX, narrow.maxX)
    // Where it cannot fit at all, it starts on screen.
    let tiny = NSRect(x: 0, y: 0, width: 200, height: 875)
    XCTAssertEqual(
      PillPeek.frame(size: size, beside: topRight, corner: .topLeft, in: tiny).minX, tiny.minX)
  }

  // MARK: - Helpers

  private func event(_ type: NSEvent.EventType, at point: NSPoint, _ window: PillWindow)
    -> NSEvent
  {
    NSEvent.mouseEvent(
      with: type, location: point, modifierFlags: [], timestamp: 0,
      windowNumber: window.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: 1)!
  }

  private func screenRect(_ view: NSView?, _ window: PillWindow) -> NSRect {
    guard let view else { return .zero }
    window.surface.layoutSubtreeIfNeeded()
    return window.panel.convertToScreen(view.convert(view.bounds, to: nil))
  }

  private func screenCenter(_ view: NSView?, _ window: PillWindow) -> NSPoint {
    screenRect(view, window).center
  }

  private func visible(_ view: NSView?) -> Bool {
    guard var view, !view.isHidden else { return false }
    while let parent = view.superview {
      if parent.isHidden { return false }
      view = parent
    }
    return true
  }

  private func visibleButton(_ button: NSButton) -> NSButton? {
    visible(button) ? button : nil
  }

  private func minimize(in view: NSView) -> NSButton? {
    buttons(in: view).first {
      $0 is PillButton && $0.accessibilityLabel() == "Minimize computer use status"
    }
  }

  private func stop(in view: NSView) -> NSButton? {
    buttons(in: view).first { $0.title == "Stop" }
  }

  private func button(_ label: String, in view: NSView) -> NSButton? {
    buttons(in: view).first { $0.accessibilityLabel() == label }
  }

  private func field(_ value: String, in view: NSView) -> NSTextField? {
    fields(in: view).first { $0.stringValue == value }
  }

  private func buttons(in view: NSView) -> [NSButton] {
    ((view as? NSButton).map { [$0] } ?? []) + view.subviews.flatMap(buttons(in:))
  }

  private func fields(in view: NSView) -> [NSTextField] {
    ((view as? NSTextField).map { [$0] } ?? []) + view.subviews.flatMap(fields(in:))
  }
}

extension NSRect {
  fileprivate var center: NSPoint { NSPoint(x: midX, y: midY) }
}
