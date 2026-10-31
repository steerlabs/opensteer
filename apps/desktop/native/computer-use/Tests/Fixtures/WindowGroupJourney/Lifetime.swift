import AppKit
import ApplicationServices

@WorkActor extension Contracts {
  static func ownerWithoutDestroy(out: URL, app: AppSessionState, monitor: WindowMonitor)
    async throws
  {
    try await command(out, "lifetime-window")
    // A new window reaches the app's Accessibility window list asynchronously;
    // what each inventory listed is kept so a miss says which list lagged.
    var listed: [[String]] = []
    var found: WindowInfo?
    let listDeadline = Date().addingTimeInterval(2)
    repeat {
      let inventory = try SessionWindows.inventory(app: app, monitor: monitor)
      listed.append(inventory.map { "\($0.id):\($0.title)" })
      found = inventory.first(where: { $0.title == "Liveness" })
      if found == nil { try await Task.sleep(nanoseconds: 100_000_000) }
    } while found == nil && Date() < listDeadline
    try JSONSerialization.data(withJSONObject: ["inventories": listed]).write(
      to: out.appendingPathComponent("liveness-inventory.json"))
    let info = try found.unwrap("liveness window")
    let bound = try app.windows[info.ref].unwrap("liveness retained AX")
    let target = CaptureTarget(
      observationId: bound.ref, app: app.identity, process: bound.process, windowID: bound.windowID,
      windowToken: AXWindowToken(element: bound.element))
    // Deliberately do not call watch(): no destroy notification reaches this owner.
    let owner = OwnerViewWindow.Binding(target: target, element: bound.element)
    _ = try owner.group()
    let initialRevision = owner.lifecycleRevision
    let binding = MacVideoBinding(owner)
    let states = Locked<[MacVideoState]>([])
    let producer = MacWindowVideoProducer(
      id: "missed-destroy", binding: binding, operations: SerialTaskChain(), authority: { true },
      onState: { state in states.withLock { $0.append(state) } })
    defer {
      producer.stop()
      try? JSONCoding.encoder.encode(states.current).write(
        to: out.appendingPathComponent("owner-missed-destroy-states.json"))
      try? JSONSerialization.data(withJSONObject: [
        "notificationRevision": owner.lifecycleRevision, "lifetimeClosed": owner.liveness.isClosed,
        "resourcesSettled": producer.resourcesSettled,
      ]).write(to: out.appendingPathComponent("owner-missed-destroy-final.json"))
    }
    await producer.start(maxLongSide: 640, maxFps: 5)
    try require(!producer.ended, "Owner video did not start before the missed destroy")
    try await command(out, "close", "Liveness")
    var status: AXError = .success
    let invalidEnd = Date().addingTimeInterval(3)
    repeat {
      var role: CFTypeRef?
      status = AXUIElementCopyAttributeValue(bound.element, kAXRoleAttribute as CFString, &role)
      if status != .invalidUIElement { try await Task.sleep(nanoseconds: 20_000_000) }
    } while status != .invalidUIElement && Date() < invalidEnd
    try JSONSerialization.data(withJSONObject: [
      "AXError": status.rawValue, "notificationRevision": owner.lifecycleRevision,
    ]).write(to: out.appendingPathComponent("owner-missed-destroy-probe.json"))
    try require(
      status == .invalidUIElement && owner.lifecycleRevision == initialRevision,
      "Missed-destroy fixture did not establish an invalid retained AX identity without notification"
    )
    do {
      _ = try owner.group()
      throw JourneyFailure.failed("Destroyed owner AX remained live")
    } catch let error as HelperError {
      try require(
        error == SessionWindows.closed, "Owner metadata bypassed definitive lifetime loss")
    }
    producer.checkLifecycle()
    let end = Date().addingTimeInterval(10)
    while !producer.ended || !producer.resourcesSettled, Date() < end {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    try require(
      owner.liveness.isClosed && binding.unavailable == "window-closed" && producer.ended
        && producer.resourcesSettled,
      "Missed destroy retained a suppressed owner-video lifetime or capture resources")
    try JSONCoding.encoder.encode(states.current).write(
      to: out.appendingPathComponent("owner-missed-destroy-states.json"))
    try JSONSerialization.data(withJSONObject: [
      "AXError": status.rawValue, "notificationRevision": owner.lifecycleRevision,
      "lifetimeClosed": owner.liveness.isClosed, "resourcesSettled": producer.resourcesSettled,
    ]).write(to: out.appendingPathComponent("owner-missed-destroy.json"))
  }

}
