import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class HelperCoreContractTests: XCTestCase {
  private func app(_ bundleId: String) -> AppSessionState {
    hostApp(
      identity: AppIdentity(bundleId: bundleId, displayName: bundleId, teamId: nil),
      path: "/Applications/Fixture.app")
  }

  @MainActor
  func testSessionsOpenIndependentlyAndClaimAppsOnlyOnUse() throws {
    let registry = SessionRegistry()
    let first = HelperSession(sessionId: "first", connectionID: 1)
    let second = HelperSession(sessionId: "second", connectionID: 2)
    let notes = app("com.apple.Notes")
    let otherNotes = app("COM.APPLE.NOTES")
    let calendar = app("com.apple.iCal")
    registry.insert(first)
    registry.insert(second)
    XCTAssertEqual(registry.sessions.count, 2)
    XCTAssertTrue(registry.owners.isEmpty)
    try registry.claim(notes, for: first)
    try registry.claim(calendar, for: second)
    try registry.claim(notes, for: first)
    XCTAssertThrowsError(try registry.claim(otherNotes, for: second)) { error in
      XCTAssertEqual(error as? HelperError, SessionRegistry.busy)
    }
    XCTAssertThrowsError(try registry.requireAvailable("com.apple.notes", for: second))
    registry.remove(first.sessionId, reason: .closed)
    XCTAssertEqual(first.cancellation.reason, .closed)
    try registry.claim(otherNotes, for: second)
    XCTAssertEqual(registry.owners.count, 2)
    XCTAssertThrowsError(try registry.claim(notes, for: first))
  }

  /// A session declares nothing: the app a call names joins the session on
  /// first use, once the deny list, the access and the claim allow it, and a
  /// refusal leaves the session exactly as it was.
  @MainActor
  func testTheAppACallNamesIsEnforcedOnEveryCall() async throws {
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    let mine = HelperSession(sessionId: "mine", connectionID: 1)
    let other = HelperSession(sessionId: "other", connectionID: 2)
    runtime.registry.insert(mine)
    runtime.registry.insert(other)

    let terminal = AppIdentity(
      bundleId: "com.apple.Terminal", displayName: "Terminal", teamId: nil)
    do {
      _ = try await runtime.appState(
        mine, SessionApp(access: .readWrite, identity: terminal), needsControl: false)
      XCTFail("A denied app is refused on every call.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .appNotAllowed) }

    let held = app("com.example.Held")
    other.add(held, access: .readWrite)
    try runtime.registry.claim(held, for: other)
    do {
      _ = try await runtime.appState(
        mine, SessionApp(access: .read, identity: held.identity), needsControl: false)
      XCTFail("An app another session holds is busy.")
    } catch let error as HelperError { XCTAssertEqual(error, SessionRegistry.busy) }

    let cached = app("com.example.Mine")
    mine.add(cached, access: .readWrite)
    try runtime.registry.claim(cached, for: mine)
    do {
      _ = try await runtime.appState(
        mine, SessionApp(access: .read, identity: cached.identity), needsControl: true)
      XCTFail("Acting needs Can see and control.")
    } catch let error as HelperError { XCTAssertEqual(error, HelperRuntime.readOnly) }
    XCTAssertEqual(mine.access[cached.key], .readWrite, "A refusal changes nothing.")

    // The same identity again is the same app state; its access follows the
    // latest call, which is what the pill reads.
    let again = try await runtime.appState(
      mine, SessionApp(access: .read, identity: cached.identity), needsControl: false)
    XCTAssertTrue(again === cached)
    XCTAssertEqual(mine.access[cached.key], .read)

    // A different identity for the same bundle is resolved again against the
    // installed app, and here there is none.
    do {
      _ = try await runtime.appState(
        mine,
        SessionApp(
          access: .read,
          identity: AppIdentity(
            bundleId: "com.example.Mine", displayName: "Renamed", teamId: "TEAM000001")),
        needsControl: false)
      XCTFail("An identity with no installed app behind it is refused.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .appNotFound) }
    XCTAssertTrue(mine.app("com.example.Mine") === cached)
    XCTAssertEqual(Set(mine.apps.keys), ["com.example.mine"])
  }

  /// The eight-app cap counts the apps a session has used, not declared.
  @MainActor
  func testASessionUsesAtMostEightApps() async throws {
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    let session = HelperSession(sessionId: "full", connectionID: 1)
    runtime.registry.insert(session)
    for index in 0..<HelperRuntime.maxSessionApps {
      session.add(app("com.example.App\(index)"), access: .read)
    }
    do {
      _ = try await runtime.appState(
        session,
        SessionApp(
          access: .read,
          identity: AppIdentity(bundleId: "com.example.Ninth", displayName: "Ninth", teamId: nil)),
        needsControl: false)
      XCTFail("A ninth app is refused.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .unsupported) }
  }

  /// The first use of an installed app resolves it from the carried identity
  /// and claims it; nothing is launched or read from the app itself.
  @MainActor
  func testFirstUseResolvesTheCarriedIdentityAgainstTheInstalledApp() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let bundle = root.appendingPathComponent("Fixture.app")
    try FileManager.default.createDirectory(
      at: bundle.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let info: [String: String] = [
      "CFBundleIdentifier": "com.apple.finder", "CFBundleName": "Fixture",
      "CFBundleExecutable": "Fixture",
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(
      to: bundle.appendingPathComponent("Contents/Info.plist"))
    let catalog = AppCatalog(roots: [root], bundles: [bundle])
    let record = try await catalog.resolve(query: "com.apple.finder")
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser, catalog: catalog)
    defer { runtime.stop() }
    let session = HelperSession(sessionId: "finder", connectionID: 1)
    runtime.registry.insert(session)
    let state = try await runtime.appState(
      session, SessionApp(access: .read, identity: record.identity), needsControl: false)
    XCTAssertEqual(state.path, record.path)
    XCTAssertEqual(runtime.registry.owners["com.apple.finder"], "finder")
    XCTAssertTrue(session.app("com.apple.finder") === state)
  }

  @MainActor
  func testStopClosesEverySessionAndIdleExpiryRemainsPerSession() throws {
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    let first = HelperSession(sessionId: "first", connectionID: 1)
    let second = HelperSession(sessionId: "second", connectionID: 2)
    let third = HelperSession(sessionId: "third", connectionID: 2)
    runtime.registry.insert(first)
    runtime.registry.insert(second)
    runtime.registry.insert(third)
    first.lastUsedAt = Date().addingTimeInterval(-HelperRuntime.sessionIdleTimeout - 1)
    runtime.expireIdleSession()
    XCTAssertEqual(first.cancellation.reason, .closed)
    XCTAssertEqual(runtime.registry.sessions.count, 2)
    runtime.stopFromOverlay()
    XCTAssertTrue(runtime.registry.sessions.isEmpty)
    XCTAssertTrue(runtime.registry.owners.isEmpty)
    XCTAssertEqual(second.cancellation.reason, .stoppedByUser)
    XCTAssertEqual(third.cancellation.reason, .stoppedByUser)
  }

  @MainActor
  func testLockedMacReturnsExactUnsupportedSentence() throws {
    XCTAssertNoThrow(try HelperRuntime.requireUnlocked(locked: false))
    XCTAssertThrowsError(try HelperRuntime.requireUnlocked(locked: true)) { error in
      XCTAssertEqual(
        error as? HelperError,
        HelperError(.unsupported, "The Mac is locked; ask the person to unlock it."))
    }
  }

  @WorkActor
  func testObserveLaunchesOnceAndWaitsForAWindow() async throws {
    var launched = 0
    var polls = 0
    let result = try await AppLaunch.ensureRunning(
      running: {
        if launched == 0 { throw HelperError(.appNotRunning, "Not running.") }
        return 42
      },
      launch: { launched += 1 },
      windowReady: { pid in
        XCTAssertEqual(pid, 42)
        polls += 1
        return polls == 2
      }, check: {})
    XCTAssertEqual(
      result, AppLaunch.Result(processIdentifier: 42, launched: true, broughtForward: false))
    XCTAssertEqual(launched, 1)
    XCTAssertEqual(polls, 2)
  }

  /// Safari, Messages or Preview running with every window closed is the same
  /// case as an app that is not running: open it in the background, wait for
  /// its window, observe.
  @WorkActor
  func testARunningAppWithNoWindowIsOpenedLikeOneThatIsNotRunning() async throws {
    var launched = 0
    var polls = 0
    let result = try await AppLaunch.ensureRunning(
      running: { 42 },
      launch: { launched += 1 },
      windowReady: { _ in
        polls += 1
        return launched == 1
      }, check: {})
    XCTAssertEqual(result.processIdentifier, 42)
    XCTAssertTrue(result.launched)
    XCTAssertEqual(launched, 1)
    XCTAssertEqual(polls, 2)
  }

  @WorkActor
  func testAHiddenAppWaitsForItsWindowWithoutReopening() async throws {
    var reads = 0
    let result = try await AppLaunch.ensureRunning(
      running: { 42 },
      launch: { XCTFail("Reopening a hidden app would show it to the person.") },
      windowReady: { _ in
        reads += 1
        return reads == 2
      },
      hidden: { _ in true },
      check: {})
    XCTAssertEqual(
      result, AppLaunch.Result(processIdentifier: 42, launched: false, broughtForward: false))

    do {
      _ = try await AppLaunch.ensureRunning(
        running: { 42 },
        launch: { XCTFail("A hidden app must never be reopened.") },
        windowReady: { _ in false },
        hidden: { _ in true },
        check: {}, timeout: 0.02)
      XCTFail("A hidden app with no accessible window must be refused.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .unsupported)
    }
  }

  /// A window already on this Space, of an app that is not hidden, is not
  /// hiding or moving: its Accessibility is still starting, as Chrome's can for
  /// seconds after the manual-Accessibility opt-in (VM job
  /// 20261028T220607Z-3c8c4c97). It is waited for, never reopened, and a window
  /// that never becomes readable fails as retryable rather than asking the
  /// person to show a window they can see.
  @WorkActor
  func testAWindowOnThisSpaceWhoseAccessibilityIsStartingIsWaitedFor() async throws {
    let reads = Locked(0)
    let result = try await AppLaunch.ensureRunning(
      running: { 42 },
      launch: { XCTFail("A window on this Space must not be reopened.") },
      windowReady: { _ in reads.withLock { $0 += 1; return $0 >= 3 } },
      windowExists: { _ in true }, windowOnScreen: { _ in true },
      check: {}, timeout: 1, settle: 0.05)
    XCTAssertEqual(
      result, AppLaunch.Result(processIdentifier: 42, launched: false, broughtForward: false))

    do {
      _ = try await AppLaunch.ensureRunning(
        running: { 42 },
        launch: { XCTFail("A window on this Space must not be reopened.") },
        windowReady: { _ in false },
        windowExists: { _ in true }, windowOnScreen: { _ in true },
        check: {}, timeout: 0.15, settle: 0.05)
      XCTFail("A window that never becomes readable must be refused.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .failed)
      XCTAssertFalse(error.message.contains("ask the person to show it"))
    }
  }

  @WorkActor
  func testAnExistingWindowOnAnotherSpaceIsNotReopened() async throws {
    do {
      _ = try await AppLaunch.ensureRunning(
        running: { 42 },
        launch: { XCTFail("An existing window must not be moved to this Space.") },
        windowReady: { _ in false },
        windowExists: { _ in true },
        check: {}, timeout: 0.02)
      XCTFail("A window unavailable to Accessibility must be refused.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .unsupported)
      XCTAssertTrue(error.message.contains("Accessibility cannot read"))
    }
  }

  /// Opening never activates. An app that comes to the front while it is
  /// being opened did so itself, and the observation says so.
  @WorkActor
  func testAnAppThatActivatesItselfOnLaunchIsReportedAsBroughtForward() async throws {
    var launched = false
    var front: pid_t = 7
    let result = try await AppLaunch.ensureRunning(
      running: {
        if !launched { throw HelperError(.appNotRunning, "Not running.") }
        return 42
      },
      launch: {
        launched = true
        front = 42
      },
      windowReady: { _ in launched },
      frontmost: { front },
      check: {})
    XCTAssertTrue(result.broughtForward)

    // Already in front before the reopen — the person was using it — is not
    // something observe did.
    var reopened = false
    let alreadyFront = try await AppLaunch.ensureRunning(
      running: { 42 }, launch: { reopened = true }, windowReady: { _ in reopened },
      frontmost: { 42 }, check: {})
    XCTAssertTrue(alreadyFront.launched)
    XCTAssertFalse(alreadyFront.broughtForward)

    let monitor = WindowMonitor()
    // noteLaunch creates AppFocusState itself; activation bookkeeping needs no AX watch.
    monitor.noteLaunch(processIdentifier: 42, broughtForward: true)
    XCTAssertTrue(monitor.state(of: 42).focusChangedByHelper)
    monitor.noteLaunch(processIdentifier: 43, broughtForward: false)
    XCTAssertFalse(monitor.state(of: 43).focusChangedByHelper)
    // An activation arriving just after the launch is counted the same way.
    monitor.noteActivation(processIdentifier: 43, frontmost: { 7 })
    XCTAssertFalse(monitor.state(of: 43).focusChangedByHelper)
    monitor.noteActivation(processIdentifier: 43, frontmost: { 43 })
    XCTAssertTrue(monitor.state(of: 43).focusChangedByHelper)
  }

  @WorkActor
  func testObserveDoesNotLaunchARunningAppWithAWindowOrAMismatchedApp() async throws {
    let result = try await AppLaunch.ensureRunning(
      running: { 42 },
      launch: { XCTFail("A running app with a window must not be opened again.") },
      windowReady: { _ in true },
      check: {})
    XCTAssertEqual(
      result, AppLaunch.Result(processIdentifier: 42, launched: false, broughtForward: false))
    do {
      _ = try await AppLaunch.ensureRunning(
        running: { throw HelperError(.appNotAllowed, "Identity mismatch.") },
        launch: { XCTFail("An identity mismatch must not launch.") },
        windowReady: { _ in true }, check: {})
      XCTFail("Identity mismatch must propagate.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .appNotAllowed) }
  }

  @WorkActor
  func testLaunchWindowWaitTimesOutAndHonorsStop() async throws {
    var launched = false
    do {
      _ = try await AppLaunch.ensureRunning(
        running: {
          if !launched { throw HelperError(.appNotRunning, "Not running.") }
          return 42
        }, launch: { launched = true }, windowReady: { _ in false }, check: {}, timeout: 0)
      XCTFail("No window must time out.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .failed)
      XCTAssertEqual(error.message, "The app did not open a window within ten seconds.")
    }
    let cancellation = SessionCancellation()
    do {
      _ = try await AppLaunch.ensureRunning(
        running: { throw HelperError(.appNotRunning, "Not running.") },
        launch: { cancellation.cancel(.stoppedByUser) }, windowReady: { _ in false },
        check: { try cancellation.check() })
      XCTFail("Stop must cancel the window wait.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .stoppedByUser) }
  }

  /// The wait after turning on `AXManualAccessibility` ends as soon as the
  /// tree has grown and held, and never runs past its bound.
  @WorkActor
  func testManualAccessibilityWaitIsBoundedAndEndsWhenTheTreeSettles() async {
    var clock = Date(timeIntervalSince1970: 0)
    let advance: (TimeInterval) async -> Void = { clock.addTimeInterval($0) }

    let never = await ManualAccessibility.settle(
      count: { 3 }, now: { clock }, sleep: advance)
    XCTAssertEqual(never, 10)
    XCTAssertEqual(clock.timeIntervalSince1970, 1.0, accuracy: 1e-3)

    clock = Date(timeIntervalSince1970: 0)
    var samples = [3, 3, 40, 120, 120, 500]
    let settled = await ManualAccessibility.settle(
      count: { samples.removeFirst() }, now: { clock }, sleep: advance)
    XCTAssertEqual(settled, 4)
    XCTAssertEqual(samples, [500])
  }

  /// The shortcut index shares the window read's time budget: past it,
  /// nothing more is read and what was read is the index.
  /// A menu tree standing in for an app's menu bar.
  private final class Menu {
    let info: MenuShortcutIndex.ItemInfo?
    let children: [Menu]
    init(_ info: MenuShortcutIndex.ItemInfo? = nil, _ children: [Menu] = []) {
      self.info = info
      self.children = children
    }

    static func item(
      _ title: String, _ keys: String? = nil, enabled: Bool = true, submenu: [Menu]? = nil
    ) -> Menu {
      Menu(
        MenuShortcutIndex.ItemInfo(
          combo: keys.map { try! KeyComboParser.parse($0) }, enabled: enabled, title: title),
        submenu.map { [Menu(nil, $0)] } ?? [])
    }

    /// A menu bar item and the one menu under it.
    static func menu(_ items: [Menu]) -> Menu { Menu(nil, [Menu(nil, items)]) }
  }

  private static func menuBar(file: [Menu]) -> Menu {
    Menu(
      nil,
      [
        .menu([
          .item("About This Mac"), .item("Force Quit…", "alt+cmd+escape"),
          .item("Lock Screen", "ctrl+cmd+q"), .item("Log Out", "shift+cmd+q"),
        ]),
        .menu([
          .item("About Fixture"),
          .item("Dienste", submenu: [.item("New Terminal at Folder", "shift+cmd+t")]),
          .item("Hide Fixture", "cmd+h"), .item("Quit Fixture", "cmd+q"),
        ]),
        .menu(file),
        .menu([.item("Copy", "cmd+c", enabled: false), .item("Paste", "cmd+v")]),
      ])
  }

  /// The Apple menu and Services are never indexed and their shortcuts are
  /// reserved, so Log Out, Lock Screen, Force Quit and a service cannot be
  /// reached by `key`; a disabled item is left to the keystroke a person
  /// would press.
  @WorkActor
  func testTheShortcutIndexNeverReachesTheAppleMenuOrServices() {
    let bar = Self.menuBar(file: [
      .item("New", "cmd+n"), .item("Services", submenu: [.item("Mail Selection", "shift+cmd+i")]),
    ])
    let index = MenuShortcutIndex.collect(
      menuBar: bar, children: { $0.children }, read: { $0.info }, deadline: .distantFuture)
    XCTAssertEqual(Set(index.shortcuts.keys), ["cmd+h", "cmd+q", "cmd+n", "cmd+v"])
    XCTAssertEqual(
      index.reserved,
      ["alt+cmd+escape", "cmd+ctrl+q", "cmd+shift+q", "cmd+shift+t", "cmd+shift+i"])
    XCTAssertNil(index.shortcuts["cmd+c"], "A disabled item is not pressed.")
    XCTAssertFalse(index.reserved.contains("cmd+c"))
    for keys in ["alt+cmd+escape", "ctrl+cmd+q", "shift+cmd+q", "alt+shift+cmd+q"] {
      let combo = try! KeyComboParser.parse(keys)
      XCTAssertTrue(
        MenuShortcutIndex.systemReserved.contains(MenuShortcutIndex.key(for: combo)), keys)
    }
  }

  /// The shortcut index shares the window read's time budget: past it,
  /// nothing more is read and what was read is the index. The Apple menu and
  /// Services are read first, so their reservations are the last to be lost.
  @WorkActor
  func testTheShortcutIndexStopsAtItsBudget() {
    let bar = Self.menuBar(
      file: (0..<10).map { Menu.item("Item \($0)", "cmd+\($0)") })
    var clock = Date(timeIntervalSince1970: 0)
    var reads = 0
    let found = MenuShortcutIndex.collect(
      menuBar: bar,
      children: { $0.children },
      read: { menu in
        reads += 1
        clock.addTimeInterval(1)
        return menu.info
      },
      deadline: Date(timeIntervalSince1970: 12),
      now: { clock })
    XCTAssertEqual(reads, 12)
    XCTAssertTrue(found.reserved.contains("cmd+shift+q"))
    XCTAssertTrue(found.reserved.contains("cmd+shift+t"))
    XCTAssertNotNil(found.shortcuts["cmd+0"])
    XCTAssertNil(found.shortcuts["cmd+9"])

    let whole = MenuShortcutIndex.collect(
      menuBar: bar, children: { $0.children }, read: { $0.info }, deadline: .distantFuture)
    XCTAssertEqual(whole.shortcuts.count, 13)
  }

  @WorkActor
  func testPixelFramesAndTargetsRoundTripThroughCropAndScale() throws {
    let coordinates = ObservationCoordinates(
      cropOrigin: CGPoint(x: -20, y: -30), scale: 1.6,
      geometry: Observation.Geometry(width: 1440, height: 992))
    let frame = CGRect(x: 10, y: 20, width: 100, height: 50)
    let pixels = coordinates.pixelFrame(from: frame)
    XCTAssertEqual(pixels, CGRect(x: 48, y: 80, width: 160, height: 80))
    let center = coordinates.windowPoint(from: CGPoint(x: pixels.midX, y: pixels.midY))
    XCTAssertEqual(center, CGPoint(x: frame.midX, y: frame.midY))
    let state = app("com.example.App")
    state.latest = LatestObservation(
      observationId: "latest", processIdentifier: 42,
      windowID: 12, windowFrame: CGRect(x: 100, y: 200, width: 900, height: 620),
      coordinates: coordinates, elements: [], takenAt: Date())
    let binding = ActionRunner.Binding(
      processIdentifier: 42, windowID: 12,
      windowFrame: CGRect(x: 100, y: 200, width: 900, height: 620))
    let target = try ActionRunner.resolve(
      target: .point(CGPoint(x: 48, y: 80)),
      app: state, binding: binding)
    XCTAssertEqual(target.windowPoint, CGPoint(x: 10, y: 20))
    XCTAssertEqual(target.screenPoint, CGPoint(x: 110, y: 220))
    XCTAssertThrowsError(
      try ActionRunner.resolve(
        target: .point(CGPoint(x: 1440, y: 80)),
        app: state, binding: binding))
  }

  @WorkActor
  func testIndexedTargetsAnswerToTheSameScreenshotBoundAsPoints() throws {
    // The window is 100×50 points, captured whole at 2 pixels per point.
    let coordinates = ObservationCoordinates(
      cropOrigin: .zero, scale: 2, geometry: Observation.Geometry(width: 200, height: 100))
    func element(_ frame: CGRect) -> ObservedElement {
      let node = FakeElementNode.node("AXButton", frame: frame)
      return ObservedElement(node: node, attributes: node.attributes, frame: frame, depth: 0)
    }
    let state = app("com.example.App")
    state.latest = LatestObservation(
      observationId: "latest", processIdentifier: 42,
      windowID: 12, windowFrame: CGRect(x: 100, y: 200, width: 100, height: 50),
      coordinates: coordinates,
      elements: [
        // Both reach past the window's right edge; only the first's center does.
        element(CGRect(x: 80, y: 10, width: 60, height: 10)),
        element(CGRect(x: 85, y: 10, width: 20, height: 10)),
      ],
      takenAt: Date())
    let binding = ActionRunner.Binding(
      processIdentifier: 42, windowID: 12,
      windowFrame: CGRect(x: 100, y: 200, width: 100, height: 50))
    let outside = HelperError(.failed, "That point is outside the observation's screenshot.")

    XCTAssertThrowsError(
      try ActionRunner.resolve(target: .point(CGPoint(x: 220, y: 30)), app: state, binding: binding)
    ) { error in XCTAssertEqual(error as? HelperError, outside) }
    XCTAssertThrowsError(
      try ActionRunner.resolve(target: .index(0), app: state, binding: binding)
    ) { error in XCTAssertEqual(error as? HelperError, outside) }

    let inside = try ActionRunner.resolve(target: .index(1), app: state, binding: binding)
    XCTAssertEqual(inside.windowPoint, CGPoint(x: 95, y: 15))
    XCTAssertEqual(inside.screenPoint, CGPoint(x: 195, y: 215))
  }

  func testCatalogScansOneFolderLevelFiltersPaginatesAndRefreshesAMiss() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try makeApp(root.appendingPathComponent("Notes.app"), id: "example.notes", name: "Notes")
    try makeApp(
      root.appendingPathComponent("Setapp/Notebook.app"), id: "example.book", name: "Notebook")
    try makeApp(
      root.appendingPathComponent("Vendor/Deep/Hidden.app"), id: "hidden.deep", name: "Hidden")
    try makeApp(
      root.appendingPathComponent("Notes.app/Nested.app"), id: "hidden.nested", name: "Hidden")
    try makeApp(
      root.appendingPathComponent("Plugin.bundle/Contents/Nested.app"), id: "hidden.bundle",
      name: "Hidden")
    let catalog = AppCatalog(roots: [root])
    let records = await catalog.records()
    XCTAssertEqual(Set(records.map(\.identity.bundleId)), ["example.notes", "example.book"])
    let params = try JSONCoding.decoder.decode(
      Wire.InstalledAppsParams.self,
      from: Data(#"{"query":"NOTE","limit":1,"offset":1}"#.utf8))
    let result = await catalog.installed(params)
    XCTAssertEqual(result.total, 2)
    XCTAssertEqual(result.apps.map(\.identity.displayName), ["Notes"])
    XCTAssertNil(result.apps.first?.iconPng)
    XCTAssertEqual(AppCatalog.matching(records, query: "EXAMPLE.BOOK").count, 1)
    let beyond = try JSONCoding.decoder.decode(
      Wire.InstalledAppsParams.self,
      from: Data(#"{"query":"note","offset":99}"#.utf8))
    let empty = await catalog.installed(beyond)
    XCTAssertEqual(empty.total, 2)
    XCTAssertTrue(empty.apps.isEmpty)
    try makeApp(root.appendingPathComponent("Fresh.app"), id: "example.fresh", name: "Fresh")
    let cached = await catalog.records()
    XCTAssertEqual(cached.count, 2)
    let resolved = try await catalog.resolve(query: "example.fresh")
    XCTAssertEqual(resolved.identity.displayName, "Fresh")
    let refreshed = await catalog.records()
    XCTAssertEqual(refreshed.count, 3)
  }

  /// macOS installs `/Applications/Safari.app` as a symlink carrying the
  /// hidden flag. Skipping hidden files dropped Safari from the catalog.
  func testCatalogListsAHiddenFlaggedAppSymlinkAndSkipsDotFiles() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let elsewhere = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString)
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: elsewhere)
    }
    try makeApp(elsewhere.appendingPathComponent("Browser.app"), id: "example.browser", name: "B")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("Browser.app")
    try FileManager.default.createSymbolicLink(
      at: link, withDestinationURL: elsewhere.appendingPathComponent("Browser.app"))
    XCTAssertEqual(lchflags(link.path, UInt32(UF_HIDDEN)), 0)
    XCTAssertEqual(try link.resourceValues(forKeys: [.isHiddenKey]).isHidden, true)
    try makeApp(root.appendingPathComponent(".Old.app"), id: "example.old", name: "Old")
    try makeApp(elsewhere.appendingPathComponent("Single.app"), id: "example.single", name: "S")

    let catalog = AppCatalog(
      roots: [root], bundles: [elsewhere.appendingPathComponent("Single.app")])
    let records = await catalog.records()
    XCTAssertEqual(
      Set(records.map(\.identity.bundleId)), ["example.browser", "example.single"])
    // Listed where the person sees it: the symlink's own path, not its target.
    let listed = try XCTUnwrap(records.first { $0.identity.bundleId == "example.browser" }?.path)
    XCTAssertEqual(
      URL(fileURLWithPath: listed).deletingLastPathComponent().resolvingSymlinksInPath().path,
      root.resolvingSymlinksInPath().path)
  }

  /// The Mac's own catalog must hold the apps the elevated-risk list names:
  /// A menu shortcut index built for one observation is dropped by the next:
  /// apps rebuild their menus, and pressing a destroyed menu item would fail
  /// `key` for the rest of the session.
  @WorkActor
  func testANewObservationDropsTheMenuShortcutIndex() {
    let state = app("com.example.menus")
    _ = state.menuShortcuts.lookup(
      KeyCombo(modifiers: [.cmd], key: "s"),
      applicationElement: AXUIElementCreateApplication(getpid()))
    XCTAssertTrue(state.menuShortcuts.isBuilt)
    state.record(
      LatestObservation(
        observationId: "0123456789abcdef", processIdentifier: getpid(), windowID: 1,
        windowFrame: .zero,
        coordinates: ObservationCoordinates(
          cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 1, height: 1)),
        elements: [], takenAt: Date()))
    XCTAssertFalse(state.menuShortcuts.isBuilt)
    XCTAssertEqual(state.latest?.observationId, "0123456789abcdef")
  }

  /// Posted events to a hidden app are dropped silently; the refusal comes
  /// before anything is posted, and a shown app is unaffected.
  @WorkActor
  func testPostedInputToAHiddenAppIsRefusedBeforeAnythingIsPosted() {
    let hidden = ActionRunner.Binding(
      processIdentifier: 1, windowID: 1, windowFrame: .zero, onScreen: false, hidden: true)
    XCTAssertThrowsError(try ActionRunner.requireEventDelivery(hidden)) { error in
      XCTAssertEqual(error as? HelperError, ActionRunner.hiddenAppRefusal)
    }
    let shown = ActionRunner.Binding(
      processIdentifier: 1, windowID: 1, windowFrame: .zero, onScreen: false, hidden: false)
    XCTAssertNoThrow(try ActionRunner.requireEventDelivery(shown))
  }

  func testCaptureFailureStillDefinesPixelGeometryAndTreeFrames() async throws {
    let capture = await WindowCapture.render(
      cropPoints: CGRect(x: 80, y: 170, width: 900, height: 620),
      keyWindowFrame: CGRect(x: 100, y: 200, width: 800, height: 600),
      captureScale: 2,
      takeImage: { throw HelperError(.failed, "Capture failed.") })
    XCTAssertNil(capture.screenshot)
    // 900×620 points at 2× would be 1,800×1,240 pixels; the pixel budget holds
    // it to 1,292×890, and the tree follows that size.
    XCTAssertEqual(capture.coordinates.geometry, Observation.Geometry(width: 1292, height: 890))
    let node = FakeElementNode.node(
      "AXButton", title: "Save",
      frame: CGRect(x: 110, y: 220, width: 100, height: 50))
    let walk = ElementTreeWalker.walk(
      root: node,
      windowFrame: CGRect(x: 100, y: 200, width: 800, height: 600))
    let rendered = TreeFormatter.render(walk, coordinates: capture.coordinates)
    XCTAssertEqual(rendered.text, #"[0] button "Save" (43,72 144×72)"#)
  }

  @MainActor
  func testOnlyWindowChangesInThisAppInvalidateCapture() {
    let monitor = WindowMonitor()
    monitor.noteObservation(
      processIdentifier: 1, windowID: 10, window: AXUIElementCreateApplication(1))
    monitor.noteObservation(
      processIdentifier: 2, windowID: 20, window: AXUIElementCreateApplication(2))
    let revision = monitor.observationRevision(processIdentifier: 1)
    monitor.noteWindowEvent(
      processIdentifier: 2, kind: .destroyed(element: AXUIElementCreateApplication(2)))
    monitor.noteActivation(processIdentifier: 1, frontmost: { 1 })
    XCTAssertNil(monitor.observationError(since: revision, processIdentifier: 1))
    monitor.noteHelperInput(processIdentifier: 1)
    let afterInput = monitor.observationRevision(processIdentifier: 1)
    monitor.noteActivation(processIdentifier: 1, frontmost: { 1 })
    XCTAssertTrue(monitor.state(of: 1).focusChangedByHelper)
    XCTAssertNil(monitor.observationError(since: afterInput, processIdentifier: 1))
    monitor.noteWindowEvent(
      processIdentifier: 1, kind: .miniaturized(element: AXUIElementCreateApplication(1)))
    XCTAssertEqual(
      monitor.observationError(since: afterInput, processIdentifier: 1)?.code,
      .staleObservation)
  }

  private func makeApp(_ url: URL, id: String, name: String) throws {
    let contents = url.appendingPathComponent("Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(
      fromPropertyList: [
        "CFBundleIdentifier": id, "CFBundleName": name, "CFBundlePackageType": "APPL",
      ], format: .xml, options: 0)
    try data.write(to: contents.appendingPathComponent("Info.plist"))
  }
}
