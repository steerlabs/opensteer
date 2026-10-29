import AppKit
import ApplicationServices

@WorkActor extension Contracts {
  /// The fixture's own change can still be landing when it is observed; as
  /// the contract tells an agent, a stale observation is observed again.
  static func observeAgainIfStale(app: AppSessionState, window: String, monitor: WindowMonitor)
    async throws -> Observation
  {
    for attempt in 1... {
      do {
        return try await AppObserver.observe(app: app, window: window, monitor: monitor)
      } catch let error as HelperError where error.code == .staleObservation && attempt < 4 {
        try await Task.sleep(nanoseconds: 200_000_000)
      }
    }
    preconditionFailure("unreachable")
  }

  static func receiptSwitch(
    out: URL, app: AppSessionState, ref: String, monitor: WindowMonitor
  ) async throws {
    try await command(out, "credentials-switch")
    _ = try await observeAgainIfStale(app: app, window: ref, monitor: monitor)
    let field = try
      (app.latest?.elements.firstIndex(where: {
        $0.attributes.help == "Fixture username"
      })).unwrap("username field")
    var calls = AccessibilityCalls.live
    let live = calls.isSettable
    calls.isSettable = { element, attribute in
      attribute == kAXSelectedTextAttribute ? false : live(element, attribute)
    }
    func completedKeys() throws -> Int {
      try String(contentsOf: out.appendingPathComponent("dispatch.jsonl"), encoding: .utf8)
        .split(separator: "\n").filter { line in
          let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
          return row?["type"] as? Int == Int(NSEvent.EventType.keyUp.rawValue)
        }.count
    }
    let before = try completedKeys()
    let result = try await ActionRunner.run(
      actions: [.type(text: "canary", target: .index(field))],
      app: app, window: ref, snapshot: app.latest?.observationId,
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil, accessibility: calls)
    // Posting is asynchronous. A command timer can snapshot the fields before
    // the final key reaches AppKit, even though the action already has a receipt.
    let deliveredBy = Date().addingTimeInterval(3)
    while try completedKeys() < before + 6, Date() < deliveredBy {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    try require(
      try completedKeys() == before + 6, "Plain-to-secure fixture did not complete six native keys")
    try await command(out, "credentials-state")
    let received =
      try JSONSerialization.jsonObject(
        with: Data(contentsOf: out.appendingPathComponent("credentials-state.json")))
      as! [String: String]
    try JSONSerialization.data(
      withJSONObject: [
        [
          "scene": "plain-to-secure-switch", "performed": result.performed,
          "error": result.error?.message ?? "", "received": received,
        ]
      ], options: [.prettyPrinted]
    ).write(to: out.appendingPathComponent("receipt-receivers.json"))
    try require(
      result.error == nil && result.performed == ["Typed 6 characters"]
        && received["username"] == "c" && received["password"] == "anary",
      "Receipt leaked, fabricated its receiver, or failed to exercise real plain→secure input")
  }
}
