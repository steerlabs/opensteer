import AppKit
import ApplicationServices
import Darwin

// The person's front app through an agent's work in Safari, on a real Mac: the shipping
// helper runtime runs in this process and is driven over its own wire, as the Mac app drives
// it. Cases (OPENSTEER_SAFARI_FRONT_CASES, comma separated):
//   front    an Electron app (the Opensteer app's process) in front; four typing calls, a type
//            into a field, a click by index, a scroll and the menu action
//   stop     the person clicks the front app's Stop while the agent types
//   typing   the person types into the front app's field while the agent types
//   type-into  the person types in Electron while the agent types into a Safari field by index
//   control  TextEdit in front, 30 calls of six kinds, the person typing 960 letters
//   choice   the person clicks into Safari during the agent's typing, and keeps it
//   churn    about 2,000 single-key acts in bursts of 64 through the focus guard
//   overlay  the agent's connection dropped while idle, then while an act is under way

enum JourneyFailure: Error { case failed(String) }
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw JourneyFailure.failed(message) }
}
extension Optional {
  func unwrap(_ name: String) throws -> Wrapped {
    guard let self else { throw JourneyFailure.failed("Missing " + name) }
    return self
  }
}
func wallMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
func sleepSeconds(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }

#if SAFARI_FRONT_KEY_TRACE
enum SafariKeyTapTrace {
  struct Row: Encodable {
    let lane: String
    let pid: pid_t
    let at: Int64
    let tick: UInt64
    let stamp: UInt64?
  }

  static let rows = Locked<[Row]?>(nil)

  static func record(_ lane: String, pid: pid_t, stamp: UInt64? = nil) {
    rows.withLock { $0?.append(Row(lane: lane, pid: pid, at: wallMs(),
      tick: DispatchTime.now().uptimeNanoseconds, stamp: stamp)) }
  }
}
#endif

enum SafariFrontCase: String {
  case front, stop, typing, control, choice, churn, overlay
  case typeInto = "type-into"
  case controlIdle = "control-idle"

  static func parse(_ name: String) throws -> SafariFrontCase {
    let base = name.hasSuffix("-watch") ? String(name.dropLast("-watch".count)) : name
    return try Self(rawValue: base).unwrap("case \(name)")
  }
}

@main struct Journey {
  @MainActor static func main() {
    let arguments = CommandLine.arguments
    if arguments.count >= 4, arguments[1] == "--person-click",
      let x = Double(arguments[2]), let y = Double(arguments[3])
    { PersonInput.click(x: x, y: y) }
    if arguments.count == 5, arguments[1] == "--person-keys",
      let interval = UInt32(arguments[3])
    { PersonInput.keys(arguments[2], intervalMs: interval, log: arguments[4]) }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if arguments.count == 4, arguments[1] == "--reminders" {
      Task { @MainActor in
        let out = URL(fileURLWithPath: arguments[2])
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let report = await RemindersProof.run(out: out, helperApp: URL(fileURLWithPath: arguments[3]))
        exit(report["error"] == nil ? 0 : 1)
      }
      app.run()
    }
    Task { @MainActor in
      let out = URL(fileURLWithPath: arguments[1])
      var result: [String: Any] = ["build": ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_BUILD"] ?? "", "pid": getpid()]
      do {
        let journey = try await SafariFront(out: out)
        defer { journey.close() }
        let cases = try await journey.run()
        result["cases"] = cases
        result["passed"] = !cases.isEmpty && cases.values.allSatisfy { $0 }
      } catch {
        result["passed"] = false
        result["error"] = String(describing: error)
      }
      await Owned.stop(out: out)
      try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("result.json"))
      exit(result["passed"] as? Bool == true ? 0 : 1)
    }
    app.run()
  }
}

/// The person's own hands: real HID events from a separate process, so the helper cannot take
/// them for its own.
enum PersonInput {
  static func click(x: Double, y: Double) -> Never {
    guard CGPreflightPostEventAccess() else { exit(3) }
    print(wallMs())
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
      guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(4) }
      event.setIntegerValueField(.mouseEventClickState, value: 1)
      event.post(tap: .cghidEventTap)
      usleep(40_000)
    }
    exit(0)
  }
  static func keys(_ text: String, intervalMs: UInt32, log: String) -> Never {
    guard CGPreflightPostEventAccess(), FileManager.default.createFile(atPath: log, contents: nil),
      let file = FileHandle(forWritingAtPath: log) else { exit(3) }
    let trace = ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_TRACE_KEYS"] == "1"
    for character in text {
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { exit(4) }
        let units = Array(String(character).utf16)
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        if trace { event.timestamp = DispatchTime.now().uptimeNanoseconds }
        if down {
          let row = "{\"text\":\"\(character)\",\"at\":\(wallMs()),\"stamp\":\(event.timestamp)}\n"
          file.write(Data(row.utf8))
        }
        event.post(tap: .cghidEventTap)
        usleep(8_000)
      }
      usleep(intervalMs * 1000)
    }
    exit(0)
  }
}

/// Apps this journey opened, quit by their own handles.
@MainActor enum Owned {
  static var apps: [NSRunningApplication] = [] {
    didSet {
      // Written at each launch: after a crash the runner stops these by PID.
      let pids = apps.map { String($0.processIdentifier) }.joined(separator: "\n") + "\n"
      if let dir = ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_OWNED"] {
        try? Data(pids.utf8).write(to: URL(fileURLWithPath: dir))
      }
    }
  }
  static func stop(out: URL) async {
    var rows: [[String: Any]] = []
    for app in apps {
      var outcome = "exited"
      if !app.isTerminated {
        app.terminate()
        outcome = "quit"
        for _ in 0..<50 where !app.isTerminated { await sleepSeconds(0.1) }
        if !app.isTerminated { app.forceTerminate(); outcome = "force-terminated" }
      }
      rows.append(["pid": app.processIdentifier, "bundle": app.bundleIdentifier ?? "", "outcome": outcome])
    }
    try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted])
      .write(to: out.appendingPathComponent("owned-apps.json"))
  }
}

