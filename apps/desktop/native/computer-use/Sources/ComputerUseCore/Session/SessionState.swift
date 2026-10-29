import ApplicationServices
import CoreGraphics
import Foundation

/// One of the app's windows as an observation saw it, front to back.
///
/// A point target lands in whichever of these is frontmost under it — a
/// popover, a child window, a menu, an open panel — and the synthetic event is
/// stamped with that window and given a point inside it (§2 "Actions").
public struct ObservedWindow: Sendable, Equatable {
  public let windowID: CGWindowID
  /// Screen points, top-left origin (CoreGraphics space).
  public let frame: CGRect

  public init(windowID: CGWindowID, frame: CGRect) {
    self.windowID = windowID
    self.frame = frame
  }
}

/// The observation an action may cite. Nothing about it is durable: after any
/// loss the agent observes again (§1 "Model").
public struct LatestObservation {
  public let observationId: String
  public let processIdentifier: pid_t
  /// The key window, which the observation's coordinates are relative to.
  public let windowID: CGWindowID
  public let windowFrame: CGRect
  public let coordinates: ObservationCoordinates
  public let elements: [ObservedElement]
  /// The app's on-screen windows inside the screenshot, front to back. Empty
  /// when the key window was captured on its own (another Space).
  public var windows: [ObservedWindow] = []
  var group: WindowGroup? = nil
  public let takenAt: Date
}

/// One app inside a session, as the work executor knows it.
///
/// Everything mutable here is read and written only by observe and act, which
/// run on the work executor; the control plane on the main actor only ever
/// reads the approved identity and path, which never change.
@WorkActor
public final class AppSessionState {
  public nonisolated let identity: AppIdentity
  public nonisolated let path: String
  nonisolated let ownerInputFence: OwnerInputFence
  var observationControlEpoch = 0
  public var processIdentifier: pid_t?
  /// The process the last full identity check verified.
  var verified: ProcessStamp?
  var windows: [String: SessionWindow] = [:]
  var retiredWindowRefs = Set<String>()
  var currentWindow: SessionWindow?
  private var unboundLatest: LatestObservation?
  public var latest: LatestObservation? {
    get { currentWindow?.latest ?? unboundLatest }
    set {
      if let currentWindow { currentWindow.latest = newValue } else { unboundLatest = newValue }
    }
  }
  var manualAccessibilityProcess: ProcessStamp?
  public var accessibilityWriteResults: [String: Int32] = [:]
  /// Set after Chromium AX opt-in, until observe has made its bounded
  /// one-time wait for populated web content.
  public var manualAccessibilityPending = false
  let menuShortcuts: MenuShortcutIndex
  /// What keeps the app believing it is active while the person's app stays in
  /// front; it outlives single actions, and the session's end stops it.
  public nonisolated let focus: FocusSlot

  public nonisolated convenience init(identity: AppIdentity, path: String) {
    self.init(identity: identity, path: path, focus: FocusSlot())
  }

  nonisolated convenience init(
    identity: AppIdentity, path: String, ownerInputFence: OwnerInputFence
  ) {
    self.init(identity: identity, path: path, focus: FocusSlot(), ownerInputFence: ownerInputFence)
  }

  nonisolated init(
    identity: AppIdentity, path: String, focus: FocusSlot,
    menuShortcuts: MenuShortcutIndex = MenuShortcutIndex(),
    ownerInputFence: OwnerInputFence = OwnerInputFence()
  ) {
    self.focus = focus
    self.menuShortcuts = menuShortcuts
    self.ownerInputFence = ownerInputFence
    self.identity = identity
    self.path = path
  }

  public nonisolated var key: String { identity.bundleId.lowercased() }

  /// The key window of the observation actions may cite.
  var latestWindowID: CGWindowID? { latest?.windowID }

  /// A committed observation becomes the one actions cite, and the menu
  /// shortcut index is read again from the app's current menus.
  func record(_ observation: LatestObservation) {
    latest = observation
    observationControlEpoch = ownerInputFence.epoch
    menuShortcuts.invalidate()
  }

  func invalidateOwnerInputObservations() {
    unboundLatest = nil
    for window in windows.values { window.latest = nil }
    menuShortcuts.invalidate()
  }

  func committedCaptureTarget(for observationId: String) -> CaptureTarget? {
    guard let latest, latest.observationId == observationId,
      let verified, verified.processIdentifier == latest.processIdentifier
    else { return nil }
    return CaptureTarget(
      observationId: observationId, app: identity,
      process: verified, windowID: latest.windowID,
      windowToken: currentWindow.map { AXWindowToken(element: $0.element) })
  }

  func currentCaptureTarget() -> CaptureTarget? {
    guard let window = currentWindow, !window.closed else { return nil }
    return CaptureTarget(
      observationId: window.ref, app: identity, process: window.process,
      windowID: window.windowID, windowToken: AXWindowToken(element: window.element))
  }

  func currentVideoBinding() throws -> OwnerViewWindow.Binding? {
    guard let target = currentCaptureTarget(), let element = currentWindow?.element else {
      return nil
    }
    return try OwnerViewWindow.bind(target, element: element)
  }

  var applicationElement: AXUIElement? {
    guard let processIdentifier else { return nil }
    let element = AXUIElementCreateApplication(processIdentifier)
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    return element
  }
}

/// One Run's apps and observations on this Mac.
///
/// A session declares nothing when it opens: each observe and act carries the
/// app and the access the Host resolved for it, and the app joins the session
/// the first time a call names it.
@MainActor
public final class HelperSession {
  public let sessionId: String
  public var threadTitle: String?
  /// A session belongs to the connection that opened it and closes when that
  /// connection drops.
  let runId: String?
  public let connectionID: Int
  public private(set) var apps: [String: AppSessionState] = [:]
  /// The access the latest call carried for each app, which is what the pill
  /// reads as `Using` or `Viewing`.
  public private(set) var access: [String: AppAccess] = [:]
  /// The process each app was last observed in, so the main actor can notice
  /// a quit app and forget its window observer without asking the work
  /// executor.
  public var processIdentifiers: [String: pid_t] = [:]
  public var openedAt = Date()
  public var lastUsedAt = Date()
  /// The stop signal running work watches. It outlives the session object
  /// so work that is mid-flight when the person presses `Stop` finds out.
  public let cancellation = SessionCancellation()

  init(sessionId: String, connectionID: Int, threadTitle: String? = nil, runId: String? = nil) {
    self.runId = runId
    self.threadTitle = threadTitle
    self.sessionId = sessionId
    self.connectionID = connectionID
  }

  func add(_ state: AppSessionState, access: AppAccess) {
    apps[state.key] = state
    self.access[state.key] = access
  }

  func remove(_ state: AppSessionState) {
    guard apps[state.key] === state else { return }
    state.focus.stop()
    apps[state.key] = nil
    access[state.key] = nil
    processIdentifiers[state.key] = nil
  }

  func noteAccess(_ access: AppAccess, for state: AppSessionState) {
    self.access[state.key] = access
  }

  public func app(_ bundleIdentifier: String) -> AppSessionState? {
    apps[bundleIdentifier.lowercased()]
  }

  public var orderedApps: [AppSessionState] {
    apps.values.sorted { $0.identity.displayName < $1.identity.displayName }
  }
}
