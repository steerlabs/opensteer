import AppKit
import ApplicationServices

// Test-only recorder. The real front-process lookup is independent of NSWorkspace's cache.
final class R4Trace: @unchecked Sendable {
  private let lock = NSLock()
  private let file: FileHandle
  private var events: [[String: Any]] = []
  init(_ path: URL) {
    FileManager.default.createFile(atPath: path.path, contents: nil)
    file = try! FileHandle(forWritingTo: path)
  }
  func add(_ kind: String, _ fields: [String: Any] = [:], at: Double = ProcessInfo.processInfo.systemUptime) {
    lock.lock(); defer { lock.unlock() }
    let row = fields.merging(["kind": kind, "mono": at]) { _, new in new }
    events.append(row)
    if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
      file.write(data); file.write(Data([10]))
    }
  }
  func rows() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return events }
  deinit { try? file.close() }
}

private final class R4Front: @unchecked Sendable {
  typealias Front = @convention(c) (UnsafeMutableRawPointer) -> Int32
  typealias PID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
  let front: Front?
  let pid: PID?
  init() {
    front = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "GetFrontProcess").map { unsafeBitCast($0, to: Front.self) }
    pid = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "GetProcessPID").map { unsafeBitCast($0, to: PID.self) }
  }
  func current() -> pid_t {
    var serial: [UInt32] = [0, 0], result: pid_t = -1
    guard let front, let pid, serial.withUnsafeMutableBytes({ front($0.baseAddress!) }) == 0,
      serial.withUnsafeBytes({ pid($0.baseAddress!, &result) }) == 0 else { return -1 }
    return result
  }
}

private let r4StreamStamp: Int64 = 0x52340000
private final class R4Watch: @unchecked Sendable {
  typealias PidTap = @convention(c) (pid_t, UInt32, UInt32, CGEventMask, CGEventTapCallBack, UnsafeMutableRawPointer?) -> Unmanaged<CFMachPort>?
  let trace: R4Trace
  private let queue = DispatchQueue(label: "R4.front", qos: .userInteractive)
  private let timer: DispatchSourceTimer
  private var tokens: [NSObjectProtocol] = []
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  init(_ trace: R4Trace, target: pid_t) throws {
    self.trace = trace
    let front = R4Front()
    try require(front.current() > 0, "GetFrontProcess unavailable")
    timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(5), leeway: .microseconds(100))
    // Doubles, not CGFloat: read back from the in-memory rows, a CGFloat in `Any`
    // fails `as? Double`, and the pointer check then compared nil with nil.
    timer.setEventHandler { trace.add("front-sample", ["pid": front.current(), "pointerX": Double(NSEvent.mouseLocation.x), "pointerY": Double(NSEvent.mouseLocation.y)]) }
    timer.resume()
    for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
      tokens.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { note in
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        trace.add(name == NSWorkspace.activeSpaceDidChangeNotification ? "space-change" : "activation",
          ["pid": app?.processIdentifier ?? 0, "bundle": app?.bundleIdentifier ?? ""])
      })
    }
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventTapCreateForPid") else {
      stop(); throw JourneyFailure.invalid("Target input receipt tap unavailable")
    }
    let create = unsafeBitCast(symbol, to: PidTap.self)
    tap = create(target, 0, CGEventTapOptions.listenOnly.rawValue, CGEventMask(1 << CGEventType.keyDown.rawValue), { _, type, event, context in
      guard let context else { return Unmanaged.passUnretained(event) }
      let recorder = Unmanaged<R4Trace>.fromOpaque(context).takeUnretainedValue()
      let stamp = event.getIntegerValueField(.eventSourceUserData)
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        recorder.add("tap-disabled")
      } else if stamp >= r4StreamStamp && stamp < r4StreamStamp + 10000 {
        recorder.add("target-person-key", ["index": stamp - r4StreamStamp])
      }
      return Unmanaged.passUnretained(event)
    }, Unmanaged.passUnretained(trace).toOpaque())?.takeRetainedValue()
    guard let tap else { stop(); throw JourneyFailure.invalid("Target input receipt tap creation refused") }
    source = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    trace.add("watch-start", ["targetPID": target, "frontSampleIntervalMs": 5, "targetReceiptTap": true])
  }
  func stop() {
    timer.cancel(); queue.sync {}
    for token in tokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }; tokens = []
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }; source = nil
    if let tap { CFMachPortInvalidate(tap) }; tap = nil
  }
  deinit { stop() }
}

