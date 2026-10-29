import Foundation
import XCTest
@testable import PasswordsBrokerKit

/// S10: the release and development brokers never share a path, and both
/// use the names the desktop app looks for.
final class BuildModeTests: XCTestCase {
  func testDevelopmentAndReleaseNeverShareAnything() {
    let release = BrokerPaths.canonical(development: false)
    let development = BrokerPaths.canonical(development: true)
    XCTAssertTrue(release.root.path.hasSuffix("/Library/Application Support/Opensteer/Passwords"))
    XCTAssertTrue(development.root.path.hasSuffix("/Library/Application Support/Opensteer/Passwords (Development)"))
    for paths in [release, development] {
      for url in [paths.socket, paths.instanceLock, paths.vault, paths.protectedFiles, paths.activity, paths.application] {
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL, paths.root.standardizedFileURL)
      }
    }
    XCTAssertNotEqual(release.socket, development.socket)
    XCTAssertNotEqual(
      BrokerIdentity.bundleIdentifier(development: false), BrokerIdentity.bundleIdentifier(development: true))
    XCTAssertEqual(release.socket.lastPathComponent, "ipc.sock")
    XCTAssertEqual(release.instanceLock.lastPathComponent, "broker.lock", "never the desktop's lifecycle.lock")
    XCTAssertEqual(release.vault.lastPathComponent, "Vault")
  }

  /// The desktop's `paths.ts` names the same bundle, executable, IDs and folders.
  func testTheDesktopUsesTheSameNames() throws {
    let url = URL(fileURLWithPath: #filePath)
      .appendingPathComponent("../../../../../src/passwords/paths.ts").standardizedFileURL
    let source = try String(contentsOf: url, encoding: .utf8)
    for name in [
      BrokerIdentity.appName, BrokerIdentity.executableName, BrokerIdentity.releaseBundleIdentifier,
      BrokerIdentity.developmentBundleIdentifier, "Passwords (Development)", "ipc.sock",
    ] {
      XCTAssertTrue(source.contains("\"\(name)\""), "apps/desktop/src/passwords/paths.ts lacks \(name)")
    }
  }
}