/// One agent connection to the in-process helper.
@MainActor final class AgentWire {
  static var nextID = 700
  let helper: HelperRuntime
  let connection: IPCConnection
  let client: Int32
  let decoder = Locked(FrameDecoder())
  private var sequence = 0
  private var pending: [Int: [String: Any]] = [:]
  init(helper: HelperRuntime) throws {
    self.helper = helper
    var pair: [Int32] = [0, 0]
    try require(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0, "socketpair")
    var noPipe: Int32 = 1
    for descriptor in pair {
      setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout<Int32>.size))
    }
    client = pair[1]
    connection = IPCConnection(id: Self.nextID, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
    Self.nextID += 1
    connection.resume()
  }
  /// Sends a request; its reply is read by `reply`.
  func send(_ method: String, _ params: [String: Any], timeoutMs: Int = 120_000) throws -> Int {
    sequence += 1
    let frame = try JSONSerialization.data(withJSONObject: [
      "id": sequence, "method": method, "params": params, "timeoutMs": timeoutMs,
    ])
    let helper = helper, connection = connection
    Task { @MainActor in await helper.handle(connection: connection, frame: frame) }
    return sequence
  }
  func reply(_ id: Int, seconds: Double = 150) async throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(seconds)
    while pending[id] == nil {
      try require(Date() < deadline, "No reply to request \(id)")
      let client = client, decoder = decoder
      let frame = try await Task.detached { () throws -> Data? in
        if let value = try decoder.withLock({ try $0.next() }) { return value }
        var ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
        guard poll(&ready, 1, 200) > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: 65_536)
        let count = Darwin.read(client, &bytes, bytes.count)
        guard count > 0 else { throw JourneyFailure.failed("AgentWire ended") }
        decoder.withLock { $0.append(Data(bytes.prefix(count))) }
        return try decoder.withLock { try $0.next() }
      }.value
      guard let frame, let object = try JSONSerialization.jsonObject(with: frame) as? [String: Any],
        let number = (object["id"] as? NSNumber)?.intValue else { continue }
      pending[number] = object
    }
    return pending.removeValue(forKey: id)!
  }
  func request(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    let envelope = try await reply(try send(method, params))
    if let error = envelope["error"] as? [String: Any] {
      throw JourneyFailure.failed("\(method): \(error["code"] ?? "") \(error["message"] ?? "")")
    }
    return try (envelope["result"] as? [String: Any]).unwrap(method + " result")
  }
  /// The connection drops: the helper hears it closed, as its server reports a dropped socket.
  private var dropped = false
  func drop() {
    guard !dropped else { return }
    dropped = true
    helper.connectionClosed(connection)
    connection.close()
    Darwin.close(client)
  }
}

/// One agent session on Safari's fixture window.
@MainActor final class Agent {
  let wire: AgentWire
  let session = "cus_" + UUID().uuidString.lowercased()
  let target: [String: Any]
  var ref = ""
  var snapshot: String?
  var tree = ""
  init(wire: AgentWire, identity: Any) { self.wire = wire; target = ["identity": identity, "access": "read-write"] }
  func open(title: String) async throws {
    _ = try await wire.request("hello", ["protocolVersion": 11, "ownerViewVersion": 3])
    _ = try await wire.request("session.open", ["sessionId": session, "threadTitle": "Safari front journey"])
    let listed = try await wire.request("session.windows", ["sessionId": session, "app": target])
    let windows = (listed["windows"] as? [[String: Any]]) ?? []
    let window = try windows.first { ($0["title"] as? String)?.contains(title) == true }
      .unwrap("Safari window titled \(title) in \(windows.map { $0["title"] ?? "" })")
    let bound = try await wire.request("session.bind", ["sessionId": session, "app": target, "windowId": window["windowId"]!])
    ref = try ((bound["window"] as? [String: Any])?["ref"] as? String).unwrap("bound ref")
    // The page at its top, where its field and link are in view.
    try await observe()
    if !tree.contains("Fixture field") {
      _ = try await act([["type": "scroll", "target": ["index": 0], "direction": "up", "amount": 50]], snapshot: true)
      try await observe()
    }
  }
  @discardableResult func observe() async throws -> [String: Any] {
    let result = try await wire.request("session.observe", ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
    let observation = try (result["observation"] as? [String: Any]).unwrap("observation")
    snapshot = observation["snapshot"] as? String
    tree = observation["tree"] as? String ?? ""
    return observation
  }
  func index(role: String, containing text: String) throws -> Int {
    for line in tree.split(separator: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard trimmed.hasPrefix("["), let close = trimmed.firstIndex(of: "]"),
        let number = Int(trimmed[trimmed.index(after: trimmed.startIndex)..<close]) else { continue }
      let rest = trimmed[trimmed.index(after: close)...].trimmingCharacters(in: .whitespaces)
      if rest.hasPrefix(role), rest.contains(text) { return number }
    }
    throw JourneyFailure.failed("No \(role) with \(text) in the tree: \(tree.prefix(1_500))")
  }
  /// The middle of an element on screen, from its line in the tree: "(x,y w×h)" in the
  /// window's own points on this 1x display.
  func screenPoint(index: Int, window: CGRect) throws -> CGPoint {
    let line = try tree.split(separator: "\n").first { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[\(index)]") }
      .unwrap("tree line \(index)")
    // The first "(x,y w×h)" of the line; a "(focused)" may follow it.
    let text = String(line)
    let pattern = try NSRegularExpression(pattern: #"\((-?[0-9.]+),(-?[0-9.]+) ([0-9.]+)×([0-9.]+)\)"#)
    let match = try pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)).unwrap("element frame in \(line)")
    let numbers = (1...4).compactMap { Range(match.range(at: $0), in: text).flatMap { Double(text[$0]) } }
    try require(numbers.count == 4, "element frame in \(line)")
    return CGPoint(x: window.minX + numbers[0] + numbers[2] / 2, y: window.minY + numbers[1] + numbers[3] / 2)
  }
  /// One call; its receipt, or the error it ended with.
  func act(_ actions: [[String: Any]], snapshot needed: Bool = false) async throws -> [String: Any] {
    let envelope = try await wire.reply(try wire.send("session.act", [
      "sessionId": session, "app": target, "window": ref,
      "snapshot": needed ? (snapshot.map { $0 as Any } ?? NSNull()) : NSNull(), "actions": actions,
    ]))
    return (envelope["result"] as? [String: Any]) ?? ["error": envelope["error"] ?? "no result"]
  }
}

/// The person watching Safari's window live, as the Opensteer app's Watch pane does: an owner
/// view of the window and its video stream, every frame acknowledged as a viewer does.
@MainActor final class Watch {
  let control: AgentWire
  let media: AgentWire
  let view = "cvw_" + UUID().uuidString.lowercased()
  var stream = ""
  let frames = Locked(0)
  let stopped = Locked(false)
  var renewal: Task<Void, Never>?

