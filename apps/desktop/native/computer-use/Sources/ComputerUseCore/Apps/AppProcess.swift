import AppKit
import Darwin
import Foundation

/// One process, told apart from any later process that reuses its pid: the
/// kernel's start time does not survive the pid being handed out again.
public struct ProcessStamp: Sendable, Equatable {
  public let processIdentifier: pid_t
  let startSeconds: UInt64
  let startMicroseconds: UInt64

  public static func of(_ processIdentifier: pid_t) -> ProcessStamp? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(processIdentifier, PROC_PIDTBSDINFO, 0, &info, size) == size else {
      return nil
    }
    return ProcessStamp(
      processIdentifier: processIdentifier,
      startSeconds: info.pbi_start_tvsec,
      startMicroseconds: info.pbi_start_tvusec)
  }

  /// Whether this exact process is still alive.
  public var isCurrent: Bool { Self.of(processIdentifier) == self }
}

/// Selecting the approved app's process (§2 "Methods": "A process is selected
/// only when its bundle path and live code identity match the approved app").
///
/// The full check reads the bundle from disk and the running code's signature,
/// which is far too slow to repeat for every chunk of `type` or tick of
/// `scroll`. It runs once per observe and once per action; the steps inside an
/// action only confirm, by `ProcessStamp`, that they are still talking to the
/// very process that check verified.
@WorkActor
public enum AppProcess {
  /// Finds and fully verifies the approved app's process.
  public static func verify(_ app: AppSessionState) throws -> pid_t {
    let running = NSRunningApplication.runningApplications(
      withBundleIdentifier: app.identity.bundleId
    ).filter { !$0.isTerminated }
    guard
      let first = running.first(where: {
        AppCatalog.runningApplication($0, matches: app.identity, bundlePath: app.path)
      })
    else {
      app.verified = nil
      if !running.isEmpty {
        throw HelperError(
          .appNotAllowed,
          "The running app no longer matches the app the owner approved. Remove it and approve it again."
        )
      }
      throw HelperError(.appNotRunning, "\(app.identity.displayName) is not running on this Mac.")
    }
    app.verified = ProcessStamp.of(first.processIdentifier)
    return first.processIdentifier
  }

  /// The verified process, when it is still the one running; otherwise the
  /// full check again. Used where one observe polls for a window.
  public static func current(_ app: AppSessionState) throws -> pid_t {
    if let verified = app.verified, verified.isCurrent,
      NSRunningApplication(processIdentifier: verified.processIdentifier)?.isTerminated == false
    {
      return verified.processIdentifier
    }
    return try verify(app)
  }

  /// An action cites one observation, so it must address that exact process.
  /// Discovering again by bundle ID could select another installation or miss
  /// a process while LaunchServices updates its app list.
  public static func verifyObserved(
    _ app: AppSessionState, readStamp: @Sendable (pid_t) -> ProcessStamp? = { ProcessStamp.of($0) }
  ) throws -> pid_t {
    guard let latest = app.latest else {
      throw HelperError(.staleObservation, "This app has not been observed yet.")
    }
    try requireSame(app.verified, "This app restarted since it was observed.", readStamp: readStamp)
    let pid = latest.processIdentifier
    guard app.verified?.processIdentifier == pid,
      let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated
    else {
      throw HelperError(.staleObservation, "This app restarted since it was observed.")
    }
    guard AppCatalog.runningApplication(running, matches: app.identity, bundlePath: app.path) else {
      throw HelperError(
        .appNotAllowed,
        "The running app no longer matches the app the owner approved. Remove it and approve it again."
      )
    }
    return pid
  }

  /// Inside one action: the process this action verified is still alive and
  /// is still the same process. A restart part way through is refused rather
  /// than followed, because the rest of the action was aimed at the old one.
  public nonisolated static func requireSame(
    _ stamp: ProcessStamp?, _ restarted: String,
    readStamp: @Sendable (pid_t) -> ProcessStamp? = { ProcessStamp.of($0) }
  ) throws {
    guard let stamp, readStamp(stamp.processIdentifier) == stamp else {
      throw HelperError(.staleObservation, restarted)
    }
  }

  /// A cheap liveness read for the idle sweep: whether any instance of the
  /// approved bundle is running. It never reads a signature, so it may run on
  /// the main actor every few seconds.
  public nonisolated static func anyInstanceRunning(bundleId: String, path: String) -> Bool {
    let expected = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).contains {
      !$0.isTerminated
        && $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expected
    }
  }
}
