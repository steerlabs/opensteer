import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import CryptoKit
import ScreenCaptureKit

// Compiled alongside the unchanged shipping ComputerUseCore sources by run-vm.sh.
// This executes the shipping sources directly, without an XCTest runner process.
enum JourneyFailure: Error { case invalid(String) }
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw JourneyFailure.invalid(message) }
}
func json(_ object: Any, _ url: URL) throws {
  try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    .write(to: url, options: .atomic)
}
private func png(_ image: CGImage, _ url: URL) throws {
  guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
  else { throw JourneyFailure.invalid("PNG encoding failed") }
  try data.write(to: url)
}
private func pixels(_ image: CGImage) throws -> Data {
  var data = Data(count: image.width * image.height * 4)
  let ok = data.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
      bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return true
  }
  try require(ok, "RGBA conversion failed")
  return data
}
private func diff(_ a: CGImage, _ b: CGImage) throws -> [String: Any] {
  try require(a.width == b.width && a.height == b.height, "Capture geometry changed")
  let left = try pixels(a), right = try pixels(b)
  var changed = 0
  for index in stride(from: 0, to: left.count, by: 4) {
    if (0..<3).contains(where: { abs(Int(left[index + $0]) - Int(right[index + $0])) > 12 }) {
      changed += 1
    }
  }
  return ["beforeSHA256": SHA256.hash(data: left).map { String(format: "%02x", $0) }.joined(),
    "afterSHA256": SHA256.hash(data: right).map { String(format: "%02x", $0) }.joined(),
    "changedPixels": changed, "changedFraction": Double(changed) / Double(a.width * a.height)]
}
private final class Frames: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var image: CGImage?
  private var count = 0
  private var failure: String?
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    lock.lock(); defer { lock.unlock() }; failure = String(describing: error)
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int,
      status == SCFrameStatus.complete.rawValue,
      let buffer = sample.imageBuffer,
      let next = CIContext().createCGImage(CIImage(cvPixelBuffer: buffer),
        from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)))
    else { return }
    lock.lock(); defer { lock.unlock() }; image = next; count += 1
  }
  func latest() throws -> (CGImage, Int) {
    lock.lock(); defer { lock.unlock() }
    if let failure { throw JourneyFailure.invalid("SCStream stopped: \(failure)") }
    guard let image else { throw JourneyFailure.invalid("No complete SCStream frame") }
    return (image, count)
  }
}

final class Activations: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [[String: Any]] = []
  private var token: NSObjectProtocol?
  init() {
    token = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      self.values.append(["pid": app.processIdentifier, "bundle": app.bundleIdentifier ?? "", "at": Date().timeIntervalSince1970])
    }
  }
  func events() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return values }
  deinit { if let token { NSWorkspace.shared.notificationCenter.removeObserver(token) } }
}

@MainActor private final class CoverInputView: NSView {
  var text = ""
  var events: [[String: Any]] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) {
    let characters = event.characters ?? ""
    text += characters
    events.append(["characters": characters, "keyCode": event.keyCode,
      "at": Date().timeIntervalSince1970, "mono": ProcessInfo.processInfo.systemUptime, "recipientPID": getpid(),
      "keyWindowID": window?.windowNumber ?? 0, "key": window?.isKeyWindow ?? false,
      "active": NSApp.isActive])
  }
}

/// The person's keystrokes, posted where a keyboard's are by a process of
/// their own. The helper tells the events it posts by their process and never
/// redirects them, so a stream posted from the helper's process would not be
/// the person's at all.
final class PersonStream: @unchecked Sendable {
  private let process = Process()
  private let log: URL

  /// At least `minimum` tokens go out, each key stamped with `stamp` plus its
  /// token's index when one is given.
  init(_ work: URL, stamp: Int64?, minimum: Int) throws {
    log = work.appendingPathComponent("person-stream-\(UUID().uuidString).jsonl")
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["--person-stream", log.path, String(stamp ?? -1), String(minimum)]
    try process.run()
  }

  /// Stops after the token under way; each token sent, in order, with when.
  func stop() async throws -> [[String: Any]] {
    FileManager.default.createFile(atPath: log.path + ".stop", contents: nil)
    while process.isRunning { try await Task.sleep(nanoseconds: 10_000_000) }
    guard process.terminationStatus == 0 else {
      throw JourneyFailure.invalid("Person stream exited \(process.terminationStatus)")
    }
    return try String(contentsOf: log, encoding: .utf8).split(separator: "\n").compactMap {
      try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
    }
  }

  deinit { if process.isRunning { process.terminate() } }

  /// `--person-stream`: numbered tokens every 40 ms until the stop file appears.
  static func run(log: URL, stamp: Int64, minimum: Int) -> Never {
    guard CGPreflightPostEventAccess(), FileManager.default.createFile(atPath: log.path, contents: nil),
      let file = try? FileHandle(forWritingTo: log) else { exit(3) }
    var number = 0
    while number < minimum || !FileManager.default.fileExists(atPath: log.path + ".stop") {
      guard number < 10_000 else { exit(4) }
      let token = String(format: "%04d|", number)
      let row: [String: Any] = ["kind": "stream-send", "index": number, "text": token,
        "mono": ProcessInfo.processInfo.systemUptime]
      guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(5) }
      file.write(data); file.write(Data([10]))
      for character in token {
        for down in [true, false] {
          guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { exit(6) }
          var units = Array(String(character).utf16)
          event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
          if stamp >= 0 { event.setIntegerValueField(.eventSourceUserData, value: stamp + Int64(number)) }
          event.flags = []; event.post(tap: .cghidEventTap)
        }
      }
      number += 1
      usleep(40_000)
    }
    try? file.close()
    exit(0)
  }
}

@main private struct Entry {
  @MainActor static func main() {
    let arguments = CommandLine.arguments
    if arguments.count == 5, arguments[1] == "--person-stream" {
      PersonStream.run(log: URL(fileURLWithPath: arguments[2]), stamp: Int64(arguments[3]) ?? -1,
        minimum: Int(arguments[4]) ?? 0)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if CommandLine.arguments.dropFirst().first == "--cover" {
      cover(URL(fileURLWithPath: CommandLine.arguments[2])); app.run(); return
    }
    Task { @WorkActor in
      var status: Int32 = 2
      do { status = try await Journey(arguments: Array(CommandLine.arguments.dropFirst())).run() }
      catch { fputs("Journey setup failed: \(error)\n", stderr) }
      exit(status)
    }
    app.run()
  }
  @MainActor private static func cover(_ directory: URL) {
    NSApp.setActivationPolicy(.regular)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "Opensteer opaque occlusion control"
    window.collectionBehavior = [.fullScreenPrimary]
    var r4 = false
    let coverTrace: R4Trace? = R4Trace(directory.appendingPathComponent("cover-timeline.jsonl"))
    let keyTokens = [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { _ in
        coverTrace?.add("cover-key", ["key": window.isKeyWindow])
      }
    }
    window.isOpaque = true; window.alphaValue = 1; window.backgroundColor = .darkGray
    let text = NSTextField(labelWithString: "Cover app — Chrome must stay behind this window")
    text.frame = NSRect(x: 20, y: 100, width: 800, height: 40)
    let input = CoverInputView(frame: window.contentView!.bounds)
    window.contentView = input
    input.addSubview(text)
    window.makeFirstResponder(input)
    var history: [[String: Any]] = []
    var previousState = ""
    var last = ""
    Timer.scheduledTimer(withTimeInterval: 0.005, repeats: true) { _ in
      if let data = try? Data(contentsOf: directory.appendingPathComponent("cover-command.json")),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let token = object["token"] as? String, token != last,
        let x = object["x"] as? Double, let y = object["y"] as? Double,
        let width = object["width"] as? Double, let height = object["height"] as? Double {
        last = token
        r4 = object["r4"] as? Bool ?? false
        let fullScreen = object["fullScreen"] as? Bool ?? false
        if window.styleMask.contains(.fullScreen) != fullScreen { window.toggleFullScreen(nil) }
        let screenHeight = NSScreen.screens.first?.frame.height ?? 800
        if !fullScreen { window.setFrame(NSRect(x: x, y: screenHeight - y - height, width: width, height: height), display: true) }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
      }
      if r4 {
        _ = keyTokens
        try? json(["pid": getpid(), "windowID": window.windowNumber, "key": window.isKeyWindow,
          "active": NSApp.isActive, "fullScreen": window.styleMask.contains(.fullScreen),
          "mono": ProcessInfo.processInfo.systemUptime, "token": last, "text": input.text,
          "keyEvents": input.events], directory.appendingPathComponent("cover-state.json"))
        return
      }
      let system = AXUIElementCreateSystemWide()
      let focusedApp = AXValueReader.copyElement(system, kAXFocusedApplicationAttribute)
      var globalPID: pid_t = 0
      if let focusedApp { AXUIElementGetPid(focusedApp, &globalPID) }
      let globalWindow = focusedApp.flatMap { AXValueReader.copyElement($0, kAXFocusedWindowAttribute) }.flatMap(KeyWindow.windowID) ?? 0
      let order = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []).map {
        ["pid": $0[kCGWindowOwnerPID as String] as? Int ?? 0,
          "id": $0[kCGWindowNumber as String] as? Int ?? 0,
          "layer": $0[kCGWindowLayer as String] as? Int ?? 0]
      }
      let state: [String: Any] = ["key": window.isKeyWindow, "active": NSApp.isActive,
        "globalPID": globalPID, "globalWindowID": globalWindow, "windowOrder": order,
        "frontPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
        "pointerX": Double(CGEvent(source: nil)?.location.x ?? -1),
        "pointerY": Double(CGEvent(source: nil)?.location.y ?? -1)]
      let encoded = String(data: try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), encoding: .utf8)!
      if encoded != previousState {
        previousState = encoded
        history.append(state.merging(["at": Date().timeIntervalSince1970]) { _, new in new })
      }
      try? json(["pid": getpid(), "windowID": window.windowNumber, "key": window.isKeyWindow,
        "active": NSApp.isActive, "token": last, "text": input.text,
        "keyEvents": input.events, "transitions": history], directory.appendingPathComponent("cover-state.json"))
    }
  }
}

