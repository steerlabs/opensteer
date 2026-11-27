import AppKit
import ApplicationServices
import Darwin

// Item i: Calendar, then Reminders, set up through the real helper app, launched by
// LaunchServices as the product launches it, so macOS records its answer for the helper's own
// identity. The journey speaks the helper's socket as the Mac app does, answers each macOS
// prompt as a person would (Accessibility press, then a real click), reads TCC's rows before
// and after, and restarts the helper to read again.

/// The real helper's socket, framed as the Mac app frames it.
final class HelperSocket {
  let fd: Int32
  private var decoder = FrameDecoder()
  private var sequence = 0
  private var replies: [Int: [String: Any]] = [:]
  init(path: String) throws {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    try require(fd >= 0, "socket")
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    _ = withUnsafeMutablePointer(to: &address.sun_path) {
      $0.withMemoryRebound(to: CChar.self, capacity: 104) { strncpy($0, path, 103) }
    }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    try require(connected == 0, "connect to the helper's socket (\(errno))")
    var noPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout<Int32>.size))
  }
  deinit { close(fd) }
  func send(_ method: String, _ params: [String: Any]) throws -> Int {
    sequence += 1
    let frame = try Frame.encode(JSONSerialization.data(withJSONObject: [
      "id": sequence, "method": method, "params": params, "timeoutMs": 120_000,
    ]))
    let written = frame.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
    try require(written == frame.count, "write to the helper")
    return sequence
  }
  /// Nil until the reply arrives; reads what is there within `ms`.
  func poll(_ id: Int, ms: Int32 = 100) throws -> [String: Any]? {
    if let reply = replies.removeValue(forKey: id) { return reply }
    var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if Darwin.poll(&ready, 1, ms) > 0 {
      var bytes = [UInt8](repeating: 0, count: 65_536)
      let count = Darwin.read(fd, &bytes, bytes.count)
      try require(count > 0, "the helper's socket closed")
      decoder.append(Data(bytes.prefix(count)))
    }
    while let frame = try decoder.next() {
      if let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
        let number = (object["id"] as? NSNumber)?.intValue { replies[number] = object }
    }
    return replies.removeValue(forKey: id)
  }
  func request(_ method: String, _ params: [String: Any], seconds: Double = 60) async throws -> [String: Any] {
    let id = try send(method, params)
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if let reply = try poll(id) { return reply }
      await sleepSeconds(0.02)
    }
    throw JourneyFailure.failed("No reply to \(method)")
  }
}

