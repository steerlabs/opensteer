import ApplicationServices
import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// `Stop` and the deadlines are honoured immediately before every write to
/// the app — after the reads a route makes to choose it, which can wait on an
/// app that is slow to answer — and a shortcut the menu index could not rule
/// out is never posted.
///
/// The Accessibility calls are fakes: each read below lands the stop part way
/// through, and the test sees that no write followed it.
final class StepCheckTests: XCTestCase {

  /// A handle that is never messaged: every call on it goes to the fakes.
  private let handle = AXUIElementCreateApplication(getpid())

  private final class Record: @unchecked Sendable {
    var writes: [String] = []
  }

  @WorkActor
  private func fakes(
    _ record: Record,
    menu: MenuShortcutIndex.Lookup = .none,
    focused: AXUIElement? = nil,
    during read: String? = nil,
    stop: @escaping () -> Void
  ) -> AccessibilityCalls {
    AccessibilityCalls(
      menuLookup: { _, _, _ in
        if read == "menu" { stop() }
        return menu
      },
      menuPath: { _ in ["File", "Save"] },
      isSettable: { _, attribute in
        if read == attribute { stop() }
        return true
      },
      focusedElement: { _ in
        if read == "focused" { stop() }
        return focused
      },
      window: { _ in 1 },
      attributes: { _ in ElementAttributes(role: "AXTextField", title: "Title") },
      press: { _ in
        record.writes.append("press")
        return .success
      },
      setAttribute: { _, attribute, _ in
        record.writes.append(attribute)
        return .success
      }, offersPress: { _ in false })
  }

