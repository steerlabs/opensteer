import AppKit
import ApplicationServices
import Darwin

// The window chip on a real Mac, through the helper runtime in this process: photographed in
// every state the owner reviews (PNG, under the case's directory), and held to what it promises:
// its Stop ends the agent working in that app and leaves another app's agent working, it is
// never drawn while its window moves, and the person's own input through an owner view draws
// nothing at all.
extension SafariFront {
  /// The window and a margin round it, and a close-up of the chip.
  struct Shot { let name: String; let rect: CGRect? }

  func png(_ caseOut: URL, _ name: String, _ rect: CGRect?, wait: Bool = true) async {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var arguments = ["-x", "-t", "png"]
    if let rect {
      let bounds = NSScreen.screens.first.map { CGRect(origin: .zero, size: $0.frame.size) } ?? rect
      let r = rect.intersection(bounds).integral
      arguments.append("-R\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))")
    }
    arguments.append(caseOut.appendingPathComponent(name + ".png").path)
    process.arguments = arguments
    guard (try? process.run()) != nil, wait else { return }
    while process.isRunning { await sleepSeconds(0.02) }
  }

  /// The window with room above it for the chip, and the chip close up.
  func shots(_ caseOut: URL, _ name: String, window: CGRect, chip: CGRect?) async {
    await png(caseOut, name + "-window", window.insetBy(dx: -28, dy: -36))
    if let chip {
      let width = max(220, chip.width + 80)
      await png(caseOut, name + "-closeup",
        CGRect(x: chip.midX - width / 2, y: chip.midY - 34, width: width, height: 68))
    }
  }

