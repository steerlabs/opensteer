import AppKit
import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

/// Opt-in because this is a real TCC integration check. CI and ordinary unit
/// runs report an explicit skip; a granted development Mac runs it with:
///
///   OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 swift test --filter BackgroundInputLiveTests
///
/// The fixture is a regular app opened in the background through
/// LaunchServices and never activated, so it is not active and its window is
/// not key — the state every app the person is not using is in.
final class BackgroundInputLiveTests: XCTestCase {
  private static let enabled =
    ProcessInfo.processInfo.environment["OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS"] == "1"

  /// The helper's `NSApplication` opens the window server connection on the
  /// main thread at launch, before the work executor captures anything; a
  /// test process has no application until one is made, and ScreenCaptureKit
  /// asserts when it is first used off the main thread without it.
  override func setUp() async throws {
    await MainActor.run { _ = NSApplication.shared }
  }

  /// Typing with a target lands in that field, typing without one follows
  /// the focus the batch left, and a point target is clicked then typed into
  /// — while the fixture never becomes active, its window never becomes key,
  /// the frontmost app stays frontmost and the system pointer does not move.
  @WorkActor
  func testTextOnlyObservationKeepsCoordinatesAndSupportsTheNextAction() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }

    let fixture = try await launchFixture()
    defer { fixture.stop() }
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }

    let observed = try await AppObserver.observe(
      app: state, monitor: monitor, includeScreenshot: false)
    XCTAssertNil(observed.screenshot)
    XCTAssertGreaterThan(observed.geometry.width, 0)
    XCTAssertGreaterThan(observed.geometry.height, 0)
    let latest = try XCTUnwrap(state.latest)
    let fields = latest.elements.enumerated()
      .filter { $0.element.attributes.role == "AXTextField" }
    let fieldB = try XCTUnwrap(fields.max { $0.element.frame.minY < $1.element.frame.minY })
    let result = try await ActionRunner.run(
      actions: [.type(text: "text only", target: .index(fieldB.offset))],
      app: state, observationId: observed.observationId,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    XCTAssertNil(result.error)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["b"] as? String) == "text only" })
    XCTAssertEqual(after["a"] as? String, "")
    let closing = try await AppObserver.observe(
      app: state, monitor: monitor, includeScreenshot: false)
    XCTAssertNil(closing.screenshot)
    XCTAssertTrue(closing.tree.contains("text only"))
  }

  @WorkActor
  func testTypingIntoABackgroundAppLandsInTheFieldItNames() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted else {
      throw XCTSkip("The test process does not have Accessibility permission.")
    }
    guard PrivateAPI.backgroundPointerDeliveryAvailable else {
      XCTFail("The explicitly enabled live test requires the targeted background pointer route.")
      return
    }

    let fixture = try await launchFixture()
    defer { fixture.stop() }
    let metadata = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let before = try await waitForJSON(fixture.output.appendingPathComponent("state.json"))
    let pid = pid_t(try XCTUnwrap(metadata["pid"] as? NSNumber).int32Value)
    XCTAssertEqual(pid, fixture.application.processIdentifier)
    XCTAssertEqual(before["active"] as? Bool, false, "The fixture must start in the background.")
    XCTAssertEqual(before["key"] as? Bool, false, "Its window must not be key.")
    let frontmostBefore = await MainActor.run {
      NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    XCTAssertNotEqual(frontmostBefore, pid)
    let pointerBefore = CGEvent(source: nil)?.location

    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }

    // With a target, then without one: the second follows the focus the
    // first left.
    var observed = try Self.observeWithoutPicture(state, pid: pid, monitor: monitor)
    let first = try await ActionRunner.run(
      actions: [
        .type(text: "typed into B", target: .index(observed.fieldB)),
        .type(text: " and more"),
      ],
      app: state,
      observationId: observed.id,
      cancellation: SessionCancellation(),
      monitor: monitor,
      overlay: nil
    )
    XCTAssertNil(first.error)
    XCTAssertEqual(first.performed.count, 2)
    var after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["b"] as? String) == "typed into B and more" })
    XCTAssertEqual(after["a"] as? String, "", "Nothing may land in the other field.")

    // A point target: clicked, then typed into.
    observed = try Self.observeWithoutPicture(state, pid: pid, monitor: monitor)
    let second = try await ActionRunner.run(
      actions: [.type(text: "typed into A", target: .point(observed.fieldACenter))],
      app: state,
      observationId: observed.id,
      cancellation: SessionCancellation(),
      monitor: monitor,
      overlay: nil
    )
    XCTAssertNil(second.error)
    XCTAssertEqual(second.performed.count, 1)
    after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["a"] as? String) == "typed into A" })
    XCTAssertEqual(after["b"] as? String, "typed into B and more")

    XCTAssertEqual(after["everActive"] as? Bool, false, "The fixture must never activate.")
    XCTAssertEqual(after["everKey"] as? Bool, false, "Its window must never become key.")
    let frontmostAfter = await MainActor.run {
      NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    XCTAssertNotEqual(frontmostAfter, pid)
    // The person may switch apps meanwhile; what matters is that the fixture
    // was never brought forward, which the fixture itself reports above.
    if frontmostAfter != frontmostBefore {
      print("The frontmost app changed during the test; the fixture never became active.")
    }
    assertPointerNotMovedToTarget(before: pointerBefore, target: observed.fieldAScreenCenter)
  }

  /// Text holding a Tab goes by keyboard: the keystrokes name the fixture's
  /// window, which is not key, and still reach its field — Tab moves focus
  /// from A to B, which selects B's text, and the rest replaces it.
  @WorkActor
  func testKeystrokesReachAWindowThatIsNotKey() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted else {
      throw XCTSkip("The test process does not have Accessibility permission.")
    }
    let fixture = try await launchFixture()
    defer { fixture.stop() }
    let metadata = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let pid = pid_t(try XCTUnwrap(metadata["pid"] as? NSNumber).int32Value)
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }

    var observed = try Self.observeWithoutPicture(state, pid: pid, monitor: monitor)
    let seeded = try await ActionRunner.run(
      actions: [.type(text: "old", target: .index(observed.fieldB))],
      app: state, observationId: observed.id, cancellation: SessionCancellation(),
      monitor: monitor, overlay: nil)
    XCTAssertNil(seeded.error)
    _ = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"), until: { ($0["b"] as? String) == "old" })

    observed = try Self.observeWithoutPicture(state, pid: pid, monitor: monitor)
    let result = try await ActionRunner.run(
      actions: [.type(text: "\tby keys", target: .index(observed.fieldA))],
      app: state, observationId: observed.id, cancellation: SessionCancellation(),
      monitor: monitor, overlay: nil)
    XCTAssertNil(result.error)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["b"] as? String) == "by keys" })
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["focus"] as? String, "B")
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertEqual(after["everKey"] as? Bool, false)
  }

  /// What `observe` records, read through Accessibility alone so the test
  /// needs no Screen Recording: the fixture's window at one pixel per point.
  private struct Observed {
    let id: String
    let fieldA: Int
    let fieldB: Int
    let fieldACenter: CGPoint
    let fieldAScreenCenter: CGPoint
  }

  @WorkActor
  private static func observeWithoutPicture(
    _ state: AppSessionState, pid: pid_t, monitor: WindowMonitor
  ) throws -> Observed {
    _ = try AppProcess.verify(state)
    state.processIdentifier = pid
    monitor.watch(processIdentifier: pid)
    let application = AXUIElementCreateApplication(pid)
    let window = try KeyWindow.resolve(applicationElement: application)
    let identity = try KeyWindow.identity(of: window, processIdentifier: pid)
    let walk = ElementTreeWalker.walk(root: AXElementNode(window), windowFrame: identity.frame)
    let fields = walk.elements.enumerated().filter { $0.element.attributes.role == "AXTextField" }
    guard fields.count == 2 else { throw HelperError(.failed, "The fixture has two fields.") }
    // Field A is the upper one; AppKit's y grows upwards, the tree's downwards.
    let fieldA = fields.min { $0.element.frame.minY < $1.element.frame.minY }!
    let fieldB = fields.max { $0.element.frame.minY < $1.element.frame.minY }!
    let id = Observation.newIdentifier()
    state.record(
      LatestObservation(
        observationId: id,
        processIdentifier: pid,
        windowID: identity.windowID,
        windowFrame: identity.frame,
        coordinates: ObservationCoordinates(
          cropOrigin: .zero, scale: 1,
          geometry: Observation.Geometry(
            width: Int(identity.frame.width), height: Int(identity.frame.height))),
        elements: walk.elements,
        windows: AppWindows.onScreen(processIdentifier: pid, within: identity.frame)
          .map(\.window),
        takenAt: Date()))
    monitor.noteObservation(processIdentifier: pid, windowID: identity.windowID, window: window)
    let center = CGPoint(x: fieldA.element.frame.midX, y: fieldA.element.frame.midY)
    return Observed(
      id: id, fieldA: fieldA.offset, fieldB: fieldB.offset,
      fieldACenter: CGPoint(x: center.x.rounded(), y: center.y.rounded()),
      fieldAScreenCenter: CGPoint(
        x: identity.frame.minX + center.x, y: identity.frame.minY + center.y))
  }

  /// The person may be moving their own pointer while this runs, so "the
  /// helper never moved it" is checked as "it did not jump to the target".
  @WorkActor
  private func assertPointerNotMovedToTarget(before: CGPoint?, target: CGPoint) {
    guard let after = CGEvent(source: nil)?.location, after != before else { return }
    XCTAssertGreaterThan(
      hypot(after.x - target.x, after.y - target.y), 2,
      "The system pointer moved to where the helper clicked.")
  }

  /// Cold Chromium and AppKit, with no task observation or pre-enabled AX tree.
  /// Records the native status rather than treating an AX error as an empty list.
  @WorkActor
  func testColdOwnerWindowBinding() async throws {
    guard Self.enabled else { throw XCTSkip("Enable live computer-use tests for controlled apps.") }
    let output = URL(fileURLWithPath:
      ProcessInfo.processInfo.environment["OPENSTEER_OWNER_VIEW_ARTIFACT_DIR"]
        ?? NSTemporaryDirectory() + "opensteer-owner-view-cold", isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    var trace: [[String: Any]] = [["accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess()]]
    func save() throws {
      try JSONSerialization.data(withJSONObject: trace, options: [.prettyPrinted, .sortedKeys])
        .write(to: output.appendingPathComponent("cold-ax.json"))
    }
    try save()
    guard AXIsProcessTrusted() else { throw XCTSkip("The dev XCTest binary lacks Accessibility; no grants changed. See cold-ax.json.") }
    let fixture = try await launchFixture()
    defer { fixture.stop() }
    _ = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let chromiumFixture = try await launchOwnerChromium()
    defer { chromiumFixture.stop() }
    let chromium = chromiumFixture.app
    let chrome = chromiumFixture.application
    for (name, url, pid) in [("appkit", fixture.app, fixture.application.processIdentifier), ("chromium", chromium, chrome.processIdentifier)] {
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
      func sample(_ phase: String) throws {
        var row: [String: Any] = ["app": name, "phase": phase, "pid": pid, "at": Observation.timestamp()]
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXWindowsAttribute] {
          var value: CFTypeRef?
          let status = AXUIElementCopyAttributeValue(app, attribute as CFString, &value)
          var ids: [UInt32] = []
          if let value, CFGetTypeID(value) == AXUIElementGetTypeID(),
            let id = KeyWindow.windowID(of: unsafeBitCast(value, to: AXUIElement.self)) { ids = [id] }
          else if let windows = value as? [AXUIElement] { ids = windows.compactMap { KeyWindow.windowID(of: $0) } }
          row[attribute] = ["status": status.rawValue, "windowIDs": ids]
          if row["selectedBy"] == nil, !ids.isEmpty { row["selectedBy"] = attribute }
        }
        if let selected = try? KeyWindow.resolve(applicationElement: app) {
          row["selectedWindowID"] = KeyWindow.windowID(of: selected)
          row["selectedFrameReadable"] = AXValueReader.copyFrame(selected) != nil
        }
        trace.append(row); try save()
      }
      try sample("cold")
      try await Task.sleep(nanoseconds: 1_000_000_000)
      try sample("cold+1s")
      let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: url.path))
      let target = try await OwnerViewWindow.open(record: record, cancellation: SessionCancellation(), budget: .unlimited)
      let refusal = OwnerViewWindow.unavailable(target)
      trace.append(["app": name, "phase": "owner-open-before-manual-AX", "selectedWindowID": target.target.windowID, "captureRefusal": refusal ?? "none"])
      try save()
      let status = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      trace.append(["app": name, "manualAccessibilityStatus": status.rawValue]); try save()
      for index in 0..<5 {
        try sample("manual+\(index * 250)ms")
        try await Task.sleep(nanoseconds: 250_000_000)
      }
      XCTAssertNil(refusal, "A window accepted by open must pass capture verification: \(name): \(refusal ?? "none")")
      if name == "chromium" {
        // A controlled unresponsive browser proves the legacy [] → waiting
        // branch with an actual AX status, without touching a person's app.
        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        do {
          defer { kill(pid, SIGCONT) }
          var value: CFTypeRef?
          let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
          let reason = OwnerViewWindow.unavailable(target)
          trace.append(["app": name, "phase": "controlled-SIGSTOP", "AXWindowsStatus": status.rawValue,
            "windowStillExists": KeyWindow.currentFrame(target.target.windowID) != nil,
            "legacyRefusal": "waiting", "bindingRefusal": reason ?? "none"])
          try save()
          XCTAssertNotEqual(status, .success)
          XCTAssertNil(reason, "Passive capture must not depend on an AX response after open.")
        }
        try await Task.sleep(nanoseconds: 300_000_000)
      }
      let selected = try KeyWindow.resolve(applicationElement: app)
      let close = try XCTUnwrap(AXValueReader.copyElement(selected, kAXCloseButtonAttribute))
      let closeStatus = AXUIElementPerformAction(close, kAXPressAction as CFString)
      try await Task.sleep(nanoseconds: 300_000_000)
      let closed = OwnerViewWindow.unavailable(target)
        ?? (KeyWindow.captureState(target.target.windowID, processIdentifier: pid) == nil ? "window-closed" : nil)
      trace.append(["app": name, "phase": "closed-exact-window", "closeStatus": closeStatus.rawValue,
        "bindingRefusal": closed ?? "none"])
      try save()
      XCTAssertEqual(closed, "window-closed")
    }
  }

  @WorkActor
  private func launchOwnerChromium() async throws -> Fixture {
    let chromiumSource = URL(fileURLWithPath: ProcessInfo.processInfo.environment["OPENSTEER_TEST_CHROMIUM_APP"]
      ?? NSHomeDirectory() + "/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app")
    guard FileManager.default.fileExists(atPath: chromiumSource.path) else { throw XCTSkip("Set OPENSTEER_TEST_CHROMIUM_APP to a controlled Chrome for Testing app.") }
    let chromiumRoot = FileManager.default.temporaryDirectory.appendingPathComponent("owner-chromium-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: chromiumRoot, withIntermediateDirectories: true)
    let chromium = chromiumRoot.appendingPathComponent(chromiumSource.lastPathComponent)
    try run("/usr/bin/ditto", [chromiumSource.path, chromium.path])
    let bundleID = try XCTUnwrap(Bundle(url: chromium)?.bundleIdentifier)
    if ProcessInfo.processInfo.environment["OPENSTEER_TEST_PRESERVE_CHROMIUM_SIGNATURE"] != "1" {
      try run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--identifier", bundleID, chromium.path])
    }
    let profile = chromiumRoot.appendingPathComponent("profile")
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--user-data-dir=" + profile.path, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "data:text/html,<title>Owner window fixture</title><h1>Controlled Chromium owner view</h1>"]
    let chrome = try await NSWorkspace.shared.openApplication(at: chromium, configuration: configuration)
    try await Task.sleep(nanoseconds: 2_000_000_000)
    return Fixture(root: chromiumRoot, app: chromium, output: profile, application: chrome)
  }

  /// Serves the production IPC protocol on a disposable socket for the Host →
  /// Runner → Desktop bridge journey. Never binds the installed helper socket.
  @WorkActor
  func testOwnerViewTransportServer() async throws {
    guard Self.enabled, let directory = ProcessInfo.processInfo.environment["OPENSTEER_OWNER_VIEW_SERVER_DIR"] else {
      throw XCTSkip("Set OPENSTEER_OWNER_VIEW_SERVER_DIR for the controlled transport journey.")
    }
    let output = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let grants: [String: Any] = ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    try JSONSerialization.data(withJSONObject: grants).write(to: output.appendingPathComponent("permissions.json"))
    guard Permissions.current().bothGranted else { throw XCTSkip("The dev XCTest binary needs Accessibility and Screen Recording; no grants changed.") }
    let frontBeforeLaunch = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
    let fixture = try await launchFixture()
    defer { fixture.stop() }
    _ = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let chromium = try await launchOwnerChromium()
    defer { chromium.stop() }
    let frontAfterLaunch = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
    try JSONSerialization.data(withJSONObject: ["before": frontBeforeLaunch, "after": frontAfterLaunch,
      "chromiumPID": chromium.application.processIdentifier, "broughtItselfForward": frontAfterLaunch == chromium.application.processIdentifier && frontBeforeLaunch != frontAfterLaunch], options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("launch-focus.json"))
    // Keep the short socket outside any real app support directory.
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("ow-" + UUID().uuidString.prefix(8), isDirectory: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }
    let socketURL = home.appendingPathComponent("Library/Application Support/Opensteer/Computer Use/ipc.sock")
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let products = package.appendingPathComponent(".build/debug")
    let executable = output.appendingPathComponent("OwnerViewHelper")
    let source = package.appendingPathComponent("Tests/Fixtures/OwnerViewHelper/OwnerViewHelper.swift")
    // SwiftPM's automatic libraries expose modules and target objects, not standalone archives.
    let objects = try ["ComputerUseCore", "OpensteerAppleData"].flatMap { target in
      try FileManager.default.contentsOfDirectory(
        at: products.appendingPathComponent("\(target).build"), includingPropertiesForKeys: nil
      ).filter { $0.pathExtension == "o" }.map(\.path).sorted()
    }
    try run("/usr/bin/xcrun", ["swiftc", "-I", products.appendingPathComponent("Modules").path,
      source.path] + objects + ["-o", executable.path])
    let helper = Process()
    helper.executableURL = executable
    helper.arguments = [socketURL.path, output.path, fixture.root.path, chromium.root.path]
    try helper.run()
    defer { if helper.isRunning { helper.terminate() } }
    let startup = Date().addingTimeInterval(10)
    while helper.isRunning, Date() < startup,
      !FileManager.default.fileExists(atPath: output.appendingPathComponent("helper-listening").path) {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    guard FileManager.default.fileExists(atPath: output.appendingPathComponent("helper-listening").path) else {
      throw XCTSkip("The standalone dev helper could not start. See helper-permissions.json and helper-error.txt; no grants changed.")
    }
    var apps: [[String: Any]] = []
    for (name, app) in [("appkit", fixture), ("chromium", chromium)] {
      let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: app.app.path))
      let ax = AXUIElementCreateApplication(app.application.processIdentifier)
      var attributes: [String: Any] = [:]
      for key in [kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXWindowsAttribute] {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(ax, key as CFString, &value)
        attributes[key] = ["status": status.rawValue]
      }
      let window = try KeyWindow.resolve(applicationElement: ax)
      apps.append(["name": name, "pid": app.application.processIdentifier,
        "windowID": try XCTUnwrap(KeyWindow.windowID(of: window)), "path": app.app.path, "ax": attributes,
        "identity": try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(record.identity))])
    }
    try JSONSerialization.data(withJSONObject: ["socket": socketURL.path, "home": home.path, "apps": apps], options: [.prettyPrinted, .sortedKeys])
      .write(to: output.appendingPathComponent("ready.json"))
    let deadline = Date().addingTimeInterval(300)
    while Date() < deadline, !FileManager.default.fileExists(atPath: output.appendingPathComponent("stop").path) {
      for file in try FileManager.default.contentsOfDirectory(at: output, includingPropertiesForKeys: nil)
        where file.lastPathComponent.hasPrefix("snapshot-") && file.pathExtension != "json" {
        let front = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
          .filter { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
          .compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
        let pointer = try XCTUnwrap(CGEvent(source: nil)?.location)
        try JSONSerialization.data(withJSONObject: ["frontmost": front, "windows": windows, "pointer": ["x": pointer.x, "y": pointer.y]], options: [.prettyPrinted, .sortedKeys])
          .write(to: file.appendingPathExtension("json"))
        try FileManager.default.removeItem(at: file)
      }
      for (name, app) in [("appkit", fixture), ("chromium", chromium)] {
        let minimize = output.appendingPathComponent("minimize-" + name)
        if FileManager.default.fileExists(atPath: minimize.path) {
          let ax = AXUIElementCreateApplication(app.application.processIdentifier)
          let window = try KeyWindow.resolve(applicationElement: ax)
          let status = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
          try JSONSerialization.data(withJSONObject: ["status": status.rawValue])
            .write(to: output.appendingPathComponent("minimized-" + name + ".json"))
          try FileManager.default.removeItem(at: minimize)
        }
        let flag = output.appendingPathComponent("close-" + name)
        if FileManager.default.fileExists(atPath: flag.path) {
          let ax = AXUIElementCreateApplication(app.application.processIdentifier)
          if let window = try? KeyWindow.resolve(applicationElement: ax),
            let button = AXValueReader.copyElement(window, kAXCloseButtonAttribute) {
            let status = AXUIElementPerformAction(button, kAXPressAction as CFString)
            try JSONSerialization.data(withJSONObject: ["status": status.rawValue])
              .write(to: output.appendingPathComponent("closed-" + name + ".json"))
          }
          try FileManager.default.removeItem(at: flag)
        }
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: output.appendingPathComponent("stop").path), "The transport driver must finish within 300 seconds.")
  }

  /// The receiver app, built, signed ad hoc and opened for one test.
  private struct Fixture {
    let root: URL
    let app: URL
    let output: URL
    let application: NSRunningApplication

    let process: ProcessStamp?

    init(root: URL, app: URL, output: URL, application: NSRunningApplication) {
      self.root = root
      self.app = app
      self.output = output
      self.application = application
      process = ProcessStamp.of(application.processIdentifier)
    }

    func stop() {
      // LaunchServices termination can refuse a copied Chromium bundle. Never
      // leave that fixture or a stopped process behind, and never signal a reused PID.
      if let process, process.isCurrent {
        kill(process.processIdentifier, SIGCONT)
        kill(process.processIdentifier, SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while process.isCurrent, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isCurrent { kill(process.processIdentifier, SIGKILL) }
      }
      try? FileManager.default.removeItem(at: root)
    }
  }

  /// Opened through LaunchServices without activation — the way the helper
  /// opens an app — so the fixture starts, and stays, in the background.
  @WorkActor
  private func launchFixture(_ extra: [String] = []) async throws -> Fixture {
    let manager = FileManager.default
    let identifier = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let bundleID = "com.opensteer.background-input-fixture.\(identifier)"
    let root = manager.temporaryDirectory.appendingPathComponent(
      identifier, isDirectory: true)
    let appURL = root.appendingPathComponent("Fixture.app", isDirectory: true)
    let executableURL = appURL.appendingPathComponent("Contents/MacOS/Fixture")
    let outputURL = root.appendingPathComponent("output", isDirectory: true)
    try manager.createDirectory(
      at: executableURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try manager.createDirectory(at: outputURL, withIntermediateDirectories: true)

    let source = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/BackgroundInputFixture/Receiver.swift")
    try run(
      "/usr/bin/xcrun", ["swiftc", source.path, "-o", executableURL.path, "-framework", "AppKit"])
    try Self.infoPlist(bundleID: bundleID).write(
      to: appURL.appendingPathComponent("Contents/Info.plist"),
      atomically: true,
      encoding: .utf8
    )
    try run(
      "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", bundleID, appURL.path])

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = [outputURL.path] + extra
    let application = try await NSWorkspace.shared.openApplication(
      at: appURL, configuration: configuration)
    return Fixture(root: root, app: appURL, output: outputURL, application: application)
  }

  /// Off the Space the person is looking at — another desktop, or a
  /// full-screen app's Space — a window is still observed and acted on in
  /// place: captured on its own, clicked and typed into by process- and
  /// window-addressed events, and the person's screen never switches.
  @WorkActor
  func testAWindowOnAnotherSpaceIsObservedAndActedOnWhereItIs() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }

    let fixture = try await launchFixture(["other-space"])
    defer { fixture.stop() }
    let metadata = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    guard let space = (metadata["space"] as? NSNumber)?.uint64Value, space != 0 else {
      throw XCTSkip("This Mac has only one desktop Space.")
    }
    let windowID = CGWindowID(try XCTUnwrap(metadata["windowID"] as? NSNumber).uint32Value)
    XCTAssertFalse(KeyWindow.isOnScreen(windowID), "The fixture window must be off this Space.")
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let pointerBefore = CGEvent(source: nil)?.location
    let observation: Observation
    do {
      observation = try await AppObserver.observe(app: state, monitor: monitor)
    } catch let error as HelperError
      where error.code == .unsupported && error.message.contains("Accessibility cannot read")
    {
      // macOS can list an off-Space window in CoreGraphics while AX exposes
      // only the app's menu bar. The helper must leave the window and Space
      // alone; there is no safe element to act on.
      let unchanged = try await waitForJSON(fixture.output.appendingPathComponent("state.json"))
      XCTAssertEqual(unchanged["a"] as? String, "")
      XCTAssertEqual(unchanged["b"] as? String, "")
      XCTAssertEqual(unchanged["everActive"] as? Bool, false)
      XCTAssertFalse(KeyWindow.isOnScreen(windowID))
      print(
        "Off-Space AX window unavailable; helper refused without reopening or changing the app.")
      return
    }
    let latest = try XCTUnwrap(state.latest)
    XCTAssertEqual(latest.windowID, windowID)
    XCTAssertNotNil(observation.screenshot, "An off-Space window is captured on its own.")
    let fields = latest.elements.enumerated()
      .filter { $0.element.attributes.role == "AXTextField" }
    XCTAssertEqual(fields.count, 2)
    let fieldB = try XCTUnwrap(fields.max { $0.element.frame.minY < $1.element.frame.minY })

    let result = try await ActionRunner.run(
      actions: [.type(text: "typed off Space", target: .index(fieldB.offset))],
      app: state,
      observationId: observation.observationId,
      cancellation: SessionCancellation(),
      monitor: monitor,
      overlay: nil
    )
    XCTAssertNil(result.error)
    XCTAssertEqual(result.performed.count, 1)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["b"] as? String) == "typed off Space" }
    )
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertFalse(KeyWindow.isOnScreen(windowID), "Acting must not bring the window here.")
    assertPointerNotMovedToTarget(
      before: pointerBefore,
      target: CGPoint(
        x: latest.windowFrame.minX + fieldB.element.frame.midX,
        y: latest.windowFrame.minY + fieldB.element.frame.midY))
  }

  /// A hidden app (Command-H) is still read through Accessibility, but the
  /// events posted to it are dropped without a trace. A click that would be
  /// posted is refused up front instead of reported as done, and the app is
  /// never shown.
  @WorkActor
  func testAHiddenAppIsObservedButPostedInputIsRefusedNotLost() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }
    let fixture = try await launchFixture(["hidden"])
    defer { fixture.stop() }
    _ = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let running = fixture.application
    let deadline = Date().addingTimeInterval(5)
    var hiddenSince: Date?
    while Date() < deadline {
      if running.isHidden {
        if let hiddenSince, Date().timeIntervalSince(hiddenSince) >= 0.5 { break }
        if hiddenSince == nil { hiddenSince = Date() }
      } else {
        hiddenSince = nil
      }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertTrue(running.isHidden)

    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let observation = try await AppObserver.observe(app: state, monitor: monitor)
    let latest = try XCTUnwrap(state.latest)
    let field = try XCTUnwrap(latest.elements.firstIndex { $0.attributes.role == "AXTextField" })
    let result = try await ActionRunner.run(
      actions: [.click(target: .index(field), button: .left, count: 1), .type(text: "lost")],
      app: state,
      observationId: observation.observationId,
      cancellation: SessionCancellation(),
      monitor: monitor,
      overlay: nil
    )
    XCTAssertEqual(result.performed.count, 0)
    XCTAssertEqual(result.error, ActionRunner.hiddenAppRefusal)
    XCTAssertTrue(running.isHidden, "Observing and acting must never show a hidden app.")
  }

  /// A pop-up button is clicked with a mouse event, never `AXPress`, so no
  /// toolkit that runs its menu inside the press can turn the click into a
  /// two-second `outcome-unknown`. The click returns at once, the menu opens
  /// in the background app, and the app is not brought forward.
  @WorkActor
  func testAPopUpButtonClickOpensItsMenuWithoutWaitingForIt() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }
    let fixture = try await launchFixture()
    defer { fixture.stop() }
    _ = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let observation = try await AppObserver.observe(app: state, monitor: monitor)
    let latest = try XCTUnwrap(state.latest)
    let popUp = try XCTUnwrap(latest.elements.firstIndex { $0.attributes.role == "AXPopUpButton" })
    let popUpFrame = latest.elements[popUp].frame
    let pointerBefore = CGEvent(source: nil)?.location

    let started = Date()
    let result = try await ActionRunner.run(
      actions: [.click(target: .index(popUp), button: .left, count: 1)],
      app: state,
      observationId: observation.observationId,
      cancellation: SessionCancellation(),
      monitor: monitor,
      overlay: nil
    )
    XCTAssertNil(result.error)
    XCTAssertEqual(result.performed.count, 1)
    XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["menuOpened"] as? Bool) == true })
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertEqual(after["everKey"] as? Bool, false)
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["b"] as? String, "")
    assertPointerNotMovedToTarget(
      before: pointerBefore,
      target: CGPoint(
        x: latest.windowFrame.minX + popUpFrame.midX,
        y: latest.windowFrame.minY + popUpFrame.midY))
  }

  /// Secure input reaches the intended field in a background app, but the
  /// action report and the accessibility tree never echo its contents.
  @WorkActor
  func testSecureFieldReceivesBackgroundTypingWithoutEchoingIt() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }
    let fixture = try await launchFixture(["secure"])
    defer { fixture.stop() }
    _ = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let observed = try await AppObserver.observe(app: state, monitor: monitor)
    let latest = try XCTUnwrap(state.latest)
    let secure = try XCTUnwrap(
      latest.elements.firstIndex {
        $0.attributes.role == "AXSecureTextField"
          || $0.attributes.subrole == "AXSecureTextField"
      })
    let text = "fixture-secret-781"
    let result = try await ActionRunner.run(
      actions: [.type(text: text, target: .index(secure))],
      app: state, observationId: observed.observationId,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    XCTAssertNil(result.error)
    XCTAssertEqual(result.performed.count, 1)
    XCTAssertFalse(result.performed.joined().contains(text))
    XCTAssertTrue(result.performed[0].contains("\(text.count) characters"))
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["secure"] as? String) == text })
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["b"] as? String, "")
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertEqual(after["everKey"] as? Bool, false)
    let following = try await AppObserver.observe(app: state, monitor: monitor)
    XCTAssertFalse(following.tree.contains(text))
  }

  /// Cancellation arriving while an app's main thread is unresponsive must
  /// prevent a queued text mutation when its AX calls finally return.
  @WorkActor
  func testCancellationDuringAnUnresponsiveAppNeverTypesLater() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted else {
      throw XCTSkip("The test process does not have Accessibility permission.")
    }
    let fixture = try await launchFixture(["slow"])
    defer { fixture.stop() }
    let metadata = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let pid = pid_t(try XCTUnwrap(metadata["pid"] as? NSNumber).int32Value)
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let observed = try Self.observeWithoutPicture(state, pid: pid, monitor: monitor)
    try Data().write(to: fixture.output.appendingPathComponent("block.flag"))
    _ = try await waitForJSON(fixture.output.appendingPathComponent("blocked.json"))
    let cancellation = SessionCancellation()
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
      cancellation.cancel(.stoppedByUser)
    }
    let result = try await ActionRunner.run(
      actions: [.type(text: "must not arrive", target: .index(observed.fieldB))],
      app: state, observationId: observed.id, cancellation: cancellation,
      monitor: monitor, overlay: nil)
    XCTAssertEqual(result.performed, [])
    XCTAssertEqual(cancellation.reason, .stoppedByUser)
    XCTAssertEqual(result.error?.code, .stoppedByUser)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["blockFinished"] as? Bool) == true })
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["b"] as? String, "")
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertEqual(after["everKey"] as? Bool, false)
  }

  /// A non-key child can receive a targeted click without taking keyboard
  /// focus. Point typing must refuse rather than type into the parent's
  /// previously focused field.
  @WorkActor
  func testChildWindowPointTypingRefusesWrongFocusButIndexTypingWorks() async throws {
    guard Self.enabled else {
      throw XCTSkip("Set OPENSTEER_RUN_LIVE_COMPUTER_USE_TESTS=1 for the TCC-backed fixture test.")
    }
    guard Permissions.current().accessibility == .granted, CGPreflightScreenCaptureAccess() else {
      throw XCTSkip("The test process needs Accessibility and Screen Recording.")
    }
    guard PrivateAPI.backgroundPointerDeliveryAvailable else {
      XCTFail("The explicitly enabled live test requires the targeted background pointer route.")
      return
    }
    let fixture = try await launchFixture(["child"])
    defer { fixture.stop() }
    let metadata = try await waitForJSON(fixture.output.appendingPathComponent("metadata.json"))
    let initial = try await waitForJSON(fixture.output.appendingPathComponent("state.json"))
    XCTAssertEqual(initial["everActive"] as? Bool, false)
    XCTAssertEqual(initial["everKey"] as? Bool, false, "The child fixture must start non-key.")
    let childID = CGWindowID(try XCTUnwrap(initial["childWindowID"] as? NSNumber).uint32Value)
    let parentID = CGWindowID(try XCTUnwrap(metadata["windowID"] as? NSNumber).uint32Value)
    XCTAssertNotEqual(childID, parentID)
    let record = try XCTUnwrap(AppResolver.record(forBundleAtPath: fixture.app.path))
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    // Creating and ordering the child emits window changes during launch.
    // A stale observation is the correct answer until those changes settle.
    var observed: Observation?
    for _ in 0..<3 {
      do {
        observed = try await AppObserver.observe(app: state, monitor: monitor)
        break
      } catch let error as HelperError where error.code == .staleObservation {
        try await Task.sleep(nanoseconds: 100_000_000)
      }
    }
    let snapshot = try XCTUnwrap(observed)
    let latest = try XCTUnwrap(state.latest)
    let childWindow = try XCTUnwrap(latest.windows.first { $0.windowID == childID })
    let field = try XCTUnwrap(
      latest.elements.first { element in
        element.attributes.role == "AXTextField"
          && (element.node as? AXElementNode).flatMap {
            ActionRunner.windowID(containing: $0.element)
          } == childID
      })
    let fieldFrame = try XCTUnwrap(field.attributes.frame)
    XCTAssertTrue(childWindow.frame.contains(fieldFrame))
    let pointerBefore = CGEvent(source: nil)?.location
    let point = latest.coordinates.pixelPoint(
      from: CGPoint(x: field.frame.midX, y: field.frame.midY))
    let result = try await ActionRunner.run(
      actions: [.type(text: "typed in child", target: .point(point))],
      app: state, observationId: snapshot.observationId,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    XCTAssertEqual(result.error?.code, .unsupported)
    XCTAssertTrue(result.error?.message.contains("did not take keyboard focus") == true)
    XCTAssertEqual(result.performed.count, 0)
    let after = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"))
    XCTAssertEqual(after["a"] as? String, "")
    XCTAssertEqual(after["b"] as? String, "")
    XCTAssertEqual(after["child"] as? String, "")
    XCTAssertEqual(after["everActive"] as? Bool, false)
    XCTAssertEqual(after["everKey"] as? Bool, false)
    assertPointerNotMovedToTarget(
      before: pointerBefore,
      target: CGPoint(x: fieldFrame.midX, y: fieldFrame.midY))

    // An exact AX element can take focus without making the child key. That
    // supported route must still work after the unsafe point route refused.
    let following = try await AppObserver.observe(app: state, monitor: monitor)
    let latestAfterClick = try XCTUnwrap(state.latest)
    let childFieldIndex = try XCTUnwrap(
      latestAfterClick.elements.firstIndex { element in
        element.attributes.role == "AXTextField"
          && (element.node as? AXElementNode).flatMap {
            ActionRunner.windowID(containing: $0.element)
          } == childID
      })
    let indexed = try await ActionRunner.run(
      actions: [.type(text: "typed in child", target: .index(childFieldIndex))],
      app: state, observationId: following.observationId,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    XCTAssertNil(indexed.error)
    XCTAssertEqual(indexed.performed.count, 1)
    let delivered = try await waitForJSON(
      fixture.output.appendingPathComponent("state.json"),
      until: { ($0["child"] as? String) == "typed in child" })
    XCTAssertEqual(delivered["a"] as? String, "")
    XCTAssertEqual(delivered["b"] as? String, "")
    XCTAssertEqual(delivered["everActive"] as? Bool, false)
    XCTAssertEqual(delivered["everKey"] as? Bool, false)
  }

  /// No `LSUIElement`: the fixture is a regular app, as the apps people use are.
  private static func infoPlist(bundleID: String) -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>Fixture</string>
    <key>CFBundleIdentifier</key><string>\(bundleID)</string>
    <key>CFBundleName</key><string>Opensteer Background Input Fixture</string>
    <key>CFBundleDisplayName</key><string>Opensteer Background Input Fixture</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>
    """
  }

  @WorkActor
  private func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let error = Pipe()
    process.standardError = error
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let detail = String(decoding: error.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      throw HelperError(.failed, "Fixture build failed: \(detail)")
    }
  }

  @WorkActor
  private func waitForJSON(
    _ url: URL,
    until predicate: ([String: Any]) -> Bool = { _ in true }
  ) async throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
      if let data = try? Data(contentsOf: url),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        predicate(object)
      {
        return object
      }
      try await Task.sleep(nanoseconds: 25_000_000)
    }
    let last = (try? Data(contentsOf: url)).map { String(decoding: $0, as: UTF8.self) } ?? "nothing"
    throw HelperError(
      .failed,
      "The controlled fixture did not report the expected state in time; it reported \(last).")
  }
}
