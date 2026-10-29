import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public struct AppFocusState: Sendable {
  public var focusChangedByHelper = false
  public var staleReason: WindowStaleReason?
  var lastHelperInputAt: Date?
}

public enum WindowStaleReason: Sendable, Equatable {
  case closed
  case minimized
  case frontWindowChanged

  public var message: String {
    switch self {
    case .closed: return "The observed window closed."
    case .minimized: return "The observed window was minimized."
    case .frontWindowChanged: return "Another window of this app came to the front."
    }
  }
}

/// Tracks window identity and reports activation following helper input.
///
/// The work executor writes to it while it observes and acts, and the main run
/// loop delivers the window and activation notifications, so its state is
/// behind one lock and never waits on an app.
public final class WindowMonitor: @unchecked Sendable {
  static let helperInputWindow: TimeInterval = 2

  private struct State {
    var states: [pid_t: AppFocusState] = [:]
    var inputs: [pid_t: UInt64] = [:]
    var observers: [pid_t: AppAXObserver] = [:]
    var observedWindows: [pid_t: CGWindowID] = [:]
    var tracked: [pid_t: [CGWindowID: AXUIElement]] = [:]
    var stale: [pid_t: [CGWindowID: WindowStaleReason]] = [:]
    /// The window the helper's own key priming is making key, until the next
    /// observation: that focus change is the helper's doing, not the app's.
    var primedWindows: [pid_t: CGWindowID] = [:]
    var observedElements: [pid_t: AXUIElement] = [:]
    /// Apps whose observed window is minimized right now. Unlike `staleReason`,
    /// which holds until the agent observes again, this follows the window.
    var minimizedObserved: Set<pid_t> = []
    /// Monotonic evidence that something observable changed while an
    /// observation was being assembled. It is global to this monitor so
    /// forgetting and re-watching the same PID cannot recreate an old token.
    var revision: UInt64 = 0
    var revisions: [pid_t: UInt64] = [:]

    mutating func changed(_ pid: pid_t) {
      revision &+= 1
      revisions[pid] = revision
    }
  }

  private let state = Locked(State())
  private let workspaceObserver = Locked<(any NSObjectProtocol)?>(nil)
  private let windowEventHandler = Locked<(@Sendable () -> Void)?>(nil)

  public init() {}

  /// Told of every window event of a watched app, after the monitor's own
  /// bookkeeping, so what the helper draws over a window can follow it.
  public var onWindowEvent: (@Sendable () -> Void)? {
    get { windowEventHandler.withLock { $0 } }
    set { windowEventHandler.withLock { $0 = newValue } }
  }

  // MARK: - Lifecycle

