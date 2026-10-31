import AppKit
import ApplicationServices

// Written before protocol 10 implementation. Every selected case fails if its
// evidence is absent; OS capabilities without an automated journey remain unverified.
@WorkActor enum Contracts {
  static func command(_ out: URL, _ op: String, _ window: String = "A") async throws {
    try JSONSerialization.data(withJSONObject: ["op": op, "window": window]).write(
      to: out.appendingPathComponent("command.json"), options: .atomic)
    let deadline = Date().addingTimeInterval(3)
    while FileManager.default.fileExists(atPath: out.appendingPathComponent("command.json").path),
      Date() < deadline
    { try await Task.sleep(nanoseconds: 20_000_000) }
    try require(
      !FileManager.default.fileExists(atPath: out.appendingPathComponent("command.json").path),
      "Fixture did not consume \(op)")
    try await Task.sleep(nanoseconds: 200_000_000)
  }
  static func save(_ observation: Observation, _ name: String, out: URL) throws {
    try JSONCoding.encoder.encode(observation).write(to: out.appendingPathComponent(name + ".json"))
    if let screenshot = observation.screenshot, let data = Data(base64Encoded: screenshot.base64) {
      try data.write(to: out.appendingPathComponent(name + ".jpg"))
    }
  }
  static func clickMember(_ title: String, app: AppSessionState, observation: Observation, monitor: WindowMonitor, out: URL) async throws {
    let latest = try app.latest.unwrap("member snapshot")
    let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("windows.json"))) as! [String: [String: Any]]
    let id = (rows[title]?["id"] as? NSNumber)?.uint32Value
    if let group = latest.group {
      try JSONSerialization.data(
        withJSONObject: [
          "associated": group.signature.associated,
          "rawAssociated": try PrivateAPI.associatedWindows(group.root.windowID),
          "members": group.members.map {
            [
              "id": $0.window.windowID, "frame": NSStringFromRect($0.window.frame),
              "layer": $0.layer, "onScreen": $0.onScreen,
            ]
          },
        ], options: [.prettyPrinted]
      ).write(to: out.appendingPathComponent("N2-" + title + "-group.json"))
      let onScreenStack =
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
      try JSONSerialization.data(withJSONObject: onScreenStack).write(
        to: out.appendingPathComponent("N2-" + title + "-onscreen-stack.json"))
      let stack = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
      try JSONSerialization.data(withJSONObject: stack).write(to: out.appendingPathComponent("N2-" + title + "-stack.json"))
    }
    let member = try (latest.group?.members.first(where: { $0.window.windowID == id })).unwrap("member " + title)
    let point = latest.coordinates.pixelPoint(from: CGPoint(x: member.window.frame.minX + 15 - latest.windowFrame.minX, y: member.window.frame.minY + 70 - latest.windowFrame.minY))
    if title == "Child" {
      let picture = try observation.screenshot.flatMap { Data(base64Encoded: $0.base64) }.flatMap(
        NSBitmapImageRep.init(data:)
      ).unwrap("child screenshot pixels")
      let color = try
        (picture.colorAt(x: Int(point.x), y: Int(point.y))?.usingColorSpace(.deviceRGB)).unwrap(
          "child pixel")
      try JSONSerialization.data(withJSONObject: [
        "x": point.x, "y": point.y, "red": color.redComponent, "green": color.greenComponent,
        "blue": color.blueComponent,
      ]).write(to: out.appendingPathComponent("N2-child-pixel.json"))
      try require(
        color.greenComponent > color.redComponent,
        "N2 picture shows red A above the established green child")
    }
    let before = try String(contentsOf: out.appendingPathComponent("events.jsonl")).split(separator: "\n").count
    let clicked = try await ActionRunner.run(actions: [.click(target: .point(point), button: .left, count: 1)], app: app, window: observation.window.ref, snapshot: observation.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try await Task.sleep(nanoseconds: 100_000_000)
    let events = try String(contentsOf: out.appendingPathComponent("events.jsonl")).split(separator: "\n").dropFirst(before)
    try require(clicked.error == nil && events.contains(where: { $0.contains("\"window\":\"" + title + "\"") }), "N2 " + title + " did not receive its click")
  }
  static func stateEvidence(_ app: AppSessionState, _ ref: String, _ name: String, monitor: WindowMonitor, out: URL) throws {
    guard let bound = app.windows[ref] else { return }
    let rows: [String: Any] = ["stage": name, "closed": bound.closed, "processCurrent": bound.process.isCurrent, "minimized": AXValueReader.copyBool(bound.element, kAXMinimizedAttribute) ?? false, "captureState": KeyWindow.captureState(bound.windowID, processIdentifier: bound.process.processIdentifier) != nil, "AXWindows": AXValueReader.copyElements(AXUIElementCreateApplication(bound.process.processIdentifier), kAXWindowsAttribute).compactMap(KeyWindow.windowID), "monitorStale": String(describing: monitor.staleReason(processIdentifier: bound.process.processIdentifier, windowID: bound.windowID))]
    try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]).write(to: out.appendingPathComponent("N5-" + name + "-state.json"))
  }
  static func personClick(_ id: CGWindowID, pid: pid_t, out: URL, fromRight: Bool = false) async throws {
    try await command(out, "raise", fromRight ? "B" : "A")
    let frame = try KeyWindow.currentFrame(id).unwrap("person window frame")
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("person-stack-\(id).json"))
    let candidates = (fromRight ? [frame.maxX - 40, frame.minX + 40] : [frame.minX + 40, frame.maxX - 40]).flatMap { x in
      [frame.midY, frame.minY + 70, frame.maxY - 40].map { CGPoint(x: x, y: $0) }
    }
    // Dock publishes a full-display alpha-1 rectangle with a mostly
    // transparent input shape. AppKit's WindowServer hit test respects that
    // shape; rectangle enumeration cannot establish which window gets a click.
    let hits = await MainActor.run {
      candidates.map { point in
        NSWindow.windowNumber(at: NSPoint(x: point.x, y: ScreenGeometry.primaryHeight - point.y), belowWindowWithWindowNumber: 0)
      }
    }
    try JSONSerialization.data(withJSONObject: ["expected": id, "hitWindows": hits]).write(to: out.appendingPathComponent("person-hit-\(id).json"))
    guard let index = hits.firstIndex(of: Int(id)) else {
      throw JourneyFailure.failed("Person window has no exposed tested point; hit windows are \(hits)")
    }
    let point = candidates[index]
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--person-click", String(Double(point.x)), String(Double(point.y)), String(id)]
    try process.run()
    defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning, Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    try require(!process.isRunning && process.terminationStatus == 0, "Person click child failed")
    try await Task.sleep(nanoseconds: 200_000_000)
    let app = AXUIElementCreateApplication(pid)
    let focused = AXValueReader.copyElement(app, kAXFocusedWindowAttribute).flatMap(KeyWindow.windowID)
    let front = PrivateAPI.focusPID(front: true)
    try JSONSerialization.data(withJSONObject: ["expectedWindow": id, "focusedWindow": focused ?? 0, "frontPID": front ?? 0, "expectedPID": pid]).write(to: out.appendingPathComponent("person-state-\(id).json"))
    try require(front == pid && focused == id, "Person click did not establish the tested front/key window")
  }

  static func run(out: URL, fixture: URL, pid: pid_t) async throws {
    var failures: [String] = []
    let fixtureRecord = try AppResolver.record(forBundleAtPath: fixture.path).unwrap("fixture identity")
    let state = AppSessionState(identity: fixtureRecord.identity, path: fixture.path)
    let monitor = WindowMonitor()
    defer {
      monitor.stop()
      state.focus.stop()
    }
    let inventory = try await SessionWindows.windows(app: state, monitor: monitor)
    try require(
      inventory.contains { $0.title == "A" } && inventory.contains { $0.title == "B" }
        && inventory.contains { $0.title == "C" }, "N4 missing fixture document windows")
    try require(!inventory.contains { $0.title == "Transparent" }, "N1 transparent window admitted")
    let a = try inventory.first(where: { $0.title == "A" }).unwrap("A")
    let b = try inventory.first(where: { $0.title == "B" }).unwrap("B")
    if ProcessInfo.processInfo.environment["OPENSTEER_MAC_SHARING_DIAGNOSTIC"] == "1" {
      try await SharingEvidence.run(pid: pid, root: a.id, out: out)
      return
    }
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_SELECTION"] == "receipt-switch" {
      let selected = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
      try await receiptSwitch(out: out, app: state, ref: selected.ref, monitor: monitor)
      return
    }
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_SELECTION"] == "focus" {
      _ = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
      _ = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
      let cover = await PersonCover()
      defer { Task { @MainActor in cover.close() } }
      try await focus(out: out, state: state, pid: pid, a: a, b: b, monitor: monitor, cover: cover)
      return
    }
    if ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_EPOCH_JOURNEY"] == "1" {
      try await personClick(a.id, pid: pid, out: out)
      let chosen = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
      _ = try await AppObserver.observe(app: state, window: chosen.ref, monitor: monitor)
      var stages: [[String: Any]] = []
      defer {
        try? JSONSerialization.data(withJSONObject: stages, options: [.prettyPrinted, .sortedKeys])
          .write(to: out.appendingPathComponent("owner-epoch-stages.json"))
      }
      func nativeKeys() throws -> Int {
        try String(contentsOf: out.appendingPathComponent("dispatch.jsonl"), encoding: .utf8)
          .split(separator: "\n").filter { line in
            let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            return row?["type"] as? Int == Int(NSEvent.EventType.keyDown.rawValue)
          }.count
      }
      func key() async throws -> ActionRunner.RunResult {
        try await ActionRunner.run(actions: [.key(keys: "x")], app: state,
          window: chosen.ref, snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
      }
      func delivered(after before: Int) async throws {
        let end = Date().addingTimeInterval(2)
        while try nativeKeys() == before, Date() < end {
          try await Task.sleep(nanoseconds: 10_000_000)
        }
        try require(try nativeKeys() == before + 1, "Admitted key did not reach the native app exactly once")
      }
      let initialCount = try nativeKeys()
      let initial = try await key()
      try require(initial.error == nil && initial.performed.count == 1, "Idle input refused agent key")
      try await delivered(after: initialCount)
      for attachment in ["first", "repeat"] {
        await state.mutations.beginPerson()
        state.mutations.setHeld(true, attachment: attachment)
        state.mutations.endPerson()
        let before = try nativeKeys()
        let held = try await key()
        try require(held.error?.code == .failed
          && held.error?.message == "A person is pressing in this app; try again.", "Wrong held-contact refusal")
        await state.mutations.beginPerson()
        state.mutations.setHeld(false, attachment: attachment)
        state.mutations.endPerson()
        let resumed = try await key()
        try require(resumed.error == nil && resumed.performed.count == 1,
          "Shared person input required a new observation")
        try await delivered(after: before)
        stages.append(["stage": attachment, "heldDeliveries": 0, "resumedDeliveries": 1, "passed": true])
      }
      try Data("Only an actual held contact excludes agent input\n".utf8)
        .write(to: out.appendingPathComponent("owner-epoch-passed.txt"))
      return
    }
    let wire = try await WireJourney(out: out)
    if ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_VIEW_ONLY_JOURNEY"] == "1" {
      do { try await wire.ownerViewOnly(app: state.identity, window: a.id); await wire.close() }
      catch { await wire.close(); throw error }
      return
    }
    if ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_INPUT_JOURNEY"] == "1" {
      do { try await wire.ownerInput(app: state.identity, a: a.id, b: b.id); await wire.close() }
      catch { _ = try? await wire.request("permissions.get", [:]); await wire.close(); throw error }
      return
    }
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_SELECTION"] == "cancellation" {
      let person = await PersonCover()
      defer { Task { @MainActor in person.close() } }
      try await Task.sleep(nanoseconds: 200_000_000)
      do {
        try await wire.inventoryOnlyCleanup(app: state.identity, pid: pid)
        try await wire.batchCancellation(app: state.identity, window: a.id, deadline: false)
        try await wire.batchCancellation(app: state.identity, window: a.id, deadline: true)
        await wire.close()
        return
      } catch { await wire.close(); throw error }
    }
    do { try await wire.run(app: state.identity, a: a.id, b: b.id); await wire.close() }
    catch { await wire.close(); throw error }
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_CURRENT_ONLY"] == "1" { return }
    _ = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
    let first = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_SELECTION"] == "settle" {
      try await command(out, "focus", "A")
      let before = try KeyWindow.currentFrame(a.id).unwrap("pre-settle root")
      try await command(out, "move-on-key")
      let keyed = try await ActionRunner.run(
        actions: [.key(keys: "x")], app: state, window: a.ref, snapshot: nil,
        cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
      try require(keyed.error == nil, "Settle fixture did not deliver its trigger")
      let moved = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
      let after = try KeyWindow.currentFrame(a.id).unwrap("post-settle root")
      try require(
        after != before && moved.window.frame.x == Double(after.minX)
          && moved.window.frame.y == Double(after.minY)
          && moved.window.frame.width == Double(after.width)
          && moved.window.frame.height == Double(after.height) && state.latest?.windowFrame == after
          && state.latest?.group?.root.frame == after, "Settle mixed old and new root geometry")
      try save(moved, "post-settle-root", out: out)
      return
    }

    try JSONCoding.encoder.encode(first).write(
      to: out.appendingPathComponent("N1-observation.json"))
    try require(
      first.window.id == a.id && !first.tree.contains("WINDOW B")
        && !first.tree.contains("WINDOW C"), "N1 sibling in tree")
    try require(state.currentWindow?.windowID == a.id, "N4 binding did not remain current")
    var moved = first
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_VIDEO_FIRST"] == "1" {
      var videoAvailable = true
      for (op, name) in [("baseline", "A"), ("move", "B"), ("resize", "B"), ("move", "C"), ("resize", "C")] {
        if op != "baseline" { try await command(out, op, name) }
        moved = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
        try require(first.geometry == moved.geometry, "N1 sibling movement or resize changed crop")
        let directory = out.appendingPathComponent("N1-\(op)-\(name)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try save(moved, "observation", out: directory)
        if videoAvailable {
          do { try await VideoEvidence.capture(bound: try state.currentWindow.unwrap("A video"), observation: moved, out: directory, recover: op == "baseline") }
          catch { videoAvailable = false; failures.append("N1 video: " + String(describing: error)) }
        }
      }
      // Restore the overlapping B used by the routing and focus checks.
      try await command(out, "reset", "B")
      if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_VIDEO_ONLY"] == "1" {
        try await ownerWithoutDestroy(out: out, app: state, monitor: monitor)
        try JSONSerialization.data(withJSONObject: failures).write(to: out.appendingPathComponent("failures.json"))
        try require(failures.isEmpty, failures.joined(separator: "; "))
        return
      }
    } else {
      try await command(out, "move", "C")
      moved = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
      try require(first.geometry == moved.geometry, "N1 sibling movement changed crop")
    }
    let covered = try state.latest.unwrap("latest A").coordinates.pixelPoint(
      from: CGPoint(x: 300, y: 80))
    // Stale snapshots are refused before a click; the current snapshot stays
    // reusable over successive act calls, and act returns no observation.
    do {
      _ = try await ActionRunner.run(
        actions: [.click(target: .point(covered), button: .left, count: 1)], app: state,
        window: a.ref, snapshot: first.snapshot, cancellation: SessionCancellation(),
        monitor: monitor, overlay: nil)
      throw JourneyFailure.failed("N7 stale snapshot accepted")
    } catch let error as HelperError {
      try require(error.code == .staleObservation, "N7 wrong stale refusal")
    }
    try await command(out, "focus", "B")
    for _ in 0..<2 {
      let result = try await ActionRunner.run(
        actions: [.click(target: .point(covered), button: .left, count: 1)], app: state,
        window: a.ref, snapshot: moved.snapshot, cancellation: SessionCancellation(),
        monitor: monitor, overlay: nil)
      try require(
        result.error == nil && result.performed.count == 1,
        "N3 covered click refused: \(String(describing: result.error))")
    }
    let trace = try String(contentsOf: out.appendingPathComponent("events.jsonl"))
    try require(
      trace.split(separator: "\n").count >= 2 && !trace.contains("\"window\":\"B\""),
      "N3 click delivered to sibling")
    try require(state.latest?.observationId == moved.snapshot, "N7 act consumed snapshot")
    let record = AppBundleRecord(identity: state.identity, path: fixture.path)
    let ownerWindows = try await SessionWindows.ownerWindows(record: record, budget: .unlimited)
      .windows
    try require(ownerWindows.contains { $0.id == b.id }, "Owner picker omitted B")
    // The picker lists only what is open: an approved app that is not running
    // lists no windows and is still not running afterwards.
    let idle = try AppResolver.record(forBundleAtPath: "/System/Applications/TextEdit.app")
      .unwrap("TextEdit record")
    func idleRunning() -> Bool {
      NSRunningApplication.runningApplications(withBundleIdentifier: idle.identity.bundleId)
        .contains { !$0.isTerminated }
    }
    for running in NSRunningApplication.runningApplications(
      withBundleIdentifier: idle.identity.bundleId)
    { running.forceTerminate() }
    let quitDeadline = Date().addingTimeInterval(5)
    while idleRunning(), Date() < quitDeadline { try await Task.sleep(nanoseconds: 100_000_000) }
    try require(!idleRunning(), "TextEdit did not quit before the picker check")
    let idleWindows = try await SessionWindows.ownerWindows(record: idle, budget: .unlimited)
      .windows
    try await Task.sleep(nanoseconds: 1_000_000_000)
    let idleLaunched = idleRunning()
    try JSONSerialization.data(withJSONObject: [
      "windows": idleWindows.count, "launched": idleLaunched,
    ]).write(to: out.appendingPathComponent("picker-no-launch.json"))
    try require(
      idleWindows.isEmpty && !idleLaunched, "Owner picker started an app that was not running")
    // A window the picker cannot verify is left out; the rest stay listed. The
    // agent's inventory still refuses the whole list over it.
    try await command(out, "unreadable-window")
    let unreadable = try ((JSONSerialization.jsonObject(
      with: Data(contentsOf: out.appendingPathComponent("windows.json"))) as? [String: [String: Any]])?[
        "Unreadable"]?["id"] as? NSNumber).unwrap("Unreadable id").uint32Value
    var pickerError = ""
    var listed: [OwnerWindowInfo] = []
    var unverified = 0
    var reason = ""
    do {
      let list = try await SessionWindows.ownerWindows(record: record, budget: .unlimited)
      (listed, unverified, reason) = (list.windows, list.unverified, list.reason?.rawValue ?? "")
    } catch { pickerError = String(describing: error) }
    var agentCode = ""
    do {
      _ = try SessionWindows.inventory(app: state, monitor: monitor)
    } catch let error as HelperError { agentCode = error.code.rawValue }
    try JSONSerialization.data(withJSONObject: [
      "listed": listed.map { Int($0.id) }, "unreadable": Int(unreadable), "pickerError": pickerError,
      "unverified": unverified, "reason": reason, "agentCode": agentCode,
    ]).write(to: out.appendingPathComponent("picker-unverifiable.json"))
    try await command(out, "close", "Unreadable")
    try require(
      pickerError.isEmpty && [a.id, b.id].allSatisfy { id in listed.contains { $0.id == id } }
        && !listed.contains { $0.id == unreadable },
      "Owner picker hid its windows for one it could not verify: \(pickerError)")
    try require(
      unverified == 1 && reason == "failed", "Owner picker did not count the window it left out")
    try require(agentCode == "failed", "Agent inventory accepted a window it could not verify")
    let ownerB = try await OwnerViewWindow.open(
      record: record, windowID: b.id, cancellation: SessionCancellation(), budget: .unlimited)
    try require(
      ownerB.target.windowID == b.id && state.currentWindow?.windowID == a.id,
      "Owner view borrowed task A")
    let cover = await PersonCover()
    defer { Task { @MainActor in cover.close() } }
    // Attached surfaces must expand picture and tree and be routable.
    await cover.show()
    do {
      let beforeReparent = try await AppObserver.observe(
        app: state, window: a.ref, monitor: monitor)
      let movingIndex = try
        (state.latest?.elements.firstIndex(where: { $0.attributes.title == "Reparent me" })).unwrap(
          "movable control")
      let movingElement = try
        ((state.latest?.elements[movingIndex].node as? AXElementNode)?.element).unwrap(
          "retained movable control")
      try await command(out, "reparent")
      // The retained element must be the one now in B; what it last reported
      // says whether AppKit kept it or replaced it.
      var role: CFTypeRef?
      var roleStatus = AXError.failure
      var reportedWindow: CGWindowID?
      let reparentDeadline = Date().addingTimeInterval(2)
      repeat {
        roleStatus = AXUIElementCopyAttributeValue(
          movingElement, kAXRoleAttribute as CFString, &role)
        reportedWindow = ActionRunner.windowID(containing: movingElement)
        if roleStatus == .success && reportedWindow == b.id { break }
        try await Task.sleep(nanoseconds: 50_000_000)
      } while Date() < reparentDeadline
      try JSONSerialization.data(withJSONObject: [
        "roleStatus": Int(roleStatus.rawValue), "reportedWindow": Int(reportedWindow ?? 0),
        "a": Int(a.id), "b": Int(b.id),
      ]).write(to: out.appendingPathComponent("N2-reparent.json"))
      try require(
        roleStatus == .success && reportedWindow == b.id,
        "Reparent fixture did not preserve the AX element")
      let movedControl = try await ActionRunner.run(
        actions: [.click(target: .index(movingIndex), button: .left, count: 1)], app: state,
        window: a.ref, snapshot: beforeReparent.snapshot, cancellation: SessionCancellation(),
        monitor: monitor, overlay: nil)
      try require(
        movedControl.performed.isEmpty && movedControl.error?.code == .staleObservation,
        "A reparented element received an AX mutation")
      try await command(out, "reparent-back")
    try await command(out, "child")
      let childRows =
        try JSONSerialization.jsonObject(
          with: Data(contentsOf: out.appendingPathComponent("windows.json")))
        as! [String: [String: Any]]
      let frontChild = try (childRows["Child"]?["id"] as? NSNumber).unwrap("front child")
        .uint32Value
      func frontChildOrder() -> Bool {
        let rows =
          CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
          ?? []
        let ids = rows.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
        guard let c = ids.firstIndex(of: frontChild), let r = ids.firstIndex(of: a.id) else {
          return false
        }
        return c < r
      }
      let stackEnd = Date().addingTimeInterval(3)
      while !frontChildOrder(), Date() < stackEnd { try await Task.sleep(nanoseconds: 20_000_000) }
      try require(frontChildOrder(), "N2 fixture child did not establish a front stack")
      try await Task.sleep(nanoseconds: 50_000_000)
      try require(frontChildOrder(), "N2 fixture child stack did not stay stable")
    let child = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(child, "N2-child", out: out)
      let childStack =
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
      try JSONSerialization.data(
        withJSONObject: [
          "rawAssociated": try PrivateAPI.associatedWindows(a.id),
          "serverOrder": AppWindows.all(processIdentifier: pid).map(\.window.windowID),
          "onScreenOrder": childStack.compactMap {
            ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value
          }, "groupOrder": state.latest?.group?.members.map(\.window.windowID) ?? [],
        ], options: [.prettyPrinted]
      ).write(to: out.appendingPathComponent("N2-child-order.json"))
      try require(frontChildOrder(), "N2 fixture child reordered while observing")
      try require(
        state.latest?.group?.members.first?.window.windowID == frontChild
          && child.tree.hasPrefix("[0] window \"Child\""),
        "N2 stable front child disagrees with group/tree order")
    try await clickMember("Child", app: state, observation: child, monitor: monitor, out: out)
    try require(child.tree.contains("Child"), "N2 associated child absent from tree")
    let group = try (state.latest?.group).unwrap("group")
    try require(group.members.count >= 2, "N2 child missing from group")
    // A corner of a union bounding box may be outside every member.
    let gap = CGPoint(x: CGFloat(child.geometry.width - 2), y: 2)
    let gapResult = try await ActionRunner.run(
      actions: [.click(target: .point(gap), button: .left, count: 1)], app: state, window: a.ref,
      snapshot: child.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(gapResult.error != nil && gapResult.performed.isEmpty, "N3 crop gap accepted")
    try await command(out, "clipped-child")
    let clipped = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(clipped, "N3-clipped", out: out)
    let clippedWindow = try clipped.windows.first(where: { $0.title == "ClippedChild" }).unwrap("clipped child window")
    let clippedGroup = try (state.latest?.group).unwrap("clipped group")
    try require(clippedWindow.frame.x + clippedWindow.frame.width > Double(clippedGroup.crop.maxX), "N3 fixture child was not clipped")
    if let clippedIndex = state.latest?.elements.firstIndex(where: { $0.attributes.title == "ClippedChild" }) {
      let clippedClick = try await ActionRunner.run(actions: [.click(target: .index(clippedIndex), button: .left, count: 1)], app: state, window: a.ref, snapshot: clipped.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
      try require(clippedClick.performed.isEmpty && clippedClick.error != nil, "N3 clipped child center was actionable")
    }
    let clippedPoint = try await ActionRunner.run(actions: [.click(target: .point(CGPoint(x: CGFloat(clipped.geometry.width + 5), y: 180)), button: .left, count: 1)], app: state, window: a.ref, snapshot: clipped.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(clippedPoint.performed.isEmpty && clippedPoint.error != nil, "N3 clipped child point was actionable")
    try await command(out, "close", "ClippedChild")
    try await command(out, "sheet")
    let sheet = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(sheet, "N2-sheet", out: out)
    try await clickMember("Sheet", app: state, observation: sheet, monitor: monitor, out: out)
    try require(
      sheet.tree.contains("Sheet") && sheet.blockedBy.isEmpty,
      "N2 sheet missing or treated as blocker")
    let sheetKey = try await ActionRunner.run(actions: [.key(keys: "x")], app: state, window: a.ref, snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(sheetKey.error == nil && sheetKey.performed.count == 1, "N2 associated sheet cannot receive keys")
    try await command(out, "dismiss")
    try await command(out, "popover", "A")
    let ownPopover = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(ownPopover, "N2-popover", out: out)
    try require(ownPopover.tree.contains("Popover"), "N2 own popover absent from tree")
    let childID = child.windows.first(where: { $0.title == "Child" })?.id
    let popoverMember = try (state.latest?.group?.members.first(where: { $0.window.windowID != a.id && $0.window.windowID != childID })).unwrap("popover member")
    let popoverPoint = try state.latest.unwrap("popover snapshot").coordinates.pixelPoint(from: CGPoint(x: popoverMember.window.frame.midX - state.latest!.windowFrame.minX, y: popoverMember.window.frame.midY - state.latest!.windowFrame.minY))
    let popoverClick = try await ActionRunner.run(actions: [.click(target: .point(popoverPoint), button: .left, count: 1)], app: state, window: a.ref, snapshot: ownPopover.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(popoverClick.error == nil, "N2 own popover not actionable")
    try await command(out, "dismiss")
    for menuKind in ["context", "menu"] {
    try? FileManager.default.removeItem(at: out.appendingPathComponent("menu-action.json"))
    try await command(out, menuKind, "A")
    let ownMenu = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(ownMenu, "N2-" + menuKind, out: out)
    let menuIndex = try (state.latest?.elements.firstIndex(where: { $0.attributes.role == kAXMenuItemRole && $0.attributes.title == "Associated menu command" })).unwrap("menu command")
    let menuClick = try await ActionRunner.run(actions: [.click(target: .index(menuIndex), button: .left, count: 1)], app: state, window: a.ref, snapshot: ownMenu.snapshot, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(menuClick.error == nil && FileManager.default.fileExists(atPath: out.appendingPathComponent("menu-action.json").path), "N2 own menu not actionable")
    try await command(out, "dismiss")
    }
    try await command(out, "popover", "B")
    let siblingPopover = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try require(!siblingPopover.tree.contains("Popover"), "N2 sibling popover included")
    try await command(out, "dismiss")
    try await command(out, "menu", "B")
    let menu = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try require(
      menu.blockedBy.contains { $0.id == b.id && $0.kind == .menu },
      "N2 sibling menu does not identify its owner")
    let blocked = try await ActionRunner.run(
      actions: [.key(keys: "Escape")], app: state, window: a.ref, snapshot: nil,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(
      blocked.performed.isEmpty && blocked.error?.code == .unsupported,
      "N2 menu failed to block input")
    try await command(out, "dismiss")
    try await command(out, "modal")
    let modal = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try save(modal, "N2-modal", out: out)
    try require(
      modal.blockedBy.contains { $0.kind == .dialog }, "N2 app-modal alert did not block A")
    let alert = try modal.blockedBy.first(where: { $0.kind == .dialog }).unwrap("modal blocker")
    let alertWindow = try SessionWindows.bind(app: state, window: alert.id, monitor: monitor)
    let alertObservation = try await AppObserver.observe(app: state, window: alertWindow.ref, monitor: monitor)
    try save(alertObservation, "N2-alert-bound", out: out)
    let alertKeys = try await ActionRunner.run(actions: [.key(keys: "Return")], app: state, window: alertWindow.ref, snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(alertKeys.error == nil && alertKeys.performed.count == 1, "N2 bound alert refused keyboard")
    try await command(out, "dismiss")
    _ = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
    try Data("Associated member, menu and alert assertions passed\n".utf8).write(to: out.appendingPathComponent("N2-passed.txt"))
    } catch {
      failures.append("N2/N3 members: " + String(describing: error))
      try await command(out, "dismiss")
      try await command(out, "reparent-back")
      try await command(out, "close", "ClippedChild")
      _ = try SessionWindows.bind(app: state, window: a.id, monitor: monitor)
    }
    do {
    try await command(out, "hide")
    try stateEvidence(state, a.ref, "hidden", monitor: monitor, out: out)
    let hidden = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try require(
      hidden.alone && state.latest?.group?.members.count == 1 && !hidden.tree.contains("Child"),
      "N5 hidden tree/picture differ")
      try save(hidden, "N5-hidden", out: out)
      let hiddenVideo = out.appendingPathComponent("N5-hidden-video")
      try FileManager.default.createDirectory(at: hiddenVideo, withIntermediateDirectories: true)
      try await VideoEvidence.capture(
        bound: try state.currentWindow.unwrap("hidden A"), observation: hidden, out: hiddenVideo)
      let hiddenButton = try
        (state.latest?.elements.firstIndex(where: { $0.attributes.title == "Reparent me" })).unwrap(
          "hidden button")
      let hiddenValue = try
        (state.latest?.elements.firstIndex(where: { $0.attributes.title == "Mutable value" }))
        .unwrap("hidden field")
      let hiddenAX = try await ActionRunner.run(
        actions: [
          .click(target: .index(hiddenButton), button: .left, count: 1),
          .setValue(index: hiddenValue, value: "hidden value"),
        ], app: state, window: a.ref, snapshot: hidden.snapshot,
        cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
      let controlResult =
        try JSONSerialization.jsonObject(
          with: Data(contentsOf: out.appendingPathComponent("control-action.json")))
        as? [String: Any]
      let hiddenFieldElement = try
        ((state.latest?.elements[hiddenValue].node as? AXElementNode)?.element).unwrap(
          "hidden value element")
      try require(
        hiddenAX.error == nil && hiddenAX.performed.count == 2
          && controlResult?["window"] as? String == "A"
          && AXValueReader.copyString(hiddenFieldElement, kAXValueAttribute) == "hidden value",
        "Hidden AX-only controls did not receive their mutations")
    let refused = try await ActionRunner.run(
      actions: [.key(keys: "Escape")], app: state, window: a.ref, snapshot: nil,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(
      refused.performed.isEmpty && refused.error?.code == .unsupported, "N5 hidden keys accepted")
    try await command(out, "show")
    try await command(out, "minimize")
    try stateEvidence(state, a.ref, "minimize", monitor: monitor, out: out)
    do {
      _ = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
      throw JourneyFailure.failed("N5 minimized observed")
    } catch let error as HelperError {
      try require(error.code == .unsupported, "N5 wrong minimize refusal")
    }
    try await command(out, "restore")
    try stateEvidence(state, a.ref, "restored", monitor: monitor, out: out)
    _ = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try await command(out, "fullscreen")
    try await Task.sleep(nanoseconds: 1_000_000_000)
    await cover.show()
    let spaceDeadline = Date().addingTimeInterval(5)
    while KeyWindow.isOnScreen(a.id), Date() < spaceDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
    try stateEvidence(state, a.ref, "fullscreen", monitor: monitor, out: out)
      var discoveredValue: CFTypeRef?
      let discoveryStatus = AXUIElementCopyAttributeValue(
        AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &discoveredValue)
      try require(
        discoveryStatus == .success && discoveredValue is [AXUIElement],
        "N5 did not read a successful off-Space AX inventory")
      let discoveredIDs = (discoveredValue as? [AXUIElement] ?? []).compactMap(KeyWindow.windowID)
      try require(
        !discoveredIDs.contains(a.id),
        "N5 did not establish AXWindows omission for the real off-Space window")
      let offSpaceInventory = try SessionWindows.inventory(app: state, monitor: monitor)
      try require(
        offSpaceInventory.contains { $0.ref == a.ref && $0.id == a.id },
        "N5 inventory retired an off-Space ref")
    let elsewhere = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
    try require(elsewhere.alone && state.latest?.group?.members.count == 1 && !elsewhere.tree.contains("Child"), "N5 full-screen elsewhere did not become alone")
    try JSONCoding.encoder.encode(elsewhere).write(to: out.appendingPathComponent("N5-elsewhere.json"))
    try await command(out, "fullscreen")
    try await Task.sleep(nanoseconds: 1_000_000_000)
    await cover.show()
    try await command(out, "close")
    for _ in 0..<2 {
      do {
        _ = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor)
        throw JourneyFailure.failed("N5 closed ref revived")
      } catch let error as HelperError {
        try require(
          error.code == .staleObservation && error.message == "That window is closed.",
          "N5 wrong closed refusal")
      }
    }
      try require(
        state.windows[a.ref] == nil && state.retiredWindowRefs.contains(a.ref),
        "N5 retired root retained AX resources")
    try await command(out, "reuse")
    // The public WindowServer allocator may not recycle an ID during this
    // bounded run. The artifact records actual IDs; absence is not a pass for
    // the real-reuse scenario.
    do { _ = try await AppObserver.observe(app: state, window: a.ref, monitor: monitor); throw JourneyFailure.failed("N5 closed ref revived during allocation") }
    catch let error as HelperError { try require(error.code == .staleObservation, "N5 wrong allocation refusal") }
    let oldProcess = try ProcessStamp.of(pid).unwrap("original process")
    try await command(out, "quit")
    let quitDeadline = Date().addingTimeInterval(3)
    while oldProcess.isCurrent, Date() < quitDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
    try require(!oldProcess.isCurrent, "N5 fixture did not quit")
    let relaunched = try await SessionWindows.windows(app: state, monitor: monitor)
    try require(relaunched.contains { $0.title == "A" && $0.ref != a.ref }, "N5 relaunch reused a ref")
    do { _ = try await AppObserver.observe(app: state, window: b.ref, monitor: monitor); throw JourneyFailure.failed("N5 old process ref revived") }
    catch let error as HelperError { try require(error.code == .staleObservation && error.message == "That window is closed.", "N5 wrong relaunch refusal") }
    let fresh = try relaunched.first(where: { $0.title == "A" }).unwrap("relaunch A")
    _ = try SessionWindows.bind(app: state, window: fresh.id, monitor: monitor)
    let videoObservation = try await AppObserver.observe(app: state, window: fresh.ref, monitor: monitor)
    try Data("N5 hidden/minimize/fullscreen/close/relaunch assertions passed; see id-reuse artifact for allocation coverage\n".utf8).write(to: out.appendingPathComponent("N5-lifecycle-passed.txt"))
    try Data("Native window/ref/tree/routing/keyboard assertions completed before video\n".utf8).write(to: out.appendingPathComponent("nonvideo-completed.txt"))
    try await VideoEvidence.capture(bound: try state.currentWindow.unwrap("new A"), observation: videoObservation, out: out)
    try await command(out, "quit")
    } catch { failures.append("N5/video: " + String(describing: error)) }
    try JSONSerialization.data(withJSONObject: failures, options: [.prettyPrinted]).write(to: out.appendingPathComponent("failures.json"))
    try require(failures.isEmpty, failures.joined(separator: "; "))
    let completion = "Member assertions completed; focus has its own selection\n"
    try Data(completion.utf8).write(
      to: out.appendingPathComponent("contracts-completed.txt"))
  }
}
extension Optional {
  func unwrap(_ name: String) throws -> Wrapped {
    guard let value = self else { throw JourneyFailure.failed("Missing \(name)") }
    return value
  }
}
