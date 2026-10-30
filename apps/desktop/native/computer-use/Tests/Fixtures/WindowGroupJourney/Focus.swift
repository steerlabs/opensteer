import AppKit
import ApplicationServices

@WorkActor extension Contracts {
  static func focus(
    out: URL, state: AppSessionState, pid: pid_t, a: WindowInfo, b: WindowInfo,
    monitor: WindowMonitor, cover: PersonCover
  ) async throws {
        await cover.moveAside()
    try await personClick(b.id, pid: pid, out: out, fromRight: true)
    let otherKey = try await ActionRunner.run(
      actions: [.key(keys: "x")], app: state, window: a.ref, snapshot: nil,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(
      otherKey.performed.isEmpty && otherKey.error?.code == .failed,
      "N6 moved person's key window")
        await cover.moveAside()
    try await personClick(a.id, pid: pid, out: out)
    let sameKey = try await ActionRunner.run(
      actions: [.key(keys: "x")], app: state, window: a.ref, snapshot: nil,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(sameKey.error == nil && sameKey.performed.count == 1, "N6 same-window keys failed")
    await cover.show()
    try await Task.sleep(nanoseconds: 200_000_000)
    let personPID = PrivateAPI.focusPID(front: true)
    let backgroundKey = try await ActionRunner.run(actions: [.key(keys: "x")], app: state, window: a.ref, snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    try require(backgroundKey.error == nil && backgroundKey.performed.count == 1 && PrivateAPI.focusPID(front: true) == personPID, "N6 background keys changed person's app")
    // A separately sourced click into the window being typed into, then the
    // person's own key: the agent's input runs to completion, the person's key
    // reaches the window they chose, and they are never sent back to the app
    // they left. Raising the surface arranges hit testing without taking the
    // person's front app or changing the app's believed key window.
    try require(personPID != pid, "N6 independent app was not foreground")
        await cover.moveAside()
    try await command(out, "raise", "A")
    let takeoverFrame = try KeyWindow.currentFrame(a.id).unwrap("takeover frame")
    let takeover = Process()
    takeover.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        let beforeTakeover = try String(contentsOf: out.appendingPathComponent("events.jsonl"))
          .split(separator: "\n").count
        takeover.arguments = [
          "--person-click", String(Double(takeoverFrame.minX + 40)),
          String(Double(takeoverFrame.midY)), String(a.id),
        ]
        takeover.environment = ProcessInfo.processInfo.environment.merging([
          "OPENSTEER_PERSON_WAIT_EVENTS": out.appendingPathComponent("events.jsonl").path,
          "OPENSTEER_PERSON_WAIT_TOKEN": "z",
          "OPENSTEER_PERSON_WAIT_BASELINE": String(beforeTakeover),
          "OPENSTEER_PERSON_THEN_TYPE": "p",
        ]) { _, new in new }
    let dispatchBaseline =
      ((try? String(contentsOf: out.appendingPathComponent("dispatch.jsonl"))) ?? "")
      .split(separator: "\n").count
    let watch = try PersonWatch(fixturePID: pid)
    try takeover.run()
    defer { if takeover.isRunning { takeover.terminate(); takeover.waitUntilExit() } }
    let takenOver = try await ActionRunner.run(actions: [.type(text: String(repeating: "z", count: 2_000))], app: state, window: a.ref, snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    let takeoverDeadline = Date().addingTimeInterval(3)
    while takeover.isRunning, Date() < takeoverDeadline { try await Task.sleep(nanoseconds: 20_000_000) }
    try await Task.sleep(nanoseconds: 300_000_000)
    let takeoverWatch = watch.finish(personPID: personPID)
    try require(!takeover.isRunning && takeover.terminationStatus == 0, "N6 takeover source failed")
    let takeoverRows = try String(contentsOf: out.appendingPathComponent("events.jsonl"))
      .split(separator: "\n").dropFirst(beforeTakeover)
    let agentKeysInA = takeoverRows.filter {
      $0.contains("\"characters\":\"z\"") && $0.contains("\"window\":\"A\"")
    }.count
    let personKeyInA = takeoverRows.contains {
      $0.contains("\"characters\":\"p\"") && $0.contains("\"window\":\"A\"")
    }
    // In the order the app received them: agent keys before the person's
    // click and after it, so the click landed while the input was going out.
    let dispatched = try String(contentsOf: out.appendingPathComponent("dispatch.jsonl"))
      .split(separator: "\n").dropFirst(dispatchBaseline)
      .compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    let clickRow = dispatched.firstIndex {
      ($0["type"] as? NSNumber)?.intValue == 1 && $0["title"] as? String == "A"
    }
    let keysBeforeClick = clickRow.map { row in
      dispatched[..<row].filter { ($0["type"] as? NSNumber)?.intValue == 10 }.count
    } ?? 0
    let keysAfterClick = clickRow.map { row in
      dispatched[(row + 1)...].filter { ($0["type"] as? NSNumber)?.intValue == 10 }.count
    } ?? 0
    try JSONSerialization.data(withJSONObject: [
      "error": takenOver.error?.code.rawValue ?? "", "message": takenOver.error?.message ?? "",
      "performed": takenOver.performed, "agentKeysInA": agentKeysInA,
      "personKeyInA": personKeyInA, "keysBeforeClick": keysBeforeClick,
      "keysAfterClick": keysAfterClick, "fixturePID": Int(pid), "windowA": Int(a.id),
      "frontAfter": Int(PrivateAPI.focusPID(front: true) ?? 0), "watch": takeoverWatch.json,
    ]).write(to: out.appendingPathComponent("N6-takeover.json"))
    try require(
      takenOver.error == nil && takenOver.performed.count == 1,
      "N6 the person's click stopped or failed the agent's input")
    try require(agentKeysInA == 2_000, "N6 the agent's keys did not all reach A")
    // After the click: the person's key and at least one of the agent's.
    try require(
      keysBeforeClick >= 1 && keysAfterClick >= 2,
      "N6 the person's click did not land while the agent's keys were going out")
    try require(personKeyInA, "N6 the person's key after clicking in did not reach A")
    try require(
      takeoverWatch.fixtureCameForward && !takeoverWatch.personSentBack
        && PrivateAPI.focusPID(front: true) == pid,
      "N6 the person was sent back to the app they left")
        await cover.moveAside()
        try await personClick(a.id, pid: pid, out: out)
        try await command(out, "raise", "B")
        let siblingFrame = try KeyWindow.currentFrame(b.id).unwrap("mid-type sibling")
        let switchPoint = CGPoint(x: siblingFrame.maxX - 12, y: siblingFrame.midY)
        let hit = await MainActor.run {
          NSWindow.windowNumber(
            at: NSPoint(x: switchPoint.x, y: ScreenGeometry.primaryHeight - switchPoint.y),
            belowWindowWithWindowNumber: 0)
        }
        try require(hit == Int(b.id), "N6 mid-type B is not exposed")
        let switcher = Process()
        switcher.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        let switchBaseline = try String(contentsOf: out.appendingPathComponent("events.jsonl"))
          .split(separator: "\n").count
        switcher.arguments = [
          "--person-click", String(Double(switchPoint.x)), String(Double(switchPoint.y)),
          String(b.id),
        ]
        switcher.environment = ProcessInfo.processInfo.environment.merging([
          "OPENSTEER_PERSON_WAIT_EVENTS": out.appendingPathComponent("events.jsonl").path,
          "OPENSTEER_PERSON_WAIT_TOKEN": "q",
          "OPENSTEER_PERSON_WAIT_BASELINE": String(switchBaseline),
          "OPENSTEER_PERSON_THEN_TYPE": "p",
        ]) { _, new in new }
        try switcher.run()
        defer { if switcher.isRunning { switcher.terminate(); switcher.waitUntilExit() } }
        let switched = try await ActionRunner.run(
          actions: [.type(text: String(repeating: "q", count: 2_000))], app: state, window: a.ref,
          snapshot: nil, cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
        let switchEnd = Date().addingTimeInterval(3)
        while switcher.isRunning, Date() < switchEnd {
          try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        let switchEvents = try String(contentsOf: out.appendingPathComponent("events.jsonl")).split(
          separator: "\n"
        ).dropFirst(switchBaseline)
        // The person moved the keyboard to B: the agent's remaining keys go
        // wherever the keyboard is, and B stays theirs.
        let switchKeysInA = switchEvents.filter {
          $0.contains("\"characters\":\"q\"") && $0.contains("\"window\":\"A\"")
        }.count
        let switchKeysInB = switchEvents.filter {
          $0.contains("\"characters\":\"q\"") && $0.contains("\"window\":\"B\"")
        }.count
        let agentKeys = switchKeysInA + switchKeysInB
        let personKeyInB = switchEvents.contains {
          $0.contains("\"characters\":\"p\"") && $0.contains("\"window\":\"B\"")
        }
        let keyWindowAfter = AXValueReader.copyElement(
          AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute
        ).flatMap(KeyWindow.windowID)
        try JSONSerialization.data(withJSONObject: [
          "error": switched.error?.code.rawValue ?? "", "message": switched.error?.message ?? "",
          "performed": switched.performed, "agentKeysInA": switchKeysInA,
          "agentKeysInB": switchKeysInB, "personKeyInB": personKeyInB,
          "keyWindowAfter": Int(keyWindowAfter ?? 0), "b": Int(b.id),
          "events": switchEvents.map(String.init), "hit": hit,
        ]).write(to: out.appendingPathComponent("N6-same-app-switch.json"))
        try require(!switcher.isRunning && switcher.terminationStatus == 0, "N6 switch source failed")
        try require(
          switched.error == nil && switched.performed.count == 1,
          "N6 the person's switch to B stopped or failed the agent's input")
        try require(agentKeys == 2_000, "N6 the agent's keys did not all arrive across A and B")
        try require(
          switchKeysInA >= 1 && switchKeysInB >= 1,
          "N6 the person's switch to B did not land while the agent's keys were going out")
        try require(personKeyInB, "N6 the person's key after switching did not reach B")
        try require(
          keyWindowAfter == b.id && PrivateAPI.focusPID(front: true) == pid,
          "N6 the keyboard was moved back off the person's window")
    await cover.show()
        try Data("Person-focus cases, takeover and same-app mid-type switch passed\n".utf8).write(
          to: out.appendingPathComponent("N6-passed.txt"))
  }
}
