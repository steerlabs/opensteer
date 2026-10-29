import AppKit
import Darwin

@MainActor final class PersonKeyReceiver: NSView {
  var received = ""
  var events: [[String: Any]] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) {
    received += event.characters ?? ""
    events.append(["text": event.characters ?? "", "key": window?.isKeyWindow ?? false,
      "stamp": event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0,
      "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
  }
}

@MainActor final class PersonCover {
  let window: NSWindow
  let receiver = PersonKeyReceiver()
  private let samples = Locked<[[String: Any]]>([])
  private let evidenceQueue = DispatchQueue(label: "owner-person-evidence")
  private var timer: DispatchSourceTimer?
  private var notifications: [NSObjectProtocol] = []
  private let decodedView = OwnerDecodedView(frame: NSRect(x: 10, y: 10, width: 240, height: 180))
  init() {
    NSApp.setActivationPolicy(.regular)
    window = NSWindow(contentRect: NSRect(x: 30, y: 40, width: 800, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = "Person's independent cover"
    window.backgroundColor = .darkGray
    window.contentView = receiver
    receiver.addSubview(decodedView)
    window.makeFirstResponder(receiver)
    show()
  }
  func show() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
  func moveAside() {
    let screen = NSScreen.screens.first!.visibleFrame
    window.setFrame(
      NSRect(x: screen.maxX - 180, y: screen.minY + 20, width: 160, height: 120), display: true)
  }
  func beginEvidence() {
    let rows = samples
    let timer = DispatchSource.makeTimerSource(queue: evidenceQueue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(5))
    timer.setEventHandler {
      let point = CGEvent(source: nil)?.location
      rows.withLock { $0.append(["kind": "sample", "front": PrivateAPI.focusPID(front: true) ?? 0,
        "x": point.map { Double($0.x) } ?? -1, "y": point.map { Double($0.y) } ?? -1,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000]) }
    }
    self.timer = timer
    timer.resume()
    for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
      notifications.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name,
        object: nil, queue: .main) { note in
          let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
          rows.withLock { $0.append(["kind": name == NSWorkspace.activeSpaceDidChangeNotification ? "space" : "activation",
            "front": app?.processIdentifier ?? 0,
            "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000]) }
        })
    }
  }
  func finishEvidence(sent: [[String: Any]], out: URL, front: pid_t?, pointer: CGPoint?, complete: Bool = true) throws {
    stopEvidence()
    let rows = samples.current
    let expected = sent.compactMap { $0["text"] as? String }.joined()
    let badFront = rows.filter { ($0["front"] as? Int32) != front && $0["kind"] as? String != "space" }
    let moved = rows.filter { $0["kind"] as? String == "sample"
      && (($0["x"] as? Double) != pointer.map { Double($0.x) }
        || ($0["y"] as? Double) != pointer.map { Double($0.y) }) }
    let spaces = rows.filter { $0["kind"] as? String == "space" }
    try JSONSerialization.data(withJSONObject: ["complete": complete, "sent": sent, "received": receiver.events,
      "expected": expected, "actual": receiver.received, "samples": rows,
      "frontChanged": badFront.count, "pointerChanged": moved.count, "spaceChanges": spaces.count],
      options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("owner-local-input.json"))
    try require(!sent.isEmpty && receiver.received == expected,
      "Numbered local keystrokes were lost, duplicated or redirected")
    try require(receiver.events.allSatisfy { $0["key"] as? Bool == true }, "Local cover lost its key window")
    try require(badFront.isEmpty && moved.isEmpty && spaces.isEmpty,
      "Owner input changed the local front app, pointer or Space during evidence capture")
  }
  func stopEvidence() {
    timer?.cancel(); timer = nil
    evidenceQueue.sync {}
    for token in notifications { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    notifications.removeAll()
  }
  func drawDecoded(_ image: CGImage) throws -> UInt64 {
    try require(window.isVisible, "The native decoder viewer is hidden")
    decodedView.image = image
    decodedView.drawnAt = nil
    decodedView.needsDisplay = true
    decodedView.displayIfNeeded()
    return try decodedView.drawnAt.unwrap("decoded native draw callback")
  }
  func close() { stopEvidence(); window.close(); NSApp.setActivationPolicy(.accessory) }
}

@MainActor private final class OwnerDecodedView: NSView {
  var image: CGImage?
  var drawnAt: UInt64?
  override func draw(_ dirtyRect: NSRect) {
    guard let image, let context = NSGraphicsContext.current?.cgContext else { return }
    context.draw(image, in: bounds)
    drawnAt = DispatchTime.now().uptimeNanoseconds / 1000
  }
}

/// The keyboard producer is a separate PID so helper-origin filtering cannot
/// mistake these global local-person events for its own targeted events.
final class OwnerPersonStream {
  private let process = Process()
  private let log: URL
  init(out: URL) throws {
    log = out.appendingPathComponent("owner-person-sent.jsonl")
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--owner-person-stream", log.path]
    try process.run()
  }
  func stop() async throws -> [[String: Any]] {
    FileManager.default.createFile(atPath: log.path + ".stop", contents: nil)
    let end = Date().addingTimeInterval(3)
    while process.isRunning, Date() < end { try await Task.sleep(nanoseconds: 10_000_000) }
    if process.isRunning { process.terminate(); process.waitUntilExit() }
    try require(process.terminationStatus == 0, "Local key producer did not finish cleanly")
    return try recorded()
  }
  func recorded() throws -> [[String: Any]] {
    try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map {
      try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
    }
  }
  func cancel() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
  deinit { cancel() }
  static func run(log: URL) -> Never {
    guard CGPreflightPostEventAccess(), FileManager.default.createFile(atPath: log.path, contents: nil),
      let file = try? FileHandle(forWritingTo: log) else { exit(3) }
    var number = 0
    while number < 10 || !FileManager.default.fileExists(atPath: log.path + ".stop") {
      guard number < 10_000 else { exit(4) }
      let token = String(format: "%04d|", number)
      let row: [String: Any] = ["index": number, "text": token,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000]
      guard let data = try? JSONSerialization.data(withJSONObject: row) else { exit(5) }
      do { try file.write(contentsOf: data + Data([10])) } catch { exit(5) }
      for character in token {
        for down in [true, false] {
          guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { exit(6) }
          var text = Array(String(character).utf16)
          event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: &text)
          event.setIntegerValueField(.eventSourceUserData, value: 0x4F574E00 + Int64(number))
          event.flags = []
          event.post(tap: .cghidEventTap)
        }
      }
      number += 1
      usleep(40_000)
    }
    try? file.close()
    exit(0)
  }
}

/// What the person's front app did around a click that is not the helper's:
/// the front app every 10 ms, and each such mouse-down as the window server
/// annotated it (source and target PIDs, window). "Sent back" is the person's
/// previous app coming in front again after the clicked app came forward.
final class PersonWatch: @unchecked Sendable {
  struct Result {
    let fixtureCameForward: Bool
    let personSentBack: Bool
    let json: [String: Any]
  }

  private let fixturePID: pid_t
  private let samples: Locked<[(at: Double, front: Int32)]>
  private let clicks: Locked<[(at: Double, fields: [String: Int64])]>
  private let sampling: Locked<Bool>
  private let tap: EventTap

  init(fixturePID: pid_t) throws {
    let helperPID = Int64(getpid())
    let samples = Locked<[(at: Double, front: Int32)]>([])
    let clicks = Locked<[(at: Double, fields: [String: Int64])]>([])
    let sampling = Locked(true)
    tap = try EventTap(
      .session, place: .headInsertEventTap, options: .listenOnly,
      types: [CGEventType.leftMouseDown.rawValue, CGEventType.rightMouseDown.rawValue],
      handler: { _, event in
        let source = event.getIntegerValueField(FocusEvents.sourcePIDField)
        if source != helperPID {
          let fields = [
            "sourcePID": source,
            "targetPID": event.getIntegerValueField(FocusEvents.targetPIDField),
            "window": event.getIntegerValueField(FocusEvents.windowNumberField),
          ]
          clicks.withLock { $0.append((ProcessInfo.processInfo.systemUptime, fields)) }
        }
        return event
      }).unwrap("person click watch")
    self.fixturePID = fixturePID
    self.samples = samples
    self.clicks = clicks
    self.sampling = sampling
    Thread {
      while sampling.current {
        let front = PrivateAPI.focusPID(front: true) ?? 0
        samples.withLock { $0.append((ProcessInfo.processInfo.systemUptime, front)) }
        usleep(10_000)
      }
    }.start()
  }

  func finish(personPID: pid_t?) -> Result {
    sampling.withLock { $0 = false }
    tap.stop()
    let samples = samples.current, clicks = clicks.current
    let clickedAt = clicks.first?.at
    let cameForwardAt = clickedAt.flatMap { clicked in
      samples.first(where: { $0.at >= clicked && $0.front == fixturePID })?.at
    }
    let sentBack = cameForwardAt.map { forward in
      samples.contains { $0.at > forward && $0.front == personPID }
    } ?? false
    return Result(
      fixtureCameForward: cameForwardAt != nil, personSentBack: sentBack,
      json: [
        "clicks": clicks.map { ["at": $0.at, "fields": $0.fields] as [String: Any] },
        "fronts": samples.map { [$0.at, Double($0.front)] },
        "personPID": Int(personPID ?? 0), "cameForwardAt": cameForwardAt ?? 0,
        "sentBack": sentBack,
      ])
  }
}
