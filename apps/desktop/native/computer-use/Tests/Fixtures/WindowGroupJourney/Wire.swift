import AppKit
import Darwin

@MainActor final class WireJourney {
  let helper: HelperRuntime
  let ownsHelper: Bool
  static var nextConnectionID = 902
  let decoder = Locked(FrameDecoder())
  let connection: IPCConnection
  let client: Int32
  let out: URL
  var sequence = 0
  var lastMediaHeader: [String: Any]?
  private var ownerEditing: [String: [String: Any]] = [:]
  /// Editing contexts in arrival order; a mark taken after a receipt admits
  /// only contexts the helper published after it.
  private var editingContexts: [(stream: String, context: [String: Any])] = []
  var editingMark: Int { editingContexts.count }
  private(set) var displayStates: [String: [String: Any]] = [:]
  init(out: URL, helper: HelperRuntime? = nil) throws {
    self.helper = helper ?? HelperRuntime(helperVersion: "native-journey", peerRequirement: .sameUser)
    ownsHelper = helper == nil
    self.out = out
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var pair: [Int32] = [0, 0]
    try require(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0, "Wire socketpair")
    client = pair[1]
    var noPipe: Int32 = 1
    for descriptor in pair {
      setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout<Int32>.size))
    }
    var timeout = timeval(tv_sec: 30, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    connection = IPCConnection(id: Self.nextConnectionID, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
    Self.nextConnectionID += 1
    connection.resume()
    if ownsHelper && (ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_OVERLAY"] == "1" || ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_INPUT_JOURNEY"] == "1") {
      try self.helper.start(socketURL: out.appendingPathComponent("helper.sock"))
    }
  }
  func close() { if ownsHelper { helper.stop() }; connection.close(); Darwin.close(client) }
  /// A connection says hello once; every journey on it shares that.
  private var greeted = false
  private var negotiatedOwnerInput = false
  func hello(ownerInput: Bool = false) async throws {
    if greeted {
      try require(!ownerInput || negotiatedOwnerInput, "This connection did not negotiate owner input")
      return
    }
    var params: [String: Any] = ["protocolVersion": 10, "ownerViewVersion": 3]
    if ownerInput { params["ownerInputVersion"] = 2 }
    let reply = try await request("hello", params)
    try require(reply["ownerViewVersion"] as? Int == 3, "Owner-view v3 negotiation failed")
    if ownerInput {
      try require(reply["ownerInputVersion"] as? Int == 2, "Owner input was not negotiated")
    } else {
      try require(reply["ownerInputVersion"] == nil, "Baseline hello acquired an unnegotiated input capability")
    }
    negotiatedOwnerInput = reply["ownerInputVersion"] as? Int == 2
    greeted = true
  }
  func nextFrame() async throws -> Data {
    try await nextFrame(until: nil).unwrap("native frame")
  }
  /// Nil once the monotonic `deadline` passes with no complete frame.
  func nextFrame(until deadline: UInt64?) async throws -> Data? {
    let client = client, decoder = decoder
    return try await Task.detached { () throws -> Data? in
      var bytes = [UInt8](repeating: 0, count: 65_536)
      while true {
        if let value = try decoder.withLock({ try $0.next() }) { return value }
        if let deadline {
          let now = DispatchTime.now().uptimeNanoseconds
          guard now < deadline else { return nil }
          var ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
          let waited = poll(&ready, 1, Int32((deadline - now + 999_999) / 1_000_000))
          guard waited > 0 else {
            if waited < 0, errno == EINTR { continue }
            if waited == 0 { return nil }
            throw JourneyFailure.failed("Native wire poll failed")
          }
        }
        let count = Darwin.read(client, &bytes, bytes.count)
        guard count > 0 else { throw JourneyFailure.failed("Native wire ended before its next frame") }
        decoder.withLock { $0.append(Data(bytes.prefix(count))) }
      }
    }.value
  }
  func nextMediaFrame(until deadline: UInt64? = nil) async throws
    -> (header: [String: Any], annex: Data, frame: Data)? {
    guard let frame = try await nextFrame(until: deadline) else { return nil }
    guard frame.count > 4 else { throw JourneyFailure.failed("Truncated native media") }
    let length = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length < frame.count - 4 else { throw JourneyFailure.failed("Bad native media header") }
    let header = try JSONSerialization.jsonObject(with: frame.subdata(in: 4..<(4 + length))) as! [String: Any]
    let sequence = (header["sequence"] as! NSNumber).intValue
    let ack = try Frame.encode(JSONSerialization.data(withJSONObject: ["type": "display.ack", "sequence": sequence]))
    let written = ack.withUnsafeBytes { Darwin.write(client, $0.baseAddress, $0.count) }
    try require(written == ack.count, "Native media ended before its acknowledgment")
    return (header, frame.subdata(in: (4 + length)..<frame.count), frame)
  }
  func keyframe(_ stream: String) async throws -> (Int, Data) {
    for _ in 0..<120 {
      let media = try await nextMediaFrame().unwrap("native media")
      let header = media.header
      if header["key"] as? Bool == true {
        lastMediaHeader = header
        try media.frame.write(to: out.appendingPathComponent(stream + "-frame.bin"))
        return ((header["generation"] as! NSNumber).intValue, media.annex)
      }
    }
    throw JourneyFailure.failed("Native stream produced no keyframe")
  }
  private func record(event value: Data, object: [String: Any]?, request: Int) throws {
    if object?["event"] as? String == "display.owner-input",
      let params = object?["params"] as? [String: Any], let stream = params["streamId"] as? String,
      let message = params["message"] as? [String: Any], message["type"] as? String == "display.editing",
      let context = message["context"] as? [String: Any] {
      ownerEditing[stream] = context
      editingContexts.append((stream, context))
    }
    if object?["event"] as? String == "display.state", let params = object?["params"] as? [String: Any],
      let stream = params["streamId"] as? String {
      displayStates[stream] = params
    }
    try value.write(to: out.appendingPathComponent("wire-event-\(request)-\(UUID().uuidString).json"))
  }
  /// The first editing context for `stream` published after `mark` that
  /// `accept` takes, read as events arrive; no request prompts it.
  func editingContext(_ stream: String, after mark: Int, seconds: Double = 1.5,
                      _ accept: ([String: Any]) -> Bool) async throws -> [String: Any] {
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(seconds * 1_000_000_000)
    var next = mark
    while true {
      while next < editingContexts.count {
        let row = editingContexts[next]; next += 1
        if row.stream == stream, accept(row.context) { return row.context }
      }
      guard let value = try await nextFrame(until: deadline) else { break }
      let object = try JSONSerialization.jsonObject(with: value) as? [String: Any]
      try require(object?["id"] == nil, "An unrequested reply reached the editing wait")
      try record(event: value, object: object, request: sequence)
    }
    throw JourneyFailure.failed("No AX editing context was published after the input's receipt")
  }
  func request(_ method: String, _ params: [String: Any], timeoutMs: Int = 30_000,
               until deadline: UInt64? = nil) async throws
    -> [String: Any]
  {
    sequence += 1
    var params = params
    if method == "session.act", params["snapshot"] == nil { params["snapshot"] = NSNull() }
    let frame = try JSONSerialization.data(withJSONObject: [
      "id": sequence, "method": method, "params": params, "timeoutMs": timeoutMs,
    ])
    await helper.handle(connection: connection, frame: frame)
    let expected = sequence
    var reply: Data
    while true {
      let value = try await nextFrame(until: deadline).unwrap("Native \(method) reply before its deadline")
      let object = try JSONSerialization.jsonObject(with: value) as? [String: Any]
      if (object?["id"] as? NSNumber)?.intValue == expected { reply = value; break }
      try record(event: value, object: object, request: expected)
    }
    try reply.write(to: out.appendingPathComponent("wire-\(sequence)-\(method).json"))
    let envelope = try JSONSerialization.jsonObject(with: reply) as! [String: Any]
    if let error = envelope["error"] as? [String: Any] {
      throw HelperError(HelperErrorCode(rawValue: error["code"] as? String ?? "") ?? .failed, error["message"] as? String ?? "")
    }
    return try (envelope["result"] as? [String: Any]).unwrap("wire result")
  }
  func assertOutline(_ window: CGWindowID, name: String, cursorOffset: CGPoint? = nil) async throws {
    let frame = try KeyWindow.currentFrame(window).unwrap("outline target")
    let expected = OverlayGeometry.outlinePanelFrame(window: frame, primaryHeight: ScreenGeometry.primaryHeight)
    let deadline = Date().addingTimeInterval(2)
    while !NSApp.windows.contains(where: { $0.contentView is WorkingOutlineView && $0.isVisible && $0.frame == expected }), Date() < deadline {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    let outlines = NSApp.windows.filter { $0.contentView is WorkingOutlineView }.map { ["id": $0.windowNumber, "visible": $0.isVisible, "frame": NSStringFromRect($0.frame)] as [String: Any] }
    try JSONSerialization.data(withJSONObject: outlines).write(to: out.appendingPathComponent("N4-outline-" + name + ".json"))
    try require(NSApp.windows.contains(where: { $0.contentView is WorkingOutlineView && $0.isVisible && $0.frame == expected }), "N4 outline did not follow " + name)
    if let cursorOffset {
      let pointerFrame = OverlayGeometry.pointerPanelFrame(tip: CGPoint(x: frame.minX + cursorOffset.x, y: frame.minY + cursorOffset.y), primaryHeight: ScreenGeometry.primaryHeight)
      try require(NSApp.windows.contains(where: { $0.contentView is AgentCursorView && $0.isVisible && $0.frame == pointerFrame }), "N4 cursor did not follow " + name)
    }
  }
  func run(app: AppIdentity, a: CGWindowID, b: CGWindowID) async throws {
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    let session = "cus_11111111-1111-4111-8111-111111111111"
    let target: [String: Any] = ["identity": identity, "access": "read-write"]
    try await hello()
    _ = try await request("session.open", ["sessionId": session, "threadTitle": "Window group journey"])
    let listed = try await request("session.windows", ["sessionId": session, "app": target])
    try require((listed["windows"] as? [[String: Any]])?.contains { ($0["id"] as? NSNumber)?.uint32Value == a } == true, "Wire inventory omitted A")
    let chosen = try await request("session.bind", ["sessionId": session, "app": target, "window": a])
    let ref = try ((chosen["window"] as? [String: Any])?["ref"] as? String).unwrap("bound ref")
    if ProcessInfo.processInfo.environment["OPENSTEER_WINDOW_GROUP_OVERLAY"] == "1" {
      let source: [String: Any] = ["kind": "task-session", "sessionId": session, "appKey": app.bundleId.lowercased()]
      let aSource = try await request("display.resolve", ["source": source])
      let pictured = try await request("session.observe", ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
      let picture = try (pictured["observation"] as? [String: Any]).unwrap("N4 observation")
      let cursorSnapshot = try (picture["snapshot"] as? String).unwrap("N4 snapshot")
      let scale = ((picture["window"] as? [String: Any])?["scale"] as? NSNumber)?.doubleValue ?? 1
      _ = try await request("session.act", ["sessionId": session, "app": target, "window": ref, "snapshot": cursorSnapshot, "actions": [["type": "click", "target": ["x": 60 * scale, "y": 100 * scale]]]])
      let cursorOffset = CGPoint(x: 60, y: 100)
      try await assertOutline(a, name: "A", cursorOffset: cursorOffset)
      _ = try await request("session.bind", ["sessionId": session, "app": target, "window": b])
      let bSource = try await request("display.resolve", ["source": source])
      try require((aSource["target"] as? [String: Any])?["bindingId"] as? String != (bSource["target"] as? [String: Any])?["bindingId"] as? String, "N4 video binding did not follow B")
      try await assertOutline(b, name: "B", cursorOffset: cursorOffset)
      try await Contracts.command(out, "focus", "C")
      let afterFocus = try await request("display.resolve", ["source": source])
      try require((bSource["target"] as? [String: Any])?["bindingId"] as? String == (afterFocus["target"] as? [String: Any])?["bindingId"] as? String, "N4 person focusing C changed task video")
      try await assertOutline(b, name: "B-after-C", cursorOffset: cursorOffset)
      _ = try await request("session.bind", ["sessionId": session, "app": target, "window": a])
      try await assertOutline(a, name: "A-again", cursorOffset: cursorOffset)
      try Data("Current-window video and outline assertions passed\n".utf8).write(to: out.appendingPathComponent("N4-passed.txt"))
    }
    let beforeCount = helper.registry.sessions.count
    let picker = try await request("view.windows", ["app": identity])
    try require(helper.registry.sessions.count == beforeCount && (picker["windows"] as? [[String: Any]])?.contains { ($0["id"] as? NSNumber)?.uint32Value == b } == true, "Owner picker created a session or omitted B")
    let opened = try await request("view.open", ["viewId": "cvw_22222222-2222-4222-8222-222222222222", "generation": 1, "leaseDurationMs": 30_000, "target": ["kind": "app", "app": identity, "window": b]])
    try require(((opened["window"] as? [String: Any])?["id"] as? NSNumber)?.uint32Value == b, "Owner B borrowed task A")
    let observed = try await request("session.observe", ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
    let snapshot = try ((observed["observation"] as? [String: Any])?["snapshot"] as? String).unwrap("snapshot")
    let next = try await request("session.observe", ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
    try require(((next["observation"] as? [String: Any])?["snapshot"] as? String) != snapshot, "Observe reused snapshot")
    do {
      _ = try await request("session.act", ["sessionId": session, "app": target, "window": ref, "snapshot": snapshot, "actions": [["type": "click", "target": ["x": 10, "y": 10]]]])
      throw JourneyFailure.failed("Wire stale snapshot accepted")
    } catch let error as HelperError { try require(error.code == .staleObservation, "Wrong wire stale refusal") }
    _ = try await request("view.close", ["viewId": "cvw_22222222-2222-4222-8222-222222222222", "generation": 1, "leaseDurationMs": 30_000])
    _ = try await request("session.close", ["sessionId": session])
    _ = try await request("session.open", ["sessionId": session, "threadTitle": "Replacement session"])
    _ = try await request("session.windows", ["sessionId": session, "app": target])
    do {
      _ = try await request("session.observe", ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
      throw JourneyFailure.failed("An ended session's ref revived")
    } catch let error as HelperError { try require(error.code == .staleObservation && error.message == "That window is closed.", "Wrong ended-ref refusal") }
    _ = try await request("session.close", ["sessionId": session])
  }
}

extension WireJourney {
  func ownerInput(app: AppIdentity, a: CGWindowID, b: CGWindowID) async throws {
    let fixtureEngine = ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_ELECTRON_APP"] == nil ? "appkit" : "electron"
    var cases: [String: String] = [:]
    var active: String?
    let planned = ["negotiation", "helper-baseline-negotiation", "capture-ready", "person-waits-for-agent-mutation", "two-idle-attachments-share-app", "agent-refused-held-button", "another-app-agent-unaffected",
      "native-text-key", "IME-commit", "external-caret-stale", "verified-replacement", "stale-replacement", "rich-paste-refusal",
      "multiline-paste", "AX-copy", "save-chord", "undo-chord", "stable-generation", "native-fixture-pixel-latency", "secure-refusal", "guest-pasteboard-unchanged",
      "resize-stale-input", "sibling-joins-composition", "sibling-leaves-composition", "contained-child-joins-composition", "contained-child-leaves-composition", "reset-preserves-agent-observation", "lost-keyup-cleanup", "hide-cleanup", "Stop-without-session", "local-cover-invariants", "disconnect-cleanup"]
    for name in planned { cases[name] = "not-run" }
    let pasteboard = NSPasteboard.general
    let sentinel = "owner-input-guest-sentinel-" + UUID().uuidString
    pasteboard.clearContents()
    try require(pasteboard.setString(sentinel, forType: .string), "Guest pasteboard sentinel setup failed")
    let pasteboardRevision = pasteboard.changeCount
    defer { pasteboard.clearContents() }
    func persistCases() {
      try? JSONSerialization.data(withJSONObject: ["boundary": "native helper core wire; no Host/Runner/viewer UI",
        "engine": fixtureEngine, "cases": cases], options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("owner-input-cases.json"), options: .atomic)
    }
    func start(_ name: String) { active = name; cases[name] = "running"; persistCases() }
    func passed() { if let active { cases[active] = "passed" }; active = nil; persistCases() }
    defer {
      if let active { cases[active] = "failed" }
      persistCases()
    }
    start("negotiation")
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    let session = "cus_11111111-1111-4111-8111-111111111111"
    let sessionApp: [String: Any] = ["identity": identity, "access": "read-write"]
    let viewA = "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let viewB = "cvw_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    let streamA = "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let streamB = "dsp_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    let agent = try WireJourney(out: out.appendingPathComponent("agent"), helper: helper)
    let other = try WireJourney(out: out.appendingPathComponent("other-viewer"), helper: helper)
    let mediaA = try WireJourney(out: out.appendingPathComponent("media-A"), helper: helper)
    let mediaB = try WireJourney(out: out.appendingPathComponent("media-B"), helper: helper)
    defer { agent.close(); other.close(); mediaA.close(); mediaB.close() }
    for wire in [self, other, agent, mediaA, mediaB] {
      try await wire.hello(ownerInput: true)
    }
    _ = try await agent.request("session.open", ["sessionId": session, "threadTitle": "Owner input native journey"])
    _ = try await agent.request("session.windows", ["sessionId": session, "app": sessionApp])
    let bound = try await agent.request("session.bind", ["sessionId": session, "app": sessionApp, "window": a])
    let ref = try ((bound["window"] as? [String: Any])?["ref"] as? String).unwrap("agent window ref")
    _ = try await agent.request("session.observe", ["sessionId": session, "app": sessionApp, "window": ref, "includeScreenshot": false])
    let helperApp = await helper.registry.sessions[session]?.app(app.bundleId)
    let mutations = try (helperApp?.mutations).unwrap("actual helper app mutation lane")
    passed()
    start("helper-baseline-negotiation")
    do {
      let baseline = try WireJourney(out: out.appendingPathComponent("baseline-helper-peer"), helper: helper)
      defer { baseline.close() }
      try await baseline.hello()
      let view = "cvw_33333333-3333-4333-8333-333333333333"
      let source: [String: Any] = ["kind": "owner-view", "viewId": view, "generation": 1]
      _ = try await baseline.request("view.open", ["viewId": view, "generation": 1,
        "leaseDurationMs": 300_000, "target": ["kind": "app", "app": identity, "window": a]])
      var targets: [[String: Any]] = []
      for params: [String: Any] in [["source": source], ["source": source, "ownerInputVersion": 1]] {
        let resolved = try await baseline.request("display.resolve", params)
        let target = try (resolved["target"] as? [String: Any]).unwrap("baseline display target")
        try require(target["editingVersion"] == nil, "A baseline helper peer received editing without hello negotiation")
        targets.append(target)
      }
      let refused = try await baseline.request("display.input", ["streamId": streamA, "source": source,
        "geometry": 1, "sequence": 0, "events": [["kind": "copy"]]])
      try require(refused["outcome"] as? String == "refused" && refused["reason"] as? String == "unavailable",
        "A baseline helper peer admitted owner input")
      _ = try await baseline.request("view.close", ["viewId": view, "generation": 1, "leaseDurationMs": 300_000])
      try JSONSerialization.data(withJSONObject: ["passed": true,
        "boundary": "actual current helper with baseline Host-style hello and resolve", "targets": targets],
        options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("owner-helper-compatibility.json"))
    }
    passed()
    try await Contracts.command(out, "owner-note")
    let person = PersonCover()
    defer { person.close() }
    try await Task.sleep(nanoseconds: 200_000_000)
    let originalFront = PrivateAPI.focusPID(front: true)
    let originalPointer = CGEvent(source: nil)?.location
    person.beginEvidence()
    let localKeys = try OwnerPersonStream(out: out)
    var localEvidenceCompleted = false
    defer {
      localKeys.cancel()
      if !localEvidenceCompleted, let sent = try? localKeys.recorded() {
        try? person.finishEvidence(sent: sent, out: out, front: originalFront, pointer: originalPointer, complete: false)
      }
    }
    func source(_ view: String) -> [String: Any] { ["kind": "owner-view", "viewId": view, "generation": 1] }
    start("capture-ready")
    for (wire, view, window, stream, media) in [(self, viewA, a, streamA, mediaA), (other, viewB, b, streamB, mediaB)] {
      _ = try await wire.request("view.open", ["viewId": view, "generation": 1, "leaseDurationMs": 300_000,
        "target": ["kind": "app", "app": identity, "window": window]])
      let resolved = try await wire.request("display.resolve", ["source": source(view), "ownerInputVersion": 2])
      let target = try (resolved["target"] as? [String: Any]).unwrap("video target")
      try require(target["editingVersion"] as? Int == 1, "Video resolution did not confirm editing")
      let started = try await wire.request("display.start", ["streamId": stream, "target": target,
        "sources": [source(view)], "maxLongSide": 1280, "maxFps": 30])
      _ = try await media.request("display.attach", ["token": started["attachmentToken"]!])
    }
    let (firstGeometry, initial) = try await mediaA.keyframe(streamA)
    var geometry = firstGeometry
    let (secondGeometry, _) = try await mediaB.keyframe(streamB)
    let image = try await VideoEvidence.decode(initial)
    try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
      .unwrap("owner baseline PNG").write(to: out.appendingPathComponent("owner-baseline.png"))
    _ = try await request("permissions.get", [:])
    let initialEvents = Set(try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("wire-event-") })
    func reset(_ wire: WireJourney, _ stream: String, _ view: String) async throws {
      _ = try await wire.request("display.input-reset", ["streamId": stream, "source": source(view)])
    }
    var inputSequence = 0
    var inputMark = 0
    var receipts: [[String: Any]] = []
    func input(_ events: [[String: Any]], generation: Int? = nil) async throws -> [String: Any] {
      defer { inputSequence += 1 }
      let answer = try await request("display.input", ["streamId": streamA, "source": source(viewA),
        "geometry": generation ?? geometry, "sequence": inputSequence, "events": events])
      inputMark = editingMark
      receipts.append(answer)
      return answer
    }
    passed()
    start("person-waits-for-agent-mutation")
    let dispatchLog = out.appendingPathComponent("dispatch.jsonl")
    func dispatchedKeys() throws -> Int {
      try String(contentsOf: dispatchLog, encoding: .utf8).split(separator: "\n").filter {
        let row = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        return row?["type"] as? Int == Int(NSEvent.EventType.keyDown.rawValue)
      }.count
    }
    func modifierReleases() throws -> Int {
      try String(contentsOf: dispatchLog, encoding: .utf8).split(separator: "\n").filter {
        guard let row = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] else { return false }
        if row["type"] as? Int == Int(NSEvent.EventType.flagsChanged.rawValue), row["code"] as? Int == 56,
          let flags = row["flags"] as? UInt64 {
          return flags & UInt64(NSEvent.ModifierFlags.shift.rawValue) == 0
        }
        return row["type"] as? Int == Int(NSEvent.EventType.keyUp.rawValue)
          && row["code"] as? String == "ShiftLeft" && row["shift"] as? Bool == false
      }.count
    }
    func waitForModifierRelease(after count: Int, seconds: TimeInterval) async throws {
      let end = Date().addingTimeInterval(seconds)
      while try modifierReleases() == count, Date() < end {
        try await Task.sleep(nanoseconds: 20_000_000)
      }
      try require(try modifierReleases() == count + 1, "Held Shift did not receive exactly one native cleanup release")
    }
    let shiftDown: [[String: Any]] = [["kind": "key", "action": "down", "code": "ShiftLeft", "key": "Shift", "modifiers": ["shift"]]]
    let beforeAgent = try dispatchedKeys()
    let agentTask = Task { @MainActor in
      try await agent.request("session.act", ["sessionId": session, "app": sessionApp, "window": ref,
        "actions": [["type": "type", "text": String(repeating: "z\n", count: 128)],
          ["type": "key", "keys": "x"]]])
    }
    let startedBy = Date().addingTimeInterval(3)
    while try dispatchedKeys() == beforeAgent, Date() < startedBy {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    do {
      try require(try dispatchedKeys() > beforeAgent, "Agent mutation never reached the native fixture")
      let personBatch = try await input([["kind": "copy"]])
      let result = try await agentTask.value
      try require(personBatch["outcome"] as? String == "dispatched"
        && result["error"] is NSNull && (result["performed"] as? [String])?.count == 2,
        "Shared input interrupted the agent or lost the waiting person batch")
    } catch {
      helper.stopFromOverlay()
      _ = try? await agentTask.value
      throw error
    }
    try await Contracts.command(out, "owner-clear")
    passed()
    start("two-idle-attachments-share-app")
    // Window B has no text field to copy from. A pointer move exercises its
    // input admission without depending on Window A's focused editor.
    let second = try await other.request("display.input", ["streamId": streamB, "source": source(viewB),
      "geometry": secondGeometry, "sequence": 0,
      "events": [["kind": "mouse", "phase": "move", "button": "none", "modifiers": [], "x": 0.5, "y": 0.5]]])
    try require(second["outcome"] as? String == "dispatched", "Idle attachment excluded another viewer")
    passed()
    start("agent-refused-held-button")
    let heldContact = try await input([["kind": "mouse", "phase": "down", "button": "left",
      "clickCount": 1, "modifiers": [], "x": 0.5, "y": 0.5]])
    try require(heldContact["outcome"] as? String == "dispatched", "Person button did not go down")
    let heldResult = try await agent.request("session.act", ["sessionId": session, "app": sessionApp, "window": ref,
      "actions": [["type": "key", "keys": "x"]]])
    let heldError = heldResult["error"] as? [String: Any]
    try require(heldError?["code"] as? String == "failed"
      && heldError?["message"] as? String == "A person is pressing in this app; try again.",
      "Agent did not refuse the actual held contact")
    passed()
    start("another-app-agent-unaffected")
    do {
      let path = try ProcessInfo.processInfo.environment["OPENSTEER_MAC_OWNER_OTHER_APP"].unwrap("independent app fixture")
      let config = NSWorkspace.OpenConfiguration()
      config.activates = false
      let running = try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: config)
      defer { running.terminate() }
      let otherOut = out.appendingPathComponent("other-app")
      let ready = Date().addingTimeInterval(10)
      while !FileManager.default.fileExists(atPath: otherOut.appendingPathComponent("windows.json").path), Date() < ready {
        try await Task.sleep(nanoseconds: 20_000_000)
      }
      let record = try AppResolver.record(forBundleAtPath: path).unwrap("independent app identity")
      let otherIdentity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(record.identity))
      let otherSession = "cus_22222222-2222-4222-8222-222222222222"
      let otherApp: [String: Any] = ["identity": otherIdentity, "access": "read-write"]
      let independent = try WireJourney(out: out.appendingPathComponent("independent-agent"), helper: helper)
      defer { independent.close() }
      try await independent.hello()
      _ = try await independent.request("session.open", ["sessionId": otherSession, "threadTitle": "Independent app during owner control"])
      let listed = try await independent.request("session.windows", ["sessionId": otherSession, "app": otherApp])
      let window = try ((listed["windows"] as? [[String: Any]])?.first(where: { $0["title"] as? String == "A" })).unwrap("independent A")
      let bound = try await independent.request("session.bind", ["sessionId": otherSession, "app": otherApp, "window": window["id"]!])
      let independentRef = try ((bound["window"] as? [String: Any])?["ref"] as? String).unwrap("independent ref")
      _ = try await independent.request("session.observe", ["sessionId": otherSession, "app": otherApp,
        "window": independentRef, "includeScreenshot": false])
      let acted = try await independent.request("session.act", ["sessionId": otherSession, "app": otherApp,
        "window": independentRef, "actions": [["type": "key", "keys": "x"]]])
      let delivered = Date().addingTimeInterval(2)
      func independentKeys() throws -> Int {
        try String(contentsOf: otherOut.appendingPathComponent("dispatch.jsonl"), encoding: .utf8)
          .split(separator: "\n").filter { line in
            let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            return row?["type"] as? Int == Int(NSEvent.EventType.keyDown.rawValue)
          }.count
      }
      while try independentKeys() == 0, Date() < delivered { try await Task.sleep(nanoseconds: 10_000_000) }
      try require(acted["error"] is NSNull && (acted["performed"] as? [String])?.count == 1
        && (try independentKeys()) == 1, "One app's lease blocked another app's native agent key")
      _ = try await independent.request("session.close", ["sessionId": otherSession])
    }
    passed()
    let beforeResetUps = try String(contentsOf: dispatchLog, encoding: .utf8).split(separator: "\n").filter {
      let row = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
      return row?["type"] as? Int == Int(NSEvent.EventType.leftMouseUp.rawValue)
    }.count
    try await reset(self, streamA, viewA)
    let releaseBy = Date().addingTimeInterval(2)
    func mouseUps() throws -> Int {
      try String(contentsOf: dispatchLog, encoding: .utf8).split(separator: "\n").filter {
        let row = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        return row?["type"] as? Int == Int(NSEvent.EventType.leftMouseUp.rawValue)
      }.count
    }
    while try mouseUps() == beforeResetUps, Date() < releaseBy { try await Task.sleep(nanoseconds: 10_000_000) }
    try require(try mouseUps() == beforeResetUps + 1, "Reset did not release exactly one held person button")
    // A snapshot the helper published after the latest input's receipt: later
    // than the input, not proof the app has finished applying it.
    func context(sensitive: Bool? = nil, excluding: String? = nil) async throws -> String {
      let context = try await editingContext(streamA, after: inputMark) { context in
        guard let id = context["contextId"] as? String, let field = context["field"] as? [String: Any]
        else { return false }
        return id != excluding && (sensitive == nil || field["sensitive"] as? Bool == sensitive)
      }
      return try (context["contextId"] as? String).unwrap("editing context id")
    }
    func note() async throws -> String {
      try await Contracts.command(out, "owner-state")
      let state = try JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("owner-state.json"))) as! [String: Any]
      return try (state["text"] as? String).unwrap("note text")
    }
    // Reset releases the input lease. Focus the editor after the contact
    // test, then admit a new action before expecting its editing context.
    try await Contracts.command(out, "owner-resume")
    let resumedInput = try await input([["kind": "copy"]])
    try require(resumedInput["outcome"] as? String == "dispatched", "New input did not reacquire the reset viewer")
    _ = try await context()
    start("native-text-key")
    let key = try await input([["kind": "key", "action": "down", "code": "KeyQ", "key": "q", "modifiers": [], "text": "q"],
      ["kind": "key", "action": "up", "code": "KeyQ", "key": "q", "modifiers": []]])
    try require(key["outcome"] as? String == "dispatched", "Unicode-carrying key was refused")
    try require(try await note() == "q", "AppKit key did not insert exactly once")
    passed()
    start("IME-commit")
    let ime = try await input([["kind": "edit", "edit": ["contextId": try await context(), "text": "漢字!", "before": "", "after": ""]]])
    try require(ime["outcome"] as? String == "dispatched", "IME commit was refused")
    try require(try await note() == "q漢字!", "IME commit did not insert once")
    passed()
    start("external-caret-stale")
    // Sent without waiting for the move's publication: the edit itself must
    // notice that the caret it names moved in the same field.
    let beforeMiddle = try await context()
    try await Contracts.command(out, "owner-middle")
    let moved = try await input([["kind": "edit", "edit": ["contextId": beforeMiddle, "text": "BAD", "before": "", "after": ""]]])
    let afterMoved = try await note()
    try require(moved["outcome"] as? String == "stale" && afterMoved == "q漢字!",
      "An external caret move admitted an old context's insertion")
    passed()
    start("verified-replacement")
    let replace = try await input([["kind": "edit", "edit": ["contextId": try await context(excluding: beforeMiddle), "text": "é", "before": "漢", "after": "字"]]])
    try require(replace["outcome"] as? String == "dispatched", "Verified replacement was refused")
    try require(try await note() == "qé!", "Verified middle replacement changed the prefix or suffix")
    passed()
    start("stale-replacement")
    let oldContext = try await context()
    let stale = try await input([["kind": "edit", "edit": ["contextId": oldContext, "text": "BAD", "before": "wrong", "after": ""]]])
    let afterStale = try await note()
    try require(stale["outcome"] as? String == "stale" && afterStale == "qé!", "Stale replacement changed the field")
    try require(try await context() != oldContext, "Stale replacement did not rotate context")
    passed()
    start("rich-paste-refusal")
    let rich = try await input([["kind": "paste", "items": [["type": "image/png", "size": 64]]]])
    try require(rich["outcome"] as? String == "refused" && rich["reason"] as? String == "unsupported", "Rich paste was not refused before upload")
    passed()
    start("multiline-paste")
    try await Contracts.command(out, "owner-select-all")
    let literal = "line 1\n\tline 2"
    let pasted = try await input([["kind": "paste", "text": literal]])
    let afterPaste = try await note()
    try require(pasted["outcome"] as? String == "dispatched" && afterPaste == literal, "Literal multiline/tab paste changed content")
    passed()
    start("AX-copy")
    try await Contracts.command(out, "owner-select-all")
    let copied = try await input([["kind": "copy"]])
    try require(copied["outcome"] as? String == "dispatched", "AX selection copy was refused")
    _ = try await request("permissions.get", [:])
    let wireFiles = try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("wire-event-") }
    let copiedTexts = try wireFiles.compactMap { url -> String? in
      let event = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
      let message = (event?["params"] as? [String: Any])?["message"] as? [String: Any]
      return message?["type"] as? String == "display.clipboard" ? message?["text"] as? String : nil
    }
    try require(copiedTexts.contains(literal), "Clipboard result did not contain the explicit AX selection")
    passed()
    start("save-chord")
    let save = try await input([["kind": "key", "action": "down", "code": "KeyS", "key": "s", "modifiers": ["primary"]],
      ["kind": "key", "action": "up", "code": "KeyS", "key": "s", "modifiers": []]])
    try require(save["outcome"] as? String == "dispatched", "Save chord was refused")
    _ = try await note()
    let saveState = try JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("owner-state.json"))) as! [String: Any]
    try require(saveState["saves"] as? Int == 1, "Save chord did not save exactly once")
    try require(try String(contentsOf: out.appendingPathComponent("owner-saved.txt"), encoding: .utf8) == literal, "Save changed content")
    passed()
    start("undo-chord")
    let selected = try await input([["kind": "command", "command": "selectAll"]])
    try require(selected["outcome"] as? String == "dispatched", "Select-all chord was refused")
    let undoValue = try await input([["kind": "paste", "text": "undo fixture"]])
    let afterUndoValue = try await note()
    try require(undoValue["outcome"] as? String == "dispatched" && afterUndoValue == "undo fixture", "Undo setup changed content")
    let undone = try await input([["kind": "command", "command": "undo"]])
    let afterUndo = try await note()
    try require(undone["outcome"] as? String == "dispatched" && afterUndo == literal, "Undo did not restore the last insertion once")
    passed()
    start("stable-generation")
    try await Contracts.command(out, "move", "B")
    try await Contracts.command(out, "resize", "B")
    _ = try await request("display.refresh", ["streamId": streamA])
    let (stableGeometry, _) = try await mediaA.keyframe(streamA)
    try require(stableGeometry == firstGeometry, "Stable shared input changed capture generation")
    _ = try await request("permissions.get", [:])
    let stableStates = try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("wire-event-") && !initialEvents.contains($0) }
      .compactMap { url -> [String: Any]? in
        let event = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        guard event?["event"] as? String == "display.state", let state = event?["params"] as? [String: Any],
          state["streamId"] as? String == streamA else { return nil }
        return state
      }
    try require(stableStates.allSatisfy { $0["generation"] as? Int == firstGeometry && $0["state"] as? String == "live" },
      "Stable shared input retired a current capture incarnation")
    passed()
    start("native-fixture-pixel-latency")
    let latency = try await OwnerLatencyEvidence.run(wire: self, media: mediaA, stream: streamA,
      generation: geometry, window: a, person: person, out: out, send: { try await input($0) })
    _ = try await input([["kind": "command", "command": "selectAll"]])
    _ = try await input([["kind": "paste", "text": literal]])
    try require(try await note() == literal, "Latency cleanup changed the fixture text")
    passed()
    start("secure-refusal")
    try await Contracts.command(out, "owner-secure")
    _ = try await context(sensitive: true)
    let secureCopy = try await input([["kind": "copy"]])
    try require(secureCopy["outcome"] as? String == "refused" && secureCopy["reason"] as? String == "sensitive", "Secure copy was not refused")
    let securePaste = try await input([["kind": "paste", "text": "must not insert"]])
    try require(securePaste["outcome"] as? String == "refused" && securePaste["reason"] as? String == "sensitive", "Secure paste was not refused")
    passed()
    start("resize-stale-input")
    try await Contracts.command(out, "owner-resume")
    let oldGeometry = geometry
    try await Contracts.command(out, "resize")
    let retired = try await input([["kind": "paste", "text": "retired sample"]], generation: oldGeometry)
    let afterRetired = try await note()
    try require(retired["outcome"] as? String == "stale" && afterRetired == literal, "Retired capture input changed content")
    for _ in 0..<12 {
      let (nextGeometry, _) = try await mediaA.keyframe(streamA)
      if nextGeometry > oldGeometry { geometry = nextGeometry; break }
    }
    try require(geometry > oldGeometry, "Resize reused its retired capture generation")
    passed()
    for (command, name) in [("child", "sibling-joins-composition"),
      ("owner-close-child", "sibling-leaves-composition"),
      ("small-child", "contained-child-joins-composition"),
      ("owner-close-child", "contained-child-leaves-composition")] {
      start(name)
      let retiredGeometry = geometry
      try await Contracts.command(out, command)
      try require(PrivateAPI.focusPID(front: true) == originalFront && CGEvent(source: nil)?.location == originalPointer,
        "Composition fixture changed the person's front app or pointer")
      let contained = name.hasPrefix("contained-child-")
      if contained {
        _ = try await request("display.refresh", ["streamId": streamA])
        let (nextGeometry, _) = try await mediaA.keyframe(streamA)
        try require(nextGeometry == retiredGeometry, "Contained content retired an unchanged input mapping")
        let current = try await input([["kind": "command", "command": "moveBackward"]], generation: retiredGeometry)
        let afterCurrent = try await note()
        try require(current["outcome"] as? String == "dispatched" && afterCurrent == literal,
          "Contained content made current-picture input stale or changed text")
      } else {
        let queued = try await input([["kind": "paste", "text": "queued old member sample"]], generation: retiredGeometry)
        let afterQueued = try await note()
        try require(queued["outcome"] as? String == "stale" && afterQueued == literal,
          "Changed sibling composition admitted input from a queued old picture")
        for _ in 0..<12 {
          let (nextGeometry, _) = try await mediaA.keyframe(streamA)
          if nextGeometry > retiredGeometry { geometry = nextGeometry; break }
        }
        try require(geometry > retiredGeometry, "A changed sibling composition reused its generation")
      }
      if name == "contained-child-joins-composition" {
        _ = try await request("display.refresh", ["streamId": streamA])
        let (picturedGeneration, bytes) = try await mediaA.keyframe(streamA)
        try require(picturedGeneration == geometry, "Small content did not keep its new composition")
        let picture = try await VideoEvidence.decode(bytes)
        let bitmap = NSBitmapImageRep(cgImage: picture)
        let root = try KeyWindow.currentFrame(a).unwrap("small content root frame")
        let color = try (bitmap.colorAt(x: Int(113 / root.width * CGFloat(picture.width)),
          y: Int(60 / root.height * CGFloat(picture.height)))?.usingColorSpace(.deviceRGB))
          .unwrap("small content decoded color")
        try bitmap.representation(using: .png, properties: [:]).unwrap("small content PNG")
          .write(to: out.appendingPathComponent("owner-small-content.png"))
        try require(color.greenComponent > color.redComponent + 0.4,
          "A real 66x20 child was excluded from the decoded composition")
      }
      passed()
    }
    _ = try await request("display.refresh", ["streamId": streamA])
    let (_, changed) = try await mediaA.keyframe(streamA)
    let changedImage = try await VideoEvidence.decode(changed)
    try NSBitmapImageRep(cgImage: changedImage).representation(using: .png, properties: [:])
      .unwrap("owner changed PNG").write(to: out.appendingPathComponent("owner-edited.png"))
    start("reset-preserves-agent-observation")
    try await Contracts.command(out, "owner-end")
    try await reset(self, streamA, viewA)
    let resumed = try await agent.request("session.act", ["sessionId": session, "app": sessionApp, "window": ref,
      "actions": [["type": "key", "keys": "y"]]])
    try require(resumed["error"] is NSNull && (resumed["performed"] as? [String])?.count == 1,
      "Person input invalidated the agent's observation")
    try await Contracts.command(out, "owner-select-all")
    _ = try await input([["kind": "paste", "text": literal]])
    passed()
    start("lost-keyup-cleanup")
    let beforeLost = try modifierReleases()
    let lostDown = try await input(shiftDown)
    try require(lostDown["outcome"] as? String == "dispatched", "Lost-keyup setup was refused")
    try await waitForModifierRelease(after: beforeLost, seconds: 6)
    let expired = try await input([["kind": "copy"]])
    try require(expired["outcome"] as? String == "dispatched",
      "Lost keyup prevented the next shared batch")
    try await reset(self, streamA, viewA)
    passed()
    start("hide-cleanup")
    let beforeHide = try modifierReleases()
    let hideDown = try await input(shiftDown)
    try require(hideDown["outcome"] as? String == "dispatched", "Hidden-demand Shift was refused")
    _ = try await request("display.demand", ["streamId": streamA, "revision": 1, "sources": [],
      "warm": ["durationMs": 30_000, "sources": [source(viewA)]]])
    try await waitForModifierRelease(after: beforeHide, seconds: 2)
    let hiddenInput = try await input([["kind": "copy"]])
    try require(hiddenInput["outcome"] as? String == "refused" && hiddenInput["reason"] as? String == "unavailable",
      "Hidden demand left owner input admitted")
    try await reset(self, streamA, viewA)
    _ = try await request("display.demand", ["streamId": streamA, "revision": 2, "sources": [source(viewA)]])
    let hiddenGeneration = geometry
    for _ in 0..<12 {
      let (next, _) = try await mediaA.keyframe(streamA)
      if next > hiddenGeneration { geometry = next; break }
    }
    try require(geometry > hiddenGeneration, "Hidden demand did not fence its old picture generation")
    passed()
    start("disconnect-cleanup")
    let beforeDisconnect = try modifierReleases()
    let disconnectDown = try await input(shiftDown)
    try require(disconnectDown["outcome"] as? String == "dispatched", "Disconnect Shift was refused")
    try require(Darwin.shutdown(client, SHUT_RDWR) == 0, "Failed to disconnect the input socket")
    try await waitForModifierRelease(after: beforeDisconnect, seconds: 2)
    try await mutations.beginAgent()
    mutations.endAgent()
    passed()
    // Use the independent viewer for Stop after the first viewer disconnects.
    start("Stop-without-session")
    _ = try await agent.request("session.close", ["sessionId": session])
    try require(helper.registry.sessions.isEmpty, "Owner Stop fixture still had an agent session")
    let beforeStop = try modifierReleases()
    // Window B moved and resized since its first picture; aim at its current one.
    _ = try? await other.request("display.refresh", ["streamId": streamB])
    let stateB = try other.displayStates[streamB].unwrap("window B display state")
    try require(stateB["state"] as? String == "live", "Window B's picture is not live: \(stateB)")
    let currentB = try (stateB["generation"] as? Int).unwrap("window B generation")
    let held = try await other.request("display.input", ["streamId": streamB, "source": source(viewB),
      "geometry": currentB, "sequence": 1, "events": shiftDown])
    try require(held["outcome"] as? String == "dispatched", "Held-key fixture failed")
    helper.stopFromOverlay()
    try await waitForModifierRelease(after: beforeStop, seconds: 2)
    let stopped = try await other.request("display.input", ["streamId": streamB, "source": source(viewB),
      "geometry": currentB, "sequence": 2, "events": [["kind": "copy"]]])
    try require(stopped["outcome"] as? String == "refused" && stopped["reason"] as? String == "unavailable",
      "Stop without a session left input admitted")
    passed()
    start("local-cover-invariants")
    try require(PrivateAPI.focusPID(front: true) == originalFront && CGEvent(source: nil)?.location == originalPointer,
      "Owner input changed the person's front app or pointer")
    let sent = try await localKeys.stop()
    try await Task.sleep(nanoseconds: 100_000_000)
    try person.finishEvidence(sent: sent, out: out, front: originalFront, pointer: originalPointer)
    localEvidenceCompleted = true
    passed()
    start("guest-pasteboard-unchanged")
    try require(pasteboard.changeCount == pasteboardRevision
      && pasteboard.string(forType: .string) == sentinel, "Remote or agent input changed the guest's general pasteboard")
    try JSONSerialization.data(withJSONObject: ["passed": true, "beforeChangeCount": pasteboardRevision,
      "afterChangeCount": pasteboard.changeCount, "boundary": "VM general pasteboard; host clipboard sharing disabled"])
      .write(to: out.appendingPathComponent("owner-pasteboard.json"))
    passed()
    try JSONSerialization.data(withJSONObject: ["passed": true, "boundary": "real helper core wire, AX and H.264; no Host/Runner",
      "engine": fixtureEngine, "receipts": receipts, "geometry": geometry, "nativeLatencyPercentiles": latency,
      "unqualified": ["Host/Runner/shipping viewer path and latency", "native IME source traces", "native mixed-version binaries"]], options: [.prettyPrinted, .sortedKeys])
      .write(to: out.appendingPathComponent("owner-input.json"))
  }
}