  @WorkActor
  private func observed() -> AppSessionState {
    let app = hostApp(
      identity: AppIdentity(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app")
    let field = ObservedElement(
      node: AXElementNode(handle),
      attributes: ElementAttributes(role: "AXTextField", title: "Title"),
      frame: CGRect(x: 10, y: 10, width: 200, height: 24), depth: 0)
    app.latest = LatestObservation(
      observationId: "0123456789abcdef", processIdentifier: getpid(), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300),
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 400, height: 300)),
      elements: [field], takenAt: Date())
    return app
  }

  @WorkActor
  private func context(
    _ app: AppSessionState, _ calls: AccessibilityCalls, cancellation: SessionCancellation,
    budget: WorkBudget = .unlimited
  ) -> ActionRunner.Context {
    hostContext(
      app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
      budget: budget, accessibility: calls)
  }

  @WorkActor
  private var binding: ActionRunner.Binding {
    ActionRunner.Binding(
      processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300), onScreen: false)
  }

  @WorkActor
  private func assertStopped(
    _ work: () async throws -> String, _ record: Record, file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    do {
      let performed = try await work()
      XCTFail("Expected the stop to win, but it \(performed).", file: file, line: line)
    } catch {
      XCTAssertEqual((error as? HelperError)?.code, .stoppedByUser, file: file, line: line)
    }
    XCTAssertEqual(record.writes, [], "Nothing is written after the stop.", file: file, line: line)
  }

  @WorkActor
  func testAStopDuringTheMenuLookupPressesNothing() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    let calls = fakes(record, menu: .item(handle), during: "menu") {
      cancellation.cancel(.stoppedByUser)
    }
    await assertStopped(
      {
        try await ActionRunner.key(
          keys: "cmd+s", binding: self.binding, self.context(app, calls, cancellation: cancellation)
        )
      },
      record)
  }

  @WorkActor
  func testAStopWhileTheFocusIsInspectedFocusesNothing() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    let calls = fakes(record, during: kAXFocusedAttribute) { cancellation.cancel(.stoppedByUser) }
    await assertStopped(
      {
        try await ActionRunner.type(
          text: "Q4", target: .index(0), binding: self.binding,
          self.context(app, calls, cancellation: cancellation))
      }, record)
  }

  @WorkActor
  func testAStopWhileTheFocusedFieldIsReadTypesNothing() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    let calls = fakes(record, focused: handle, during: "focused") {
      cancellation.cancel(.stoppedByUser)
    }
    await assertStopped(
      {
        try await ActionRunner.type(
          text: "Q4", target: nil, binding: self.binding,
          self.context(app, calls, cancellation: cancellation))
      }, record)
  }

  @WorkActor
  func testAStopWhileSettabilityIsInspectedSetsNothing() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    let calls = fakes(record, during: kAXValueAttribute) { cancellation.cancel(.stoppedByUser) }
    await assertStopped(
      {
        try await ActionRunner.setValue(
          index: 0, value: "Q4", binding: self.binding,
          self.context(app, calls, cancellation: cancellation))
      }, record)
  }

  /// A deadline that passes while an app is slow to answer a read is
  /// honoured the same way.
  @WorkActor
  func testADeadlineThatPassesDuringAReadWritesNothing() async {
    let app = observed()
    let record = Record()
    let calls = fakes(record, during: kAXValueAttribute) { Thread.sleep(forTimeInterval: 0.05) }
    do {
      _ = try await ActionRunner.setValue(
        index: 0, value: "Q4", binding: binding,
        context(
          app, calls, cancellation: SessionCancellation(),
          budget: WorkBudget(requestEnd: Date().addingTimeInterval(0.01))))
      XCTFail("The deadline must win.")
    } catch {
      XCTAssertEqual(error as? HelperError, WorkBudget.requestExpired)
    }
    XCTAssertEqual(record.writes, [])
  }

  /// Without a stop, the same routes write, and say what they did.
  @WorkActor
  func testWithoutAStopEachRouteWritesOnceAndDescribesIt() async throws {
    let app = observed()
    let record = Record()
    let calls = fakes(record, menu: .item(handle), focused: handle) {}
    let context = context(app, calls, cancellation: SessionCancellation())
    let chose = try await ActionRunner.key(keys: "cmd+s", binding: binding, context)
    XCTAssertEqual(chose, "Chose File › Save")
    let set = try await ActionRunner.setValue(index: 0, value: "Q4", binding: binding, context)
    XCTAssertEqual(set, #"Set "Title" to "Q4""#)
    let typed = try await ActionRunner.type(
      text: "Venue shortlist", target: .index(0), binding: binding, context)
    XCTAssertEqual(typed, #"Typed "Venue shortlist" into "Title""#)
    XCTAssertEqual(
      record.writes,
      ["press", kAXValueAttribute, kAXFocusedAttribute, kAXSelectedTextAttribute])
  }

  // MARK: - What the person sees for a write

  @MainActor
  private final class FeedbackRecorder: ActionFeedback {
    let record: Record
    init(_ record: Record) { self.record = record }
    func show(_ feedback: OverlayFeedback, in app: AppSessionState) {
      record.writes.append("show \(feedback)")
    }
  }

  @WorkActor
  private func feedbackContext(
    _ app: AppSessionState, _ calls: AccessibilityCalls, _ record: Record,
    cancellation: SessionCancellation
  ) async -> ActionRunner.Context {
    let recorder = await MainActor.run { FeedbackRecorder(record) }
    return hostContext(
      app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
      budget: .unlimited, accessibility: calls, feedback: recorder)
  }

  @WorkActor
  private var onScreenBinding: ActionRunner.Binding {
    ActionRunner.Binding(
      processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 400, height: 300), onScreen: true)
  }

  /// `Stop` during the pointer's travel: no ripple for a press that never
  /// comes.
  @WorkActor
  func testAStopDuringTravelShowsNoRippleForThePress() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    var calls = fakes(record) {}
    calls.offersPress = { _ in true }
    let context = await feedbackContext(app, calls, record, cancellation: cancellation)
    cancellation.cancel(.stoppedByUser)
    await assertStopped(
      {
        try await ActionRunner.click(
          target: .index(0), button: .left, count: 1, binding: self.onScreenBinding, context)
      }, record)
  }

  @WorkActor
  func testAPressShowsItsRippleImmediatelyBeforeIt() async throws {
    let app = observed()
    let record = Record()
    var calls = fakes(record) {}
    calls.offersPress = { _ in true }
    let context = await feedbackContext(app, calls, record, cancellation: SessionCancellation())
    let clicked = try await ActionRunner.click(
      target: .index(0), button: .left, count: 1, binding: onScreenBinding, context)
    XCTAssertEqual(clicked, #"Clicked "Title""#)
    XCTAssertEqual(record.writes, ["show click", "press"])
  }

  @WorkActor
  func testAStopBeforeAScrollTickShowsNoNudge() async {
    let app = observed()
    let record = Record()
    let cancellation = SessionCancellation()
    let context = await feedbackContext(
      app, fakes(record) {}, record, cancellation: cancellation)
    cancellation.cancel(.stoppedByUser)
    await assertStopped(
      {
        try await ActionRunner.scroll(
          target: .index(0), direction: .down, amount: 3, binding: self.onScreenBinding,
          context)
      }, record)
  }

  // MARK: - Secure fields

  /// Every read answers for `handle`, the element the batch names; `other`
  /// is what the app reports as focused once it is focused.
  @WorkActor
  private func focusFakes(
    _ record: Record, focused: AXUIElement?,
    attributes: @escaping (AXUIElement) -> ElementAttributes
  ) -> AccessibilityCalls {
    var calls = fakes(record, focused: focused) {}
    calls.attributes = attributes
    return calls
  }

  /// Focusing the named field can land in another one — a password field
  /// that took the focus — and the text is then only counted.
  @WorkActor
  func testTextThatLandsInAFocusedSecureFieldIsCounted() async throws {
    let app = observed()
    let record = Record()
    let other = AXUIElementCreateSystemWide()
    let calls = focusFakes(record, focused: other) { element in
      CFEqual(element, other)
        ? ElementAttributes(role: "AXTextField", subrole: "AXSecureTextField")
        : ElementAttributes(role: "AXTextField", title: "Title")
    }
    let typed = try await ActionRunner.type(
      text: "hunter22", target: .index(0), binding: binding,
      context(app, calls, cancellation: SessionCancellation()))
    XCTAssertEqual(typed, #"Typed 8 characters into "Title""#)
  }

  /// A field observed as plain text that now reports itself secure.
  @WorkActor
  func testAValueSetIntoAFieldThatIsNowSecureIsCounted() async throws {
    let app = observed()
    let record = Record()
    let calls = focusFakes(record, focused: nil) { _ in
      ElementAttributes(role: "AXSecureTextField", title: "Title")
    }
    let set = try await ActionRunner.setValue(
      index: 0, value: "s3cret", binding: binding,
      context(app, calls, cancellation: SessionCancellation()))
    XCTAssertEqual(set, #"Set "Title" to 6 characters"#)
  }

  // MARK: - Shortcuts the menus could not rule out

  @WorkActor
  func testAShortcutAnIncompleteIndexCannotRuleOutIsRefusedAndPlainKeysGoOut() throws {
    for keys in ["cmd+s", "ctrl+a", "alt+x", "shift+cmd+t", "ctrl+tab"] {
      XCTAssertThrowsError(
        try ActionRunner.keyRoute(.unverified, combo: try KeyComboParser.parse(keys)), keys
      ) { error in
        XCTAssertEqual(error as? HelperError, ActionRunner.unverifiedShortcut, keys)
      }
    }
    for keys in ["enter", "tab", "shift+tab", "escape", "left", "a", "shift+a", "f5", "fn+up"] {
      guard
        case .keystroke = try ActionRunner.keyRoute(
          .unverified, combo: try KeyComboParser.parse(keys))
      else { return XCTFail("\(keys) is typing, not a shortcut.") }
    }
    // A complete index lets a shortcut no menu has go out as a keystroke, and
    // a reserved one is refused either way.
    guard
      case .keystroke = try ActionRunner.keyRoute(.none, combo: try KeyComboParser.parse("cmd+s"))
    else { return XCTFail("A verified-absent shortcut is a keystroke.") }
    XCTAssertThrowsError(
      try ActionRunner.keyRoute(.reserved, combo: try KeyComboParser.parse("cmd+s")))
  }

  @WorkActor
  func testAnUnverifiedShortcutIsRefusedBeforeAnythingIsPosted() async {
    let app = observed()
    let record = Record()
    let calls = fakes(record, menu: .unverified) {}
    do {
      _ = try await ActionRunner.key(
        keys: "cmd+shift+t", binding: binding,
        context(app, calls, cancellation: SessionCancellation()))
      XCTFail("An unverified shortcut must be refused.")
    } catch {
      XCTAssertEqual(error as? HelperError, ActionRunner.unverifiedShortcut)
    }
    XCTAssertEqual(record.writes, [])
  }

  /// A menu bar that did not answer leaves the index incomplete; an app that
  /// has none has nothing to find.
  func testAnUnreadableMenuBarLeavesTheIndexIncomplete() {
    XCTAssertFalse(MenuShortcutIndex.withoutMenuBar(.cannotComplete).complete)
    XCTAssertFalse(MenuShortcutIndex.withoutMenuBar(.apiDisabled).complete)
    XCTAssertFalse(MenuShortcutIndex.withoutMenuBar(.failure).complete)
    XCTAssertTrue(MenuShortcutIndex.withoutMenuBar(.noValue).complete)
    XCTAssertTrue(MenuShortcutIndex.withoutMenuBar(.attributeUnsupported).complete)
    guard
      case .unverified = MenuShortcutIndex.lookup(
        "cmd+shift+t", in: MenuShortcutIndex.withoutMenuBar(.cannotComplete))
    else { return XCTFail("An unread menu bar cannot rule a shortcut out.") }
    guard
      case .none = MenuShortcutIndex.lookup(
        "cmd+shift+t", in: MenuShortcutIndex.withoutMenuBar(.noValue))
    else { return XCTFail("An app with no menu bar has no menu shortcut.") }
  }

  /// An index that ran out of time is incomplete: what it did not read may
  /// hold a service. What it did read still answers.
  func testAnIndexThatRanOutOfTimeCannotRuleAShortcutOut() {
    final class Menu {
      let info: MenuShortcutIndex.ItemInfo?
      let children: [Menu]
      init(_ info: MenuShortcutIndex.ItemInfo? = nil, _ children: [Menu] = []) {
        self.info = info
        self.children = children
      }
    }
    func item(_ title: String, _ keys: String) -> Menu {
      Menu(MenuShortcutIndex.ItemInfo(combo: try? KeyComboParser.parse(keys), title: title))
    }
    let file = Menu(nil, [Menu(nil, (0..<10).map { item("Item \($0)", "cmd+\($0)") })])
    let bar = Menu(nil, [Menu(nil, [Menu(nil, [])]), Menu(nil, [Menu(nil, [])]), file])
    var clock = Date(timeIntervalSince1970: 0)
    let partial = MenuShortcutIndex.collect(
      menuBar: bar, children: { $0.children },
      read: { menu in
        clock.addTimeInterval(1)
        return menu.info
      },
      deadline: Date(timeIntervalSince1970: 4), now: { clock })
    XCTAssertFalse(partial.complete)
    guard case .item = MenuShortcutIndex.lookup("cmd+0", in: partial) else {
      return XCTFail("What was read still answers.")
    }
    guard case .unverified = MenuShortcutIndex.lookup("cmd+9", in: partial) else {
      return XCTFail("What was not read cannot be ruled out.")
    }

    let whole = MenuShortcutIndex.collect(
      menuBar: bar, children: { $0.children }, read: { $0.info }, deadline: .distantFuture)
    XCTAssertTrue(whole.complete)
    guard case .none = MenuShortcutIndex.lookup("cmd+shift+t", in: whole) else {
      return XCTFail("A complete index rules an absent shortcut out.")
    }
  }
}

extension StepCheckTests {
  @WorkActor
  func testSavedTypingRefusesControlsBeforeFocusAndUsesFixedReceipt() async throws {
    let app = observed()
    let record = Record()
    let calls = fakes(record, focused: handle) {}
    let context = context(app, calls, cancellation: SessionCancellation())
    for text in ["a\rb", "a\nb", "a\tb"] {
      do {
        _ = try await ActionRunner.type(
          text: text, target: .index(0), binding: binding,
          context, savedField: .password)
        XCTFail("Saved controls must refuse before focusing.")
      } catch { XCTAssertEqual(record.writes, []) }
    }
    let receipt = try await ActionRunner.type(
      text: "雪😀", target: .index(0), binding: binding,
      context, savedField: .username)
    XCTAssertEqual(receipt, "Typed saved username")
    XCTAssertEqual(record.writes, [kAXFocusedAttribute, kAXSelectedTextAttribute])
  }

  @WorkActor
  func testSavedInputRechecksReceiverAfterAccessibilityRead() async {
    let app = observed()
    let record = Record()
    let active = Locked<Bool>(true)
    let calls = fakes(record, focused: handle, during: "focused") { active.withLock { $0 = false } }
    let context = context(app, calls, cancellation: SessionCancellation())
    do {
      _ = try await ActionRunner.type(
        text: "synthetic", target: nil, binding: binding,
        context, savedField: .password,
        savedCheck: {
          if !active.current { throw HelperError(.unsupported, "Saved login text is unavailable.") }
        })
      XCTFail("Receiver loss during a read must win.")
    } catch { XCTAssertEqual(record.writes, []) }
  }
}
