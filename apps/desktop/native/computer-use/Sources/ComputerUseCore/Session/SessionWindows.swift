import AppKit
import ApplicationServices
import CoreGraphics

public struct OwnerWindowInfo: Encodable, Sendable {
  let id: CGWindowID
  let title: String
  let focused: Bool
  let main: Bool
  let minimized: Bool
  let onScreen: Bool
}

public struct WindowInfo: Encodable, Sendable {
  let ref: String
  let id: CGWindowID
  let title: String
  let focused: Bool
  let main: Bool
  let minimized: Bool
  let onScreen: Bool
  let modal: Bool
  let current: Bool
  let frame: Observation.Rect
}

public struct WindowBlocker: Encodable, Sendable, Equatable {
  enum Kind: String, Encodable, Sendable { case dialog, menu }
  let id: CGWindowID
  let title: String
  let kind: Kind
  var refusal: HelperError {
    HelperError(.unsupported, "\"\(title)\" (window \(id)) blocks this app; use that window.")
  }
}

@WorkActor
final class SessionWindow {
  let ref = UUID().uuidString
  let process: ProcessStamp
  let element: AXUIElement
  let windowID: CGWindowID
  let liveness: WindowLiveness
  var closed: Bool {
    get { liveness.isClosed }
    set { if newValue { liveness.close() } }
  }
  var latest: LatestObservation?
  var group: WindowGroup?
  var inputSinceObservation = false
  var beforeInput: ActionSettle.Fingerprint?

  init(process: ProcessStamp, element: AXUIElement, windowID: CGWindowID) {
    self.process = process
    self.element = element
    self.windowID = windowID
    liveness = WindowLiveness(process: process, element: element, windowID: windowID)
  }
}

/// An AppSessionState belongs to exactly one helper session. Its retained AX
/// token and process incarnation, never a numeric id alone, identify a ref.
@WorkActor
enum SessionWindows {
  nonisolated static let closed = HelperError(.staleObservation, "That window is closed.")

  /// Attaches the app's process. With `launching`, an app that is not running,
  /// or runs with no window, is opened in the background (`AppLaunch`);
  /// without it, only an app already running is attached, as it is.
  static func prepare(
    app: AppSessionState, monitor: WindowMonitor, budget: WorkBudget,
    check: @Sendable () throws -> Void,
    launching: Bool = true,
    processAcquired: @Sendable (pid_t) async throws -> Void = { _ in }
  ) async throws {
    try WindowGroup.requireAvailable()
    guard AXIsProcessTrusted() else {
      throw HelperError(
        .permissionRequired,
        "Opensteer Computer Use needs macOS Accessibility to read this app. Turn it on for Opensteer Computer Use in System Settings."
      )
    }
    let launch: AppLaunch.Result
    if launching {
      launch = try await AppLaunch.ensureRunning(
        app,
        check: {
          try check()
          try budget.check()
        })
    } else {
      launch = AppLaunch.Result(
        processIdentifier: try AppProcess.verify(app), launched: false, broughtForward: false)
    }
    try await processAcquired(launch.processIdentifier)
    try check()
    try budget.check()
    if app.processIdentifier != launch.processIdentifier {
      for window in Array(app.windows.values) { retire(window, app: app, monitor: monitor) }
      if let old = app.processIdentifier { monitor.forget(processIdentifier: old) }
      app.currentWindow = nil
      app.processIdentifier = launch.processIdentifier
      app.menuShortcuts.invalidate()
    }
    monitor.watch(processIdentifier: launch.processIdentifier)
    do {
      try check(); try budget.check()
      if launch.launched {
        monitor.noteLaunch(
          processIdentifier: launch.processIdentifier, broughtForward: launch.broughtForward)
      }
      if let element = app.applicationElement {
        AppObserver.applyManualAccessibilityIfNeeded(app: app, applicationElement: element)
      }
      try check(); try budget.check()
    } catch {
      monitor.forget(processIdentifier: launch.processIdentifier)
      throw error
    }
  }

  static func windows(
    app: AppSessionState, monitor: WindowMonitor, budget: WorkBudget = .unlimited,
    check: @Sendable () throws -> Void = {},
    launching: Bool = true,
    report: InventoryReport? = nil,
    processAcquired: @Sendable (pid_t) async throws -> Void = { _ in }
  ) async throws -> [WindowInfo] {
    try await prepare(
      app: app, monitor: monitor, budget: budget, check: check, launching: launching,
      processAcquired: processAcquired)
    return try inventory(
      app: app, monitor: monitor, check: { try check(); try budget.check() }, report: report)
  }