extension WireJourney {
  func ownerViewOnly(app: AppIdentity, window: CGWindowID) async throws {
    let names = ["baseline-hello-does-not-negotiate-input", "baseline-and-probed-resolve",
      "passive-media-decodes", "forged-input-zero-delivery", "passive-media-after-refusal"]
    var cases = Dictionary(uniqueKeysWithValues: names.map { ($0, "not-run") })
    var active: String?
    func start(_ name: String) { active = name; cases[name] = "running" }
    func passed() { if let active { cases[active] = "passed" }; active = nil }
    defer {
      if let active { cases[active] = "failed" }
      try? JSONSerialization.data(withJSONObject: ["boundary": "actual native helper core and decoded H.264",
        "cases": cases], options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("owner-view-only-cases.json"))
    }
    start("baseline-hello-does-not-negotiate-input")
    let hello = try await request("hello", ["protocolVersion": 10, "ownerViewVersion": 3])
    try require(hello["ownerViewVersion"] as? Int == 3 && hello["ownerInputVersion"] == nil,
      "A baseline helper peer negotiated owner input")
    passed()
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    let view = "cvw_44444444-4444-4444-8444-444444444444"
    let stream = "dsp_44444444-4444-4444-8444-444444444444"
    let source: [String: Any] = ["kind": "owner-view", "viewId": view, "generation": 1]
    _ = try await request("view.open", ["viewId": view, "generation": 1,
      "leaseDurationMs": 300_000, "target": ["kind": "app", "app": identity, "window": window]])
    start("baseline-and-probed-resolve")
    var targets: [[String: Any]] = []
    for params: [String: Any] in [["source": source], ["source": source, "ownerInputVersion": 1]] {
      let resolved = try await request("display.resolve", params)
      let target = try (resolved["target"] as? [String: Any]).unwrap("passive video target")
      try require(target["editingVersion"] == nil, "A passive view acquired an editing target")
      targets.append(target)
    }
    try JSONSerialization.data(withJSONObject: ["hello": hello, "targets": targets], options: [.prettyPrinted, .sortedKeys])
      .write(to: out.appendingPathComponent("owner-view-only-negotiation.json"))
    passed()
    start("passive-media-decodes")
    let media = try WireJourney(out: out.appendingPathComponent("passive-media"), helper: helper)
    defer { media.close() }
    try await media.hello()
    let started = try await request("display.start", ["streamId": stream, "target": targets[1],
      "sources": [source], "maxLongSide": 1280, "maxFps": 30])
    _ = try await media.request("display.attach", ["token": started["attachmentToken"]!])
    let (geometry, frame) = try await media.keyframe(stream)
    let image = try await VideoEvidence.decode(frame)
    try require(image.width > 0 && image.height > 0, "Passive media decoded no pixels")
    try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
      .unwrap("passive decoded PNG").write(to: out.appendingPathComponent("owner-view-only.png"))
    passed()
    func keys() throws -> Int {
      let url = out.appendingPathComponent("dispatch.jsonl")
      guard FileManager.default.fileExists(atPath: url.path) else { return 0 }
      return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").filter {
        let row = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        return row?["type"] as? Int == Int(NSEvent.EventType.keyDown.rawValue)
      }.count
    }
    let before = try keys()
    start("forged-input-zero-delivery")
    let result = try await request("display.input", ["streamId": stream, "source": source,
      "geometry": geometry, "sequence": 1,
      "events": [["kind": "key", "action": "down", "code": "KeyX", "key": "x", "text": "x", "modifiers": []]]])
    try require(result["outcome"] as? String == "refused" && result["reason"] as? String == "unavailable",
      "Wrong view-only input refusal")
    try await Task.sleep(nanoseconds: 200_000_000)
    let after = try keys()
    try require(before == after, "View-only control or input delivered a native key")
    try JSONSerialization.data(withJSONObject: ["before": before, "after": after, "result": result],
      options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("owner-view-only-refusal.json"))
    passed()
    start("passive-media-after-refusal")
    try await Contracts.command(out, "resize")
    _ = try await request("display.refresh", ["streamId": stream])
    var laterImage: CGImage?
    for _ in 0..<12 {
      let (nextGeometry, laterFrame) = try await media.keyframe(stream)
      if nextGeometry > geometry {
        laterImage = try await VideoEvidence.decode(laterFrame)
        break
      }
    }
    let changedImage = try laterImage.unwrap("passive resized frame after refusals")
    try require(changedImage.width != image.width || changedImage.height != image.height,
      "View-only refusals interrupted passive resize media")
    try NSBitmapImageRep(cgImage: changedImage).representation(using: .png, properties: [:])
      .unwrap("passive resized PNG").write(to: out.appendingPathComponent("owner-view-only-resized.png"))
    passed()
    _ = try await request("display.stop", ["streamId": stream])
    _ = try await request("view.close", ["viewId": view, "generation": 1, "leaseDurationMs": 300_000])
  }
}
