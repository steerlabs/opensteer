import AppKit
import Darwin
import Foundation
import Security

/// The narrow surface used to stop the canonical broker before its bundle is
/// replaced. Retaining the `NSRunningApplication` keeps the application's
/// identity stable while its state changes.
@MainActor
protocol ReplacementRunningApplication: AnyObject {
  var bundleURL: URL? { get }
  var executableURL: URL? { get }
  var isTerminated: Bool { get }
  var processIdentifier: pid_t { get }
  func terminate() -> Bool
}

extension NSRunningApplication: ReplacementRunningApplication {}

/// Kernel identity of one file. Paths are not identities: a case-insensitive
/// volume may report another spelling of the same item.
struct ReplacementFileIdentity: Equatable {
  let device: dev_t
  let inode: ino_t
}

/// `--prepare-replacement`, run by the desktop from the copy of the new broker
/// sealed inside its own bundle before it swaps the installed bundle in.
///
/// It takes no path, pid or requirement from the caller. Only a running
/// broker at this user's canonical path for this build, which passes the
/// compiled check, is asked to quit, and success waits until it has.
@MainActor
public enum BrokerReplacement {
  public static let argument = "--prepare-replacement"
  static let gracefulTimeout: TimeInterval = 5
  static let pollInterval: TimeInterval = 0.05

  public static func prepare(development: Bool, rule: PeerRule) -> Bool {
    let paths = BrokerPaths.canonical(development: development)
    return prepare(
      applications: NSRunningApplication.runningApplications(
        withBundleIdentifier: BrokerIdentity.bundleIdentifier(development: development)),
      canonicalBundle: paths.application,
      canonicalExecutable: paths.executable,
      currentProcessIdentifier: getpid(),
      validates: { validates($0, rule: rule) }
    )
  }

  static func prepare(
    applications: [any ReplacementRunningApplication],
    canonicalBundle bundleURL: URL,
    canonicalExecutable executableURL: URL,
    currentProcessIdentifier: pid_t,
    timeout: TimeInterval = gracefulTimeout,
    pollInterval: TimeInterval = pollInterval,
    identifies: @MainActor (URL) -> ReplacementFileIdentity? = fileIdentity,
    validates: (any ReplacementRunningApplication) -> Bool
  ) -> Bool {
    guard let canonicalBundle = identity(bundleURL, using: identifies),
      let canonicalExecutable = identity(executableURL, using: identifies)
    else {
      // Nothing is installed there, so nothing there can be running.
      return applications.allSatisfy { $0.isTerminated || $0.processIdentifier == currentProcessIdentifier }
    }
    let active = applications.filter { !$0.isTerminated && $0.processIdentifier != currentProcessIdentifier }
    var candidates: [any ReplacementRunningApplication] = []
    for application in active {
      guard let bundle = identity(application.bundleURL, using: identifies),
        let executable = identity(application.executableURL, using: identifies)
      else { return false }
      if bundle != canonicalBundle && executable != canonicalExecutable { continue }
      candidates.append(application)
    }
    guard
      candidates.allSatisfy({
        identity($0.bundleURL, using: identifies) == canonicalBundle
          && identity($0.executableURL, using: identifies) == canonicalExecutable && validates($0)
      })
    else { return false }

    for application in candidates where !application.isTerminated {
      if !application.terminate(), !application.isTerminated { return false }
    }
    let deadline = Date().addingTimeInterval(max(0, timeout))
    while candidates.contains(where: { !$0.isTerminated }) {
      guard Date() < deadline else { return false }
      RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(max(0.001, pollInterval))))
    }
    return true
  }

  private static func identity(
    _ url: URL?, using identifies: @MainActor (URL) -> ReplacementFileIdentity?
  ) -> ReplacementFileIdentity? {
    guard let url else { return nil }
    return identifies(url.standardizedFileURL)
  }

  static func fileIdentity(_ url: URL) -> ReplacementFileIdentity? {
    var information = stat()
    let descriptor = url.withUnsafeFileSystemRepresentation { path -> Int32 in
      guard let path else { return -1 }
      return Darwin.open(path, O_RDONLY | O_CLOEXEC)
    }
    guard descriptor >= 0 else { return nil }
    defer { Darwin.close(descriptor) }
    guard Darwin.fstat(descriptor, &information) == 0 else { return nil }
    return ReplacementFileIdentity(device: information.st_dev, inode: information.st_ino)
  }

  private static func validates(_ application: any ReplacementRunningApplication, rule: PeerRule) -> Bool {
    switch rule {
    case .codeRequirement(let text):
      let attributes = [kSecGuestAttributePid as String: NSNumber(value: application.processIdentifier)] as CFDictionary
      var guest: SecCode?
      guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest else { return false }
      var requirement: SecRequirement?
      guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else {
        return false
      }
      return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    case .sameUser:
      var information = proc_bsdinfo()
      let expected = Int32(MemoryLayout<proc_bsdinfo>.size)
      let read = withUnsafeMutablePointer(to: &information) {
        proc_pidinfo(application.processIdentifier, PROC_PIDTBSDINFO, 0, $0, expected)
      }
      return read == expected && information.pbi_uid == getuid()
    }
  }
}
