import Foundation
import XCTest
@testable import PasswordsBrokerKit

@MainActor
private final class FakeApplication: ReplacementRunningApplication {
  let bundleURL: URL?
  let executableURL: URL?
  let processIdentifier: pid_t
  private(set) var isTerminated = false
  private(set) var terminationRequests = 0
  let terminates: Bool

  init(bundleURL: URL?, executableURL: URL?, processIdentifier: pid_t, terminates: Bool) {
    self.bundleURL = bundleURL
    self.executableURL = executableURL
    self.processIdentifier = processIdentifier
    self.terminates = terminates
  }

  func terminate() -> Bool {
    terminationRequests += 1
    if terminates { isTerminated = true }
    return terminates
  }
}

/// B16: `--prepare-replacement` stops only the canonical broker of this build.
@MainActor
final class ReplacementTests: XCTestCase {
  private let paths = BrokerPaths(root: URL(fileURLWithPath: "/tmp/pwr/Passwords (Development)"))
  private let bundle = ReplacementFileIdentity(device: 1, inode: 100)
  private let executable = ReplacementFileIdentity(device: 1, inode: 101)

  private func identifies(_ url: URL) -> ReplacementFileIdentity? {
    switch url.standardizedFileURL.path {
    case paths.application.standardizedFileURL.path: return bundle
    case paths.executable.standardizedFileURL.path: return executable
    case "/Applications/Opensteer Passwords.app": return ReplacementFileIdentity(device: 2, inode: 200)
    case "/Applications/Opensteer Passwords.app/Contents/MacOS/Opensteer Passwords":
      return ReplacementFileIdentity(device: 2, inode: 201)
    default: return nil
    }
  }

  private func prepare(_ applications: [FakeApplication], validates: Bool = true, current: pid_t = 99) -> Bool {
    BrokerReplacement.prepare(
      applications: applications, canonicalBundle: paths.application, canonicalExecutable: paths.executable,
      currentProcessIdentifier: current, timeout: 0.2, pollInterval: 0.01, identifies: identifies,
      validates: { _ in validates })
  }

  private func canonical(_ pid: pid_t, terminates: Bool = true) -> FakeApplication {
    FakeApplication(bundleURL: paths.application, executableURL: paths.executable, processIdentifier: pid, terminates: terminates)
  }

  func testOnlyTheCanonicalBrokerIsAskedToQuit() {
    let running = canonical(41)
    let elsewhere = FakeApplication(
      bundleURL: URL(fileURLWithPath: "/Applications/Opensteer Passwords.app"),
      executableURL: URL(fileURLWithPath: "/Applications/Opensteer Passwords.app/Contents/MacOS/Opensteer Passwords"),
      processIdentifier: 42, terminates: true)
    let me = canonical(99)
    XCTAssertTrue(prepare([running, elsewhere, me]))
    XCTAssertEqual(running.terminationRequests, 1)
    XCTAssertEqual(elsewhere.terminationRequests, 0)
    XCTAssertEqual(me.terminationRequests, 0)
  }

  func testNothingRunningNeedsNothing() {
    XCTAssertTrue(prepare([]))
  }

  func testAnUnverifiedBrokerIsNotTrusted() {
    let running = canonical(41)
    XCTAssertFalse(prepare([running], validates: false))
    XCTAssertEqual(running.terminationRequests, 0)
  }

  func testABrokerThatDoesNotQuitIsAFailure() {
    XCTAssertFalse(prepare([canonical(41, terminates: false)]))
  }

  func testAnUnidentifiableBrokerIsAFailure() {
    let ghost = FakeApplication(
      bundleURL: URL(fileURLWithPath: "/nowhere.app"), executableURL: nil, processIdentifier: 41, terminates: true)
    XCTAssertFalse(prepare([ghost]))
  }

  func testNoInstalledBundleWithOneRunningIsAFailure() {
    let empty = BrokerPaths(root: URL(fileURLWithPath: "/tmp/pwr/none"))
    let running = FakeApplication(
      bundleURL: empty.application, executableURL: empty.executable, processIdentifier: 41, terminates: true)
    XCTAssertFalse(
      BrokerReplacement.prepare(
        applications: [running], canonicalBundle: empty.application, canonicalExecutable: empty.executable,
        currentProcessIdentifier: 99, timeout: 0.1, pollInterval: 0.01, identifies: { _ in nil }, validates: { _ in true }))
    XCTAssertTrue(
      BrokerReplacement.prepare(
        applications: [], canonicalBundle: empty.application, canonicalExecutable: empty.executable,
        currentProcessIdentifier: 99, identifies: { _ in nil }, validates: { _ in true }))
  }
}
