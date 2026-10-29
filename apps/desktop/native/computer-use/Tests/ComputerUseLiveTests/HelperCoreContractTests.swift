import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class HelperCoreContractTests: XCTestCase {
  func testThisMacsCatalogResolvesSafariAndFinder() async throws {
    let catalog = AppCatalog()
    for (query, bundleId) in [("Safari", "com.apple.Safari"), ("Finder", "com.apple.finder")] {
      let record = try await catalog.resolve(query: query)
      XCTAssertEqual(record.identity.bundleId, bundleId)
    }
  }

  func testSigningIdentityReadsTheTeamOfATeamSignedBundle() throws {
    let selector = Process()
    selector.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    selector.arguments = ["-p"]
    let output = Pipe()
    selector.standardOutput = output
    try selector.run()
    selector.waitUntilExit()
    let developer = String(
      decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let xcode = URL(fileURLWithPath: developer).deletingLastPathComponent()
      .deletingLastPathComponent()
    guard xcode.pathExtension == "app" else {
      throw XCTSkip("The selected developer directory is not inside Xcode.app.")
    }
    var staticCode: SecStaticCode?
    XCTAssertEqual(SecStaticCodeCreateWithPath(xcode as CFURL, [], &staticCode), errSecSuccess)
    let identity = try XCTUnwrap(AppCatalog.signingIdentity(of: try XCTUnwrap(staticCode)))
    XCTAssertEqual(identity.identifier, "com.apple.dt.Xcode")
    XCTAssertEqual(identity.teamId, "59GAB85EFG")
    XCTAssertEqual(AppCatalog.teamIdentifier(forBundleAt: xcode), "59GAB85EFG")
  }

  @MainActor
  func testRunningTeamSignedAppsMatchTheirOwnBundleIdentity() throws {
    var checked = 0
    for application in NSWorkspace.shared.runningApplications {
      guard let url = application.bundleURL, url.pathExtension == "app",
        let record = AppResolver.record(forBundleAtPath: url.path),
        record.identity.teamId != nil
      else { continue }
      XCTAssertTrue(
        AppCatalog.runningApplication(
          application, matches: record.identity, bundlePath: record.path),
        record.identity.bundleId)
      checked += 1
      if checked == 5 { break }
    }
    if checked == 0 { throw XCTSkip("No team-signed app is running on this Mac.") }
  }
}