@MainActor enum RemindersProof {
  static func run(out: URL, helperApp: URL) async -> [String: Any] {
    var report: [String: Any] = ["helperApp": helperApp.path]
    var notes: [String] = []
    var helper: NSRunningApplication?
    do {
      report["helperVersion"] = Bundle(url: helperApp)?.infoDictionary?["CFBundleShortVersionString"] ?? NSNull()
      report["helperInfoPlistUsage"] = [
        "calendars": Bundle(url: helperApp)?.infoDictionary?["NSCalendarsFullAccessUsageDescription"] ?? NSNull(),
        "reminders": Bundle(url: helperApp)?.infoDictionary?["NSRemindersFullAccessUsageDescription"] ?? NSNull(),
      ]
      report["tccBefore"] = tcc()
      helper = try await launch(helperApp)
      report["helperPID"] = Int(helper!.processIdentifier)
      var socket = try await connect()
      _ = try await socket.request("hello", ["protocolVersion": 11, "ownerViewVersion": 3])
      report["statusBefore"] = try await socket.request("data.status", [:])["result"] ?? NSNull()
      var prompts: [[String: Any]] = []
      for grant in ["calendars", "reminders"] {
        let id = try socket.send("data.request", ["grant": grant])
        var reply: [String: Any]?
        var prompt: [String: Any] = ["grant": grant]
        let deadline = Date().addingTimeInterval(75)
        var answered = false
        var others: [[String: Any]] = []
        while reply == nil, Date() < deadline {
          reply = try socket.poll(id, ms: 50)
          // Another macOS question first (a helper identity new to this Mac is asked about
          // Accessibility): its words are kept and it is declined, as a person here would.
          if reply == nil, let other = otherPrompt(), others.count < 4 {
            await shot(out, "other-prompt-\(grant)-\(others.count)")
            var facts = other.facts
            facts["press"] = AXUIElementPerformAction(other.decline, kAXPressAction as CFString).rawValue
            others.append(facts)
            await sleepSeconds(1)
          }
          if reply == nil, !answered, let found = findPrompt() {
            prompt.merge(found.facts) { $1 }
            await shot(out, "prompt-\(grant)")
            prompt["press"] = AXUIElementPerformAction(found.allow, kAXPressAction as CFString).rawValue
            await sleepSeconds(1.5)
            if findPrompt() != nil, let point = center(found.allow) {
              prompt["pressLeftPromptUp"] = true
              prompt["hidClick"] = ["x": point.x, "y": point.y]
              let process = Process()
              process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
              process.arguments = ["--person-click", String(Double(point.x)), String(Double(point.y))]
              try process.run()
              process.waitUntilExit()
              await sleepSeconds(1.5)
            }
            prompt["promptGoneAfterAnswer"] = findPrompt() == nil
            answered = true
          }
        }
        prompt["answered"] = answered
        prompt["otherPrompts"] = others
        prompt["reply"] = reply?["result"] ?? reply?["error"] ?? "no reply in 75 s"
        prompts.append(prompt)
      }
      report["prompts"] = prompts
      report["statusAfter"] = try await socket.request("data.status", [:])["result"] ?? NSNull()
      report["tccAfter"] = tcc()
      report["agentBeforeRestart"] = try await agent(socket)
      // The helper stopped by its PID; started again the way the product starts it.
      let pid = helper!.processIdentifier
      kill(pid, SIGTERM)
      for _ in 0..<100 where !helper!.isTerminated { await sleepSeconds(0.05) }
      report["stoppedPID"] = Int(pid)
      report["stoppedCleanly"] = helper!.isTerminated
      helper = try await launch(helperApp)
      report["restartedPID"] = Int(helper!.processIdentifier)
      socket = try await connect()
      _ = try await socket.request("hello", ["protocolVersion": 11, "ownerViewVersion": 3])
      report["statusAfterRestart"] = try await socket.request("data.status", [:])["result"] ?? NSNull()
      report["agentAfterRestart"] = try await agent(socket)
      report["tccAfterRestart"] = tcc()
      // System Settings, Privacy & Security, each list.
      for pane in ["Privacy_Reminders", "Privacy_Calendars"] {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
          NSWorkspace.shared.open(url)
          await sleepSeconds(4)
          await shot(out, "settings-\(pane)")
        }
      }
      if let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first {
        notes.append("System Settings \(settings.processIdentifier) quit")
        settings.terminate()
      }
    } catch {
      report["error"] = String(describing: error)
    }
    if let helper, !helper.isTerminated {
      kill(helper.processIdentifier, SIGTERM)
      for _ in 0..<100 where !helper.isTerminated { await sleepSeconds(0.05) }
      notes.append("helper \(helper.processIdentifier) stopped: \(helper.isTerminated)")
    }
    report["notes"] = notes
    try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      .write(to: out.appendingPathComponent("reminders.json"))
    return report
  }

  static func launch(_ app: URL) async throws -> NSRunningApplication {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    let running = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
    for _ in 0..<200 where !FileManager.default.fileExists(atPath: HelperPaths.socket.path) { await sleepSeconds(0.05) }
    await sleepSeconds(0.5)
    return running
  }
  static func connect() async throws -> HelperSocket {
    var last: Error?
    for _ in 0..<40 {
      do { return try HelperSocket(path: HelperPaths.socket.path) } catch { last = error; await sleepSeconds(0.25) }
    }
    throw last ?? JourneyFailure.failed("no helper socket")
  }

  /// An agent's read of reminder lists, and a reminder created and deleted.
  static func agent(_ socket: HelperSocket) async throws -> [String: Any] {
    let operations = DataContracts.operations["apple-reminders"] ?? [:]
    func invoke(_ operation: String, _ arguments: [String: Any]) async throws -> Any {
      let contract = try operations[operation].unwrap(operation)
      let reply = try await socket.request("data.invoke", [
        "definitionId": "apple-reminders", "operation": operation, "access": "read-write",
        "contract": contract.contract, "effect": contract.effect.rawValue, "arguments": arguments,
      ])
      return reply["result"] ?? reply["error"] ?? NSNull()
    }
    var row: [String: Any] = ["operations": operations.keys.sorted()]
    row["listReminderLists"] = try await invoke("list_reminder_lists", [:])
    let created = try await invoke("create_reminder", ["title": "Opensteer proof \(wallMs())"])
    row["createReminder"] = created
    if let value = (created as? [String: Any])?["value"] as? [String: Any], let id = value["id"] as? String {
      row["deleteReminder"] = try await invoke("delete_reminder", ["id": id])
    }
    return row
  }

  /// The macOS question on screen: its process, its words and its allowing button.
  static func findPrompt() -> (allow: AXUIElement, facts: [String: Any])? {
    for app in NSWorkspace.shared.runningApplications {
      let element = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetMessagingTimeout(element, 0.3)
      for window in AXValueReader.copyElements(element, kAXWindowsAttribute) {
        var texts: [String] = []
        var buttons: [(String, AXUIElement)] = []
        collect(window, depth: 0, texts: &texts, buttons: &buttons)
        let words = texts.joined(separator: " ")
        guard words.contains("Calendar") || words.contains("Reminders") else { continue }
        guard let allow = buttons.first(where: { ["Allow Full Access", "Allow", "OK"].contains($0.0) }) else { continue }
        return (allow.1, ["process": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "",
          "pid": Int(app.processIdentifier), "texts": texts, "buttons": buttons.map(\.0)])
      }
    }
    return nil
  }
  /// A macOS question about anything but Calendar or Reminders, with its declining button.
  static func otherPrompt() -> (decline: AXUIElement, facts: [String: Any])? {
    let hosts = ["com.apple.accessibility.universalAccessAuthWarn", "com.apple.UserNotificationCenter"]
    for app in NSWorkspace.shared.runningApplications where hosts.contains(app.bundleIdentifier ?? "") {
      let element = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetMessagingTimeout(element, 0.3)
      for window in AXValueReader.copyElements(element, kAXWindowsAttribute) {
        var texts: [String] = []
        var buttons: [(String, AXUIElement)] = []
        collect(window, depth: 0, texts: &texts, buttons: &buttons)
        let words = texts.joined(separator: " ")
        guard !words.contains("Calendar"), !words.contains("Reminders"),
          let decline = buttons.first(where: { ["Deny", "Don’t Allow", "Don't Allow", "Cancel"].contains($0.0) })
        else { continue }
        return (decline.1, ["process": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "",
          "texts": texts, "buttons": buttons.map(\.0)])
      }
    }
    return nil
  }
  static func collect(_ element: AXUIElement, depth: Int, texts: inout [String], buttons: inout [(String, AXUIElement)]) {
    guard depth < 12 else { return }
    let role = AXValueReader.copyString(element, kAXRoleAttribute) ?? ""
    if role == kAXStaticTextRole as String, let value = AXValueReader.copyString(element, kAXValueAttribute), !value.isEmpty { texts.append(value) }
    if role == kAXButtonRole as String, let title = AXValueReader.copyString(element, kAXTitleAttribute), !title.isEmpty { buttons.append((title, element)) }
    for child in AXValueReader.copyElements(element, kAXChildrenAttribute) { collect(child, depth: depth + 1, texts: &texts, buttons: &buttons) }
  }
  static func center(_ element: AXUIElement) -> CGPoint? {
    var position = CGPoint.zero, size = CGSize.zero
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &value) == .success,
      let p = value, AXValueGetValue(p as! AXValue, .cgPoint, &position),
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &value) == .success,
      let s = value, AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
  }
  static func tcc() -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
    process.arguments = [NSHomeDirectory() + "/Library/Application Support/com.apple.TCC/TCC.db",
      "select service, client, client_type, auth_value, auth_reason, last_modified from access where service in ('kTCCServiceCalendar','kTCCServiceReminders');"]
    process.standardOutput = pipe
    process.standardError = pipe
    do { try process.run() } catch { return "sqlite3 failed: \(error)" }
    process.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  }
  static func shot(_ out: URL, _ name: String) async {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "jpg", out.appendingPathComponent(name + ".jpg").path]
    if (try? process.run()) != nil { while process.isRunning { await sleepSeconds(0.02) } }
  }
}