// Read raw AX rather than an observer cache, including windows created during a batch.
private func r4Effects(_ pid: pid_t) -> [String: Any] {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.1)
  var raw: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw)
  let windows = raw as? [AXUIElement] ?? []
  var tabs = 0, fields: [String] = [], urls: [String] = [], titles: [String] = [], body: [String] = []
  var windowIDs: [UInt32] = []
  for window in windows {
    if let id = KeyWindow.windowID(of: window) { windowIDs.append(id) }
    var pending = [window], index = 0
    while index < pending.count && index < 3000 {
      let element = pending[index]; index += 1
      let role = AXValueReader.copyString(element, kAXRoleAttribute) ?? ""
      let title = AXValueReader.copyString(element, kAXTitleAttribute) ?? ""
      let value = AXValueReader.copyString(element, kAXValueAttribute) ?? ""
      if role == "AXTabGroup" {
        tabs += AXElementNode.children(of: element).filter { AXValueReader.copyString($0, kAXRoleAttribute) == "AXRadioButton" }.count
      }
      if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) { fields.append(value) }
      if role == "AXWebArea" {
        titles.append(title)
        var url: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXURLAttribute as CFString, &url)
        if let url = url as? URL { urls.append(url.absoluteString) }
        else if let url = url as? String { urls.append(url) }
      }
      if role == "AXStaticText" { body.append(value.isEmpty ? title : value) }
      pending.append(contentsOf: AXElementNode.children(of: element))
    }
  }
  return ["windows": windowIDs, "tabs": tabs, "fields": fields, "urls": urls, "titles": titles, "body": body]
}

@WorkActor extension Journey {
  func incidentJourney() async throws -> Int32 {
    let id = "R4-chrome-fullscreen-A"
    do { try await incidentCase(id) }
    catch { rows.append(["journey": "R4", "id": id, "status": "invalid", "verdict": "invalid", "reasons": [String(describing: error)]]) }
    try save()
    for stamp in owned where stamp.processIdentifier != coverPID { await stop(stamp.processIdentifier) }
    return rows.allSatisfy { ["pass", "accepted-limitation"].contains($0["status"] as? String ?? "") } ? 0 : 1
  }