  /// One inventory's counts: never a title.
  final class InventoryReport {
    var accessibilityWindows = 0
    /// Accessibility windows with no window-server window to match.
    var unlisted = 0
    var unverified = 0
    var reason: HelperErrorCode?
  }

  /// With a report, as for the person's picker, a window that cannot be
  /// verified is counted and left out. Without one, as for the agent, it fails
  /// the whole list: an agent must never act on a window it could not check.
  static func inventory(
    app: AppSessionState, monitor: WindowMonitor, check: () throws -> Void = {},
    report: InventoryReport? = nil
  ) throws -> [WindowInfo] {
    try check()
    try WindowGroup.requireAvailable()
    guard let process = app.verified, process.isCurrent, let application = app.applicationElement
    else { throw closed }
    let entries = AppWindows.all(processIdentifier: process.processIdentifier)
    for bound in Array(app.windows.values)
    where bound.closed
      || monitor.staleReason(
        processIdentifier: bound.process.processIdentifier, windowID: bound.windowID) == .closed
    {
      retire(bound, app: app, monitor: monitor)
    }
    var windowValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowValue)
        == .success,
      let elements = windowValue as? [AXUIElement]
    else {
      throw HelperError(.failed, "This app's window list could not be read; try again.")
    }
    let focused = AXValueReader.copyElement(application, kAXFocusedWindowAttribute)
    let main = AXValueReader.copyElement(application, kAXMainWindowAttribute)
    // Enumeration absence is inconclusive. Only definitive lifetime loss from
    // the retained identity, its process or WindowServer permanently retires a ref.
    var retained: [(SessionWindow, WindowLiveness.State)] = []
    var readFailure: HelperError?
    func unverifiable(_ error: HelperError) {
      guard let report else { readFailure = error; return }
      report.unverified += 1
      report.reason = error.code
    }
    report?.accessibilityWindows = elements.count
    for bound in Array(app.windows.values) {
      try check()
      if bound.closed || bound.process != process
        || monitor.staleReason(
          processIdentifier: process.processIdentifier, windowID: bound.windowID) == .closed
      {
        retire(bound, app: app, monitor: monitor)
      } else {
        do { retained.append((bound, try bound.liveness.read())) } catch let error as HelperError
          where error == closed
        { retire(bound, app: app, monitor: monitor) } catch let error as HelperError {
          unverifiable(error)
        } catch {
          unverifiable(HelperError(.failed, "This app's windows could not be checked; try again."))
        }
      }
    }
    var result: [WindowInfo] = []
    for element in elements {
      try check()
      guard result.count < 64, let id = KeyWindow.windowID(of: element),
        let entry = entries.first(where: { $0.window.windowID == id })
      else {
        report?.unlisted += 1
        continue
      }
      let bound: SessionWindow
      if let existing = app.windows.values.first(where: {
        !$0.closed && $0.process == process && $0.windowID == id && CFEqual($0.element, element)
      }) {
        bound = existing
      } else {
        bound = SessionWindow(process: process, element: element, windowID: id)
      }
      do { _ = try bound.liveness.read() } catch let error as HelperError where error == closed {
        retire(bound, app: app, monitor: monitor); continue
      } catch let error as HelperError { unverifiable(error); continue } catch {
        unverifiable(HelperError(.failed, "This app's windows could not be checked; try again."))
        continue
      }
      app.windows[bound.ref] = bound
      monitor.trackWindow(
        processIdentifier: process.processIdentifier, windowID: id, window: element)
      result.append(
        WindowInfo(
          ref: bound.ref, id: id,
          title: ActionDescription.clip(AXValueReader.copyString(element, kAXTitleAttribute) ?? "", to: 1024),
          focused: focused.map { CFEqual($0, element) } ?? false,
          main: main.map { CFEqual($0, element) } ?? false,
          minimized: AXValueReader.copyBool(element, kAXMinimizedAttribute) == true,
          onScreen: entry.onScreen,
          modal: AXValueReader.copyBool(element, kAXModalAttribute) == true,
          current: app.currentWindow === bound, frame: Observation.Rect(entry.window.frame)))
    }
    for (bound, live) in retained.sorted(by: { $0.0.windowID < $1.0.windowID })
    where !result.contains(where: { $0.ref == bound.ref }) {
      try check()
      guard result.count < 64, !bound.closed, live.entry.alpha > 0 || live.hidden || live.minimized
      else { continue }
      result.append(
        WindowInfo(
          ref: bound.ref, id: bound.windowID,
          title: ActionDescription.clip(
            AXValueReader.copyString(bound.element, kAXTitleAttribute) ?? "", to: 1024),
          focused: focused.map { CFEqual($0, bound.element) } ?? false,
          main: main.map { CFEqual($0, bound.element) } ?? false,
          minimized: live.minimized, onScreen: live.entry.onScreen && !live.hidden,
          modal: AXValueReader.copyBool(bound.element, kAXModalAttribute) == true,
          current: app.currentWindow === bound, frame: Observation.Rect(live.entry.window.frame)))
    }
    try check()
    if let readFailure { throw readFailure }
    return result
  }

  static func bind(app: AppSessionState, window: CGWindowID?, monitor: WindowMonitor, check: () throws -> Void = {}) throws
    -> WindowInfo
  {
    let inventory = try inventory(app: app, monitor: monitor, check: check)
    let selected =
      window.flatMap { id in inventory.first { $0.id == id } }
      ?? (window == nil
        ? inventory.first(where: \.current) ?? inventory.first(where: \.focused)
          ?? inventory.first(where: \.main) ?? inventory.first : nil)
    guard let selected, let bound = app.windows[selected.ref], !bound.closed else { throw closed }
    app.currentWindow = bound
    return WindowInfo(
      ref: selected.ref, id: selected.id, title: selected.title, focused: selected.focused,
      main: selected.main, minimized: selected.minimized, onScreen: selected.onScreen,
      modal: selected.modal,
      current: true, frame: selected.frame)
  }

  static func resolve(app: AppSessionState, ref: String, monitor: WindowMonitor) throws
    -> SessionWindow
  {
    try WindowGroup.requireAvailable()
    guard let bound = app.windows[ref] else { throw closed }
    if bound.closed { retire(bound, app: app, monitor: monitor); throw closed }
    guard app.verified == bound.process,
      monitor.staleReason(
        processIdentifier: bound.process.processIdentifier, windowID: bound.windowID) != .closed
    else { retire(bound, app: app, monitor: monitor); throw closed }
    do {
      let live = try bound.liveness.read()
      if live.minimized {
        throw HelperError(.unsupported, "The window is minimized; ask the person to restore it.")
      }
    } catch let error as HelperError where error == closed {
      retire(bound, app: app, monitor: monitor); throw error
    }
    return bound
  }

  private static func retire(_ bound: SessionWindow, app: AppSessionState, monitor: WindowMonitor) {
    bound.closed = true
    bound.latest = nil
    bound.group = nil
    app.retiredWindowRefs.insert(bound.ref)
    app.windows[bound.ref] = nil
    if app.currentWindow === bound { app.currentWindow = nil }
    monitor.retireWindow(
      processIdentifier: bound.process.processIdentifier, windowID: bound.windowID,
      window: bound.element)
  }

  struct OwnerWindowList {
    let windows: [OwnerWindowInfo]
    /// Windows left out because they could not be verified, and the last reason.
    let unverified: Int
    let reason: HelperErrorCode?
  }

  /// The person's window picker lists what is already open: it never starts an
  /// app, or asks a running one to open a window, just to count its windows.
  /// It offers only what macOS Accessibility reports, which omits windows on
  /// other Spaces. Opening a view checks its window again.
  static func ownerWindows(record: AppBundleRecord, budget: WorkBudget) async throws
    -> OwnerWindowList
  {
    let state = AppSessionState(identity: record.identity, path: record.path)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let bundle = record.identity.bundleId
    let report = InventoryReport()
    let listed: [WindowInfo]
    do {
      listed = try await windows(
        app: state, monitor: monitor, budget: budget, launching: false, report: report)
    } catch let error as HelperError where error.code == .appNotRunning {
      Log.apps.notice("Owner windows \(bundle, privacy: .public): not running")
      return OwnerWindowList(windows: [], unverified: 0, reason: nil)
    } catch {
      let code = (error as? HelperError)?.code.rawValue ?? HelperErrorCode.failed.rawValue
      Log.apps.error("Owner windows \(bundle, privacy: .public): \(code, privacy: .public)")
      throw error
    }
    Log.apps.notice(
      "Owner windows \(bundle, privacy: .public): ax=\(report.accessibilityWindows) listed=\(listed.count) unlisted=\(report.unlisted) unverified=\(report.unverified) reason=\(report.reason?.rawValue ?? "none", privacy: .public)"
    )
    return OwnerWindowList(
      windows: listed.map {
        OwnerWindowInfo(
          id: $0.id, title: $0.title, focused: $0.focused, main: $0.main,
          minimized: $0.minimized, onScreen: $0.onScreen)
      }, unverified: report.unverified, reason: report.reason)
  }
}
