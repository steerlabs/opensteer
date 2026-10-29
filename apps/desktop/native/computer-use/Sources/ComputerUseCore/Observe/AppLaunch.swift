import AppKit
import ApplicationServices
import Foundation

/// Getting an app to the point where it has a window to observe.
///
/// An app that is not running and an app that is running with every window
/// closed are the same case: LaunchServices is asked to open it in the
/// background. A hidden app or a window on another Space must never be
/// reopened just because Accessibility has not listed its window yet.
@WorkActor
enum AppLaunch {
  struct Result: Equatable {
    let processIdentifier: pid_t
    /// Whether this observe opened the app.
    let launched: Bool
    /// The app came to the front while it was being opened: it activated
    /// itself, as some apps do on launch or reopen. Opening never asks for it.
    let broughtForward: Bool
  }

  static let outOfTime = HelperError(
    .failed,
    "The app did not open a window before this request ran out of time; observe it again.")

  static func ensureRunning(
    running: () throws -> pid_t,
    launch: () async throws -> Void,
    windowReady: (pid_t) -> Bool,
    hidden: (pid_t) -> Bool = { _ in false },
    windowExists: (pid_t) -> Bool = { _ in false },
    windowOnScreen: (pid_t) -> Bool = { _ in false },
    frontmost: () async -> pid_t? = { nil },
    check: () throws -> Void,
    timeout: TimeInterval = 10,
    settle: TimeInterval = 2
  ) async throws -> Result {
    do {
      let pid = try running()
      if windowReady(pid) {
        return Result(processIdentifier: pid, launched: false, broughtForward: false)
      }
      let isHidden = hidden(pid)
      if isHidden || windowExists(pid) {
        // Accessibility can briefly stop listing a window while an app hides
        // or its window moves between Spaces. Reopening would show the app or
        // move its window to the person's current Space. A window already on
        // this Space, of an app that is not hidden, is neither: its
        // Accessibility is still starting (Chromium can take seconds after the
        // manual-Accessibility opt-in), so it gets the whole timeout.
        let starting = !isHidden && windowOnScreen(pid)
        let deadline = Date().addingTimeInterval(starting ? timeout : min(timeout, settle))
        while Date() < deadline {
          try check()
          if windowReady(pid) {
            return Result(processIdentifier: pid, launched: false, broughtForward: false)
          }
          try await Task.sleep(nanoseconds: 100_000_000)
        }
        if starting {
          throw HelperError(
            .failed,
            "This app's window did not become readable to Accessibility in time; observe it again.")
        }
        throw HelperError(
          .unsupported,
          isHidden
            ? "This hidden app has no accessible window; ask the person to show it."
            : "This app has an open window that Accessibility cannot read; ask the person to show it."
        )
      }
    } catch let error as HelperError where error.code == .appNotRunning {}
    try check()
    let frontBefore = await frontmost()
    try await launch()
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      try check()
      do {
        let pid = try running()
        if windowReady(pid) {
          let front = await frontmost()
          return Result(
            processIdentifier: pid, launched: true,
            broughtForward: front == pid && frontBefore != pid)
        }
      } catch let error as HelperError where error.code == .appNotRunning {}
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw HelperError(.failed, "The app did not open a window within ten seconds.")
  }

  static func ensureRunning(_ app: AppSessionState, check: () throws -> Void) async throws
    -> Result
  {
    // The first read is the full identity check; the polls while a window
    // appears reuse it for as long as it is the same process.
    var verifiedOnce = false
    return try await ensureRunning(
      running: {
        defer { verifiedOnce = true }
        return verifiedOnce ? try AppProcess.current(app) : try AppProcess.verify(app)
      },
      launch: {
        guard let record = AppResolver.record(forBundleAtPath: app.path),
          AppCatalog.sameIdentity(record.identity, app.identity)
        else {
          throw HelperError(.appNotAllowed, "This app no longer matches what the owner approved.")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = false
        configuration.addsToRecentItems = false
        do {
          _ = try await NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: app.path), configuration: configuration)
        } catch {
          throw HelperError(
            .failed, "\(app.identity.displayName) could not be started on this Mac.")
        }
      },
      windowReady: { pid in
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
        AppObserver.applyManualAccessibilityIfNeeded(app: app, applicationElement: element)
        return (try? KeyWindow.resolve(applicationElement: element)) != nil
      },
      hidden: { NSRunningApplication(processIdentifier: $0)?.isHidden == true },
      windowExists: { AppWindows.hasWindow(processIdentifier: $0) },
      windowOnScreen: { AppWindows.hasWindow(processIdentifier: $0, onThisSpace: true) },
      frontmost: {
        await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier }
      },
      check: check)
  }
}
