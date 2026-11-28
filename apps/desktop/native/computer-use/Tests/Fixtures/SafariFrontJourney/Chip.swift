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

  /// The chip panel on a window, shown or still fading in.
  func chipPanel(on window: CGRect) -> CGRect? {
    NSApp.windows.compactMap { panel -> CGRect? in
      guard panel.contentView is ChipView, panel.isVisible else { return nil }
      return OverlayGeometry.appKitRect(fromCoreGraphics: panel.frame, primaryHeight: ScreenGeometry.primaryHeight)
    }.first { abs($0.midX - window.midX) <= 1.5 && $0.minY <= window.minY + 1 && $0.maxY >= window.minY - 1 }
  }

  /// Whether Safari's keyboard focus is in its address field (a text field
  /// outside the page), and what it is, for the record.
  func safariAddressFieldFocused() -> (Bool, String) {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
      AXUIElementCreateApplication(safari.processIdentifier), kAXFocusedUIElementAttribute as CFString, &value)
      == .success, let focused = value, CFGetTypeID(focused) == AXUIElementGetTypeID()
    else { return (false, "nothing focused") }
    let element = focused as! AXUIElement
    let role = AXValueReader.copyString(element, kAXRoleAttribute) ?? ""
    let described = [role, AXValueReader.copyString(element, kAXDescriptionAttribute) ?? "",
      AXValueReader.copyString(element, "AXIdentifier") ?? ""].joined(separator: " | ")
    var current: AXUIElement? = element
    for _ in 0..<40 {
      guard let node = current else { break }
      if AXValueReader.copyString(node, kAXRoleAttribute) == "AXWebArea" { return (false, described + " (in the page)") }
      var parent: CFTypeRef?
      guard AXUIElementCopyAttributeValue(node, kAXParentAttribute as CFString, &parent) == .success,
        let next = parent, CFGetTypeID(next) == AXUIElementGetTypeID() else { break }
      current = (next as! AXUIElement)
    }
    return (role == "AXTextField", described)
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

  /// An agent's keys to window A, after its session last bound a window B that the person
  /// then minimized: its Stop must be on A by the first key that reaches the page.
  func chipBindCase(_ caseOut: URL) async throws -> [String: Any] {
    _ = front.hide()
    defer { _ = front.unhide() }
    let safariAX = try safariWindow()
    place(safariAX, at: CGPoint(x: 160, y: 140), size: CGSize(width: 700, height: 480))
    // A person's click on the page brings Safari forward: an accessory app cannot activate it.
    try await makeFront(safari, at: CGPoint(x: 510, y: 596))
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    let refA = agent.ref
    let app = AXUIElementCreateApplication(safari.processIdentifier)
    func windowB() -> AXUIElement? {
      AXValueReader.copyElements(app, kAXWindowsAttribute).first {
        AXValueReader.copyString($0, kAXTitleAttribute)?.contains("Sol fixture") == false
      }
    }
    _ = try await agent.act([["type": "key", "keys": "cmd+n"]])
    for _ in 0..<60 where windowB() == nil { await sleepSeconds(0.1) }
    let bAX = try windowB().unwrap("Safari window B")
    defer {
      _ = AXUIElementSetAttributeValue(bAX, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
      if let close = AXValueReader.copyElements(bAX, kAXCloseButtonAttribute).first {
        _ = AXUIElementPerformAction(close, kAXPressAction as CFString)
      } else {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(bAX, kAXCloseButtonAttribute as CFString, &value) == .success,
          let close = value, CFGetTypeID(close) == AXUIElementGetTypeID()
        {
          _ = AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString)
        }
      }
    }
    let listed = try await wire.request("session.windows", ["sessionId": agent.session, "app": agent.target])
    let windows = (listed["windows"] as? [[String: Any]]) ?? []
    let b = try windows.first { ($0["title"] as? String)?.contains("Sol fixture") == false }
      .unwrap("window B in \(windows.map { $0["title"] ?? "" })")
    _ = try await wire.request("session.bind", ["sessionId": agent.session, "app": agent.target, "windowId": b["windowId"]!])
    await sleepSeconds(0.5)
    _ = AXUIElementSetAttributeValue(bAX, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    await sleepSeconds(1.2)
    let frameA = try frame(of: safariAX)
    let before = chipPanel(on: frameA)
    let baseline = lineCount(fixtureLog)
    let id = try wire.send("session.act", ["sessionId": agent.session, "app": agent.target, "window": refA,
      "snapshot": NSNull(), "actions": Array(repeating: ["type": "key", "keys": "z"] as [String: Any], count: 24)])
    var firstKey = false
    for _ in 0..<500 where !firstKey {
      firstKey = lines(fixtureLog, after: baseline).contains { $0["kind"] as? String == "keydown" }
      if !firstKey { await sleepSeconds(0.01) }
    }
    let atFirstKey = chipPanel(on: frameA)
    await png(caseOut, "bind-at-first-key-window", frameA.insetBy(dx: -28, dy: -36), wait: false)
    let reply = try await wire.reply(id)
    return [
      "met": firstKey && before == nil && atFirstKey != nil,
      "firstKeyReachedThePage": firstKey,
      "chipOnABeforeTheAct": before.map { NSStringFromRect($0) } ?? "none",
      "chipOnAAtTheFirstKey": atFirstKey.map { NSStringFromRect($0) } ?? "none",
      "actError": (reply["error"] as? [String: Any])?["message"] as? String ?? "none",
    ]
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
    // A person's click on the page brings Safari forward: an accessory app cannot activate it.
    try await makeFront(safari, at: CGPoint(x: home.x + width / 2, y: home.y + height - 24))
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
    checks["a-still"] = still?.view.chip?.look == .agent(.still)
      && still.map { $0.frame.width > $0.frame.height && $0.frame.height == OverlayStyle.chipHeight } == true
    await shots(caseOut, "a-one-agent-still", window: safariFrame, chip: still?.frame)
    await png(caseOut, "a-full-screen", nil)

    // i: the click ring, mid-fade.
    let field = try a.index(role: "textfield", containing: "Fixture field")
    let clickID = try wireA.send("session.act", ["sessionId": a.session, "app": a.target, "window": a.ref,
      "snapshot": a.snapshot ?? "", "actions": [["type": "click", "target": ["index": field]]]])
    var ring: CGRect?
    for _ in 0..<300 where ring == nil {
      ring = NSApp.windows.first { $0.isVisible && $0.frame.size == ClickRing.size }.map {
        OverlayGeometry.appKitRect(fromCoreGraphics: $0.frame, primaryHeight: ScreenGeometry.primaryHeight)
      }
      if ring == nil { await sleepSeconds(0.01) }
    }
    if let ring {
      await png(caseOut, "i-click-ring-closeup", ring.insetBy(dx: -70, dy: -40))
    }
    checks["i-ring"] = ring != nil
    let clicked = try await wireA.reply(clickID)
    row["clickError"] = (clicked["error"] as? [String: Any])?["message"] as? String ?? "none"
    await sleepSeconds(0.8)

    // b: working, two frames of the breath.
    let typing = Task { @MainActor in
      _ = try await a.act([["type": "type", "text": String(repeating: "steady ", count: 40)]])
    }
    await sleepSeconds(0.25)
    let working = await chip(on: safariFrame)
    checks["b-working"] = working?.view.chip?.look == .agent(.working)
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
    await sleepSeconds(OverlayModel.holdAfterWork + OverlayStyle.fadeDuration + 0.6)
    let textEditFrame = try frame(of: textEditAX)
    checks["textedit-chip"] = await chip(on: textEditFrame) != nil
    safariFrame = try frame(of: safariAX)
    try await makeFront(safari, at: CGPoint(x: safariFrame.maxX - 60, y: safariFrame.maxY - 24))
    await sleepSeconds(0.6)

    // Stop on Safari's chip ends Safari's agent and leaves TextEdit's working.
    safariFrame = try frame(of: safariAX)
    let safariChip = try await chip(on: safariFrame).unwrap("Safari's chip before Stop")
    try await move(CGPoint(x: safariChip.frame.midX, y: safariChip.frame.midY))
    await sleepSeconds(OverlayStyle.expandDuration + 0.3)
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

    // f: under the menu bar: the notch inside the window. It takes none of the address
    // field's clicks: below it at rest, beside it opened; it opens only once the pointer rests.
    place(safariAX, at: CGPoint(x: safariFrame.minX, y: menuBarBottom))
    await sleepSeconds(0.8)
    safariFrame = try frame(of: safariAX)
    let notch = try await chip(on: safariFrame).unwrap("the notch")
    checks["f-notch"] = abs(notch.frame.minY - safariFrame.minY) <= 0.5
      && notch.frame.height == OverlayStyle.notchHeight && notch.view.dot.frame.height == OverlayStyle.notchDotSize
    row["notch"] = ["window": NSStringFromRect(safariFrame), "chip": NSStringFromRect(notch.frame)]
    await shots(caseOut, "f-notch-at-rest", window: safariFrame, chip: notch.frame)
    let below = CGPoint(x: notch.frame.midX, y: notch.frame.maxY + 5)
    let focusBefore = safariAddressFieldFocused()
    try await personClick(below)
    await sleepSeconds(0.5)
    let focusBelow = safariAddressFieldFocused()
    checks["f-click-below-the-notch-reaches-safari"] = !focusBefore.0 && focusBelow.0
      && helper.registry.sessions[c.session] != nil
    // The page takes the focus back, so the next click is seen to move it again.
    try await personClick(CGPoint(x: safariFrame.midX, y: safariFrame.midY + 120))
    await sleepSeconds(0.5)
    let focusPage = safariAddressFieldFocused()
    // Passing over the notch opens nothing; resting on it does.
    try await move(CGPoint(x: notch.frame.midX, y: notch.frame.midY))
    await sleepSeconds(0.1)
    try await move(away)
    await sleepSeconds(OverlayStyle.notchDwell + 0.3)
    let passed = await chip(on: safariFrame)
    checks["f-passing-over-opens-nothing"] = passed?.frame.height == OverlayStyle.notchHeight
    try await move(CGPoint(x: notch.frame.midX, y: notch.frame.midY))
    await sleepSeconds(0.1)
    let early = await chip(on: safariFrame)
    await sleepSeconds(OverlayStyle.notchDwell + OverlayStyle.expandDuration + 0.2)
    let opened = try await chip(on: safariFrame).unwrap("the opened notch")
    checks["f-notch-opens-after-a-rest"] = early?.frame.height == OverlayStyle.notchHeight
      && opened.frame.height == OverlayStyle.notchOpenHeight && opened.frame.minY == notch.frame.minY
      && opened.view.word.opacity == 1
    await shots(caseOut, "f-notch-dwelled-open", window: safariFrame, chip: opened.frame)
    try await personClick(CGPoint(x: opened.frame.maxX + 24, y: opened.frame.midY + 2))
    await sleepSeconds(0.5)
    let focusBeside = safariAddressFieldFocused()
    checks["f-click-beside-the-open-notch-reaches-safari"] = !focusPage.0 && focusBeside.0
      && helper.registry.sessions[c.session] != nil
    try await personClick(CGPoint(x: safariFrame.midX, y: safariFrame.midY + 120))
    row["addressField"] = ["before": focusBefore.1, "belowRestingNotch": focusBelow.1, "page": focusPage.1,
      "besideOpenNotch": focusBeside.1]
    try await move(away)

    // j: the window's top under the menu bar and its left part off the screen: the chip sits
    // at the top of the part the person can see.
    place(safariAX, at: CGPoint(x: -300, y: 4))
    await sleepSeconds(0.8)
    safariFrame = try frame(of: safariAX)
    let visible = safariFrame.intersection(CGRect(x: 0, y: menuBarBottom, width: screen.frame.width,
      height: screen.frame.height - menuBarBottom))
    let clamped = shownChips().first { $0.view.chip?.app.key == "com.apple.safari" }
    checks["j-clamped-to-the-visible-part"] = clamped.map {
      abs($0.frame.midX - visible.midX) <= 1 && abs($0.frame.minY - visible.minY) <= 0.5
    } == true
    row["clamped"] = ["window": NSStringFromRect(safariFrame), "chip": clamped.map { NSStringFromRect($0.frame) } ?? "none"]
    await png(caseOut, "j-partly-off-screen-full-screen", nil)
    place(safariAX, at: home)
    await sleepSeconds(0.8)

    // g (dark): the same two windows in dark mode.
    row["darkMode"] = appearance(dark: true)
    await sleepSeconds(1.5)
    row["darkStyleAfter"] = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") ?? "light"
    safariFrame = try frame(of: safariAX)
    let darkSafari = await chip(on: safariFrame)
    checks["g-dark"] = darkSafari != nil
    await shots(caseOut, "g-dark-safari", window: safariFrame, chip: darkSafari?.frame)
    await png(caseOut, "g-dark-full-screen", nil)
    appearance(dark: false)
    await sleepSeconds(1)
    wireB.drop()
    wireC.drop()
    await sleepSeconds(0.5)

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
    checks["h-amber"] = amber?.view.chip?.look == .connectionLost && amber?.view.dot.animation(forKey: "breath") == nil
    await shots(caseOut, "h-amber-notice", window: safariFrame, chip: amber?.frame)
    if let amber {
      try await move(CGPoint(x: amber.frame.midX, y: amber.frame.midY))
      await sleepSeconds(0.6)
      let sentence = await chip(on: safariFrame)
      checks["h-hover-says-why"] = sentence.map { $0.view.word.opacity == 1 && $0.frame.width > amber.frame.width } == true
      await shots(caseOut, "h-amber-hover", window: safariFrame, chip: sentence?.frame)
      try await move(away)
      await sleepSeconds(0.4)
      // One ordinary click on the resting amber chip dismisses it, and stops nothing.
      let resting = try await chip(on: safariFrame).unwrap("the resting amber chip")
      try await personClick(CGPoint(x: resting.frame.midX, y: resting.frame.midY))
      await sleepSeconds(0.4)
      let gone = await chip(on: safariFrame, seconds: 0.3)
      checks["h-one-click-dismisses"] = gone == nil && resting.frame.width == amber.frame.width
      try await move(away)
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
