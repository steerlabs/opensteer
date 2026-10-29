import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import OpensteerAppleData

/// One `session.observe` (§2 "Observation").
@WorkActor
public enum AppObserver {

  /// `check` runs before anything is committed and between the slow steps;
  /// it throws when the session was stopped or closed, or the request ran
  /// out of time. `budget` bounds the launch wait and the tree walk.
  public static func observe(
    app: AppSessionState,
    window: String? = nil,
    monitor: WindowMonitor,
    budget: WorkBudget = .unlimited,
    walkBudget: TimeInterval = ElementTreeWalker.timeBudget,
    includeScreenshot: Bool = true,
    cancellation: SessionCancellation = SessionCancellation(),
    check: @Sendable () throws -> Void = {}
  ) async throws -> Observation {
    try HelperRuntime.requireUnlocked()
    if let ref = window {
      // An existing ref may never launch or discover a replacement process.
      _ = try SessionWindows.resolve(app: app, ref: ref, monitor: monitor)
      _ = try AppProcess.verify(app)
    } else {
      try await SessionWindows.prepare(app: app, monitor: monitor, budget: budget, check: check)
      _ = try SessionWindows.bind(app: app, window: nil, monitor: monitor)
    }
    guard let bound = window.flatMap({ app.windows[$0] }) ?? app.currentWindow else {
      throw SessionWindows.closed
    }
    app.currentWindow = bound
    let processIdentifier = bound.process.processIdentifier
    let applicationElement = AXUIElementCreateApplication(processIdentifier)
    AXUIElementSetMessagingTimeout(applicationElement, axMessagingTimeout)
    let window = bound.element
    if bound.inputSinceObservation {
      await ActionSettle.wait(
        window: window, before: bound.beforeInput, budget: budget,
        cancellation: cancellation)
      try check()
      try budget.check()
    }
    if app.manualAccessibilityPending {
      let populated = try await ManualAccessibility.settleWebContent(
        of: window, budget: budget, check: check)
      app.manualAccessibilityPending = false
      Log.observe.notice("Chromium web accessibility populated: \(populated, privacy: .public).")
      try check()
    }
    let observationRevision = monitor.observationRevision(processIdentifier: processIdentifier)

    let group = try WindowGroup.resolve(
      window: window, process: bound.process,
      lifecycleRevision: observationRevision, previous: bound.group, liveness: bound.liveness,
      check: { try check(); try budget.check() })
    let identity = group.root
    let plan = try await WindowCapture.plan(
      processIdentifier: processIdentifier, keyWindow: identity, group: group)
    try check()
    try budget.check()
    let roots = TreeRoots.collect(
      applicationElement: applicationElement, keyWindow: window, group: group)
    let walk = ElementTreeWalker.walk(
      roots: roots,
      bounds: plan.cropPoints,
      origin: identity.frame.origin,
      budget: max(0, min(walkBudget, budget.remaining())),
      isCancelled: { (try? check()) == nil }
    )
    try check()

    try HelperRuntime.requireUnlocked()
    let capture =
      includeScreenshot
      ? await WindowCapture.take(plan)
      : WindowCapture.Capture(screenshot: nil, coordinates: plan.plannedCoordinates)
    let rendered = TreeFormatter.render(walk, coordinates: capture.coordinates)

    // A close/reopen or window change while this observation was assembled
    // makes the tree and screenshot stale. Validate before mutating either
    // the app snapshot or the shared monitor.
    try check()
    try HelperRuntime.requireUnlocked()
    _ = try SessionWindows.resolve(app: app, ref: bound.ref, monitor: monitor)
    let verifiedGroup = try WindowGroup.resolve(
      window: window, process: bound.process,
      lifecycleRevision: monitor.observationRevision(processIdentifier: processIdentifier),
      previous: group, liveness: bound.liveness,
      check: {
        try check(); try budget.check()
      })
    guard verifiedGroup.signature == group.signature, verifiedGroup.root == group.root else {
      throw HelperError(.staleObservation, "This app changed while it was being observed.")
    }
    if let error = monitor.commitObservation(
      processIdentifier: processIdentifier, windowID: identity.windowID, window: window,
      since: observationRevision
    ) {
      throw error
    }

    let focusChanged = monitor.takeFocusChanged(processIdentifier: processIdentifier)
    let observationId = Observation.newIdentifier()
    app.record(
      LatestObservation(
        observationId: observationId,
        processIdentifier: processIdentifier,
        windowID: identity.windowID,
        windowFrame: identity.frame,
        coordinates: capture.coordinates,
        // Only what the tree shows may be cited: an index the budget cut was
        // never seen.
        elements: Array(walk.elements.prefix(rendered.elementCount)),
        windows: group.members.map(\.window),
        group: group,
        takenAt: Date()
      ))
    bound.group = group
    bound.inputSinceObservation = false
    bound.beforeInput = nil
    return Observation(
      snapshot: observationId,
      app: app.identity,
      window: Observation.WindowSummary(
        ref: bound.ref, id: identity.windowID,
        title: identity.title ?? "",
        frame: Observation.Rect(identity.frame),
        scale: Double(capture.scale)
      ),
      windows: try SessionWindows.inventory(app: app, monitor: monitor, check: { try check(); try budget.check() }),
      blockedBy: group.blockedBy, alone: group.alone,
      tree: rendered.text,
      elementCount: rendered.elementCount,
      truncated: rendered.truncated,
      geometry: capture.coordinates.geometry,
      screenshot: capture.screenshot,
      focusChanged: focusChanged,
      capturedAt: Observation.timestamp()
    )
  }

