import AppKit
import ApplicationServices

extension WireJourney {
  /// Real protocol-10 batches, not an obsolete wait action. The receiver trace
  /// establishes actual partial delivery and proves the final click never ran.
  func batchCancellation(app: AppIdentity, window: CGWindowID, deadline: Bool) async throws {
    let session =
      deadline
      ? "cus_55555555-5555-4555-8555-555555555555" : "cus_44444444-4444-4444-8444-444444444444"
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    let target: [String: Any] = ["identity": identity, "access": "read-write"]
    try await hello()
    _ = try await request(
      "session.open", ["sessionId": session, "threadTitle": "Batch cancellation"])
    let bound = try await request(
      "session.bind", ["sessionId": session, "app": target, "window": window])
    let ref = try ((bound["window"] as? [String: Any])?["ref"] as? String).unwrap("batch ref")
    let observed = try await request(
      "session.observe",
      ["sessionId": session, "app": target, "window": ref, "includeScreenshot": false])
    let snapshot = try ((observed["observation"] as? [String: Any])?["snapshot"] as? String).unwrap(
      "batch snapshot")
    let events = out.appendingPathComponent("events.jsonl")
    let baseline = try String(contentsOf: events, encoding: .utf8).split(separator: "\n").count
    let action: [[String: Any]] = [
      ["type": "click", "target": ["x": 40, "y": 90]],
      ["type": "type", "text": String(repeating: "z", count: 8_000)],
      ["type": "click", "target": ["x": 80, "y": 90]],
    ]
    let task = Task { @MainActor in
      try await self.request(
        "session.act",
        [
          "sessionId": session, "app": target, "window": ref, "snapshot": snapshot,
          "actions": action,
        ], timeoutMs: deadline ? 2_000 : 30_000)
    }
    if !deadline {
      let end = Date().addingTimeInterval(3)
      var started = false
      while !started, Date() < end {
        let rows = try String(contentsOf: events, encoding: .utf8).split(separator: "\n").dropFirst(
          baseline)
        started = rows.contains { $0.contains("\"characters\":\"z\"") }
        if !started { try await Task.sleep(nanoseconds: 10_000_000) }
      }
      guard started else {
        helper.stopFromOverlay()
        _ = try? await task.value
        throw JourneyFailure.failed("Batch did not establish partial input")
      }
      helper.stopFromOverlay()
    }
    let result = try await task.value
    let performed = result["performed"] as? [String] ?? []
    let error = result["error"] as? [String: Any]
    let rows = try String(contentsOf: events, encoding: .utf8).split(separator: "\n").dropFirst(
      baseline)
    let clicks = rows.filter {
      let object = try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
      return (object?["type"] as? NSNumber)?.intValue == 1
    }
    let keys = rows.filter { $0.contains("\"characters\":\"z\"") }
    try require(
      performed.count == 1 && error != nil && clicks.count == 1 && !keys.isEmpty
        && keys.count < 8_000, "Running batch lost its completed prefix or sent a subsequent action"
    )
    try JSONSerialization.data(withJSONObject: [
      "result": result, "receiver": rows.map(String.init),
    ]).write(to: out.appendingPathComponent(deadline ? "deadline-prefix.json" : "stop-prefix.json"))
    if deadline { _ = try await request("session.close", ["sessionId": session]) }
  }
}

extension WireJourney {
  func inventoryOnlyCleanup(app: AppIdentity, pid: pid_t) async throws {
    let session = "cus_66666666-6666-4666-8666-666666666666"
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    try await hello()
    _ = try await request("session.open", ["sessionId": session, "threadTitle": "Inventory only"])
    _ = try await request(
      "session.windows",
      ["sessionId": session, "app": ["identity": identity, "access": "read-write"]])
    try require(
      helper.registry.sessions[session]?.processIdentifiers[app.bundleId.lowercased()] == pid
        && helper.isMonitoring(pid), "Inventory did not register observer cleanup ownership")
    helper.stopFromOverlay()
    try require(!helper.isMonitoring(pid), "Inventory-only Stop leaked its observer")
    try Data("Inventory-only observer released\n".utf8).write(
      to: out.appendingPathComponent("inventory-cleanup-passed.txt"))
  }
}