  func incidentCase(_ id: String) async throws {
    beginCase(); defer { actionCancellation.cancel(.closed) }
    let name = "chrome", placement = "fullscreen", batch = "A"
    let env = ProcessInfo.processInfo.environment
    let appURL = chrome
    try require(FileManager.default.fileExists(atPath: appURL.path), "Target app absent")
    // End the preceding full-screen Space before arranging a fresh target on the desktop.
    try await incidentCover(fullScreen: false)
    let base = env["R4_ORIGIN"]!
    let initialPath = "/\(id)/initial/document?text=initial-local-page-abcdefghijklmnopqrstuvwxyz"
    let path = "/\(id)/search/?q=logitech&type=communities"
    // A background browser is refused what would bring it forward: a new tab,
    // a new window, Settings. The batch then sends nothing and changes nothing.
    let url = base + path
    let args = ["--user-data-dir=\(work.path)/profile-\(id)", "--no-first-run", "--no-default-browser-check", "--window-position=100,100", "--window-size=850,600", base + initialPath]
    let pid = try await open(appURL, args: args, active: true).processIdentifier
    defer { signalOwned(pid) }
    try await sleep(2)
    let target = try state(appURL), monitor = WindowMonitor()
    defer { monitor.stop() }
    let setup = try await observe(target, monitor)
    try observationEvidence(setup, id + "-setup")
    try require(target.latest != nil, "Target observation absent")
    try await cover(target.latest!.windowFrame)
    // Chromium exposes no web content while its window is on another Space, so
    // effects are read with the target on the visible desktop, before and after.
    var before = r4Effects(pid)
    // A cold browser exposes its first page to AX a few seconds after launch.
    for _ in 0..<50 where !(before["urls"] as? [String] ?? []).contains(base + initialPath) {
      try await sleep(0.2)
      before = r4Effects(pid)
    }
    do {
      try require((before["urls"] as? [String] ?? []).contains(base + initialPath), "Local initial page absent from AX")
      try require(before["tabs"] as? Int == 1, "Expected one initial AX tab")
    }
    try await incidentCover(fullScreen: true)
    let initial = try coverState(), initialText = initial["text"] as? String ?? ""
    let trace = R4Trace(out.appendingPathComponent(id + "-timeline.jsonl"))
    let watch = try R4Watch(trace, target: pid)
    defer { watch.stop() }
    let pointer = NSEvent.mouseLocation
    let start = ProcessInfo.processInfo.systemUptime
    trace.add("baseline", ["effects": before, "cover": initial, "placement": placement])
    try desktop(id + "-before")
    let stream = try PersonStream(work, stamp: r4StreamStamp, minimum: 0)
    var receipt: [String: Any] = [:], failure = "", focusChanged = false
    let sampling = Locked(true), effectTrace = trace
    let effectTask = Task.detached {
      while sampling.current {
        effectTrace.add("target-effects", r4Effects(pid))
        try await Task.sleep(nanoseconds: 100_000_000)
      }
    }
    do {
      try await sleep(0.3)
      let observed = try await observe(target, monitor)
      focusChanged = observed.focusChanged
      try observationEvidence(observed, id + "-before")
      let actions: [ActionRequest] = [.key(keys: "Command+t"), .type(text: url), .key(keys: "Return")]
      trace.add("batch-start", ["batch": batch, "actions": actions.map { String(describing: $0) }])
      receipt = try await runActions(actions, target, monitor, observed)
      try await sleep(1.8)
      focusChanged = focusChanged || monitor.state(of: pid).focusChangedByHelper
      trace.add("batch-return", ["receipt": receipt, "focusChanged": focusChanged])
      try await sleep(0.3)
    } catch { failure = String(describing: error); trace.add("batch-error", ["error": failure]) }
    let sent = try await stream.stop()
    for row in sent {
      trace.add("stream-send", ["index": row["index"] ?? -1, "text": row["text"] ?? ""], at: row["mono"] as? Double ?? 0)
    }
    let expected = sent.compactMap { $0["text"] as? String }.joined()
    try await sleep(0.3)
    sampling.withLock { $0 = false }; _ = try await effectTask.value
    let final = try coverState()
    try desktop(id + "-after")
    watch.stop()
    let end = ProcessInfo.processInfo.systemUptime
    try await incidentCover(fullScreen: false)
    let after = r4Effects(pid)
    trace.add("final", ["effects": after, "cover": final])
    // Merge the cover process's monotonic key notifications and received stream indices.
    let coverData = (try? String(contentsOf: work.appendingPathComponent("cover-timeline.jsonl"), encoding: .utf8)) ?? ""
    for line in coverData.split(separator: "\n") {
      if let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        let at = row["mono"] as? Double, at >= start && at <= end { trace.add(row["kind"] as? String ?? "cover", row, at: at) }
    }
    for event in final["keyEvents"] as? [[String: Any]] ?? [] {
      if let at = event["mono"] as? Double, at >= start && at <= end { trace.add("cover-received-key", event, at: at) }
    }
    let events = trace.rows().sorted { ($0["mono"] as? Double ?? 0) < ($1["mono"] as? Double ?? 0) }
    // Rewrite in monotonic order after merging the independent process/queue recorders.
    let data = try events.reduce(into: Data()) { data, event in
      data.append(try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])); data.append(10)
    }
    try data.write(to: out.appendingPathComponent(id + "-timeline.jsonl"), options: .atomic)
    let samples = events.filter { $0["kind"] as? String == "front-sample" }
    let badFront = samples.filter { ($0["pid"] as? NSNumber)?.int32Value != coverPID }
    let activation = events.filter { $0["kind"] as? String == "activation" && ($0["pid"] as? NSNumber)?.int32Value == pid }
    let space = events.filter { $0["kind"] as? String == "space-change" }
    let keys = events.filter { $0["kind"] as? String == "cover-key" }
    let received = String((final["text"] as? String ?? "").dropFirst(initialText.count))
    let refusal = (receipt["error"] as? String ?? "").contains("brings itself to the front")
      && (receipt["performed"] as? [String])?.isEmpty == true
    let delivered = refusal && NSDictionary(dictionary: before).isEqual(to: after)
    // One reader for baseline, samples and final: the watch's own samples.
    let firstX = samples.first?["pointerX"] as? Double, firstY = samples.first?["pointerY"] as? Double
    let lastX = samples.last?["pointerX"] as? Double, lastY = samples.last?["pointerY"] as? Double
    // A pointer that was never read proves nothing: it fails, with its own reason.
    let pointerSampled = !samples.isEmpty && samples.allSatisfy { $0["pointerX"] is Double && $0["pointerY"] is Double }
    let pointerHeld = pointerSampled && samples.allSatisfy { $0["pointerX"] as? Double == firstX && $0["pointerY"] as? Double == firstY }
    var reasons: [String] = []
    if !refusal { reasons.append("Expected pre-dispatch refusal with no performed actions") }
    if !pointerSampled { reasons.append("Person pointer not sampled") }
    else if !pointerHeld { reasons.append("Person pointer moved") }
    if !delivered { reasons.append("Target effect not exact (see before/after and target-effects)") }
    if !badFront.isEmpty || !activation.isEmpty { reasons.append("Target/front process changed during batch") }
    if !space.isEmpty { reasons.append("Active Space changed \(space.count) time(s)") }
    if keys.contains(where: { $0["key"] as? Bool == false }) || final["key"] as? Bool != true { reasons.append("Cover lost key window") }
    if expected != received { reasons.append("Person stream corrupted: expected \(expected.count), received \(received.count) characters") }
    let targetKeys = events.filter { $0["kind"] as? String == "target-person-key" }
    if !targetKeys.isEmpty { reasons.append("Target received \(targetKeys.count) person stream keys") }
    if events.contains(where: { $0["kind"] as? String == "tap-disabled" }) { reasons.append("Target receipt tap disabled") }
    if focusChanged { reasons.append("Helper reported focusChanged") }
    if !failure.isEmpty { reasons.append(failure) }
    let times = samples.compactMap { $0["mono"] as? Double }
    let maxGap = zip(times, times.dropFirst()).map { ($1 - $0) * 1000 }.max() ?? 0
    rows.append(["journey": "R4", "id": id, "status": reasons.isEmpty ? "pass" : "regression", "pointerStable": pointerHeld, "pointerBaseline": [firstX ?? -1, firstY ?? -1], "pointerAtSetup": [Double(pointer.x), Double(pointer.y)], "pointerLast": [lastX ?? -1, lastY ?? -1], "refusalConfirmed": refusal, "app": name, "placement": placement, "batch": batch,
      "verdict": reasons.isEmpty ? "pass" : "regression", "reasons": reasons, "startMono": start, "endMono": end,
      "durationMs": (end - start) * 1000, "frontIntervals": incidentIntervals(samples, end: end) { ($0["pid"] as? NSNumber)?.int32Value != self.coverPID },
      "keyLossIntervals": incidentIntervals([["mono": start, "key": true]] + keys, end: end) { $0["key"] as? Bool == false },
      "spaceChanges": space, "targetActivationNotifications": activation, "frontSampleMaxGapMs": maxGap,
      "frontSampleCount": samples.count, "personStreamExact": received == expected, "expectedStream": expected,
      "receivedStream": received, "targetPersonKeyCount": targetKeys.count, "focusChanged": focusChanged,
      "receipt": receipt, "effectExact": delivered, "expectedURL": url, "expectedPath": path,
      "before": before, "after": after,
      "timeline": id + "-timeline.jsonl"])
    fputs("\(id): \(reasons.isEmpty ? "pass" : "fail") \(reasons.joined(separator: "; "))\n", stderr)
  }

  func incidentCover(fullScreen: Bool) async throws {
    let token = UUID().uuidString
    try json(["r4": true, "token": token, "x": 50, "y": 50, "width": 1100, "height": 700, "fullScreen": fullScreen], work.appendingPathComponent("cover-command.json"))
    try await sleep(2)
    let state = try coverState()
    try require(state["token"] as? String == token && state["key"] as? Bool == true
      && state["fullScreen"] as? Bool == fullScreen, "Cover Space placement failed")
  }

  func incidentIntervals(_ samples: [[String: Any]], end: Double, bad: ([String: Any]) -> Bool) -> [[String: Double]] {
    var result: [[String: Double]] = [], start: Double?
    for sample in samples {
      let at = sample["mono"] as? Double ?? end
      if bad(sample) && start == nil { start = at }
      if !bad(sample), let began = start { result.append(["startMono": began, "endMono": at, "durationMs": (at - began) * 1000]); start = nil }
    }
    if let began = start { result.append(["startMono": began, "endMono": end, "durationMs": (end - began) * 1000]) }
    return result
  }
}