  /// Chromium and Electron apps expose nothing to Accessibility until they are
  /// asked to, and the ask is per process (§2 "Observation").
  static func applyManualAccessibilityIfNeeded(
    app: AppSessionState,
    applicationElement: AXUIElement
  ) {
    var pid: pid_t = 0
    guard AXUIElementGetPid(applicationElement, &pid) == .success,
      let process = ProcessStamp.of(pid), app.manualAccessibilityProcess != process
    else { return }
    guard ChromiumDetection.isChromiumLike(bundlePath: app.path, bundleId: app.identity.bundleId)
    else { return }
    // Unsupported attributes are independent: Chromium variants need different
    // switches, and a failed write must not suppress the other one.
    for attribute in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
      let status = AXUIElementSetAttributeValue(
        applicationElement, attribute as CFString, kCFBooleanTrue)
      app.accessibilityWriteResults[attribute] = status.rawValue
      Log.observe.notice(
        "Chromium accessibility \(attribute, privacy: .public): \(status.rawValue, privacy: .public)."
      )
    }
    app.manualAccessibilityProcess = process
    app.manualAccessibilityPending = true
  }
}

/// Where the tree walk starts, in the order that matters to the agent: open
/// menus, then what the app shows in front of its key window — sheets,
/// popovers, dialogs, child windows — then the key window, then what shows of
/// its windows behind it.
enum TreeRoots {
  @WorkActor
  static func collect(applicationElement: AXUIElement, keyWindow: AXUIElement, group: WindowGroup)
    -> [WalkRoot]
  {
    let rootIndex = group.members.firstIndex { $0.window.windowID == group.root.windowID } ?? group.members.count
    let allowed = Set(group.members.prefix(rootIndex).map(\.window.windowID) + [group.root.windowID])
    var roots: [WalkRoot] = []
    var seen = Set<AnyHashable>()
    func add(_ element: AXUIElement, occluders: [CGRect] = []) {
      guard seen.insert(AnyHashable(element)).inserted else { return }
      roots.append(WalkRoot(AXElementNode(element, allowedWindows: allowed), occluders: occluders))
    }
    if !group.alone {
      let candidates =
        AXValueReader.copyElements(applicationElement, kAXWindowsAttribute)
        + AXElementNode.children(of: keyWindow)
        + openMenus(of: applicationElement)
      for (index, member) in group.members.prefix(rootIndex).enumerated() {
        for element in candidates {
          let id = KeyWindow.windowID(of: element) ?? ActionRunner.windowID(containing: element)
          let role = AXValueReader.copyString(element, kAXRoleAttribute)
          let menu =
            role == kAXMenuRole && member.layer >= AppWindows.popUpMenuLevel
            && AXValueReader.copyFrame(element)?.intersects(member.window.frame) == true
          if id == member.window.windowID || menu {
            add(element, occluders: group.members.prefix(index).map(\.window.frame))
          }
        }
      }
    }
    add(keyWindow, occluders: group.members.prefix(rootIndex).map(\.window.frame))
    return roots
  }

  static func menuBarMenus(of applicationElement: AXUIElement) -> [AXUIElement] {
    guard let menuBar = AXValueReader.copyElement(applicationElement, kAXMenuBarAttribute) else {
      return []
    }
    return AXElementNode.children(of: menuBar).dropFirst().filter {
      AXValueReader.copyBool($0, kAXSelectedAttribute) == true
    }.flatMap { item in
      AXElementNode.children(of: item).filter {
        AXValueReader.copyString($0, kAXRoleAttribute) == kAXMenuRole
      }
    }
  }

  static func openMenus(of applicationElement: AXUIElement) -> [AXUIElement] {
    AXElementNode.children(of: applicationElement).filter {
      AXValueReader.copyString($0, kAXRoleAttribute) == kAXMenuRole
    } + menuBarMenus(of: applicationElement)
  }
}

