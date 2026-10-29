import AppKit
import Darwin
import Foundation
import Security

/// The narrow surface used to stop the canonical helper before its signed
/// bundle is replaced. Retaining the `NSRunningApplication` instance keeps the
/// application identity stable while its time-varying state changes.
@MainActor
protocol ReplacementRunningApplication: AnyObject {
  var bundleURL: URL? { get }
  var executableURL: URL? { get }
  var isTerminated: Bool { get }
  var processIdentifier: pid_t { get }
  func terminate() -> Bool
}

extension NSRunningApplication: ReplacementRunningApplication {}

/// Kernel identity for one filesystem object. Paths are not identities: a
/// case-insensitive volume may report a different spelling for the same item.
struct ReplacementFileIdentity: Equatable {
  let device: dev_t
  let inode: ino_t
}

/// Maintenance mode run from the helper sealed inside the desktop app, before
/// the desktop swaps a new installed copy in.
///
/// It accepts no path, pid, or requirement from the caller. Only a live helper
/// at this user's canonical path and satisfying this build's compiled policy
/// can be asked to quit.
@MainActor
public enum HelperReplacement {
  public static let argument = "--prepare-replacement"
  static let gracefulTimeout: TimeInterval = 5
  static let pollInterval: TimeInterval = 0.05

  public static func prepare() -> Bool {
    prepare(
      applications: NSRunningApplication.runningApplications(
        withBundleIdentifier: "com.opensteer.computer-use"
      ),
      currentProcessIdentifier: getpid(),
      validates: validates
    )
  }

  static func prepare(
    applications: [any ReplacementRunningApplication],
    currentProcessIdentifier: pid_t,
    timeout: TimeInterval = gracefulTimeout,
    pollInterval: TimeInterval = pollInterval,
    identifies: @MainActor (URL) -> ReplacementFileIdentity? = fileIdentity,
    validates: (any ReplacementRunningApplication) -> Bool
  ) -> Bool {
    guard let canonicalBundle = fileIdentity(HelperPaths.application, using: identifies),
      let canonicalExecutable = fileIdentity(HelperPaths.executable, using: identifies)
    else { return false }
    let active = applications.filter {
      !$0.isTerminated && $0.processIdentifier != currentProcessIdentifier
    }
    var candidates: [any ReplacementRunningApplication] = []
    for application in active {
      guard let bundle = fileIdentity(application.bundleURL, using: identifies),
        let executable = fileIdentity(application.executableURL, using: identifies)
      else { return false }
      if bundle != canonicalBundle && executable != canonicalExecutable {
        continue
      }
      candidates.append(application)
    }
    guard
      candidates.allSatisfy({
        fileIdentity($0.bundleURL, using: identifies) == canonicalBundle
          && fileIdentity($0.executableURL, using: identifies) == canonicalExecutable
          && validates($0)
      })
    else { return false }

    for application in candidates where !application.isTerminated {
      if !application.terminate(), !application.isTerminated { return false }
    }

    let deadline = Date().addingTimeInterval(max(0, timeout))
    while candidates.contains(where: { !$0.isTerminated }) {
      guard Date() < deadline else { return false }
      RunLoop.current.run(
        until: min(deadline, Date().addingTimeInterval(max(0.001, pollInterval)))
      )
    }
    return true
  }

  private static func fileIdentity(
    _ url: URL?, using identifies: @MainActor (URL) -> ReplacementFileIdentity?
  ) -> ReplacementFileIdentity? {
    guard let url else { return nil }
    return identifies(url.standardizedFileURL)
  }

  static func fileIdentity(_ url: URL) -> ReplacementFileIdentity? {
    var information = stat()
    let descriptor = url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return Int32(-1) }
      return Darwin.open(path, O_RDONLY | O_CLOEXEC)
    }
    guard descriptor >= 0 else { return nil }
    defer { Darwin.close(descriptor) }
    guard Darwin.fstat(descriptor, &information) == 0 else { return nil }
    return ReplacementFileIdentity(device: information.st_dev, inode: information.st_ino)
  }

  private static func validates(_ application: any ReplacementRunningApplication) -> Bool {
    switch PeerRequirement.label {
    case .release:
      return validatesReleaseCode(processIdentifier: application.processIdentifier)
    case .development:
      return runsAsCurrentUser(processIdentifier: application.processIdentifier)
    }
  }

  private static func validatesReleaseCode(processIdentifier: pid_t) -> Bool {
    let attributes =
      [kSecGuestAttributePid as String: NSNumber(value: processIdentifier)] as CFDictionary
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
      let guest
    else { return false }

    guard let text = HelperPeerVerifier.releaseRequirement else { return false }
    var requirement: SecRequirement?
    guard
      SecRequirementCreateWithString(
        text as CFString, [], &requirement) == errSecSuccess,
      let requirement
    else { return false }
    return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
  }

  private static func runsAsCurrentUser(processIdentifier: pid_t) -> Bool {
    var information = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.size)
    let read = withUnsafeMutablePointer(to: &information) { pointer in
      proc_pidinfo(processIdentifier, PROC_PIDTBSDINFO, 0, pointer, expected)
    }
    return read == expected && information.pbi_uid == getuid()
  }
}
