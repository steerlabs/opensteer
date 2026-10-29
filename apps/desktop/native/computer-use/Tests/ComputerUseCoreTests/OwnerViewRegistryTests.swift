import Foundation
import XCTest

@testable import ComputerUseCore

@MainActor
final class OwnerViewRegistryTests: XCTestCase {
  private let app = AppIdentity(
    bundleId: "com.apple.TextEdit", displayName: "TextEdit", teamId: nil)

  // Failures: wall-clock skew, unbounded lease, renewal revival, stale generation, shared agent lane.
  func testIndependentBoundedExpiringConnectionAndGenerationAuthority() throws {
    let views = OwnerViewRegistry()
    let now: TimeInterval = 1_000
    let first = try views.open(
      id: "a", generation: 1, leaseDurationMs: 60_000, app: app, connectionID: 1,
      now: now)
    XCTAssertTrue(try views.require("a", generation: 1, connectionID: 1, now: now) === first)
    XCTAssertThrowsError(try views.require("a", generation: 1, connectionID: 2, now: now))
    XCTAssertThrowsError(
      try views.require("a", generation: 1, connectionID: 1, now: now + 61))
    try views.close("a", generation: 1, connectionID: 1)
    XCTAssertThrowsError(
      try views.open(
        id: "a", generation: 1, leaseDurationMs: 60_000, app: app, connectionID: 1,
        now: now))
    let second = try views.open(
      id: "a", generation: 2, leaseDurationMs: 60_000, app: app, connectionID: 1,
      now: now)
    XCTAssertThrowsError(try views.close("a", generation: 1, connectionID: 1))
    XCTAssertTrue(try views.require("a", generation: 2, connectionID: 1, now: now) === second)
    views.remove(connectionID: 1)
    XCTAssertThrowsError(try views.require("a", generation: 2, connectionID: 1, now: now))
  }

  func testRelativeLeaseIsBoundedAndOwnerWorkBypassesAgentLane() throws {
    let views = OwnerViewRegistry()
    let view = try views.open(
      id: "ttl", generation: 1, leaseDurationMs: 600_000, app: app, connectionID: 1, now: 500)
    XCTAssertEqual(view.expiresAt, 1_100)
    XCTAssertNoThrow(try views.require("ttl", generation: 1, connectionID: 1, now: 1_099))
    XCTAssertThrowsError(try views.require("ttl", generation: 1, connectionID: 1, now: 1_100))
    for duration in [0, -1, 600_001] {
      XCTAssertThrowsError(try views.open(
        id: "invalid", generation: 1, leaseDurationMs: duration, app: app, connectionID: 1, now: 500))
    }
    for method in ["view.open", "view.activate", "view.renew", "view.close"] {
      XCTAssertTrue(HelperRuntime.outOfBandMethods.contains(method), method)
    }
  }

  func testRenewDoesNotReviveAndReadsDoNotExtendExpiry() throws {
    let views = OwnerViewRegistry()
    let now: TimeInterval = 1_000
    let view = try views.open(
      id: "a", generation: 1, leaseDurationMs: 60_000, app: app, connectionID: 1,
      now: now)
    _ = try views.require("a", generation: 1, connectionID: 1, now: now + 30)
    XCTAssertEqual(view.expiresAt, now + 60)
    XCTAssertThrowsError(
      try views.renew(
        "a", generation: 1, leaseDurationMs: 100_000, connectionID: 1,
        now: now + 61))
  }
}