/// Chromium and Electron build web accessibility asynchronously after opt-in.
/// Observe waits once per process for populated web content, within its budget.
/// The generic count settle remains shared with deterministic contract checks.
public enum ManualAccessibility {
  public static let settleTimeout: TimeInterval = 1
  static let pollInterval: TimeInterval = 0.1
  /// A shallow fingerprint remains cheap for action settle and owner view.
  static let countDepth = 3
  static let countLimit = 400

  /// Waits until the count has changed from its first reading and then held
  /// for one poll, or until `timeout`. Returns the number of polls taken.
  @WorkActor
  public static func settle(
    count: () -> Int,
    timeout: TimeInterval = settleTimeout,
    now: () -> Date = Date.init,
    sleep: (TimeInterval) async -> Void = { interval in
      try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
    }
  ) async -> Int {
    let deadline = now().addingTimeInterval(timeout)
    let initial = count()
    var previous = initial
    var polls = 0
    while now() < deadline {
      await sleep(pollInterval)
      polls += 1
      let current = count()
      if current != initial, current == previous { break }
      previous = current
    }
    return polls
  }

  static func shallowCount(
    of element: AXUIElement, beforeRead: (AXUIElement) -> Bool = { _ in true }
  ) -> Int {
    var total = 0
    func visit(_ node: AXUIElement, depth: Int) {
      guard depth < countDepth, total < countLimit, beforeRead(node) else { return }
      for child in AXElementNode.children(of: node) {
        guard total < countLimit else { return }
        total += 1
        visit(child, depth: depth + 1)
      }
    }
    visit(element, depth: 0)
    return total
  }

  /// Chrome debounces enhanced-UI enablement for two seconds. Native toolbar
  /// growth cannot establish readiness: wait for actual renderer children.
  /// See Chromium's chrome_browser_application_mac.mm and trycua/cua
  /// ax/enablement.rs (MIT), Copyright (c) 2025 Cua AI, Inc.
  @WorkActor
  static func settleWebContent(
    of window: AXUIElement, budget: WorkBudget, check: () throws -> Void
  ) async throws -> Bool {
    let deadline = Date().addingTimeInterval(max(0, min(4, budget.remaining())))
    while Date() < deadline {
      var pending = [(window, 0)]
      var visits = 0
      while let (node, depth) = pending.popLast(), visits < countLimit, Date() < deadline {
        try check()
        try budget.check()
        visits += 1
        AXUIElementSetMessagingTimeout(
          node, Float(min(Double(axMessagingTimeout), deadline.timeIntervalSinceNow)))
        let role = AXValueReader.copyString(node, kAXRoleAttribute)
        if role == kAXMenuBarRole || depth >= 10 { continue }
        try check()
        try budget.check()
        guard Date() < deadline else { break }
        AXUIElementSetMessagingTimeout(
          node, Float(min(Double(axMessagingTimeout), deadline.timeIntervalSinceNow)))
        let children = AXElementNode.children(of: node)
        if role == "AXWebArea", !children.isEmpty { return true }
        pending.append(
          contentsOf: children.prefix(countLimit - visits).reversed().map { ($0, depth + 1) })
      }
      try check()
      try budget.check()
      let remaining = deadline.timeIntervalSinceNow
      if remaining > 0 {
        try await Task.sleep(nanoseconds: UInt64(min(pollInterval, remaining) * 1e9))
      }
    }
    try check()
    try budget.check()
    return false
  }

}

/// Which apps need `AXManualAccessibility`.
public enum ChromiumDetection {
  public static func isChromiumLike(bundlePath: String, bundleId: String) -> Bool {
    if AppPolicy.isBrowser(bundleId) || isChromiumBrowser(bundlePath: bundlePath) { return true }
    let frameworks = URL(fileURLWithPath: bundlePath, isDirectory: true)
      .appendingPathComponent("Contents/Frameworks", isDirectory: true)
    let contents =
      (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
    return contents.contains { name in
      guard name.hasSuffix("Framework.framework") else { return false }
      if name == "Electron Framework.framework" { return true }
      let lowered = name.lowercased()
      return lowered.contains("chrome") || lowered.contains("chromium")
        || lowered.contains("cef") || lowered.contains("electron")
    }
  }

  /// A Chromium browser — Chrome or any fork — by its application class,
  /// which Electron and CEF apps do not share.
  public static func isChromiumBrowser(bundlePath: String) -> Bool {
    Bundle(path: bundlePath)?.object(forInfoDictionaryKey: "NSPrincipalClass") as? String
      == "BrowserCrApplication"
  }
}