  init(helper: HelperRuntime) throws {
    control = try AgentWire(helper: helper)
    media = try AgentWire(helper: helper)
  }
  func start(identity: Any, title: String) async throws {
    _ = try await control.request("hello", ["protocolVersion": 11, "ownerViewVersion": 3, "videoProfile": 1])
    let listed = try await control.request("view.windows", ["app": identity])
    let windows = (listed["windows"] as? [[String: Any]]) ?? []
    let window = try windows.first { ($0["title"] as? String)?.contains(title) == true }.unwrap("watched window")
    _ = try await control.request("view.open", ["viewId": view, "generation": 1, "leaseDurationMs": 120_000,
      "target": ["kind": "app", "app": identity, "windowId": window["windowId"]!]])
    let source: [String: Any] = ["kind": "owner-view", "viewId": view, "generation": 1]
    let resolved = try await control.request("display.resolve", ["source": source])
    let target = try (resolved["target"] as? [String: Any]).unwrap("video target")
    stream = "dsp_" + UUID().uuidString.lowercased()
    let started = try await control.request("display.start", ["streamId": stream, "target": target,
      "sources": [source], "maxLongSide": 1280, "maxFps": 60, "maxBitrate": NSNull()])
    _ = try await media.request("hello", ["protocolVersion": 11, "ownerViewVersion": 3])
    _ = try await media.request("display.attach", ["token": started["attachmentToken"]!])
    let client = media.client, decoder = media.decoder, frames = frames, stopped = stopped
    Thread.detachNewThread {
      var bytes = [UInt8](repeating: 0, count: 262_144)
      while !stopped.current {
        while let frame = try? decoder.withLock({ try $0.next() }) {
          guard frame.count > 4 else { continue }
          let length = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
          guard length > 0, length < frame.count - 4,
            let header = try? JSONSerialization.jsonObject(with: frame.subdata(in: 4..<(4 + length))) as? [String: Any],
            let sequence = (header["sequence"] as? NSNumber)?.intValue,
            let ack = try? Frame.encode(JSONSerialization.data(withJSONObject: ["type": "display.ack", "sequence": sequence]))
          else { continue }
          frames.withLock { $0 += 1 }
          _ = ack.withUnsafeBytes { Darwin.write(client, $0.baseAddress, $0.count) }
        }
        var ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
        guard poll(&ready, 1, 200) > 0 else { continue }
        let count = Darwin.read(client, &bytes, bytes.count)
        if count <= 0 { return }
        decoder.withLock { $0.append(Data(bytes.prefix(count))) }
      }
    }
    let control = control, view = view
    renewal = Task { @MainActor in
      while !Task.isCancelled {
        await sleepSeconds(30)
        if Task.isCancelled { return }
        _ = try? await control.request("view.renew", ["viewId": view, "generation": 1, "leaseDurationMs": 120_000])
      }
    }
  }
  func stop() async -> Int {
    renewal?.cancel()
    _ = try? await control.request("display.stop", ["streamId": stream])
    _ = try? await control.request("view.close", ["viewId": view, "generation": 1, "leaseDurationMs": 120_000])
    stopped.withLock { $0 = true }
    await sleepSeconds(0.3)
    control.drop()
    media.drop()
    return frames.current
  }
}

/// The front app, sampled with wall-clock timestamps.
final class FrontSampler {
  private let rows = Locked<[[String: Any]]>([])
  private let queue = DispatchQueue(label: "front-sampler", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  func start(interval: DispatchTimeInterval = .milliseconds(50)) {
    let rows = rows
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: interval)
    timer.setEventHandler {
      rows.withLock { $0.append(["at": wallMs(), "front": Int(PrivateAPI.focusPID(front: true) ?? 0)]) }
    }
    self.timer = timer
    timer.resume()
  }
  func mark(_ name: String) { rows.withLock { $0.append(["at": wallMs(), "mark": name]) } }
  func stop() -> [[String: Any]] { timer?.cancel(); timer = nil; queue.sync {}; return rows.current }
}

@MainActor final class SafariFront {
  let out: URL
  let helper = HelperRuntime(helperVersion: "safari-front-journey", peerRequirement: .sameUser)
  let safariIdentity: Any
  var safari: NSRunningApplication!
  var front: NSRunningApplication!
  var frontReady: [String: Any] = [:]
  var fixtureURL: URL
  let fixtureLog: URL
  let frontLog: URL
  var screenshots = 0

