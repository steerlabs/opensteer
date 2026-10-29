import AppKit
import ApplicationServices

// Executes shipping core directly. The initial N1 journey deliberately uses the
// earlier public planner, so the old overlap bug fails at runtime.
enum JourneyFailure: Error { case failed(String) }
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw JourneyFailure.failed(message) }
}
@main struct Journey {
  @MainActor static func main() {
    if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--owner-person-stream" {
      OwnerPersonStream.run(log: URL(fileURLWithPath: CommandLine.arguments[2]))
    }
    if [5, 6].contains(CommandLine.arguments.count), CommandLine.arguments[1] == "--person-click",
      let x = Double(CommandLine.arguments[2]), let y = Double(CommandLine.arguments[3]),
      let window = UInt32(CommandLine.arguments[4]) {
      guard CGPreflightPostEventAccess() else { exit(3) }
      let env = ProcessInfo.processInfo.environment
      if let path = env["OPENSTEER_PERSON_WAIT_EVENTS"],
        let token = env["OPENSTEER_PERSON_WAIT_TOKEN"]
      {
        let baseline = Int(env["OPENSTEER_PERSON_WAIT_BASELINE"] ?? "0") ?? 0
        let deadline = Date().addingTimeInterval(3)
        var started = false
        while !started, Date() < deadline {
          let rows =
            (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n").dropFirst(
              baseline) ?? []
          started = rows.contains { $0.contains("\"characters\":\"" + token + "\"") }
          if !started { usleep(10_000) }
        }
        guard started else { exit(5) }
      }
      if CommandLine.arguments.count == 6 { usleep(UInt32(CommandLine.arguments[5]) ?? 0) }
      for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { exit(4) }
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.setIntegerValueField(FocusEvents.windowNumberField, value: Int64(window))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
        event.post(tap: .cghidEventTap)
        usleep(50_000)
      }
      // The person goes on to type, as they would after clicking in.
      if let typed = ProcessInfo.processInfo.environment["OPENSTEER_PERSON_THEN_TYPE"] {
        usleep(300_000)
        for down in [true, false] {
          guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0x23, keyDown: down)
          else { exit(4) }
          let units = Array(typed.utf16)
          event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
          event.post(tap: .cghidEventTap)
          usleep(20_000)
        }
      }
      exit(0)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    Task {
      let out = URL(fileURLWithPath: CommandLine.arguments[1])
      var result: [String: Any] = ["case": ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_SELECTION"] ?? "members", "passed": false]
      do {
        let electron = ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_ELECTRON_APP"]
        let fixture = URL(fileURLWithPath: electron ?? CommandLine.arguments[2])
        let process = try await launchFixture(fixture, arguments: [out.path])
        defer { process.terminate() }
        if electron != nil {
          let readyBy = Date().addingTimeInterval(10)
          while !FileManager.default.fileExists(atPath: out.appendingPathComponent("electron-ready.json").path), Date() < readyBy {
            try await Task.sleep(nanoseconds: 50_000_000)
          }
          try require(FileManager.default.fileExists(atPath: out.appendingPathComponent("electron-ready.json").path),
            "Electron owner fixture did not become ready")
          let record = try AppResolver.record(forBundleAtPath: fixture.path).unwrap("Electron fixture identity")
          let inventory = try await SessionWindows.ownerWindows(record: record, budget: .unlimited)
          let rows = Dictionary(uniqueKeysWithValues: inventory.windows.map { window in
            (window.title, ["id": window.id] as [String: Any])
          })
          try JSONSerialization.data(withJSONObject: rows).write(to: out.appendingPathComponent("windows.json"))
        }
        let until = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(
          atPath: out.appendingPathComponent("windows.json").path), Date() < until
        { try await Task.sleep(nanoseconds: 50_000_000) }
        let data = try Data(contentsOf: out.appendingPathComponent("windows.json"))
        let rows = try JSONSerialization.jsonObject(with: data) as! [String: [String: Any]]
        let id = (rows["A"]!["id"] as! NSNumber).uint32Value
        let plan = try await capture(pid: process.processIdentifier, id: id)
        result["crop"] = [
          plan.cropPoints.minX, plan.cropPoints.minY, plan.cropPoints.width, plan.cropPoints.height,
        ]
        result["root"] = [
          plan.keyWindowFrame.minX, plan.keyWindowFrame.minY, plan.keyWindowFrame.width,
          plan.keyWindowFrame.height,
        ]
        let picture = await WindowCapture.take(plan)
        if let screenshot = picture.screenshot {
          try Data(base64Encoded: screenshot.base64)?.write(to: out.appendingPathComponent("A.jpg"))
        }
        try require(
          plan.cropPoints == plan.keyWindowFrame, "A crop includes an overlapping sibling document")
        try await Contracts.run(out: out, fixture: fixture, pid: process.processIdentifier)
        result["passed"] = true
      } catch { result["error"] = String(describing: error) }
      try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("result.json"))
      exit(result["passed"] as? Bool == true ? 0 : 1)
    }
    app.run()
  }
  @WorkActor static func capture(pid: pid_t, id: CGWindowID) async throws -> WindowCapture.Plan {
    let app = AXUIElementCreateApplication(pid)
    guard
      let window = AXValueReader.copyElements(app, kAXWindowsAttribute).first(where: {
        KeyWindow.windowID(of: $0) == id
      })
    else { throw JourneyFailure.failed("A absent from AXWindows") }
    return try await WindowCapture.plan(
      processIdentifier: pid, keyWindow: KeyWindow.identity(of: window, processIdentifier: pid))
  }
}

// LaunchServices establishes real app-bundle identity for WindowServer and TCC.
@MainActor func launchFixture(_ app: URL, arguments: [String] = []) async throws -> NSRunningApplication {
  let config = NSWorkspace.OpenConfiguration()
  config.activates = false
  config.createsNewApplicationInstance = ProcessInfo.processInfo.environment["OPENSTEER_JOURNEY_APPS"] != nil
  config.arguments = arguments
  let running = try await NSWorkspace.shared.openApplication(at: app, configuration: config)
  guard ProcessInfo.processInfo.environment["OPENSTEER_JOURNEY_APPS"] != nil else { return running }
  let stamp = try ProcessStamp.of(running.processIdentifier).unwrap("launched app identity")
  let claim: [String: Any] = ["pid": running.processIdentifier, "bundle": app.path,
    "startSeconds": stamp.startSeconds, "startMicroseconds": stamp.startMicroseconds]
  let request = try JSONSerialization.data(withJSONObject: claim) + Data([10])
  var timeout = timeval(tv_sec: 30, tv_usec: 0)
  setsockopt(3, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  var offset = 0
  while offset < request.count {
    let written = request.withUnsafeBytes { Darwin.write(3, $0.baseAddress!.advanced(by: offset), request.count - offset) }
    guard written > 0 else { throw JourneyFailure.failed("App registration bridge write failed") }
    offset += written
  }
  var reply = Data()
  while reply.last != 10, reply.count < 8192 {
    var byte: UInt8 = 0
    guard Darwin.read(3, &byte, 1) == 1 else { throw JourneyFailure.failed("App registration bridge ended") }
    reply.append(byte)
  }
  let result = try JSONSerialization.jsonObject(with: reply) as! [String: Any]
  try require(result["ok"] as? Bool == true, "App registration refused: " + (result["error"] as? String ?? "invalid acknowledgment"))
  return running
}
