import AppKit
import ApplicationServices
import Foundation

/// AX selects the exact window once. The retained element is only a lifecycle
/// identity; WorkActor validates it with the shared liveness rule before capture.
@WorkActor
enum OwnerViewWindow {
  struct Failure: Error {
    let reason: String
  }

  final class Binding: @unchecked Sendable {
    let target: CaptureTarget
    let element: AXUIElement
    let liveness: WindowLiveness
    private let revision = Locked(0)
    var lifecycleRevision: Int { revision.current }
    private let notifications = Locked(0)
    private let resolvedNotifications = Locked(0)
    var needsDiscovery: Bool { notifications.current != resolvedNotifications.current }
    private let ended = Locked<String?>(nil)
    private var observer: AppAXObserver?
    private let groupState = Locked<WindowGroup?>(nil)

    init(target: CaptureTarget, element: AXUIElement) {
      self.target = target
      self.element = element
      liveness = WindowLiveness(
        process: target.process, element: element, windowID: target.windowID)
    }

    @WorkActor
    func summary() throws -> Wire.ViewStateResult.OwnerWindowSummary {
      Wire.ViewStateResult.OwnerWindowSummary(
        windowId: try WindowIdentities.retain(liveness, app: target.app),
        title: ActionDescription.clip(AXValueReader.copyString(element, kAXTitleAttribute) ?? "", to: 1024))
    }

    @WorkActor
    func group() throws -> WindowGroup {
      guard unavailableReason != "window-closed" else { throw SessionWindows.closed }
      let notified = notifications.current
      let previous = groupState.current
      let next = try WindowGroup.resolve(
        window: element, process: target.process,
        lifecycleRevision: UInt64(notified), previous: previous,
        liveness: liveness)
      if previous?.captureLayout != next.captureLayout {
        revision.withLock { $0 += 1 }
      }
      groupState.withLock { $0 = next }
      resolvedNotifications.withLock { $0 = notified }
      return next
    }

    @WorkActor
    func watch() throws {
      let observer = AppAXObserver(processIdentifier: target.process.processIdentifier,
        onNotification: { [weak self] name in
          guard let self else { return }
          MacVideoDiagnostic.write(["event": "capture-binding-ax-notification",
            "window": self.target.windowID, "notification": name,
            "revision": self.lifecycleRevision])
        }) {
        [weak self] _, kind in
        guard let self else { return }
        let notification: String
        switch kind {
        case .activated: notification = "activated"
        case .focusedWindowChanged: notification = "focus"
        case .created: notification = "created"
        case .moved: notification = "geometry"
        case .destroyed: notification = "destroyed"
        case .miniaturized: notification = "minimized"
        case .deminiaturized: notification = "restored"
        }
        MacVideoDiagnostic.write(["event": "capture-binding-notification",
          "window": self.target.windowID, "notification": notification])
        // AXWindowCreated/AXUIElementDestroyed also describe transient controls.
        // They request discovery; only a changed resolved sample retires capture.
        self.notifications.withLock { $0 += 1 }
        switch kind {
        case .destroyed(let window) where CFEqual(window, self.element):
          self.liveness.close()
          self.ended.withLock { $0 = "window-closed" }
        case .miniaturized(let window) where CFEqual(window, self.element):
          self.ended.withLock { if $0 == nil { $0 = "minimized" } }
        case .deminiaturized(let window) where CFEqual(window, self.element):
          self.ended.withLock { if $0 == "minimized" { $0 = nil } }
        default: break
        }
      }
      guard observer.start() else { throw Failure(reason: "accessibility-error") }
      observer.watchWindow(element)
      self.observer = observer
    }

    deinit { observer?.stop() }

    var unavailableReason: String? { liveness.isClosed ? "window-closed" : ended.current }
  }

  /// No task state, tree walk, observation commit, selection mutation or overlay.
  static func open(
    record: AppBundleRecord, windowID requestedWindowID: String,
    cancellation: SessionCancellation, budget: WorkBudget
  )
    async throws -> Binding
  {
    guard PrivateAPI.windowGroupsAvailable else { throw Failure(reason: "unsupported") }
    guard AXIsProcessTrusted() else { throw Failure(reason: "permission-required") }
    guard (try? HelperRuntime.requireUnlocked()) != nil else { throw Failure(reason: "locked") }
    guard Permissions.current().screenRecording == .granted else {
      throw Failure(reason: "permission-required")
    }
    let check = {
      try cancellation.check()
      try budget.check()
    }
    let identity: WindowLiveness
    do { identity = try WindowIdentities.resolve(requestedWindowID) }
    catch let error as OwnerViewWindow.Failure { throw error }
    catch let error as HelperError where error == SessionWindows.closed {
      throw Failure(reason: "window-closed")
    }
    let state = AppSessionState(identity: record.identity, path: record.path)
    let pid = try AppProcess.verify(state)
    guard state.verified == identity.process, pid == identity.process.processIdentifier else {
      throw Failure(reason: "window-closed")
    }
    try check()
    let window = identity.element
    let windowID = identity.windowID
    let process = identity.process
    return try bind(
      CaptureTarget(
        observationId: UUID().uuidString, app: record.identity, process: process,
        windowID: windowID, windowToken: AXWindowToken(element: window)),
      element: window)
  }

  /// Task-held views bind the committed element, never the app's current selection.
  static func bind(_ target: CaptureTarget, element: AXUIElement) throws -> Binding {
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    var pid: pid_t = 0
    try check(AXUIElementGetPid(element, &pid), attribute: "AXPID")
    guard pid == target.process.processIdentifier, try windowID(element) == target.windowID else {
      throw Failure(reason: "window-unreadable")
    }
    let binding = Binding(target: target, element: element)
    try binding.watch()
    let live: WindowLiveness.State
    do { live = try binding.liveness.read() } catch let error as HelperError
      where error == SessionWindows.closed
    { throw Failure(reason: "window-closed") } catch { throw Failure(reason: "window-unreadable") }
    if live.minimized { throw Failure(reason: "minimized") }
    guard live.hidden || live.entry.alpha > 0 else { throw Failure(reason: "window-unreadable") }
    return binding
  }

  nonisolated static func unavailable(_ binding: Binding) -> String? {
    binding.unavailableReason
  }

  private static func windowID(_ element: AXUIElement) throws -> CGWindowID {
    guard let resolve = PrivateAPI.axUIElementGetWindow else {
      throw Failure(reason: "unsupported")
    }
    var identifier: CGWindowID = 0
    try check(resolve(element, &identifier), attribute: "_AXUIElementGetWindow")
    guard identifier != 0 else { throw Failure(reason: "window-unreadable") }
    return identifier
  }

  private static func check(_ status: AXError, attribute: String) throws {
    guard status != .success else { return }
    Log.observe.error(
      "Owner window AX read failed: attribute=\(attribute, privacy: .public) status=\(status.rawValue, privacy: .public)"
    )
    switch status {
    case .apiDisabled: throw Failure(reason: "permission-required")
    case .invalidUIElement: throw Failure(reason: "window-closed")
    case .noValue, .attributeUnsupported: throw Failure(reason: "window-unreadable")
    default: throw Failure(reason: "accessibility-error")
    }
  }
}