  func move(_ point: CGPoint) async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--person-move", String(Double(point.x)), String(Double(point.y))]
    try process.run()
    while process.isRunning { await sleepSeconds(0.02) }
    try require(process.terminationStatus == 0, "Person move failed (\(process.terminationStatus))")
  }

  /// The chip shown on a window whose frame is `window`, within `seconds`.
  func chip(on window: CGRect, seconds: Double = 2) async -> (view: ChipView, frame: CGRect)? {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
      if let found = shownChips().first(where: { abs($0.frame.midX - window.midX) <= 1.5
        && (abs($0.frame.midY - window.minY) <= 1.5 || abs($0.frame.minY - window.minY) <= 1.5) }) {
        return found
      }
      await sleepSeconds(0.03)
    } while Date() < deadline
    return nil
  }

  func axWindow(pid: pid_t, title: String) throws -> AXUIElement {
    try AXValueReader.copyElements(AXUIElementCreateApplication(pid), kAXWindowsAttribute).first {
      AXValueReader.copyString($0, kAXTitleAttribute)?.contains(title) == true
    }.unwrap("window titled \(title)")
  }

  func place(_ window: AXUIElement, at origin: CGPoint, size: CGSize? = nil) {
    var position = origin
    _ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &position)!)
    if var size {
      _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    }
  }

  func frame(of window: AXUIElement) throws -> CGRect {
    try KeyWindow.currentFrame(KeyWindow.windowID(of: window).unwrap("window id")).unwrap("window frame")
  }

  /// Dark or light for every app, as System Settings switches it.
  @discardableResult func appearance(dark: Bool) -> String {
    typealias SetTheme = @convention(c) (Bool) -> Void
    if let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
      let symbol = dlsym(handle, "SLSSetAppearanceThemeLegacy")
    {
      unsafeBitCast(symbol, to: SetTheme.self)(dark)
      return "SLSSetAppearanceThemeLegacy"
    }
    let defaults = Process()
    defaults.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
    defaults.arguments = dark ? ["write", "-g", "AppleInterfaceStyle", "Dark"] : ["delete", "-g", "AppleInterfaceStyle"]
    try? defaults.run()
    defaults.waitUntilExit()
    DistributedNotificationCenter.default().postNotificationName(
      .init("AppleInterfaceThemeChangedNotification"), object: nil, userInfo: nil, deliverImmediately: true)
    return "AppleInterfaceStyle default"
  }

  func chipCase(_ caseOut: URL) async throws -> [String: Any] {
    var row: [String: Any] = [:]
    var checks: [String: Bool] = [:]
    let screen = try (NSScreen.main ?? NSScreen.screens.first).unwrap("screen")
    let menuBarBottom = screen.frame.maxY - screen.visibleFrame.maxY
    row["screen"] = ["points": NSStringFromSize(screen.frame.size), "scale": screen.backingScaleFactor,
      "menuBarBottom": menuBarBottom]
    let away = CGPoint(x: screen.frame.width - 40, y: screen.frame.height - 40)
    _ = front.hide()
    defer { _ = front.unhide() }
    defer { appearance(dark: false) }
    let safariAX = try safariWindow()
    let width = min(940, screen.frame.width - 300), height = min(600, screen.frame.height - 260)
    let home = CGPoint(x: (screen.frame.width - width) / 2, y: menuBarBottom + 90)
    place(safariAX, at: home, size: CGSize(width: width, height: height))
    safari.activate()
    try await move(away)
    await sleepSeconds(0.8)

    // a: one agent, still.
    let wireA = try AgentWire(helper: helper)
    defer { wireA.drop() }
    let a = Agent(wire: wireA, identity: safariIdentity)
    try await a.open(title: "Sol fixture")
    await sleepSeconds(OverlayModel.holdAfterWork + OverlayStyle.fadeDuration + 0.3)
    var safariFrame = try frame(of: safariAX)
    let still = await chip(on: safariFrame)
    checks["a-still"] = still?.view.chip?.look == .agents(dots: [.still], more: 0)
    await shots(caseOut, "a-one-agent-still", window: safariFrame, chip: still?.frame)
    await png(caseOut, "a-full-screen", nil)

    // i: the click ring, mid-fade.
    let field = try a.index(role: "textfield", containing: "Fixture field")
    _ = try wireA.send("session.act", ["sessionId": a.session, "app": a.target, "window": a.ref,
      "snapshot": NSNull(), "actions": [["type": "click", "target": ["index": field]]]])
    var ring: CGRect?
    for _ in 0..<300 where ring == nil {
      ring = NSApp.windows.first { $0.isVisible && $0.frame.size == ClickRing.size }.map {
        OverlayGeometry.appKitRect(fromCoreGraphics: $0.frame, primaryHeight: ScreenGeometry.primaryHeight)
      }
      if ring == nil { await sleepSeconds(0.01) }
    }
    if let ring {
      await sleepSeconds(0.1)
      await png(caseOut, "i-click-ring-closeup", ring.insetBy(dx: -70, dy: -40))
    }
    checks["i-ring"] = ring != nil
    await sleepSeconds(0.8)

    // b: working, two frames of the breath.
    let typing = Task { @MainActor in
      _ = try await a.act([["type": "type", "text": String(repeating: "steady ", count: 40)]])
    }
    await sleepSeconds(0.25)
    let working = await chip(on: safariFrame)
    checks["b-working"] = working?.view.chip?.look == .agents(dots: [.working], more: 0)
    await shots(caseOut, "b-working-1", window: safariFrame, chip: working?.frame)
    await sleepSeconds(0.55)
    await png(caseOut, "b-working-2-closeup", working.map {
      CGRect(x: $0.frame.midX - 110, y: $0.frame.midY - 34, width: 220, height: 68) })
    try await typing.value

    // d: the person points at the chip: Stop.
    safariFrame = try frame(of: safariAX)
    let rest = try await chip(on: safariFrame).unwrap("Safari's chip before hover")
    try await move(CGPoint(x: rest.frame.midX, y: rest.frame.midY))
    await sleepSeconds(0.6)
    let open = try await chip(on: safariFrame).unwrap("Safari's chip on hover")
    checks["d-hover-widens"] = open.frame.width > rest.frame.width + 20 && open.view.word.opacity == 1
    await shots(caseOut, "d-hover-stop", window: safariFrame, chip: open.frame)
    try await move(away)
    await sleepSeconds(0.5)
    checks["d-closes-again"] = await chip(on: safariFrame).map { $0.frame.width == rest.frame.width } == true

    // g (light) and the second app: TextEdit, held by another agent.
    let note = FileManager.default.temporaryDirectory.appendingPathComponent("Chip notes.txt")
    try "The agent keeps these notes while it works in Safari.\n".write(to: note, atomically: true, encoding: .utf8)
    let textEditPath = "/System/Applications/TextEdit.app"
    let textEditConfiguration = NSWorkspace.OpenConfiguration()
    textEditConfiguration.activates = false
    let textEdit = try await NSWorkspace.shared.open([note], withApplicationAt: URL(fileURLWithPath: textEditPath),
      configuration: textEditConfiguration)
    Owned.apps.append(textEdit)
    try await waitForWindow(pid: textEdit.processIdentifier, title: "Chip notes", seconds: 20)
    let textEditAX = try axWindow(pid: textEdit.processIdentifier, title: "Chip notes")
    place(textEditAX, at: CGPoint(x: 60, y: safariFrame.minY + 160), size: CGSize(width: 520, height: 300))
    let textEditRecord = try AppResolver.record(forBundleAtPath: textEditPath).unwrap("TextEdit identity")
    let textEditIdentity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(textEditRecord.identity))
    let wireB = try AgentWire(helper: helper)
    defer { wireB.drop() }
    let b = Agent(wire: wireB, identity: textEditIdentity)
    try await b.open(title: "Chip notes", page: false)
    textEdit.activate()
    await sleepSeconds(OverlayModel.holdAfterWork + OverlayStyle.fadeDuration + 0.6)
    let textEditFrame = try frame(of: textEditAX)
    let light = await chip(on: textEditFrame)
    checks["g-light"] = light != nil
    await shots(caseOut, "g-light-textedit", window: textEditFrame, chip: light?.frame)
    await png(caseOut, "g-full-screen-two-apps", nil)
    safari.activate()
    await sleepSeconds(0.6)

    // Stop on Safari's chip ends Safari's agent and leaves TextEdit's working.
    safariFrame = try frame(of: safariAX)
    let safariChip = try await chip(on: safariFrame).unwrap("Safari's chip before Stop")
    try await move(CGPoint(x: safariChip.frame.midX, y: safariChip.frame.midY))
    await sleepSeconds(OverlayStyle.expandDuration + OverlayStyle.stopArmDelay + 0.3)
    let armed = try await chip(on: safariFrame).unwrap("Safari's chip open")
    let frontBefore = PrivateAPI.focusPID(front: true)
    try await personClick(CGPoint(x: armed.frame.maxX - 20, y: armed.frame.midY))
    await sleepSeconds(0.5)
    let frontAfter = PrivateAPI.focusPID(front: true)
    let afterStop = try await a.wire.reply(try a.wire.send("session.observe",
      ["sessionId": a.session, "app": a.target, "window": a.ref, "includeScreenshot": false]))
    let refusal = (afterStop["error"] as? [String: Any])?["code"] as? String
    let bStill = try await b.observe()
    let textEditChip = await chip(on: textEditFrame)
    let safariChipAfter = await chip(on: safariFrame, seconds: 0.3)
    checks["stop-ends-safari-agent"] = helper.registry.sessions[a.session] == nil && refusal == "stopped-by-user"
      && safariChipAfter == nil
    checks["stop-leaves-textedit-agent"] = helper.registry.sessions[b.session] != nil && bStill["tree"] != nil
      && textEditChip != nil
    checks["stop-keeps-the-front-app"] = frontBefore == frontAfter
    row["stop"] = ["refusalAfterStop": refusal ?? "none", "frontBefore": Int(frontBefore ?? 0), "frontAfter": Int(frontAfter ?? 0)]
    try await move(away)
    await png(caseOut, "stop-after-full-screen", nil)

    // e: dragged. Never drawn while the window moves; back at the new place once it settles.
    let wireC = try AgentWire(helper: helper)
    defer { wireC.drop() }
    let c = Agent(wire: wireC, identity: safariIdentity)
    try await c.open(title: "Sol fixture")
    await sleepSeconds(0.8)
    safariFrame = try frame(of: safariAX)
    let beforeDrag = await chip(on: safariFrame)
    try require(beforeDrag != nil, "No chip before the drag")
    var visibleWhileMoving = 0, steps = 0
    let origin = safariFrame.origin
    for step in 1...60 {
      place(safariAX, at: CGPoint(x: origin.x + CGFloat(step) * 1.5, y: origin.y + CGFloat(step)))
      await sleepSeconds(0.02)
      if step == 30 {
        let midDrag = try frame(of: safariAX)
        await png(caseOut, "e-mid-drag-window", midDrag.insetBy(dx: -28, dy: -36), wait: false)
      }
      if step > 2 {
        steps += 1
        if shownChips().contains(where: { $0.view.chip?.app.key == "com.apple.safari" }) { visibleWhileMoving += 1 }
      }
    }
    let stoppedAt = Date()
    safariFrame = try frame(of: safariAX)
    let settled = await chip(on: safariFrame, seconds: 2)
    let returnMs = Int(Date().timeIntervalSince(stoppedAt) * 1000)
    checks["e-hidden-while-moving"] = visibleWhileMoving == 0
    checks["e-back-after-settling"] = settled != nil && returnMs < 1_000
    row["drag"] = ["steps": steps, "framesWithAChipWhileMoving": visibleWhileMoving, "returnedAfterMs": returnMs,
      "how": "Safari's window moved through Accessibility in 60 steps of about 20 ms, as a drag moves it"]
    await sleepSeconds(0.3)
    await shots(caseOut, "e-after-settling", window: safariFrame, chip: settled?.frame)

    // f: under the menu bar: the notch inside the window, at rest and on hover.
    place(safariAX, at: CGPoint(x: safariFrame.minX, y: menuBarBottom))
    await sleepSeconds(0.8)
    safariFrame = try frame(of: safariAX)
    let notch = await chip(on: safariFrame)
    checks["f-notch"] = notch.map { abs($0.frame.minY - safariFrame.minY) <= 0.5 && $0.frame.height == OverlayStyle.notchHeight } == true
    row["notch"] = ["window": NSStringFromRect(safariFrame), "chip": notch.map { NSStringFromRect($0.frame) } ?? "none"]
    await shots(caseOut, "f-notch-under-menu-bar", window: safariFrame, chip: notch?.frame)
    if let notch {
      try await move(CGPoint(x: notch.frame.midX, y: notch.frame.midY))
      await sleepSeconds(0.6)
      let grown = await chip(on: safariFrame)
      checks["f-notch-grows-down"] = grown.map { $0.frame.height == OverlayStyle.chipHeight && $0.frame.minY == notch.frame.minY } == true
      await shots(caseOut, "f-notch-hover", window: safariFrame, chip: grown?.frame)
      try await move(away)
    }
    place(safariAX, at: home)
    await sleepSeconds(0.8)

    // g (dark): the same two windows in dark mode.
    row["darkMode"] = appearance(dark: true)
    await sleepSeconds(1.5)
    row["darkStyleAfter"] = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") ?? "light"
    safariFrame = try frame(of: safariAX)
    let darkSafari = await chip(on: safariFrame)
    await shots(caseOut, "g-dark-safari", window: safariFrame, chip: darkSafari?.frame)
    await png(caseOut, "g-dark-full-screen", nil)
    textEdit.activate()
    await sleepSeconds(0.8)
    let darkTextEdit = await chip(on: textEditFrame)
    checks["g-dark-textedit"] = darkTextEdit != nil
    await shots(caseOut, "g-dark-textedit", window: textEditFrame, chip: darkTextEdit?.frame)
    safari.activate()
    appearance(dark: false)
    await sleepSeconds(1)
    wireB.drop()
    wireC.drop()
    await sleepSeconds(0.5)

    // c: three agents in one window, through a second overlay handed three sessions on Safari:
    // the registry admits one session per app, so three real sessions cannot hold it at once.
    safariFrame = try frame(of: safariAX)
    let seam = OverlayController(drawsWindows: true, onStop: { _ in })
    let key = "com.apple.safari"
    let app = OverlayModel.App(key: key, name: "Safari")
    seam.present((1...3).map { OverlayModel.Session(id: "agent-\($0)", apps: [app]) }, ending: .ended)
    seam.bind(app: key, window: try KeyWindow.windowID(of: safariAX).unwrap("Safari window id"))
    seam.workStarted(.init(session: "agent-1", app: key))
    seam.workStarted(.init(session: "agent-2", app: key))
    await sleepSeconds(0.6)
    let three = await chip(on: safariFrame)
    checks["c-three-dots"] = three?.view.dots.count == 3
    await shots(caseOut, "c-three-agents", window: safariFrame, chip: three?.frame)
    seam.present((1...5).map { OverlayModel.Session(id: "agent-\($0)", apps: [app]) }, ending: .ended)
    // New holders find their window again, as a new session's first observation does.
    seam.bind(app: key, window: try KeyWindow.windowID(of: safariAX).unwrap("Safari window id"))
    await sleepSeconds(0.5)
    let five = await chip(on: safariFrame)
    checks["c-five-is-three-and-a-count"] = five?.view.dots.count == 3
      && (five?.view.count.string as? NSAttributedString)?.string == "+2"
    await shots(caseOut, "c-five-agents", window: safariFrame, chip: five?.frame)
    seam.present([], ending: .ended)
    await sleepSeconds(0.3)

    // h: the connection dropped with an action under way: amber, still; hover says why.
    let wireD = try AgentWire(helper: helper)
    defer { wireD.drop() }
    let d = Agent(wire: wireD, identity: safariIdentity)
    try await d.open(title: "Sol fixture")
    let baseline = lineCount(fixtureLog)
    _ = try wireD.send("session.act", ["sessionId": d.session, "app": d.target, "window": d.ref,
      "snapshot": NSNull(), "actions": Array(repeating: ["type": "key", "keys": "z"] as [String: Any], count: 32)])
    for _ in 0..<100 where !lines(fixtureLog, after: baseline).contains(where: { $0["kind"] as? String == "keydown" }) {
      await sleepSeconds(0.05)
    }
    wireD.drop()
    await sleepSeconds(0.8)
    let amber = await chip(on: safariFrame)
    checks["h-amber"] = amber?.view.chip?.look == .connectionLost && amber?.view.dots.first?.animation(forKey: "breath") == nil
    await shots(caseOut, "h-amber-notice", window: safariFrame, chip: amber?.frame)
    if let amber {
      try await move(CGPoint(x: amber.frame.midX, y: amber.frame.midY))
      await sleepSeconds(0.6)
      let sentence = await chip(on: safariFrame)
      checks["h-hover-says-why"] = sentence.map { $0.view.word.opacity == 1 && $0.frame.width > amber.frame.width } == true
      await shots(caseOut, "h-amber-hover", window: safariFrame, chip: sentence?.frame)
      try await move(away)
      await sleepSeconds(0.4)
      let dismissing = await chip(on: safariFrame)
      _ = dismissing?.view.accessibilityPerformPress()
      await sleepSeconds(0.3)
      let gone = await chip(on: safariFrame, seconds: 0.3)
      checks["h-dismissed"] = gone == nil
    }

    // The person typing into Safari through an owner view draws nothing on the Mac.
    let watch = try Watch(helper: helper)
    var drawnWhileTyping = 0, outcomes: [String] = []
    do {
      try await watch.start(identity: safariIdentity, title: "Sol fixture", input: true)
      for _ in 0..<150 where watch.geometry.current == nil { await sleepSeconds(0.05) }
      let source: [String: Any] = ["kind": "owner-view", "viewId": watch.view, "generation": 1]
      var batches: [[[String: Any]]] = ["down", "up"].map { phase in
        [["kind": "mouse", "phase": phase, "button": "left", "modifiers": [], "x": 0.5, "y": 0.5]]
      }
      for character in "person" {
        let key = String(character), code = "Key" + key.uppercased()
        batches.append([["kind": "key", "action": "down", "code": code, "key": key, "text": key, "modifiers": []],
          ["kind": "key", "action": "up", "code": code, "key": key, "modifiers": []]])
      }
      for (sequence, batch) in batches.enumerated() {
        let geometry = try watch.geometry.current.unwrap("owner video generation")
        let reply = try await watch.control.reply(try watch.control.send("display.input", ["streamId": watch.stream,
          "source": source, "sequence": sequence, "geometry": geometry, "events": batch], timeoutMs: 8_000), seconds: 10)
        outcomes.append(((reply["result"] as? [String: Any])?["outcome"] as? String) ?? "error")
        if NSApp.windows.contains(where: { $0.isVisible && $0 is WindowOverlayPanel }) { drawnWhileTyping += 1 }
        await sleepSeconds(0.1)
      }
      await png(caseOut, "owner-typing-nothing-drawn-window", safariFrame.insetBy(dx: -28, dy: -36))
      if NSApp.windows.contains(where: { $0.isVisible && $0 is WindowOverlayPanel }) { drawnWhileTyping += 1 }
    } catch {
      row["ownerError"] = String(describing: error)
    }
    _ = await watch.stop()
    checks["owner-input-draws-nothing"] = drawnWhileTyping == 0 && outcomes.contains("dispatched")
    row["ownerInput"] = ["outcomes": outcomes, "framesWithAnythingDrawn": drawnWhileTyping]

    place(safariAX, at: CGPoint(x: 560, y: 60), size: CGSize(width: 710, height: 700))
    row["checks"] = checks
    row["met"] = !checks.isEmpty && checks.values.allSatisfy { $0 }
    return row
  }
}