  @MainActor
  public func start() {
    guard workspaceObserver.current == nil else { return }
    let observer = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard
        let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
          as? NSRunningApplication
      else { return }
      self?.noteActivation(processIdentifier: application.processIdentifier)
    }
    workspaceObserver.withLock { $0 = observer }
  }

  public func stop() {
    if let observer = workspaceObserver.withLock({ current -> (any NSObjectProtocol)? in
      defer { current = nil }
      return current
    }) {
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
    }
    let observers = state.withLock { state -> [AppAXObserver] in
      defer {
        state.observers = [:]
        state.states = [:]
        state.inputs = [:]
        state.observedWindows = [:]
        state.tracked = [:]
        state.stale = [:]
        state.primedWindows = [:]
        state.observedElements = [:]
        state.minimizedObserved = []
      }
      return Array(state.observers.values)
    }
    for observer in observers { observer.stop() }
  }

  /// Registers for the app's window notifications. Called from the work
  /// executor, because registering is a message the app has to answer.
  public func watch(processIdentifier: pid_t) {
    let needsObserver = state.withLock { state -> Bool in
      if state.states[processIdentifier] == nil {
        state.states[processIdentifier] = AppFocusState()
        state.changed(processIdentifier)
      }
      return state.observers[processIdentifier] == nil
    }
    guard needsObserver else { return }
    let observer = AppAXObserver(processIdentifier: processIdentifier) { [weak self] pid, kind in
      self?.noteWindowEvent(processIdentifier: pid, kind: kind)
    }
    guard observer.start() else { return }
    let redundant = state.withLock { state -> Bool in
      guard state.observers[processIdentifier] == nil else { return true }
      state.observers[processIdentifier] = observer
      return false
    }
    if redundant { observer.stop() }
  }

  func isWatching(_ pid: pid_t) -> Bool { state.withLock { $0.observers[pid] != nil } }

  public func forget(processIdentifier: pid_t) {
    let observer = state.withLock { state -> AppAXObserver? in
      let observer = state.observers.removeValue(forKey: processIdentifier)
      state.states[processIdentifier] = nil
      state.inputs[processIdentifier] = nil
      state.observedWindows[processIdentifier] = nil
      state.tracked[processIdentifier] = nil
      state.stale[processIdentifier] = nil
      state.primedWindows[processIdentifier] = nil
      state.observedElements[processIdentifier] = nil
      state.minimizedObserved.remove(processIdentifier)
      state.changed(processIdentifier)
      return observer
    }
    observer?.stop()
  }

  // MARK: - Reading and writing state

  public func state(of processIdentifier: pid_t) -> AppFocusState {
    state.withLock { $0.states[processIdentifier] ?? AppFocusState() }
  }

  /// Consume only after an observation commits, so a failed capture keeps
  /// the activation evidence for the next successful observation.
  func takeFocusChanged(processIdentifier: pid_t) -> Bool {
    state.withLock { state in
      guard var app = state.states[processIdentifier] else { return false }
      let changed = app.focusChangedByHelper
      app.focusChangedByHelper = false
      state.states[processIdentifier] = app
      return changed
    }
  }

  func observedWindow(of processIdentifier: pid_t) -> AXUIElement? {
    state.withLock { $0.observedElements[processIdentifier] }
  }

  /// Whether the window the agent last observed in this app is minimized now.
  func observedWindowMinimized(processIdentifier: pid_t) -> Bool {
    state.withLock { $0.minimizedObserved.contains(processIdentifier) }
  }

  public func observationRevision(processIdentifier: pid_t) -> UInt64 {
    state.withLock { $0.revisions[processIdentifier] ?? 0 }
  }

  /// Reject a capture assembled across a window change or session replacement.
  public func observationError(
    since expectedRevision: UInt64,
    processIdentifier: pid_t
  ) -> HelperError? {
    guard observationRevision(processIdentifier: processIdentifier) != expectedRevision else {
      return nil
    }
    return Self.staleRefusal(
      processIdentifier: processIdentifier,
      message: "This app changed while it was being observed.")
  }

  @WorkActor
  func trackWindow(processIdentifier: pid_t, windowID: CGWindowID, window: AXUIElement) {
    state.withLock {
      if $0.tracked[processIdentifier]?[windowID].map({ !CFEqual($0, window) }) ?? true {
        $0.stale[processIdentifier]?[windowID] = nil
      }
      $0.tracked[processIdentifier, default: [:]][windowID] = window
    }
    state.withLock { $0.observers[processIdentifier] }?.watchWindow(window)
  }

  @WorkActor
  func retireWindow(processIdentifier: pid_t, windowID: CGWindowID, window: AXUIElement) {
    let observer = state.withLock { state -> AppAXObserver? in
      guard let tracked = state.tracked[processIdentifier]?[windowID], CFEqual(tracked, window)
      else { return nil }
      state.tracked[processIdentifier]?[windowID] = nil
      state.stale[processIdentifier, default: [:]][windowID] = .closed
      if state.observedWindows[processIdentifier] == windowID {
        state.observedWindows[processIdentifier] = nil
        state.observedElements[processIdentifier] = nil
        state.minimizedObserved.remove(processIdentifier)
      }
      return state.observers[processIdentifier]
    }
    observer?.unwatchWindow(window)
  }

  func staleReason(processIdentifier: pid_t, windowID: CGWindowID) -> WindowStaleReason? {
    state.withLock { $0.stale[processIdentifier]?[windowID] }
  }

  public func noteObservation(
    processIdentifier: pid_t, windowID: CGWindowID, window: AXUIElement
  ) {
    state.withLock { state in
      Self.recordObservation(
        processIdentifier: processIdentifier, windowID: windowID, window: window, in: &state)
    }
  }

  /// A window event must not land between validating a capture and replacing
  /// its observed window. Otherwise the replacement would clear that event.
  func commitObservation(
    processIdentifier: pid_t, windowID: CGWindowID, window: AXUIElement,
    since expectedRevision: UInt64
  ) -> HelperError? {
    let changed = state.withLock { state -> Bool in
      guard state.revisions[processIdentifier] == expectedRevision else { return true }
      Self.recordObservation(
        processIdentifier: processIdentifier, windowID: windowID, window: window, in: &state)
      return false
    }
    return changed
      ? Self.staleRefusal(
        processIdentifier: processIdentifier,
        message: "This app changed while it was being observed.")
      : nil
  }

  private static func recordObservation(
    processIdentifier: pid_t, windowID: CGWindowID, window: AXUIElement, in state: inout State
  ) {
    var app = state.states[processIdentifier] ?? AppFocusState()
    app.staleReason = nil
    state.states[processIdentifier] = app
    state.observedWindows[processIdentifier] = windowID
    state.primedWindows[processIdentifier] = nil
    state.observedElements[processIdentifier] = window
    state.tracked[processIdentifier, default: [:]][windowID] = window
    state.stale[processIdentifier]?[windowID] = nil
    state.minimizedObserved.remove(processIdentifier)
    state.changed(processIdentifier)
  }

  /// The app came forward on the helper's input and was sent back before the
  /// screen showed it: there is nothing to report.
  func forgetActivation(processIdentifier: pid_t) {
    state.withLock { state in
      guard var app = state.states[processIdentifier] else { return }
      app.focusChangedByHelper = false
      state.states[processIdentifier] = app
    }
  }

  /// Key priming is about to make `windowID` the app's key window.
  public func notePrimedWindow(processIdentifier: pid_t, windowID: CGWindowID) {
    state.withLock { $0.primedWindows[processIdentifier] = windowID }
  }

  public func primedWindow(processIdentifier: pid_t) -> CGWindowID? {
    state.withLock { $0.primedWindows[processIdentifier] }
  }

  func helperInputRevision(processIdentifier: pid_t) -> UInt64 {
    state.withLock { $0.inputs[processIdentifier] ?? 0 }
  }

  public func noteHelperInput(processIdentifier: pid_t) {
    state.withLock { state in
      state.inputs[processIdentifier, default: 0] &+= 1
      var app = state.states[processIdentifier] ?? AppFocusState()
      app.lastHelperInputAt = Date()
      state.states[processIdentifier] = app
      state.changed(processIdentifier)
    }
  }

  /// Observe opened this app. Opening never activates it, so the app coming
  /// to the front under the launch is the app's own doing, reported as
  /// `focusChanged` like a response to input; an activation that arrives just
  /// after is counted the same way.
  public func noteLaunch(processIdentifier: pid_t, broughtForward: Bool) {
    state.withLock { state in
      var app = state.states[processIdentifier] ?? AppFocusState()
      app.lastHelperInputAt = Date()
      if broughtForward { app.focusChangedByHelper = true }
      state.states[processIdentifier] = app
      state.changed(processIdentifier)
    }
    if broughtForward {
      Log.focus.notice("App \(processIdentifier, privacy: .public) came forward on launch.")
    }
  }

  func noteActivation(
    processIdentifier: pid_t,
    frontmost: () -> pid_t? = {
      PrivateAPI.focusPID(front: true)
        ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
  ) {
    // Target-only focus records make an app announce AXApplicationActivated
    // while WindowServer keeps the person's app in front; only a real front
    // process change is the app coming forward.
    guard frontmost() == processIdentifier else { return }
    let cameForward = state.withLock { state -> Bool in
      guard var app = state.states[processIdentifier] else { return false }
      guard let helperInput = app.lastHelperInputAt,
        Date().timeIntervalSince(helperInput) < Self.helperInputWindow
      else { return false }
      // The app brought itself forward on receiving the helper's input. The
      // helper reports it and never pushes focus back.
      app.focusChangedByHelper = true
      state.states[processIdentifier] = app
      return true
    }
    if cameForward {
      Log.focus.notice("App \(processIdentifier, privacy: .public) came forward on input.")
    }
  }

  func noteWindowEvent(processIdentifier: pid_t, kind: AppAXObserver.EventKind) {
    defer { onWindowEvent?() }
    if case .activated = kind {
      noteActivation(processIdentifier: processIdentifier)
      return
    }
    state.withLock { state in
      switch kind {
      case .activated: return
      case .focusedWindowChanged(let windowID):
        if windowID != state.observedWindows[processIdentifier] { state.changed(processIdentifier) }
      case .moved, .created:
        // Topology revisions fence an in-flight capture, but changing the
        // person's key window never invalidates a retained explicit snapshot.
        state.changed(processIdentifier)
      case .deminiaturized(let element):
        for (id, tracked) in state.tracked[processIdentifier] ?? [:] where CFEqual(tracked, element)
        {
          if state.observedWindows[processIdentifier] == id {
            state.minimizedObserved.remove(processIdentifier)
          }
        }
        state.changed(processIdentifier)
      case .miniaturized(let element), .destroyed(let element):
        var affected = false
        for (id, tracked) in state.tracked[processIdentifier] ?? [:] where CFEqual(tracked, element)
        {
          let reason: WindowStaleReason
          if case .miniaturized = kind { reason = .minimized } else { reason = .closed }
          // Destruction is permanent, even if a minimized token later reports
          // another lifecycle notification.
          if state.stale[processIdentifier]?[id] != .closed {
            state.stale[processIdentifier, default: [:]][id] = reason
          }
          if state.observedWindows[processIdentifier] == id {
            var app = state.states[processIdentifier] ?? AppFocusState()
            if app.staleReason == nil { app.staleReason = reason }
            state.states[processIdentifier] = app
            if reason == .minimized { state.minimizedObserved.insert(processIdentifier) }
          }
          affected = true
        }
        if affected { state.changed(processIdentifier) }
      }
    }
  }

  static func staleRefusal(processIdentifier: pid_t, message: String) -> HelperError {
    Log.focus.notice(
      "Stale observation refused: pid=\(processIdentifier, privacy: .public) reason=\(message, privacy: .public)"
    )
    return HelperError(.staleObservation, message)
  }
}