  init(out: URL) async throws {
    self.out = out
    let env = ProcessInfo.processInfo.environment
    fixtureURL = try URL(string: env["OPENSTEER_SAFARI_FRONT_URL"].unwrap("OPENSTEER_SAFARI_FRONT_URL")).unwrap("fixture URL")
    fixtureLog = URL(fileURLWithPath: try env["OPENSTEER_SAFARI_FRONT_LOG"].unwrap("OPENSTEER_SAFARI_FRONT_LOG"))
    let frontApp = URL(fileURLWithPath: try env["OPENSTEER_SAFARI_FRONT_APP"].unwrap("OPENSTEER_SAFARI_FRONT_APP"))
    frontLog = URL(fileURLWithPath: try env["OPENSTEER_SAFARI_FRONT_APP_OUT"].unwrap("OPENSTEER_SAFARI_FRONT_APP_OUT"))
      .appendingPathComponent("front-events.jsonl")
    let safariPath = "/Applications/Safari.app"
    let record = try AppResolver.record(forBundleAtPath: safariPath).unwrap("Safari identity")
    safariIdentity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(record.identity))
    try helper.start(socketURL: out.appendingPathComponent("helper.sock"))
    // Safari on the fixture, then the person's front app over part of it.
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    let safariConfiguration = NSWorkspace.OpenConfiguration()
    safariConfiguration.activates = false
    // No windows restored from an earlier run: the fixture window is the only one.
    safariConfiguration.arguments = ["-ApplePersistenceIgnoreState", "YES"]
    safari = try await NSWorkspace.shared.open([fixtureURL], withApplicationAt: URL(fileURLWithPath: safariPath), configuration: safariConfiguration)
    Owned.apps.append(safari)
    try await waitForWindow(pid: safari.processIdentifier, title: "Sol fixture", seconds: 30)
    try placeSafari()
    let frontConfiguration = NSWorkspace.OpenConfiguration()
    frontConfiguration.activates = false
    frontConfiguration.createsNewApplicationInstance = true
    front = try await NSWorkspace.shared.openApplication(at: frontApp, configuration: frontConfiguration)
    Owned.apps.append(front)
    let ready = frontLog.deletingLastPathComponent().appendingPathComponent("front-ready.json")
    for _ in 0..<200 where !FileManager.default.fileExists(atPath: ready.path) { await sleepSeconds(0.05) }
    frontReady = try (JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: Any]).unwrap("front ready")
  }
  func close() { helper.stop() }

  func run() async throws -> [String: Bool] {
    let cases = (ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_CASES"] ?? "front").split(separator: ",").map(String.init)
    var results: [String: Bool] = [:]
    for name in cases {
      let caseOut = out.appendingPathComponent(name)
      try FileManager.default.createDirectory(at: caseOut, withIntermediateDirectories: true)
      var row: [String: Any]
      let watched = name.hasSuffix("-watch")
      var watch: Watch?
      do {
        let kind = try SafariFrontCase.parse(name)
        if watched {
          let started = try Watch(helper: helper)
          watch = started
          try await started.start(identity: safariIdentity, title: "Sol fixture")
          await sleepSeconds(1)
        }
        switch kind {
        case .front: row = try await frontCase(caseOut)
        case .stop: row = try await stopCase(caseOut)
        case .typing: row = try await typingCase(caseOut)
        case .typeInto: row = try await typeIntoCase(caseOut)
        case .control: row = try await controlCase(caseOut)
        case .controlIdle: row = try await controlCase(caseOut, agentActs: false)
        case .choice: row = try await choiceCase(caseOut)
        case .churn: row = try await churnCase(caseOut)
        case .overlay: row = try await overlayCase(caseOut)
        }
      } catch {
        row = ["met": false, "error": String(describing: error)]
      }
      if let watch {
        let frames = await watch.stop()
        row["watchFrames"] = frames
        // A watched case counts only with the live picture flowing.
        if frames < 10 { row["met"] = false; row["watchError"] = "the live picture did not flow" }
      }
      try? JSONSerialization.data(withJSONObject: row, options: [.prettyPrinted, .sortedKeys])
        .write(to: caseOut.appendingPathComponent("case.json"))
      results[name] = row["met"] as? Bool ?? false
    }
    return results
  }

  // MARK: - Fixture handling

  func waitForWindow(pid: pid_t, title: String, seconds: Double) async throws {
    let app = AXUIElementCreateApplication(pid)
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      let titles = AXValueReader.copyElements(app, kAXWindowsAttribute).compactMap { AXValueReader.copyString($0, kAXTitleAttribute) }
      if titles.contains(where: { $0.contains(title) }) { return }
      await sleepSeconds(0.2)
    }
    throw JourneyFailure.failed("No \(title) window")
  }
  func safariWindow() throws -> AXUIElement {
    let app = AXUIElementCreateApplication(safari.processIdentifier)
    return try AXValueReader.copyElements(app, kAXWindowsAttribute).first {
      AXValueReader.copyString($0, kAXTitleAttribute)?.contains("Sol fixture") == true
    }.unwrap("Safari fixture window")
  }
  /// Safari to the right, under the front app's left part: a part of each stays exposed.
  func placeSafari() throws {
    let window = try safariWindow()
    var position = CGPoint(x: 560, y: 60), size = CGSize(width: 710, height: 700)
    _ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &position)!)
    _ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
  }
  func point(_ key: String) throws -> CGPoint {
    let value = try (frontReady[key] as? [String: Any]).unwrap(key)
    return CGPoint(x: (value["x"] as! NSNumber).doubleValue, y: (value["y"] as! NSNumber).doubleValue)
  }
  /// The person clicks at a screen point (top-left origin); the wall-clock time it was sent.
  @discardableResult func personClick(_ at: CGPoint) async throws -> Int64 {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--person-click", String(Double(at.x)), String(Double(at.y))]
    process.standardOutput = pipe
    try process.run()
    while process.isRunning { await sleepSeconds(0.02) }
    try require(process.terminationStatus == 0, "Person click failed (\(process.terminationStatus))")
    let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    return Int64(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
  }
  func personKeys(_ text: String, intervalMs: Int, log: URL) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--person-keys", text, String(intervalMs), log.path]
    try process.run()
    return process
  }
  func makeFront(_ app: NSRunningApplication, at: CGPoint) async throws {
    // Always one click (it also focuses what is under it); a second when the first did not
    // bring the app forward.
    for attempt in 0..<2 where attempt == 0 || PrivateAPI.focusPID(front: true) != app.processIdentifier {
      try await personClick(at)
      for _ in 0..<40 where PrivateAPI.focusPID(front: true) != app.processIdentifier { await sleepSeconds(0.05) }
    }
    if PrivateAPI.focusPID(front: true) != app.processIdentifier { await screenshot(out, "front-refused") }
    try require(PrivateAPI.focusPID(front: true) == app.processIdentifier,
      "\(app.localizedName ?? "app") did not come to the front; front is \(PrivateAPI.focusPID(front: true) ?? 0)")
  }
  func screenshot(_ caseOut: URL, _ name: String) async {
    screenshots += 1
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "jpg", caseOut.appendingPathComponent(String(format: "%03d-%@.jpg", screenshots, name)).path]
    if (try? process.run()) != nil { while process.isRunning { await sleepSeconds(0.02) } }
  }
  /// Whether a Safari window is drawn over the front app's window.
  func safariAboveFront() -> Bool {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let owner = { (row: [String: Any]) in (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value }
    let layer = { (row: [String: Any]) in (row[kCGWindowLayer as String] as? NSNumber)?.intValue }
    guard let frontIndex = windows.firstIndex(where: { owner($0) == self.front.processIdentifier && layer($0) == 0 }) else { return false }
    return windows[..<frontIndex].contains { owner($0) == self.safari.processIdentifier && layer($0) == 0 }
  }
  func lines(_ url: URL, after: Int = 0) -> [[String: Any]] {
    ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").dropFirst(after).compactMap {
      try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
    }
  }
  func lineCount(_ url: URL) -> Int { ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").count }

  /// Each call: its times and the front app when it returned and 300 ms later.
  struct Call { let name: String; let start: Int64; let end: Int64; let frontAtEnd: pid_t?; let frontAfter: pid_t?; let safariAbove: Bool; let receipt: [String: Any] }
  func call(_ agent: Agent, _ name: String, _ caseOut: URL, sampler: FrontSampler, shots: Bool = true,
            snapshot: Bool = false, _ actions: [[String: Any]]) async throws -> Call {
    sampler.mark("start " + name)
    let start = wallMs()
    // No actions: the call is an observation.
    let receipt = actions.isEmpty ? try await agent.observe() : try await agent.act(actions, snapshot: snapshot)
    let end = wallMs()
    let atEnd = PrivateAPI.focusPID(front: true)
    sampler.mark("end " + name)
    await sleepSeconds(0.3)
    let after = PrivateAPI.focusPID(front: true)
    let above = safariAboveFront()
    if shots { await screenshot(caseOut, name) }
    return Call(name: name, start: start, end: end, frontAtEnd: atEnd, frontAfter: after, safariAbove: above, receipt: receipt)
  }
  func json(_ call: Call) -> [String: Any] {
    ["name": call.name, "start": call.start, "end": call.end, "frontAtEnd": Int(call.frontAtEnd ?? 0),
     "frontAfter300ms": Int(call.frontAfter ?? 0), "safariAboveFrontAfter300ms": call.safariAbove,
     "error": (call.receipt["error"] as? [String: Any])?["message"] ?? call.receipt["error"] ?? NSNull()]
  }
  /// Every stretch Safari was in front, from the 50 ms samples.
  func safariEpisodes(_ samples: [[String: Any]]) -> [[String: Any]] {
    var episodes: [[String: Any]] = []
    var since: Int64?
    for row in samples where row["front"] != nil {
      let at = (row["at"] as! NSNumber).int64Value
      let isSafari = (row["front"] as! NSNumber).int32Value == safari.processIdentifier
      if isSafari, since == nil { since = at }
      if !isSafari, let start = since { episodes.append(["from": start, "ms": Int(at - start)]); since = nil }
    }
    if let start = since { episodes.append(["from": start, "ms": -1, "open": true]) }
    return episodes
  }

  // MARK: - a / b: the front app stays in front through every kind of call

  func frontCase(_ caseOut: URL) async throws -> [String: Any] {
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await makeFront(front, at: point("field"))
    await screenshot(caseOut, "before")
    let sampler = FrontSampler()
    sampler.start()
    var calls: [Call] = []
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    calls.append(try await call(agent, "type-into", caseOut, sampler: sampler, snapshot: true,
      [["type": "type", "text": "a", "target": ["index": field]]]))
    for number in 1...4 {
      for step in 1...3 {
        calls.append(try await call(agent, "typing-\(number)-\(step)", caseOut, sampler: sampler, shots: step == 3,
          [["type": "type", "text": "q"]]))
        await sleepSeconds(3.5)
      }
    }
    try await agent.observe()
    let link = try agent.index(role: "link", containing: "Open fixture page")
    calls.append(try await call(agent, "click-index", caseOut, sampler: sampler, snapshot: true,
      [["type": "click", "target": ["index": link]]]))
    await sleepSeconds(1)
    try await agent.observe()
    let scrollAt = try agent.index(role: "link", containing: "Open fixture page")
    calls.append(try await call(agent, "scroll", caseOut, sampler: sampler, snapshot: true,
      [["type": "scroll", "target": ["index": scrollAt], "direction": "down", "amount": 3],
       ["type": "scroll", "target": ["index": scrollAt], "direction": "up", "amount": 3]]))
    // The menu action: View → Reload Page, which opens no window.
    calls.append(try await call(agent, "menu-reload", caseOut, sampler: sampler, [["type": "key", "keys": "cmd+r"]]))
    await sleepSeconds(0.5)
    let samples = sampler.stop()
    wire.drop()
    let frontPID = front.processIdentifier
    let episodes = safariEpisodes(samples)
    let lateEpisodes = episodes.filter { ($0["ms"] as? Int ?? 0) > 300 || $0["open"] as? Bool == true }
    let callsMet = calls.filter { $0.frontAfter == frontPID && !$0.safariAbove }.count
    try JSONSerialization.data(withJSONObject: samples).write(to: caseOut.appendingPathComponent("front-samples.json"))
    return [
      "met": callsMet == calls.count && lateEpisodes.isEmpty,
      "calls": calls.map(json), "callsWithFrontAppInFrontAfter300ms": callsMet, "callCount": calls.count,
      "callsWithFrontAppInFrontAtReturn": calls.filter { $0.frontAtEnd == frontPID }.count,
      "safariInFrontEpisodes": episodes, "episodesOver300ms": lateEpisodes.count,
      "frontPID": Int(frontPID), "safariPID": Int(safari.processIdentifier),
    ]
  }

  // MARK: - c: the person's Stop lands in the front app

  func stopCase(_ caseOut: URL) async throws -> [String: Any] {
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    _ = try await agent.act([["type": "click", "target": ["index": field]]], snapshot: true)
    try await makeFront(front, at: point("field"))
    let frontBaseline = lineCount(frontLog), fixtureBaseline = lineCount(fixtureLog)
    let sampler = FrontSampler()
    sampler.start()
    var clicked: Int64?
    var stopSeen: Int64?
    var steps = 0
    for step in 1...20 {
      if stopSeen != nil { break }
      _ = try await agent.act([["type": "type", "text": "q"]])
      steps += 1
      if step == 5 {
        clicked = try await personClick(point("stop"))
        await screenshot(caseOut, "after-stop-click")
      }
      if clicked != nil, let stop = lines(frontLog, after: frontBaseline).first(where: { $0["kind"] as? String == "stop" }) {
        stopSeen = (stop["at"] as? NSNumber)?.int64Value
      }
      await sleepSeconds(0.4)
    }
    await sleepSeconds(1)
    let samples = sampler.stop()
    wire.drop()
    let clickAt = try clicked.unwrap("click time")
    let fixture = lines(fixtureLog, after: fixtureBaseline)
    let keysAfter = fixture.filter { $0["kind"] as? String == "input" && (($0["at"] as? NSNumber)?.int64Value ?? 0) > clickAt + 300 }
    let clicksInSafari = fixture.filter {
      ["mousedown", "click"].contains($0["kind"] as? String ?? "") && abs((($0["at"] as? NSNumber)?.int64Value ?? 0) - clickAt) < 1_000
    }
    try JSONSerialization.data(withJSONObject: samples).write(to: caseOut.appendingPathComponent("front-samples.json"))
    return [
      "met": stopSeen != nil && keysAfter.isEmpty && clicksInSafari.isEmpty,
      "clickSentAt": clickAt, "stopReceivedAt": stopSeen ?? NSNull(), "agentSteps": steps,
      "fixtureKeysMoreThan300msAfterClick": keysAfter.count, "fixtureClicksFromThatClick": clicksInSafari.count,
      "safariInFrontEpisodes": safariEpisodes(samples),
    ]
  }

  // MARK: - d: the person's typing in the front app stays there

  func typingCase(_ caseOut: URL) async throws -> [String: Any] {
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    _ = try await agent.act([["type": "click", "target": ["index": field]]], snapshot: true)
    try await makeFront(front, at: point("field"))
    let frontBaseline = lineCount(frontLog), fixtureBaseline = lineCount(fixtureLog)
    let letters = String(repeating: "abcdefghijlnoprstuvwxyz", count: 2)
    let keysLog = caseOut.appendingPathComponent("person-keys.jsonl")
    let person = try personKeys(letters, intervalMs: 70, log: keysLog)
    for _ in 1...15 {
      _ = try await agent.act([["type": "type", "text": "q"]])
      await sleepSeconds(0.3)
    }
    while person.isRunning { await sleepSeconds(0.05) }
    await sleepSeconds(1)
    await screenshot(caseOut, "after")
    wire.drop()
    let frontInputs = lines(frontLog, after: frontBaseline).filter { $0["kind"] as? String == "input" }
    let typedHere = frontInputs.last?["value"] as? String ?? ""
    let safariInputs = lines(fixtureLog, after: fixtureBaseline).filter { $0["kind"] as? String == "input" }
    let personInSafari = safariInputs.compactMap { $0["data"] as? String }.filter { $0 != "q" }
    return [
      "met": typedHere.hasSuffix(letters) && personInSafari.isEmpty,
      "sent": letters.count, "arrivedInFrontApp": typedHere, "personLettersInSafari": personInSafari,
      "agentQsInSafari": safariInputs.filter { $0["data"] as? String == "q" }.count,
    ]
  }

  func typeIntoCase(_ caseOut: URL) async throws -> [String: Any] {
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await makeFront(front, at: point("field"))
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    let frontBaseline = lineCount(frontLog), fixtureBaseline = lineCount(fixtureLog)
    let letters = "abcdefghijlmnoprstuvwxyz"
    let agentText = "7482916530"
    let keysLog = caseOut.appendingPathComponent("person-keys.jsonl")
    let sampler = FrontSampler()
    sampler.start(interval: .milliseconds(10))
    defer { _ = sampler.stop() }
    let person = try personKeys(letters, intervalMs: 40, log: keysLog)
    defer { if person.isRunning { person.terminate() } }
    for _ in 0..<100 where lineCount(frontLog) == frontBaseline && person.isRunning {
      await sleepSeconds(0.01)
    }
    let act = try await call(agent, "type-into-during-person-typing", caseOut, sampler: sampler,
      shots: false, snapshot: true, [["type": "type", "text": agentText, "target": ["index": field]]])
    while person.isRunning { await sleepSeconds(0.05) }
    await sleepSeconds(0.3)
    let samples = sampler.stop()
    let episodes = safariEpisodes(samples)
    let frontPID = front.processIdentifier
    let frontSamples = samples.compactMap { ($0["front"] as? NSNumber)?.int32Value }
    let personLetters = lines(frontLog, after: frontBaseline).filter { $0["kind"] as? String == "input" }
      .compactMap { $0["data"] as? String }.joined()
    let safariInputs = lines(fixtureLog, after: fixtureBaseline).filter { $0["kind"] as? String == "input" }
    let safariValue = safariInputs.last?["value"] as? String ?? ""
    let overlappingKeys = lines(keysLog).filter {
      guard let at = ($0["at"] as? NSNumber)?.int64Value else { return false }
      return at >= act.start && at <= act.end
    }.count
    let completed = (act.receipt["performed"] as? [String])?.count == 1 && act.receipt["error"] is NSNull
    // Accessibility writes run with the screen live. As in the front case, permit a Safari
    // activation lasting at most 300 ms, provided all of the person's keys still reach them.
    let lateEpisodes = episodes.filter { ($0["ms"] as? Int ?? 0) > 300 || $0["open"] as? Bool == true }
    let frontRestored = !frontSamples.isEmpty && lateEpisodes.isEmpty
      && frontSamples.allSatisfy { $0 == frontPID || $0 == safari.processIdentifier }
      && act.frontAtEnd == frontPID && act.frontAfter == frontPID && !act.safariAbove
    try JSONSerialization.data(withJSONObject: samples).write(to: caseOut.appendingPathComponent("front-samples.json"))
    await screenshot(caseOut, "after")
    return [
      "met": completed && frontRestored && person.terminationStatus == 0 && overlappingKeys > 0
        && personLetters == letters && safariValue.contains(agentText),
      "frontSamples": frontSamples.count, "safariInFrontEpisodes": episodes,
      "safariEpisodesOver300msOrOpen": lateEpisodes.count, "frontAppRestored": frontRestored,
      "safariInFrontSamples": frontSamples.filter { $0 == safari.processIdentifier }.count,
      "personLettersSent": lines(keysLog).count, "personLettersReceived": personLetters.count,
      "personLettersInOrder": personLetters == letters, "personKeysDuringAct": overlappingKeys,
      "agentTextInSafari": safariValue.contains(agentText), "safariFieldValue": safariValue,
      "call": json(act), "receipt": act.receipt,
    ]
  }

  // MARK: - e: TextEdit in front, the control

  private struct KeyRoute: Encodable {
    let lane: String
    let stamp: UInt64
    let at: Int64
    let source: Int64
    let destination: Int64
  }

  private func keyRoutes(to textEdit: pid_t, recording routes: Locked<[KeyRoute]>) async throws -> [EventTap] {
    guard ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_TRACE_KEYS"] == "1" else {
      return []
    }
    let lanes: [(String, EventTap.Scope)] = [
      ("session", .session), ("textEdit", .process(textEdit)),
      ("safari", .process(safari.processIdentifier)),
    ]
    let taps = try lanes.map { lane, scope in
      try EventTap(scope, place: .tailAppendEventTap, options: .listenOnly,
        types: [CGEventType.keyDown.rawValue], handler: { _, event in
          let row = KeyRoute(lane: lane, stamp: event.timestamp, at: wallMs(),
            source: event.getIntegerValueField(FocusEvents.sourcePIDField),
            destination: event.getIntegerValueField(FocusEvents.targetPIDField))
          routes.withLock { $0.append(row) }
          return event
        }).unwrap("control keyboard observer \(lane)")
    }
    await withCheckedContinuation { ready in
      EventTapThread.shared.perform { ready.resume() }
    }
    return taps
  }

  func controlCase(_ caseOut: URL, agentActs: Bool = true) async throws -> [String: Any] {
    let document = caseOut.appendingPathComponent("control.txt")
    try Data().write(to: document)
    let configuration = NSWorkspace.OpenConfiguration()
    let textEdit = try await NSWorkspace.shared.open([document], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"), configuration: configuration)
    Owned.apps.append(textEdit)
    try await waitForWindow(pid: textEdit.processIdentifier, title: "control", seconds: 20)
    let textWindow = try AXValueReader.copyElements(AXUIElementCreateApplication(textEdit.processIdentifier), kAXWindowsAttribute).first.unwrap("TextEdit window")
    var position = CGPoint(x: 20, y: 60), size = CGSize(width: 520, height: 600)
    _ = AXUIElementSetAttributeValue(textWindow, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &position)!)
    _ = AXUIElementSetAttributeValue(textWindow, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    await sleepSeconds(0.5)
    try await makeFront(textEdit, at: CGPoint(x: 200, y: 300))
    let wire = agentActs ? try AgentWire(helper: helper) : nil
    defer { wire?.drop() }
    let agent = wire.map { Agent(wire: $0, identity: safariIdentity) }
    try await agent?.open(title: "Sol fixture")
    let cycle = "abcdefghijlnoprstuvwxyz"
    let letters = String(String(repeating: cycle, count: 42).prefix(960))
    let keysLog = caseOut.appendingPathComponent("person-keys.jsonl")
    let routes = Locked<[KeyRoute]>([])
    let observers = try await keyRoutes(to: textEdit.processIdentifier, recording: routes)
    defer { for observer in observers { observer.stop() } }
    #if SAFARI_FRONT_KEY_TRACE
    if !observers.isEmpty { SafariKeyTapTrace.rows.withLock { $0 = [] } }
    defer { SafariKeyTapTrace.rows.withLock { $0 = nil } }
    #endif
    let person = try personKeys(letters, intervalMs: 40, log: keysLog)
    var calls: [Call] = []
    let sampler = FrontSampler()
    sampler.start()
    if let agent {
      for round in 1...5 {
        calls.append(try await call(agent, "observe-\(round)", caseOut, sampler: sampler, shots: false, [] ))
        try await agent.observe()
        let link = try agent.index(role: "link", containing: "Open fixture page")
        calls.append(try await call(agent, "click-index-\(round)", caseOut, sampler: sampler, shots: false, snapshot: true, [["type": "click", "target": ["index": link]]]))
        await sleepSeconds(0.6)
        try await agent.observe()
        let field = try agent.index(role: "textfield", containing: "Fixture field")
        calls.append(try await call(agent, "type-into-\(round)", caseOut, sampler: sampler, shots: false, snapshot: true, [["type": "type", "text": "k", "target": ["index": field]]]))
        try await agent.observe()
        calls.append(try await call(agent, "click-then-type-\(round)", caseOut, sampler: sampler, shots: false, snapshot: true, [["type": "click", "target": ["index": field]], ["type": "type", "text": "m"]]))
        try await agent.observe()
        calls.append(try await call(agent, "scroll-\(round)", caseOut, sampler: sampler, shots: false, snapshot: true, [["type": "scroll", "target": ["index": link], "direction": "down", "amount": 2], ["type": "scroll", "target": ["index": link], "direction": "up", "amount": 2]]))
        calls.append(try await call(agent, "menu-\(round)", caseOut, sampler: sampler, shots: round == 5, [["type": "key", "keys": "cmd+r"]]))
      }
    }
    while person.isRunning { await sleepSeconds(0.05) }
    await sleepSeconds(1)
    let samples = sampler.stop()
    await screenshot(caseOut, "after")
    wire?.drop()
    defer { textEdit.hide() }
    let area = AXValueReader.copyElement(textWindow, "AXFocusedUIElement" as String)
      ?? AXValueReader.copyElement(AXUIElementCreateApplication(textEdit.processIdentifier), kAXFocusedUIElementAttribute)
    let typed = area.flatMap { AXValueReader.copyString($0, kAXValueAttribute) } ?? ""
    let kept = typed.lowercased().filter { $0.isLetter }
    var matched = 0
    var iterator = kept.makeIterator()
    var next = iterator.next()
    for expected in letters where next != nil {
      if next == expected { matched += 1; next = iterator.next() }
    }
    let textEditFront = calls.filter { $0.frontAfter == textEdit.processIdentifier }.count
    try JSONSerialization.data(withJSONObject: samples).write(to: caseOut.appendingPathComponent("front-samples.json"))
    if !observers.isEmpty {
      try JSONEncoder().encode(routes.current).write(to: caseOut.appendingPathComponent("key-routing.json"))
    }
    #if SAFARI_FRONT_KEY_TRACE
    if let tapTrace = SafariKeyTapTrace.rows.current {
      try JSONEncoder().encode(tapTrace).write(to: caseOut.appendingPathComponent("key-taps.json"))
    }
    #endif
    return [
      "met": textEditFront == calls.count && kept == letters,
      "callCount": calls.count, "textEditFrontAfter300ms": textEditFront,
      "lettersSent": letters.count, "lettersKeptInOrder": matched, "textEditText": typed,
      "extraOrStray": kept.count - matched, "calls": calls.map(json), "safariInFrontEpisodes": safariEpisodes(samples),
    ]
  }

  // MARK: - f: a person who clicks into Safari keeps it

  func choiceCase(_ caseOut: URL) async throws -> [String: Any] {
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    _ = try await agent.act([["type": "click", "target": ["index": field]]], snapshot: true)
    try await makeFront(front, at: point("field"))
    let frame = try KeyWindow.currentFrame(KeyWindow.windowID(of: safariWindow()).unwrap("Safari window id")).unwrap("Safari frame")
    let fieldPoint = try agent.screenPoint(index: field, window: frame)
    try require(fieldPoint.x > 720, "Safari's field is not in its exposed part: \(fieldPoint)")
    var frontAfterClick: [Int] = []
    var errors = 0
    var errorMessages: [String] = []
    for step in 1...12 {
      let receipt = try await agent.act([["type": "type", "text": "q"]])
      if let error = receipt["error"], !(error is NSNull) { errors += 1; errorMessages.append(String(describing: error).prefix(160).description) }
      if step == 3 {
        // Safari's own field: the window comes forward and the page keeps its field's focus.
        // (The helper's overlay pill covers the exposed part of Safari's toolbar.)
        try await personClick(fieldPoint)
        await sleepSeconds(0.5)
        frontAfterClick.append(Int(PrivateAPI.focusPID(front: true) ?? 0))
        await screenshot(caseOut, "after-choice-click")
      }
      await sleepSeconds(0.4)
    }
    frontAfterClick.append(Int(PrivateAPI.focusPID(front: true) ?? 0))
    await sleepSeconds(1)
    frontAfterClick.append(Int(PrivateAPI.focusPID(front: true) ?? 0))
    await screenshot(caseOut, "end")
    wire.drop()
    let safariPID = Int(safari.processIdentifier)
    return [
      "met": frontAfterClick.allSatisfy { $0 == safariPID } && errors == 0,
      "frontAfterClickThenAtEndThenOneSecondLater": frontAfterClick, "safariPID": safariPID, "agentErrors": errors,
      "agentErrorMessages": errorMessages,
    ]
  }

  // MARK: - g: about 2,000 single-key acts in bursts of 64 through the guard

  func churnCase(_ caseOut: URL) async throws -> [String: Any] {
    let reports = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/DiagnosticReports")
    let before = Set((try? FileManager.default.contentsOfDirectory(atPath: reports.path)) ?? [])
    let pid = getpid()
    let wire = try AgentWire(helper: helper)
    defer { wire.drop() }
    let agent = Agent(wire: wire, identity: safariIdentity)
    try await agent.open(title: "Sol fixture")
    try await agent.observe()
    let field = try agent.index(role: "textfield", containing: "Fixture field")
    _ = try await agent.act([["type": "click", "target": ["index": field]]], snapshot: true)
    try await makeFront(front, at: point("field"))
    let started = Date()
    var errors: [String: Int] = [:]
    var acts = 0
    let deadline = Int64(ProcessInfo.processInfo.environment["OPENSTEER_SAFARI_FRONT_DEADLINE"] ?? "") ?? Int64.max
    var stoppedEarly = false
    while acts < 1_984 {
      if wallMs() > deadline { stoppedEarly = true; break }
      for _ in 0..<64 {
        let receipt = try await agent.act([["type": "key", "keys": "q"]])
        if let error = receipt["error"], !(error is NSNull) { errors[String(describing: error).prefix(120).description, default: 0] += 1 }
        acts += 1
      }
      await sleepSeconds(0.2)
    }
    let seconds = Date().timeIntervalSince(started)
    await screenshot(caseOut, "after")
    wire.drop()
    let after = Set((try? FileManager.default.contentsOfDirectory(atPath: reports.path)) ?? [])
    let new = after.subtracting(before).sorted()
    return [
      "met": new.isEmpty && getpid() == pid && !stoppedEarly, "acts": acts, "stoppedEarlyForTheSuiteDeadline": stoppedEarly,
      "seconds": seconds, "errors": errors,
      "pidStart": Int(pid), "pidEnd": Int(getpid()), "newDiagnosticReports": new,
    ]
  }

  // MARK: - h: the overlay's connection-lost notice

  /// Every overlay status shown during `seconds`, in order.
  func pillStatuses(seconds: Double) async -> [String] {
    var seen: [String] = []
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      for window in NSApp.windows where window.isVisible {
        for text in Self.texts(window.contentView) where !text.isEmpty && seen.last != text { seen.append(text) }
      }
      await sleepSeconds(0.05)
    }
    return seen
  }
  static func texts(_ view: NSView?) -> [String] {
    guard let view else { return [] }
    return ((view as? NSTextField).map { [$0.stringValue] } ?? []) + view.subviews.flatMap { texts($0) }
  }
  func overlayCase(_ caseOut: URL) async throws -> [String: Any] {
    // Idle: the act has returned when the connection drops.
    let idleWire = try AgentWire(helper: helper)
    defer { idleWire.drop() }
    let idle = Agent(wire: idleWire, identity: safariIdentity)
    try await idle.open(title: "Sol fixture")
    try await idle.observe()
    _ = try await idle.act([["type": "key", "keys": "z"]])
    await sleepSeconds(0.6)
    idleWire.drop()
    let idleSeen = await pillStatuses(seconds: 3)
    await screenshot(caseOut, "idle-drop")
    // In flight: dropped while a long act is going out.
    let busyWire = try AgentWire(helper: helper)
    defer { busyWire.drop() }
    let busy = Agent(wire: busyWire, identity: safariIdentity)
    try await busy.open(title: "Sol fixture")
    try await busy.observe()
    let baseline = lineCount(fixtureLog)
    _ = try busyWire.send("session.act", [
      "sessionId": busy.session, "app": busy.target, "window": busy.ref, "snapshot": NSNull(),
      "actions": Array(repeating: ["type": "key", "keys": "z"] as [String: Any], count: 32),
    ])
    // Dropped once the act's first key has reached the page: work is under way.
    var underWay = false
    for _ in 0..<100 where !underWay {
      underWay = lines(fixtureLog, after: baseline).contains { $0["kind"] as? String == "keydown" && $0["key"] as? String == "z" }
      if !underWay { await sleepSeconds(0.05) }
    }
    let inFlight = helper.registry.sessions.count
    busyWire.drop()
    let busySeen = await pillStatuses(seconds: 3)
    await screenshot(caseOut, "busy-drop")
    let lost = "Connection lost · last action unconfirmed"
    return [
      "met": underWay && !idleSeen.contains(lost) && idleSeen.contains("Computer use ended") && busySeen.contains(lost),
      "firstKeyReachedThePageBeforeTheDrop": underWay,
      "dropped": "the agent's IPC connection closed: HelperRuntime.connectionClosed, as the helper's server reports a dropped socket, then both socket ends closed",
      "idleStatuses": idleSeen, "inFlightStatuses": busySeen, "sessionsWhenDropped": inFlight,
    ]
  }
}