@WorkActor final class Journey {
  let out: URL, chrome: URL, fixture: URL, coverApp: URL, page: URL, work: URL
  var rows: [[String: Any]] = []
  var r0Iteration = 0
  let suiteStarted = ProcessInfo.processInfo.systemUptime
  var owned: [ProcessStamp] = []
  var coverPID: pid_t = 0
  let activations = Activations()
  var actionCancellation = SessionCancellation()
  func beginCase() {
    actionCancellation.cancel(.closed)
    actionCancellation = SessionCancellation()
  }
  init(arguments: [String]) throws {
    try require(arguments.count == 6, "Expected out, Chrome, fixture, cover, page, work")
    let urls = arguments.map { URL(fileURLWithPath: $0) }
    out = urls[0]; chrome = urls[1]; fixture = urls[2]; coverApp = urls[3]; page = urls[4]; work = urls[5]
  }
  func save() throws {
    if let row = rows.last {
      fputs("Journey \(row["journey"] ?? "") \(row["app"] ?? "") \(row["control"] ?? "") \(row["step"] ?? row["route"] ?? "") \(row["status"] ?? "")\n", stderr)
    }
    try json(["schema": 1, "rows": rows, "suiteSeconds": ProcessInfo.processInfo.systemUptime - suiteStarted, "forceRendererAccessibility": ProcessInfo.processInfo.environment["OPENSTEER_CHROME_FORCE_AX"] == "1", "permissions": ["accessibility": AXIsProcessTrusted(),
      "screenCapture": CGPreflightScreenCaptureAccess(), "postEvent": CGPreflightPostEventAccess()],
      "AXManualAccessibility": "set by production AppObserver for Chromium",
      "AXEnhancedUserInterface": "set independently by production AppObserver for Chromium",
      "capture": "WindowCapture.plan + SCStream; MacWindowVideoProducer identical filter/config, no encoder"],
      out.appendingPathComponent("results.json"))
  }
  func sleep(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
  func open(_ url: URL, args: [String] = [], active: Bool = false) async throws -> NSRunningApplication {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = active; configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = args
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    if let stamp = ProcessStamp.of(app.processIdentifier) { owned.append(stamp) }
    return app
  }
  func signalOwned(_ pid: pid_t) {
    if let stamp = owned.first(where: { $0.processIdentifier == pid }), stamp.isCurrent { kill(pid, SIGTERM) }
  }
  func stop(_ pid: pid_t) async {
    guard let stamp = owned.first(where: { $0.processIdentifier == pid }), stamp.isCurrent else { return }
    kill(pid, SIGTERM)
    for _ in 0..<30 {
      if !stamp.isCurrent { return }; try? await sleep(0.1)
    }
    if stamp.isCurrent { kill(pid, SIGKILL) }
  }
  func run() async throws -> Int32 {
    defer {
      for stamp in owned where stamp.isCurrent { kill(stamp.processIdentifier, SIGKILL) }
      try? json(["ownedPIDs": owned.map(\.processIdentifier), "remainingPIDs": owned.filter(\.isCurrent).map(\.processIdentifier)], out.appendingPathComponent("cleanup.json"))
    }
    try save()
    try require(AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() && CGPreflightPostEventAccess(), "Missing TCC grants")
    coverPID = try await open(coverApp, args: ["--cover", work.path], active: true).processIdentifier
    // Prove shared foreground setup before the samples.
    try await cover(CGRect(x: 50, y: 50, width: 1100, height: 650))
    try desktop("setup-cover")
    let selected = ProcessInfo.processInfo.environment["OPENSTEER_CHROME_JOURNEY"] ?? "all"
    try require(["R0", "R1", "R2", "R3", "R4", "sweep", "acceptance", "all"].contains(selected), "Unknown journey selection")
    if selected == "R4" { return try await incidentJourney() }
    if selected != "R1" {
      // Repeats confirm macOS delivery when typing paths change; PersonKeyOrderTests is the deterministic guard.
      let repeats = max(1, Int(ProcessInfo.processInfo.environment["OPENSTEER_CHROME_R0_REPEAT"] ?? "") ?? 1)
      for iteration in 1...repeats {
        r0Iteration = iteration
        for (name, context) in [("appkit", false), ("chrome", false), ("chrome", true)] {
          do { try await popupSafety(name, context: context) }
          catch {
            rows.append(["journey": "R0", "iteration": iteration, "app": name, "contextMenu": context, "status": "invalid", "error": String(describing: error)])
            try save(); return 1
          }
          if !["pass", "accepted-limitation"].contains(rows.last?["status"] as? String ?? "") { return 1 }
        }
      }
    }
    if selected == "R0" { for stamp in owned { await stop(stamp.processIdentifier) }; return 0 }
    for variant in ["R2", "R3", "acceptance"].contains(selected) ? [] : ["chrome-covered"] {
      do { try await freeze(variant) }
      catch { rows.append(["journey": "R1", "variant": variant, "status": "invalid", "error": String(describing: error)]); try save() }
      for appURL in [chrome, fixture] {
        for app in NSWorkspace.shared.runningApplications where app.bundleURL?.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath() {
          if let stamp = ProcessStamp.of(app.processIdentifier), !owned.contains(stamp) { owned.append(stamp) }
        }
      }
      for stamp in owned where stamp.processIdentifier != coverPID { await stop(stamp.processIdentifier) }
    }
    for app in ["R1", "R3"].contains(selected) ? [] : ["chrome"] {
      for route in ["point-click", "targeted-type", "untargeted-type", "shortcut", "scroll", "batch"] {
        do { try await focus(app, route) }
        catch { rows.append(["journey": "R2", "app": app, "route": route, "status": "invalid", "error": String(describing: error)]); try save() }
        for appURL in [chrome, fixture] {
        for app in NSWorkspace.shared.runningApplications where app.bundleURL?.resolvingSymlinksInPath() == appURL.resolvingSymlinksInPath() {
          if let stamp = ProcessStamp.of(app.processIdentifier), !owned.contains(stamp) { owned.append(stamp) }
        }
      }
      for stamp in owned where stamp.processIdentifier != coverPID { await stop(stamp.processIdentifier) }
      }
    }
    if ["R3", "acceptance", "all", "sweep"].contains(selected) {
      for route in ["siblings"] {
        do { try await chromiumSpecial(route) }
        catch { rows.append(["journey": "R3", "route": route, "status": "invalid", "error": String(describing: error)]); try save() }
        for stamp in owned where stamp.processIdentifier != coverPID { await stop(stamp.processIdentifier) }
      }
    }
    if ["sweep", "all"].contains(selected) { _ = try await incidentJourney() }
    for stamp in owned { await stop(stamp.processIdentifier) }
    try save()
    return rows.contains { !["pass", "accepted-limitation"].contains($0["status"] as? String ?? "") } ? 1 : 0
  }
  func state(_ app: URL) throws -> AppSessionState {
    guard let record = AppResolver.record(forBundleAtPath: app.path) else { throw JourneyFailure.invalid("Unresolvable app \(app.path)") }
    return AppSessionState(identity: record.identity, path: record.path)
  }
  func launch(_ name: String) async throws -> NSRunningApplication {
    if name == "appkit" { return try await open(fixture) }
    let profile = work.appendingPathComponent("profile-" + UUID().uuidString)
    var args = ["--user-data-dir=\(profile.path)", "--no-first-run", "--no-default-browser-check",
      "--window-position=100,100", "--window-size=850,600", page.absoluteString]
    if ProcessInfo.processInfo.environment["OPENSTEER_CHROME_FORCE_AX"] == "1" { args.append("--force-renderer-accessibility") }
    let app = try await open(chrome, args: args)
    try await sleep(2)
    return app
  }
  func observe(_ state: AppSessionState, _ monitor: WindowMonitor) async throws -> Observation {
    // Observation can be invalidated during launch, but actions are never retried.
    for attempt in 0..<3 {
      do {
        _ = try await SessionWindows.windows(app: state, monitor: monitor)
        if state.currentWindow == nil { _ = try SessionWindows.bind(app: state, window: nil, monitor: monitor) }
        guard let bound = state.currentWindow else { throw JourneyFailure.invalid("No explicit window") }
        return try await AppObserver.observe(app: state, window: bound.ref, monitor: monitor, includeScreenshot: true)
      }
      catch let error as HelperError where error.code == .staleObservation && attempt < 2 { try await sleep(0.2) }
    }
    throw JourneyFailure.invalid("Observation remained stale")
  }
  func observationEvidence(_ observation: Observation, _ prefix: String) throws {
    try JSONCoding.encoder.encode(observation).write(to: out.appendingPathComponent(prefix + "-observation.json"))
    try observation.tree.write(to: out.appendingPathComponent(prefix + "-ax.txt"), atomically: true, encoding: .utf8)
    guard let screenshot = observation.screenshot, let data = Data(base64Encoded: screenshot.base64),
      let image = NSImage(data: data)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { throw JourneyFailure.invalid("Agent observation screenshot absent") }
    try png(image, out.appendingPathComponent(prefix + "-agent.png"))
  }
  func cover(_ frame: CGRect, partial: Bool = false) async throws {
    // Frame extends beyond all target edges; partial case deliberately reveals 80 points.
    let rect = CGRect(x: frame.minX - 10, y: frame.minY - 10,
      width: frame.width + 20 - (partial ? 80 : 0), height: frame.height + 20)
    let token = UUID().uuidString
    try json(["token": token, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
      work.appendingPathComponent("cover-command.json"))
    for _ in 0..<50 {
      if let data = try? Data(contentsOf: work.appendingPathComponent("cover-state.json")),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        object["token"] as? String == token, object["key"] as? Bool == true { break }
      try await sleep(0.1)
    }
    let data = try Data(contentsOf: work.appendingPathComponent("cover-state.json"))
    let ready = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    try require(ready?["token"] as? String == token && ready?["key"] as? Bool == true, "Cover did not become key")
    try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == coverPID, "Cover not frontmost")
    try await sleep(1.5)
  }
  func snapshot(_ pid: pid_t) -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    let app = AXUIElementCreateApplication(pid)
    var result: [String: Any] = ["at": Date().timeIntervalSince1970, "pid": pid, "frontPID": front?.processIdentifier ?? 0,
      "frontBundle": front?.bundleIdentifier ?? "", "pointerX": Double(CGEvent(source: nil)?.location.x ?? -1),
      "pointerY": Double(CGEvent(source: nil)?.location.y ?? -1),
      "helperFocusChanged": false]
    for flag in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
      var raw: CFTypeRef?
      let status = AXUIElementCopyAttributeValue(app, flag as CFString, &raw)
      result[flag] = ["status": status.rawValue, "value": raw as? Bool ?? false]
    }
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      var value: CFTypeRef?
      let status = AXUIElementCopyAttributeValue(app, attr as CFString, &value)
      var detail: [String: Any] = ["status": status.rawValue]
      if let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
        let window = unsafeBitCast(value, to: AXUIElement.self)
        detail["windowID"] = KeyWindow.windowID(of: window) ?? 0
        for flag in [kAXMainAttribute, kAXFocusedAttribute] {
          var raw: CFTypeRef?
          let status = AXUIElementCopyAttributeValue(window, flag as CFString, &raw)
          detail[flag] = ["status": status.rawValue, "value": raw as? Bool ?? false]
        }
      }
      result[attr] = detail
    }
    let system = AXUIElementCreateSystemWide()
    if let focusedApp = AXValueReader.copyElement(system, kAXFocusedApplicationAttribute) {
      var focusedPID: pid_t = 0
      AXUIElementGetPid(focusedApp, &focusedPID)
      result["globalKeyPID"] = focusedPID
      if let window = AXValueReader.copyElement(focusedApp, kAXFocusedWindowAttribute) {
        result["globalKeyWindowID"] = KeyWindow.windowID(of: window) ?? 0
      }
    }
    result["activationHistory"] = activations.events()
    result["windowServer"] = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    if let data = try? Data(contentsOf: work.appendingPathComponent("cover-state.json")),
      let object = try? JSONSerialization.jsonObject(with: data) { result["cover"] = object }
    return result
  }
  func coverage(_ pid: pid_t, windowID: CGWindowID, frame: CGRect, partial: Bool) throws -> [String: Any] {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let targetIndex = windows.firstIndex(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }),
      let coverIndex = windows.firstIndex(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == coverPID && ($0[kCGWindowLayer as String] as? Int) == 0 }),
      let bounds = windows[coverIndex][kCGWindowBounds as String] as? [String: Any],
      let coverFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { throw JourneyFailure.invalid("Target/cover not present in WindowServer order") }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == coverPID
    let geometry = partial ? coverFrame.intersects(frame) && !coverFrame.contains(frame) && frame.maxX - coverFrame.maxX >= 50 : coverFrame.contains(frame)
    let data = try Data(contentsOf: work.appendingPathComponent("cover-state.json"))
    let coverState = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let valid = front && coverIndex < targetIndex && geometry && coverState?["key"] as? Bool == true
    return ["valid": valid, "frontmostCover": front, "coverIndex": coverIndex, "targetIndex": targetIndex,
      "coverBounds": [coverFrame.minX, coverFrame.minY, coverFrame.width, coverFrame.height], "geometryValid": geometry,
      "targetPID": pid, "windowID": windowID]
  }
  func desktop(_ prefix: String) throws {
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", out.appendingPathComponent(prefix + "-desktop.png").path]
    try process.run(); process.waitUntilExit()
    try require(process.terminationStatus == 0, "Desktop evidence capture failed")
  }
  func elements(_ state: AppSessionState) throws -> (Int, Int) {
    guard let latest = state.latest else { throw JourneyFailure.invalid("No observation binding") }
    guard let button = latest.elements.firstIndex(where: {
      $0.attributes.role == "AXButton" && ($0.attributes.title ?? "").hasPrefix("Counter ")
    }) else { throw JourneyFailure.invalid("Web/AppKit AX counter button absent") }
    guard let field = latest.elements.firstIndex(where: { $0.attributes.role == "AXTextField" &&
      (($0.attributes.title ?? "").contains("Journey") || ($0.attributes.title ?? "").contains("Field A")) })
      ?? latest.elements.firstIndex(where: { $0.attributes.role == "AXTextField" && $0.frame.minY > latest.elements[button].frame.minY })
    else { throw JourneyFailure.invalid("AX input field absent") }
    return (button, field)
  }
  func counter(_ observation: Observation) -> Int? {
    guard let range = observation.tree.range(of: #"Counter [0-9]+"#, options: .regularExpression) else { return nil }
    return Int(observation.tree[range].dropFirst(8))
  }
  func action(_ route: String, state: AppSessionState) throws -> ActionRequest {
    guard let latest = state.latest else { throw JourneyFailure.invalid("No observed geometry") }
    let indexed = try? elements(state)
    let frame = indexed.map { latest.elements[$0.0].frame }
    // These screenshot points name this fixed local page in Chrome's 850x600 window.
    // They let synthetic routes run even when Chrome exposes only browser AX controls.
    let center = frame.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: 324, y: 270)
    let point = latest.coordinates.pixelPoint(from: center)
    switch route {
    case "ax-press":
      guard let (button, _) = indexed else { throw JourneyFailure.invalid("Web AX button absent; no AXPress route available") }
      let node = latest.elements[button].node as? AXElementNode
      try require(node.map { ActionRunner.supportsPress($0.element) } ?? false, "Counter does not offer AXPress")
      return .click(target: .index(button), button: .left, count: 1)
    case "point-click":
      guard let frame else { throw JourneyFailure.invalid("Web AX counter missing for canvas geometry") }
      // The canvas has no AXPress route, so this sample must post a left click.
      let canvas = CGPoint(x: frame.minX + 686, y: frame.minY + 40)
      return .click(target: .point(latest.coordinates.pixelPoint(from: canvas)), button: .left, count: 1)
    case "targeted-type":
      guard let (_, field) = indexed else { throw JourneyFailure.invalid("AX field absent for index-targeted typing") }
      return .type(text: "Journey", target: .index(field))
    case "point-targeted-type":
      guard let (_, field) = indexed else { throw JourneyFailure.invalid("AX field absent") }
      let frame = latest.elements[field].frame
      return .type(text: "Journey", target: .point(latest.coordinates.pixelPoint(from: CGPoint(x: frame.midX, y: frame.midY))))
    case "untargeted-type": return .type(text: "Untargeted")
    case "shortcut": return .key(keys: "Control+Alt+j")
    case "scroll": return .scroll(target: .point(point), direction: .down, amount: 3)
    default: throw JourneyFailure.invalid("Unknown route")
    }
  }
  func act(_ action: ActionRequest, _ state: AppSessionState, _ monitor: WindowMonitor, _ observation: Observation) async throws -> [String: Any] {
    try await runActions([action], state, monitor, observation)
  }
  func runActions(_ actions: [ActionRequest], _ state: AppSessionState, _ monitor: WindowMonitor, _ observation: Observation) async throws -> [String: Any] {
    let live = AccessibilityCalls.live
    var calls = live, writes: [[String: Any]] = []
    calls.press = { element in
      let status = live.press(element)
      writes.append(["action": "AXPress", "role": AXValueReader.copyString(element, kAXRoleAttribute) ?? "", "status": status.rawValue])
      return status
    }
    calls.setAttribute = { element, attribute, value in
      let status = live.setAttribute(element, attribute, value)
      writes.append(["attribute": attribute, "role": AXValueReader.copyString(element, kAXRoleAttribute) ?? "", "status": status.rawValue])
      return status
    }
    let result = try await ActionRunner.run(actions: actions, app: state, window: observation.window.ref, snapshot: observation.snapshot,
      cancellation: actionCancellation, monitor: monitor, overlay: nil, budget: .unlimited, accessibility: calls)
    return ["performed": result.performed, "error": result.error.map { String(describing: $0) } ?? "", "AXWrites": writes]
  }
  func focus(_ name: String, _ route: String) async throws {
    beginCase()
    defer { actionCancellation.cancel(.closed) }
    let url = name == "chrome" ? chrome : fixture
    let target = try state(url), monitor = WindowMonitor()
    defer { monitor.stop() }
    var pid: pid_t = 0
    defer { signalOwned(pid) }
    let prefix = "R2-\(name)-\(route)"
    var observed: Observation?
    if route != "cold-observe" {
      pid = try await launch(name).processIdentifier
      observed = try await observe(target, monitor)
      try observationEvidence(observed!, prefix + "-setup")
      try await cover(target.latest!.windowFrame)
    } else {
      // Production launch has no argv hook: fresh disposable guest default Chrome profile.
      try await cover(CGRect(x: 50, y: 50, width: 1100, height: 650))
    }
    try desktop(prefix + "-before")
    var before = snapshot(pid)
    before["helperFocusChanged"] = pid == 0 ? false : monitor.state(of: pid).focusChangedByHelper
    let treeBefore = observed?.tree ?? ""
    let fieldNode: AXElementNode? = (try? elements(target)).flatMap { indices in
      target.latest?.elements[indices.1].node as? AXElementNode
    }
    let counterNode = target.latest?.elements.first(where: {
      $0.attributes.role == "AXButton" && ($0.attributes.title ?? "").hasPrefix("Counter ")
    })?.node as? AXElementNode
    var receipt: [String: Any] = [:]
    if route == "cold-observe" || route == "observe" {
      observed = try await observe(target, monitor)
      pid = target.processIdentifier ?? 0
      if !owned.contains(where: { $0.processIdentifier == pid }), let stamp = ProcessStamp.of(pid) { owned.append(stamp) }
    } else {
      let actions: [ActionRequest]
      if route == "batch" {
        actions = [try action("ax-press", state: target), .type(text: "Batch"), .key(keys: "Control+Alt+j"), .key(keys: "Tab")]
      } else {
        let primary = try action(route, state: target)
        actions = ["targeted-type", "point-targeted-type", "untargeted-type"].contains(route) ? [primary, .key(keys: "Tab")] : [primary]
      }
      receipt = try await runActions(actions, target, monitor, observed!)
    }
    try await sleep(0.7)
    var after = snapshot(pid)
    let helperFocus = monitor.state(of: pid).focusChangedByHelper || (observed?.focusChanged ?? false)
    after["helperFocusChanged"] = helperFocus
    let following = try await observe(target, monitor)
    try observationEvidence(following, prefix + "-after")
    after["observationFocusChanged"] = following.focusChanged
    try desktop(prefix + "-after")
    let baselineActivations = (before["activationHistory"] as? [[String: Any]])?.count ?? 0
    let activated = activations.events().dropFirst(baselineActivations).contains { $0["pid"] as? Int32 == pid }
    let frontChanged = before["frontPID"] as? Int32 != after["frontPID"] as? Int32
    let pointerMoved = before["pointerX"] as? Double != after["pointerX"] as? Double || before["pointerY"] as? Double != after["pointerY"] as? Double
    let keyChanged = before["globalKeyWindowID"] as? UInt32 != after["globalKeyWindowID"] as? UInt32 || ((before["cover"] as? [String: Any])?["key"] as? Bool) != ((after["cover"] as? [String: Any])?["key"] as? Bool)
    let expectedText = route == "batch" ? "Batchj" : route == "untargeted-type" ? "Untargeted" : "Journey"
    let targetFieldValueAfter = fieldNode.flatMap { AXValueReader.copyString($0.element, kAXValueAttribute) }
    let fieldDelivered = targetFieldValueAfter == expectedText
    let rawCounterTitle = counterNode.flatMap { AXValueReader.copyString($0.element, kAXTitleAttribute) }
    let rawCounterAfter = rawCounterTitle.flatMap { $0.hasPrefix("Counter ") ? Int($0.dropFirst(8)) : nil }
    let fieldValuesAfter = target.latest?.elements.filter { $0.attributes.role == "AXTextField" }.map {
      ["title": $0.attributes.title ?? "", "value": $0.attributes.value ?? "", "focused": $0.attributes.focused] as [String: Any]
    } ?? []
    let effectText = target.latest?.elements.compactMap { $0.attributes.title ?? $0.attributes.value }.first { $0.hasPrefix("Journey events {") }
    let effects = effectText.flatMap { try? JSONSerialization.jsonObject(with: Data($0.dropFirst("Journey events ".count).utf8)) as? [String: Any] } ?? [:]
    let fixtureEffects = name == "appkit" ? (try? JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("fixture-state/state.json"))) as? [String: Any]) : nil
    let typingRoute = (receipt["AXWrites"] as? [[String: Any]] ?? []).contains { $0["attribute"] as? String == kAXSelectedTextAttribute } ? "AXSelectedText" : "keyboard (no AX text write)"
    let typeEffects = name != "chrome" || ((effects["input"] as? Int ?? 0) > 0 && (effects["change"] as? Int ?? 0) > 0 && effects["text"] as? String == expectedText)
    let delivered: Bool
    if ["targeted-type", "point-targeted-type", "untargeted-type", "batch"].contains(route) { delivered = fieldDelivered && typeEffects }
    else if route == "point-click" {
      let press = (receipt["AXWrites"] as? [[String: Any]] ?? []).contains { $0["action"] as? String == "AXPress" }
      delivered = (effects["canvas"] as? Int) == 1 && !press
    }
    else if ["ax-press", "shortcut", "scroll"].contains(route) {
      // A missing counter cannot establish delivery. Keep the raw observed AX
      // node so a successful scroll can be verified after it leaves the crop.
      if let prior = observed.flatMap(counter), let next = rawCounterAfter ?? counter(following) { delivered = next > prior }
      else { delivered = false }
    } else { delivered = true }
    let routeEffect: Bool
    let effectKey = ["ax-press": "clicks", "point-click": "canvas", "shortcut": "shortcuts", "scroll": "scroll"]
    if let key = effectKey[route] {
      routeEffect = name == "chrome" ? (effects[key] as? Int ?? 0) > 0
        : (fixtureEffects?[key == "scroll" ? "scrolls" : key] as? Int ?? 0) > 0
    } else if ["targeted-type", "point-targeted-type", "untargeted-type", "batch"].contains(route) && name == "appkit" {
      routeEffect = (fixtureEffects?["inputEvents"] as? Int ?? 0) > 0 && (fixtureEffects?["changeEvents"] as? Int ?? 0) > 0
    } else { routeEffect = true }
    let orderUnchanged: Bool
    if route == "cold-observe" {
      // No target window exists yet; qualification records launch separately.
      let existing = Set(order(before, pid: pid))
      orderUnchanged = order(after, pid: pid).filter { existing.contains($0) } == order(before, pid: pid)
    } else { orderUnchanged = order(before, pid: pid) == order(after, pid: pid) }
    let batchEffects = route != "batch" || (name == "chrome"
      ? (effects["clicks"] as? Int ?? 0) == 1 && (effects["shortcuts"] as? Int ?? 0) == 1
      : (fixtureEffects?["clicks"] as? Int ?? 0) == 1 && (fixtureEffects?["shortcuts"] as? Int ?? 0) == 1)
    let safetyEvidence = safety(before, after, pid: pid)
    let continuousSafe = ["keysStable", "frontStable", "pointerStable", "finalPersonOnTop"].allSatisfy { safetyEvidence[$0] as? Bool == true }
    // Decision (A), as in R0's reviewed contract (docs/computer-use.md, "Preparing
    // an app"): the agent's own input may move the app's focus to its target, and
    // the helper's own record of that (`helperFocus`) is reported, not failed on.
    // What the person has must hold: the front app, the key window, the pointer,
    // the window order and the 5 ms samples of all of them.
    let normalStatus = !delivered || !routeEffect || !batchEffects || !(receipt["error"] as? String ?? "").isEmpty ? "regression" : frontChanged || activated || pointerMoved || keyChanged || !orderUnchanged || !continuousSafe ? "regression" : "pass"
    // docs/computer-use.md: a ⌃ chord without ⌘ also inserts its character.
    // Assert Batch + j exactly, so fixing the limitation changes this result.
    let status = route == "batch" && normalStatus == "pass" ? "accepted-limitation" : normalStatus
    rows.append(["journey": "R2", "app": name, "route": route, "before": before, "after": after,
      "safety": safetyEvidence, "frontmostChanged": frontChanged, "targetActivated": activated, "keyWindowChanged": keyChanged, "pointerMoved": pointerMoved,
      "focusChanged": helperFocus || following.focusChanged, "windowOrderUnchanged": orderUnchanged, "receipt": receipt, "deliveryConfirmed": delivered,
      "treeBefore": treeBefore, "treeAfter": following.tree, "fieldValuesAfter": fieldValuesAfter,
      "rawCounterAfter": rawCounterAfter.map { $0 as Any } ?? NSNull(),
      "targetFieldValueAfter": targetFieldValueAfter.map { $0 as Any } ?? NSNull(),
      "limitation": route == "batch" ? "expected Batch + j per the documented ⌃-chord limitation; 'Batch' alone means the limitation was fixed — update this case" : "", "typingRoute": typingRoute, "routeEffectConfirmed": routeEffect, "batchEffectsConfirmed": batchEffects, "DOMEffects": effects, "fixtureEffects": fixtureEffects ?? [:], "status": status])
    try save(); await stop(pid)
  }
  func popupState(_ element: AXUIElement) -> [String: Any] {
    var nodes: [[String: Any]] = [], pending = [(element, 0)]
    while let (node, depth) = pending.popLast(), nodes.count < 40 {
      let role = AXValueReader.copyString(node, kAXRoleAttribute) ?? ""
      nodes.append(["role": role, "title": AXValueReader.copyString(node, kAXTitleAttribute) ?? "",
        "value": AXValueReader.copyString(node, kAXValueAttribute) ?? ""])
      if depth < 3 { pending.append(contentsOf: AXElementNode.children(of: node).map { ($0, depth + 1) }) }
    }
    let expanded = AXValueReader.copyBool(element, kAXExpandedAttribute) == true
    let menu = nodes.dropFirst().contains { $0["role"] as? String == "AXMenu" }
      || nodes.dropFirst().filter { ["AXMenuItem", "AXMenuListOption"].contains($0["role"] as? String ?? "") }.count > 1
    return ["expanded": expanded, "menuPresent": menu, "open": expanded || menu, "nodes": nodes]
  }
  func coverState() throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("cover-state.json"))) as! [String: Any]
  }
  func order(_ state: [String: Any], pid: pid_t) -> [UInt32] {
    (state["windowServer"] as? [[String: Any]] ?? []).compactMap {
      guard let owner = ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
        owner == pid || owner == coverPID, $0[kCGWindowLayer as String] as? Int == 0 else { return nil }
      return ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
  }
  func safety(_ before: [String: Any], _ after: [String: Any], pid: pid_t) -> [String: Any] {
    let initial = before["cover"] as? [String: Any] ?? [:]
    let final = after["cover"] as? [String: Any] ?? [:]
    let offset = (initial["transitions"] as? [[String: Any]] ?? []).count
    let transitions = Array((final["transitions"] as? [[String: Any]] ?? []).dropFirst(offset))
    let expectedWindow = (before["globalKeyWindowID"] as? NSNumber)?.uint32Value
    let keys = transitions.allSatisfy {
      $0["key"] as? Bool == true && $0["active"] as? Bool == true
        && ($0["globalPID"] as? NSNumber)?.int32Value == coverPID
        && ($0["globalWindowID"] as? NSNumber)?.uint32Value == expectedWindow
    } && (after["globalKeyWindowID"] as? NSNumber)?.uint32Value == expectedWindow
      && (after["globalKeyPID"] as? NSNumber)?.int32Value == coverPID
    let front = transitions.allSatisfy { ($0["frontPID"] as? NSNumber)?.int32Value == coverPID }
      && (after["frontPID"] as? NSNumber)?.int32Value == coverPID
    let pointer = transitions.allSatisfy {
      $0["pointerX"] as? Double == before["pointerX"] as? Double
        && $0["pointerY"] as? Double == before["pointerY"] as? Double
    } && after["pointerX"] as? Double == before["pointerX"] as? Double
      && after["pointerY"] as? Double == before["pointerY"] as? Double
    var intervals: [[String: Double]] = [], raisedAt: Double?
    for sample in transitions {
      let normal = (sample["windowOrder"] as? [[String: Any]] ?? []).filter {
        ($0["layer"] as? Int) == 0 && [pid, coverPID].contains(($0["pid"] as? NSNumber)?.int32Value ?? 0)
      }
      let raised = (normal.first?["pid"] as? NSNumber)?.int32Value == pid
      let at = sample["at"] as? Double ?? 0
      if raised && raisedAt == nil { raisedAt = at }
      if !raised, let start = raisedAt {
        intervals.append(["start": start, "end": at, "durationMs": (at - start) * 1000]); raisedAt = nil
      }
    }
    if let start = raisedAt {
      let end = after["at"] as? Double ?? start
      intervals.append(["start": start, "end": end, "durationMs": (end - start) * 1000])
    }
    let coverIDs = (after["windowServer"] as? [[String: Any]] ?? []).filter {
      ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == coverPID
        && ($0[kCGWindowLayer as String] as? Int) == 0
    }.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    let finalTop = order(after, pid: pid).first.map(coverIDs.contains) == true
    return ["keysStable": keys, "frontStable": front, "pointerStable": pointer,
      "finalPersonOnTop": finalTop, "transientRaises": intervals, "sampleIntervalMs": 5,
      "transitions": transitions]
  }

  /// Run before the input samples. Only the person's stream posts globally;
  /// production input continues to address the target process exclusively.
  func popupSafety(_ name: String = "chrome", context: Bool = false) async throws {
    beginCase()
    defer { actionCancellation.cancel(.closed) }
    let prefix = "R0-\(r0Iteration)-" + name + (context ? "-context" : "-select")
    let pid = try await launch(name).processIdentifier
    defer { signalOwned(pid) }
    let target = try state(name == "chrome" ? chrome : fixture), monitor = WindowMonitor()
    defer { monitor.stop() }
    var observed = try await observe(target, monitor)
    // Chrome exposes a page to Accessibility some time after the first observe
    // turns that on; under host load this can outlast the helper's 4 s wait, so
    // setup observes again, as an agent would, until the page is there. 10 s was
    // not always enough in a full post-merge job (20261028T193003Z-d5e7a0a7).
    // Chrome is not relaunched: an agent cannot, and a page that never appears
    // is a product readiness problem to see, not to retry away.
    let setupStarted = Date()
    let pageBy = setupStarted.addingTimeInterval(20)
    while (try? elements(target)) == nil, Date() < pageBy {
      try await sleep(0.5)
      observed = try await observe(target, monitor)
    }
    let pageReadySeconds = Date().timeIntervalSince(setupStarted)
    try observationEvidence(observed, prefix + "-setup")
    guard (try? elements(target)) != nil else {
      throw JourneyFailure.invalid(String(format: "Web/AppKit AX counter button absent after %.1f s of observing", pageReadySeconds))
    }
    guard let latest = target.latest,
      let popup = latest.elements.first(where: {
        if context { return $0.attributes.role == "AXButton" && ($0.attributes.title ?? "").hasPrefix("Counter ") }
        guard $0.attributes.role == "AXPopUpButton" else { return false }
        guard name == "chrome" else { return true }
        guard let node = $0.node as? AXElementNode else { return false }
        return [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].contains {
          (AXValueReader.copyString(node.element, $0) ?? "").contains("Journey popup")
        }
      })
    else { throw JourneyFailure.invalid("Real target popup/content absent") }
    try await cover(latest.windowFrame)
    let before = snapshot(pid)
    try desktop(prefix + "-before")
    let initialCover = try JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("cover-state.json"))) as! [String: Any]
    let initialText = initialCover["text"] as? String ?? ""
    let initialTransitions = (initialCover["transitions"] as? [[String: Any]])?.count ?? 0
    let baselineOrder = (before["windowServer"] as? [[String: Any]] ?? []).compactMap { item -> UInt32? in
      guard let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
        owner == pid || owner == coverPID,
        item[kCGWindowLayer as String] as? Int == 0 else { return nil }
      return (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
    guard let popupNode = popup.node as? AXElementNode else { throw JourneyFailure.invalid("Popup node absent") }
    guard let clickedWindow = target.currentWindow?.windowID, baselineOrder.contains(clickedWindow)
    else { throw JourneyFailure.invalid("Clicked window absent from the baseline order") }
    // Decision (A) is measured from the person's window on top; any other start is invalid.
    guard let personWindow = baselineOrder.first, personWindow != clickedWindow,
      (before["windowServer"] as? [[String: Any]] ?? []).contains(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == personWindow
          && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == coverPID
      })
    else { throw JourneyFailure.invalid("The person's window was not on top before R0") }
    /// The menu's own open state, from reads that succeeded; `open` is null when
    /// a read failed, so an unreadable menu never counts as open or closed.
    func dismissalState() -> [String: Any] {
      var state = popupState(context ? AXUIElementCreateApplication(pid) : popupNode.element)
      var open: Bool?
      if name == "appkit" {
        if let data = try? Data(contentsOf: work.appendingPathComponent("fixture-state/state.json")),
          let fixture = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          open = fixture["menuOpen"] as? Bool
        }
      } else if context {
        // Evidence only: Chrome exposes no AX for an open context menu (see
        // `windowOnly`), so `open` stays null and the menu-level window decides.
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] {
          state["applicationMenus"] = children.filter { AXValueReader.copyString($0, kAXRoleAttribute) == kAXMenuRole }.count
        }
      } else {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(popupNode.element, kAXExpandedAttribute as CFString, &value) == .success,
          let expanded = AXValueReader.bool(value) {
          open = expanded || state["menuPresent"] as? Bool == true
        }
      }
      state["open"] = open.map { $0 as Any } ?? NSNull()
      return state
    }
    // Chrome exposes no AX at all for an open web context menu. In VM job
    // 20261028T041703Z-b6fc42d7 its menu-level window showed while the application
    // had no AXMenu child, no open menu-bar menu and nothing in the agent's tree;
    // the menu bar's closed menus read the same during and after. For it, the
    // menu-level window alone proves the menu open, then closed in time and still
    // gone at the end; the select and AppKit popups need their own state as well.
    let windowOnly = context
    /// The target's menu-level windows that were not on screen before the popup opened.
    func newMenuWindows(_ during: [String: Any]) -> [[String: Any]] {
      (during["windowServer"] as? [[String: Any]] ?? []).filter { item in
        (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
          && (item[kCGWindowLayer as String] as? Int ?? 0) >= 101
          && !((before["windowServer"] as? [[String: Any]] ?? []).contains {
            ($0[kCGWindowNumber as String] as? NSNumber) == (item[kCGWindowNumber as String] as? NSNumber)
          })
      }
    }
    let stream = try PersonStream(work, stamp: nil, minimum: 10)
    var receipts: [[String: Any]] = []
    var during: [String: Any] = [:]
    var clickAt = 0.0, escapeAt = 0.0, popupOpenAt = 0.0, popupDismissAt = 0.0, popupWindowGone = false
    var openedInTime = false, dismissedInTime = false
    var popupDuring: [String: Any] = [:], popupAfter: [String: Any] = [:]
    var failure = ""
    do {
      try await sleep(0.3)
      // Exercise the key-record sequence while ordinary global input continues.
      receipts.append(try await act(.key(keys: "Control+Alt+j"), target, monitor, observed))
      observed = try await observe(target, monitor)
      let point = target.latest!.coordinates.pixelPoint(from: CGPoint(x: popup.frame.midX, y: popup.frame.midY))
      clickAt = Date().timeIntervalSince1970
      receipts.append(try await act(.click(target: .point(point), button: context ? .right : .left, count: 1), target, monitor, observed))
      // As with Escape below: the helper used to return ~350 ms after posting, so
      // one check 0.3 s later saw the menu ~650 ms after the click. Actions now
      // return at once, and Chrome shows its context menu 0.4-0.5 s after the click
      // returns (jobs 20261028T041703Z-b6fc42d7, 20261028T044620Z-9af6e4d1), so
      // opening is polled every 20 ms and counts only if seen within that 0.65 s.
      let clicked = ProcessInfo.processInfo.systemUptime
      while true {
        during = snapshot(pid)
        popupDuring = dismissalState()
        let elapsed = ProcessInfo.processInfo.systemUptime - clicked
        if !newMenuWindows(during).isEmpty && (windowOnly || popupDuring["open"] as? Bool == true) {
          openedInTime = elapsed <= 0.65
          break
        }
        if elapsed >= 0.65 { break }
        try await sleep(min(0.02, 0.65 - elapsed))
      }
      popupOpenAt = Date().timeIntervalSince1970
      popupDuring["openedInTime"] = openedInTime
      try desktop(prefix + "-popup-open")
      observed = try await observe(target, monitor)
      try observationEvidence(observed, prefix + "-popup-open")
      try await sleep(0.4)
      escapeAt = Date().timeIntervalSince1970
      receipts.append(try await act(.key(keys: "Escape"), target, monitor, observed))
      popupDismissAt = Date().timeIntervalSince1970
      // The helper used to return at least ~350 ms after posting (its deleted
      // after-input watch), so one read 0.3 s later saw the menu ~650 ms after Escape.
      // Actions now return at once; Chrome's menu window leaves and its AX collapses
      // 0.25-0.32 s after Escape (r0-escape numbers). Both must read closed within that
      // 0.65 s, on a monotonic clock; a confirmation completed later does not count.
      let escaped = ProcessInfo.processInfo.systemUptime
      let menuIDs = Set(newMenuWindows(during).compactMap { $0[kCGWindowNumber as String] as? NSNumber })
      var elapsed = 0.0
      while true {
        popupAfter = dismissalState()
        let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        popupWindowGone = !listed.contains { ($0[kCGWindowNumber as String] as? NSNumber).map(menuIDs.contains) == true }
        elapsed = ProcessInfo.processInfo.systemUptime - escaped
        if popupWindowGone && (windowOnly || popupAfter["open"] as? Bool == false) {
          dismissedInTime = elapsed <= 0.65
          break
        }
        if elapsed >= 0.65 { break }
        try await sleep(min(0.02, 0.65 - elapsed))
      }
      popupAfter["readMs"] = elapsed * 1000
      popupAfter["windowGone"] = popupWindowGone
      popupAfter["dismissedInTime"] = dismissedInTime
      try desktop(prefix + "-popup-dismissed")
    } catch { failure = String(describing: error) }
    let expected = try await stream.stop().compactMap { $0["text"] as? String }.joined()
    try await sleep(0.3)
    let after = snapshot(pid)
    let coverState = try JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("cover-state.json"))) as! [String: Any]
    let transitions = Array((coverState["transitions"] as? [[String: Any]] ?? []).dropFirst(initialTransitions))
    let stableKeys = transitions.allSatisfy { state in
      state["key"] as? Bool == true && state["active"] as? Bool == true
        && state["globalPID"] as? Int32 == coverPID
        && state["globalWindowID"] as? UInt32 == before["globalKeyWindowID"] as? UInt32
    }
    // Decision (A), as Codex (docs/computer-use.md): the agent's own popup click may
    // raise the window it clicked over the person's, and that window then stays where
    // it is; nothing sends it back. Every sample is the baseline, with the person's
    // window on top, until a raise first seen at or after the click starts and before
    // the next agent action (the Escape) starts; from then on it is the baseline with
    // only the clicked window raised, and that window on top. Any other window above
    // the person's, new or not, fails. The raise is not bounded by the open check: the
    // 20 ms poll confirms the menu as soon as it shows, and the click's raise can be
    // sampled just after (+0.079 s vs +0.065 s, job at e25f3dc70).
    let raisedOrder = [clickedWindow] + baselineOrder.filter { $0 != clickedWindow }
    let samples: [(at: Double, all: [UInt32])] = transitions.map { state in
      (state["at"] as? Double ?? 0, (state["windowOrder"] as? [[String: Any]] ?? []).compactMap { item -> UInt32? in
        guard let owner = item["pid"] as? Int32, owner == pid || owner == coverPID,
          item["layer"] as? Int == 0, let id = item["id"] as? UInt32 else { return nil }
        return id
      })
    } + [(after["at"] as? Double ?? 0, order(after, pid: pid))]
    // `above` is every target or cover window above the person's, new or not.
    let orders = samples.map {
      (at: $0.at, above: Array($0.all.prefix { $0 != personWindow }), order: $0.all.filter(baselineOrder.contains))
    }
    let firstRaised = orders.firstIndex { $0.order == raisedOrder }
    let raisedAt = firstRaised.map { orders[$0].at }
    let orderContract = orders.indices.allSatisfy { index in
      let raised = firstRaised.map { index >= $0 } == true
      return orders[index].order == (raised ? raisedOrder : baselineOrder)
        && orders[index].above == (raised ? [clickedWindow] : [])
    } && raisedAt.map { $0 >= clickAt && $0 < escapeAt } != false
    let actual = String((coverState["text"] as? String ?? "").dropFirst(initialText.count))
    let popupWindows = (during["windowServer"] as? [[String: Any]] ?? []).filter { item in
      (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        && !((before["windowServer"] as? [[String: Any]] ?? []).contains {
          ($0[kCGWindowNumber as String] as? NSNumber) == (item[kCGWindowNumber as String] as? NSNumber)
        })
    }
    let menuWindows = newMenuWindows(during)
    let popupOpened = openedInTime && !menuWindows.isEmpty && (windowOnly || popupDuring["open"] as? Bool == true)
    let popupDismissed = dismissedInTime && popupWindowGone && (windowOnly || popupAfter["open"] as? Bool == false) && menuWindows.allSatisfy { popup in
      !((after["windowServer"] as? [[String: Any]] ?? []).contains { window in
        (popup[kCGWindowNumber as String] as? NSNumber) == (window[kCGWindowNumber as String] as? NSNumber)
      })
    }
    // The agent is never interrupted: every action returns what it performed.
    let delivered = receipts.count == 3 && receipts.allSatisfy {
      $0["error"] as? String == "" && ($0["performed"] as? [String])?.isEmpty == false
    }
    let pointerStable = before["pointerX"] as? Double == after["pointerX"] as? Double
      && before["pointerY"] as? Double == after["pointerY"] as? Double
      && transitions.allSatisfy { $0["pointerX"] as? Double == before["pointerX"] as? Double && $0["pointerY"] as? Double == before["pointerY"] as? Double }
    let frontStable = transitions.allSatisfy { ($0["frontPID"] as? NSNumber)?.int32Value == coverPID }
    let typingDuringPopup = (coverState["keyEvents"] as? [[String: Any]] ?? []).contains {
      let time = $0["at"] as? Double ?? 0
      return time >= popupOpenAt && time <= popupDismissAt
    }
    let safetyEvidence = safety(before, after, pid: pid)
    // The person's front and pointer stay unchanged and window order follows
    // decision (A) above, pass or accepted; a pass also keeps their key status
    // without a single loss.
    let otherSafety = ["frontStable", "pointerStable"].allSatisfy { safetyEvidence[$0] as? Bool == true } && orderContract
    let finalSafety = safetyEvidence["keysStable"] as? Bool == true && otherSafety
    let passed = failure.isEmpty && delivered && popupOpened && popupDismissed && typingDuringPopup && actual == expected && stableKeys && finalSafety && pointerStable && frontStable
    // The helper uses cua's menu guard, which returns a stolen keyboard as soon
    // as it sees the theft. A brief key loss with every keystroke still landing in
    // the person's app and focus back at the end is that accepted design, not a pass.
    // Counted over the same transitions as safety().keysStable, from the baseline
    // snapshot on: a loss before the person's stream starts still counts.
    var keyLossMs: [Double] = []
    var lostAt: Double?
    for state in safetyEvidence["transitions"] as? [[String: Any]] ?? [] {
      let held = state["key"] as? Bool == true && state["active"] as? Bool == true
        && state["globalPID"] as? Int32 == coverPID
        && state["globalWindowID"] as? UInt32 == before["globalKeyWindowID"] as? UInt32
      let at = state["at"] as? Double ?? 0
      if !held, lostAt == nil { lostAt = at }
      if held, let start = lostAt { keyLossMs.append((at - start) * 1000); lostAt = nil }
    }
    let keyBack = (after["globalKeyPID"] as? NSNumber)?.int32Value == coverPID
      && (after["globalKeyWindowID"] as? NSNumber)?.uint32Value == (before["globalKeyWindowID"] as? NSNumber)?.uint32Value
    let briefKeyLoss = !stableKeys && lostAt == nil && !keyLossMs.isEmpty && keyLossMs.allSatisfy { $0 < 250 }
    let accepted = !passed && briefKeyLoss && keyBack && failure.isEmpty && delivered && popupOpened && popupDismissed
      && typingDuringPopup && actual == expected && otherSafety && pointerStable && frontStable
    let limitation = accepted
      ? keyLossMs.map { String(format: "key status lost for %.1f ms (< 250 ms) and back at the end; every keystroke landed", $0) }
      : []
    rows.append(["journey": "R0", "iteration": r0Iteration, "app": name, "route": context ? "context-global-typing" : "select-global-typing", "pageReadySeconds": pageReadySeconds, "safety": safetyEvidence,
      "status": passed ? "pass" : accepted ? "accepted-limitation" : "regression", "limitation": limitation, "keyLossMs": keyLossMs, "keyBack": keyBack, "before": before, "during": during, "after": after,
      "expectedGlobalText": expected, "actualGlobalText": actual, "globalSequenceExact": actual == expected,
      "globalKeyUnchanged": stableKeys, "frontUnchanged": frontStable, "pointerUnchanged": pointerStable,
      "windowOrder": !orderContract ? "violated" : raisedAt == nil ? "unchanged" : "raised-by-click", "raisedAt": raisedAt.map { $0 as Any } ?? NSNull(),
      "clickAt": clickAt, "escapeAt": escapeAt, "clickedWindow": clickedWindow,
      "popupOpened": popupOpened, "popupDismissed": popupDismissed, "popupDuring": popupDuring, "popupAfter": popupAfter, "typingDuringPopup": typingDuringPopup, "popupOpenAt": popupOpenAt, "popupDismissAt": popupDismissAt, "popupWindows": popupWindows, "receipts": receipts,
      "error": failure, "coverEvidence": coverState, "baselineOrder": baselineOrder])
    try json(coverState, out.appendingPathComponent(prefix + "-cover.json"))
    try save()
    await stop(pid)
  }

  func chromiumSpecial(_ route: String) async throws {
    beginCase()
    defer { actionCancellation.cancel(.closed) }
    let pid = try await launch("chrome").processIdentifier
    defer { signalOwned(pid) }
    let target = try state(chrome), monitor = WindowMonitor()
    defer { monitor.stop() }
    var observed = try await observe(target, monitor)
    var receipts: [[String: Any]] = []
    let prefix = "R3-" + route
    if route == "siblings" {
      // Setup may activate Chrome itself. Re-establish the person's cover only
      // BEFORE measurement; no test-side restoration is allowed during input.
      let newWindow = try await act(.key(keys: "cmd+n"), target, monitor, observed)
      try require(newWindow["error"] as? String == "", "Could not create sibling window")
      // ⌘N returns before Chrome lists its new window: wait for it, up to 5 s.
      let listed = ProcessInfo.processInfo.systemUptime
      var created = try await SessionWindows.windows(app: target, monitor: monitor)
      while !created.contains(where: { $0.id != observed.window.id }),
        ProcessInfo.processInfo.systemUptime - listed < 5
      {
        try await sleep(0.1)
        created = try await SessionWindows.windows(app: target, monitor: monitor)
      }
      guard let next = created.first(where: { $0.id != observed.window.id }) else { throw JourneyFailure.invalid("New explicit Chrome window absent") }
      _ = try SessionWindows.bind(app: target, window: next.id, monitor: monitor)
      observed = try await observe(target, monitor)
      let navigation = try await runActions([.key(keys: "cmd+l"), .type(text: page.absoluteString + "?sibling"), .key(keys: "Return")], target, monitor, observed)
      try require(navigation["error"] as? String == "", "Could not load sibling page")
      try await sleep(2)
      let application = AXUIElementCreateApplication(pid)
      let windows = AXValueReader.copyElements(application, kAXWindowsAttribute).filter {
        KeyWindow.windowID(of: $0).map { order(snapshot(pid), pid: pid).contains($0) } == true
      }
      try require(windows.count == 2, "Two Chrome document windows required")
      // Deliberate overlap must never add a sibling to either window group.
      for (index, window) in windows.enumerated() {
        var origin = CGPoint(x: CGFloat(20 + index * 260), y: 100)
        var size = CGSize(width: 600, height: 600)
        guard let position = AXValueCreate(.cgPoint, &origin), let dimensions = AXValueCreate(.cgSize, &size) else {
          throw JourneyFailure.invalid("Sibling geometry construction failed")
        }
        try require(AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, dimensions) == .success
          && AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) == .success,
          "Could not arrange visible sibling controls")
      }
      try await sleep(0.3)
      observed = try await observe(target, monitor)
    }
    try observationEvidence(observed, prefix + "-setup")
    guard let latest = target.latest else { throw JourneyFailure.invalid("No special-case observation") }
    let buttons = latest.elements.enumerated().filter {
      $0.element.attributes.role == "AXButton" && ($0.element.attributes.title ?? "").hasPrefix("Counter ")
    }
    try require(!buttons.isEmpty, "Web AX counter missing")
    try await cover(latest.windowFrame)
    let before = snapshot(pid)
    try desktop(prefix + "-before")
    var delivered = false, details: [String: Any] = [:]
    // When each batch's click on a sibling window started, in batch order.
    var clicks: [(window: CGWindowID, at: Double)] = []
    do {
      let inventory = try await SessionWindows.windows(app: target, monitor: monitor)
      try require(inventory.count == 2, "Two explicit Chrome document windows required")
      var effects: [[String: Any]] = []
      var prior: [CGWindowID: [String: Any]] = [:]
      for window in inventory {
        _ = try SessionWindows.bind(app: target, window: window.id, monitor: monitor)
        _ = try await observe(target, monitor)
        prior[window.id] = webEffects(target, window: window.id)
        try require(!(prior[window.id]?.isEmpty ?? true), "R3 receiver baseline missing")
      }
      for window in inventory {
        _ = try SessionWindows.bind(app: target, window: window.id, monitor: monitor)
        observed = try await observe(target, monitor)
        guard let snapshot = target.latest else { throw JourneyFailure.invalid("Missing explicit snapshot") }
        let owned = snapshot.elements.filter { $0.attributes.role == "AXButton" && ($0.attributes.title ?? "").hasPrefix("Counter ") }
        try require(owned.count == 1, "Explicit tree includes a sibling counter")
        let currentPlan = try await WindowCapture.plan(processIdentifier: pid,
          keyWindow: WindowIdentity(windowID: window.id, title: window.title, frame: snapshot.windowFrame))
        try require(currentPlan.cropPoints == snapshot.windowFrame, "Overlapping Chrome sibling enlarged crop")
        guard let counter = snapshot.elements.firstIndex(where: { $0.attributes.role == "AXButton" && ($0.attributes.title ?? "").hasPrefix("Counter ") }),
          let field = snapshot.elements.firstIndex(where: { $0.attributes.role == "AXTextField" && ($0.attributes.title ?? "").contains("Journey input") }) else { throw JourneyFailure.invalid("Explicit Chrome controls missing") }
        clicks.append((window.id, Date().timeIntervalSince1970))
        receipts.append(try await runActions([.click(target: .index(counter), button: .left, count: 1),
          .type(text: "Window-\(window.id)", target: .index(field)), .key(keys: "Control+Alt+j"), .key(keys: "Tab")], target, monitor, observed))
        observed = try await observe(target, monitor)
        let effect = webEffects(target, window: window.id)
        try require((effect["clicks"] as? Int) == 1 && (effect["shortcuts"] as? Int) == 1, "Input did not stay in explicit Chrome window")
        // The known limitation in docs/computer-use.md: the batch's ⌃⌥J also
        // types "j" into the focused field. Asserted as it is, so a fix shows.
        let typed = "Window-\(window.id)" + "j"
        try require(
          (effect["input"] as? Int ?? 0) > (prior[window.id]?["input"] as? Int ?? 0)
            && (effect["change"] as? Int ?? 0) > (prior[window.id]?["change"] as? Int ?? 0)
            && effect["text"] as? String == typed,
          "R3 input/change receiver events missing")
        try require(target.latest?.elements.contains { $0.attributes.value == typed } == true, "Typed text went to a sibling")
        try observationEvidence(observed, prefix + "-window-\(window.id)")
        prior[window.id] = effect
        for sibling in inventory where sibling.id != window.id {
          _ = try SessionWindows.bind(app: target, window: sibling.id, monitor: monitor)
          _ = try await observe(target, monitor)
          let actual = webEffects(target, window: sibling.id)
          try require(
            NSDictionary(dictionary: actual).isEqual(to: prior[sibling.id] ?? [:]),
            "R3 batch changed its untouched sibling")
          effects.append([
            "actedWindow": window.id, "sibling": sibling.id, "unchanged": true, "effects": actual,
          ])
        }
        effects.append(["id": window.id, "effects": effect])
      }
      delivered = true
      details = ["windows": effects]

    }
    try await sleep(0.3)
    let after = snapshot(pid), evidence = safety(before, after, pid: pid)
    try observationEvidence(observed, prefix + "-after")
    try desktop(prefix + "-after")
    let safe = ["keysStable", "frontStable", "pointerStable"].allSatisfy { evidence[$0] as? Bool == true }
    // Decision (A) with Codex's preparation (docs/computer-use.md, "Preparing an
    // app"): an agent's click may raise the window it clicked to the top, above
    // the person's window too, and it stays there until the next agent action.
    // That action's preparation may raise the person's window back over it, as
    // Codex's `safelyEnforceActiveState` does, and only that. Nothing else moves
    // and nothing is lowered at any other time. A batch is one act call, so both
    // fall between its click's start and the next batch or the final read.
    var orderStable = order(before, pid: pid) == order(after, pid: pid)
    var observedOrders: [[UInt32]] = []
    if route == "siblings" {
      let samples: [(at: Double, order: [UInt32])] = (evidence["transitions"] as? [[String: Any]] ?? []).map { state in
        (state["at"] as? Double ?? 0, (state["windowOrder"] as? [[String: Any]] ?? []).compactMap { item -> UInt32? in
          guard let owner = (item["pid"] as? NSNumber)?.int32Value, owner == pid || owner == coverPID,
            item["layer"] as? Int == 0, let id = (item["id"] as? NSNumber)?.uint32Value else { return nil }
          return id
        })
      } + [(after["at"] as? Double ?? 0, order(after, pid: pid))]
      let person = (before["globalKeyWindowID"] as? NSNumber)?.uint32Value
      func top(_ window: UInt32, _ order: [UInt32]) -> [UInt32] { [window] + order.filter { $0 != window } }
      var current = order(before, pid: pid)
      var raisedIn: Int?, restoredIn: Int?
      observedOrders = [current]
      orderStable = person != nil && current.first == person && samples.allSatisfy { sample in
        guard sample.order != current else { return true }
        guard let person, let batch = clicks.lastIndex(where: { $0.at <= sample.at }) else { return false }
        let end = batch + 1 < clicks.count ? clicks[batch + 1].at : (after["at"] as? Double ?? .infinity)
        let raised = top(clicks[batch].window, current)
        guard sample.at < end, restoredIn != batch else { return false }
        if raisedIn != batch, sample.order == raised {
          raisedIn = batch
        } else if raisedIn == batch, sample.order == top(person, current) {
          restoredIn = batch
        } else if raisedIn != batch, sample.order == top(person, raised) {
          // The raise and the restore between two samples.
          raisedIn = batch
          restoredIn = batch
        } else {
          return false
        }
        current = sample.order
        observedOrders.append(current)
        return true
      }
    }
    let finalOnTop = evidence["finalPersonOnTop"] as? Bool == true
    let receiptsOK = !receipts.isEmpty && receipts.allSatisfy { $0["error"] as? String == "" }
    let passed = delivered && receiptsOK && safe && orderStable && finalOnTop
    let status = passed ? "pass" : "regression"
    rows.append(["journey": "R3", "route": route, "status": status,
      "deliveryConfirmed": delivered, "before": before, "after": after, "safety": evidence,
      "windowOrderUnchanged": orderStable, "observedOrders": observedOrders,
      "clicks": clicks.map { ["window": $0.window, "at": $0.at] }, "details": details, "receipts": receipts])
    try save()
    await stop(pid)
  }

  func webEffects(_ state: AppSessionState, window: CGWindowID? = nil) -> [String: Any] {
    let text = state.latest?.elements.first(where: {
      ($0.attributes.title ?? $0.attributes.value ?? "").hasPrefix("Journey events {")
        && (window == nil || ($0.node as? AXElementNode).flatMap { ActionRunner.windowID(containing: $0.element) } == window)
    }).flatMap { $0.attributes.title ?? $0.attributes.value }
    return text.flatMap { try? JSONSerialization.jsonObject(with: Data($0.dropFirst("Journey events ".count).utf8)) as? [String: Any] } ?? [:]
  }

  func freeze(_ variant: String) async throws {
    beginCase()
    defer { actionCancellation.cancel(.closed) }
    let name = "chrome"
    let pid = try await launch(name).processIdentifier
    defer { signalOwned(pid) }
    let target = try state(name == "chrome" ? chrome : fixture), monitor = WindowMonitor()
    defer { monitor.stop() }
    var observed = try await observe(target, monitor)
    try observationEvidence(observed, "R1-" + variant + "-setup")
    let latest = target.latest!
    let (button, _) = try elements(target)
    let buttonFrame = latest.elements[button].attributes.frame!
    try await cover(latest.windowFrame, partial: false)
    let plan = try await WindowCapture.plan(processIdentifier: pid,
      keyWindow: WindowIdentity(windowID: latest.windowID, title: nil, frame: latest.windowFrame), outputMaxLongSide: 1280)
    let config = plan.configuration
    config.width = max(2, config.width / 2 * 2); config.height = max(2, config.height / 2 * 2)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30); config.queueDepth = 3
    config.showsCursor = false; config.capturesAudio = false
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    if #available(macOS 15.0, *) { config.captureDynamicRange = .SDR }
    let frames = Frames(), stream = SCStream(filter: plan.filter, configuration: config, delegate: frames)
    try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "journey.frames"))
    try await stream.startCapture()
    do {
      try await sleep(2)
      let idleBefore = try frames.latest()
      try await sleep(0.7)
      let idleAfter = try frames.latest()
      let idleDiff = try diff(idleBefore.0, idleAfter.0)
      try png(idleBefore.0, out.appendingPathComponent("R1-" + variant + "-idle-before.png"))
      try png(idleAfter.0, out.appendingPathComponent("R1-" + variant + "-idle-after.png"))
      try json(idleDiff, out.appendingPathComponent("R1-" + variant + "-idle.json"))
      for route in ["ax-press"] {
        observed = try await observe(target, monitor)
        let prefix = "R1-\(variant)-\(route)"
        try observationEvidence(observed, prefix + "-before")
        let beforeCoverage = try coverage(pid, windowID: latest.windowID, frame: latest.windowFrame, partial: false)
        try require(beforeCoverage["valid"] as? Bool == true, "Invalid baseline occlusion")
        try desktop(prefix + "-before")
        let beforeState = snapshot(pid), before = try frames.latest()
        let receipt = try await act(try action(route, state: target), target, monitor, observed)
        try await sleep(1)
        let afterState = snapshot(pid), following = try await observe(target, monitor)
        let after = try frames.latest()
        try observationEvidence(following, prefix + "-after")
        try png(before.0, out.appendingPathComponent(prefix + "-before.png"))
        try png(after.0, out.appendingPathComponent(prefix + "-after.png"))
        let scale = CGFloat(before.0.width) / plan.cropPoints.width
        let region = CGRect(x: (buttonFrame.minX - plan.cropPoints.minX + 5) * scale,
          y: (buttonFrame.minY - plan.cropPoints.minY + 5) * scale,
          width: (buttonFrame.width - 10) * scale, height: (buttonFrame.height - 10) * scale).integral
        guard let a = before.0.cropping(to: region), let b = after.0.cropping(to: region) else { throw JourneyFailure.invalid("Counter crop invalid") }
        try png(a, out.appendingPathComponent(prefix + "-counter-before.png"))
        try png(b, out.appendingPathComponent(prefix + "-counter-after.png"))
        let counterDiff = try diff(a, b), wholeDiff = try diff(before.0, after.0)
        let advanced = counter(following).flatMap { next in counter(observed).map { next > $0 } } ?? false
        let fresh = (counterDiff["changedFraction"] as? Double ?? 0) > 0.01
        let afterCoverage = try coverage(pid, windowID: latest.windowID, frame: latest.windowFrame, partial: false)
        let remainedCovered = afterCoverage["valid"] as? Bool == true
        try desktop(prefix + "-after")
        let delivered = receipt["error"] as? String == "" && advanced
        let orderUnchanged = order(beforeState, pid: pid) == order(afterState, pid: pid)
        let status = !delivered || !remainedCovered ? "regression" : fresh && orderUnchanged ? "pass" : "regression"
        rows.append(["journey": "R1", "variant": variant, "route": route, "status": status,
          "AXBefore": counter(observed).map { $0 as Any } ?? NSNull(), "AXAfter": counter(following).map { $0 as Any } ?? NSNull(),
          "coverageBefore": beforeCoverage, "coverageAfter": afterCoverage, "AXAdvanced": advanced, "counterFresh": fresh, "counterDiff": counterDiff, "wholeDiff": wholeDiff,
          "idleAnimationControl": idleDiff, "completeFramesBefore": before.1, "completeFramesAfter": after.1, "before": beforeState,
          "after": afterState, "receipt": receipt, "evidencePrefix": prefix])
        try save()
        // A route that activates Chrome invalidates occlusion; restore cover only BETWEEN samples.
        if !remainedCovered { try await cover(latest.windowFrame, partial: false) }
      }
      try await stream.stopCapture()
    } catch { try? await stream.stopCapture(); throw error }
    await stop(pid)
  }
}
