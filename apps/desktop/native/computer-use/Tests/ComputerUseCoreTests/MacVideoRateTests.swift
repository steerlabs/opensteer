import XCTest
@testable import ComputerUseCore

final class MacVideoRateTests: XCTestCase {
  /// A Host without the profile keeps the original fixed budget and cadence.
  func testLegacyStartKeepsTheOriginalBudgetAndIgnoresCaps() {
    var rate = MacVideoRate(maxFps: 30, mode: .legacy)
    rate.setLinkCap(800_000)
    XCTAssertFalse(rate.acknowledged(delay: 2, now: 5, width: 1920, height: 1248))
    XCTAssertEqual(rate.mode, .legacy)
    XCTAssertEqual(rate.plan(width: 1920, height: 1248), .init(bitrate: MacVideoRate.legacyBitrate, fps: 30))
  }

  /// Uncapped, the budget follows the picture size and the full cadence fits;
  /// a viewer cap lowers the budget and the cadence steps down with it.
  func testBudgetFollowsSizeAndViewerCap() {
    var rate = MacVideoRate(maxFps: 60, mode: .negotiated(cap: nil))
    XCTAssertEqual(rate.plan(width: 1920, height: 1248), .init(bitrate: 20_000_000, fps: 60))
    XCTAssertEqual(rate.plan(width: 1180, height: 766), .init(bitrate: 8_134_920, fps: 60))
    XCTAssertEqual(rate.plan(width: 320, height: 208).bitrate, 1_500_000, "A tiny window keeps a floor")
    rate.setLinkCap(2_000_000)
    XCTAssertEqual(rate.plan(width: 1180, height: 766), .init(bitrate: 2_000_000, fps: 30))
    rate.setLinkCap(600_000)
    XCTAssertEqual(rate.plan(width: 1180, height: 766), .init(bitrate: 600_000, fps: 10))
    rate.setLinkCap(nil)
    XCTAssertEqual(rate.plan(width: 1180, height: 766).fps, 60)
  }

  /// The cadence never exceeds what the Host asked for, even at its floor.
  func testCadenceNeverExceedsTheRequestedMaximum() {
    let rate = MacVideoRate(maxFps: 5, mode: .negotiated(cap: 400_000))
    XCTAssertEqual(rate.plan(width: 1920, height: 1248).fps, 5)
    XCTAssertEqual(MacVideoRate(maxFps: 24, mode: .negotiated(cap: nil))
      .plan(width: 640, height: 400).fps, 20)
  }

  /// A start carries the profile exactly when it carries `maxBitrate`, null
  /// included, and only a connection that negotiated it may send one.
  func testStartAndDemandAcceptTheProfileOnlyWhenNegotiated() throws {
    func start(_ extra: String) throws -> MacWindowVideoRegistry.StartParams {
      try JSONDecoder().decode(MacWindowVideoRegistry.StartParams.self, from: Data("""
        {"streamId":"dsp_x","target":{"kind":"mac-window","bindingId":"b"},
         "sources":[{"kind":"owner-view","viewId":"v","generation":1}],"maxLongSide":1280\(extra)}
        """.utf8))
    }
    let legacy = try start(#","maxFps":30"#)
    XCTAssertEqual(legacy.rate, .legacy)
    XCTAssertTrue(MacVideoRegistryLimits.valid(legacy, videoProfile: nil))
    XCTAssertFalse(MacVideoRegistryLimits.valid(try start(#","maxFps":60"#), videoProfile: 1),
      "60 fps needs the Host's confirmation, not just the connection's")
    let uncapped = try start(#","maxFps":60,"maxBitrate":null"#)
    XCTAssertEqual(uncapped.rate, .negotiated(cap: nil))
    XCTAssertTrue(MacVideoRegistryLimits.valid(uncapped, videoProfile: 1))
    XCTAssertFalse(MacVideoRegistryLimits.valid(uncapped, videoProfile: nil))
    XCTAssertTrue(MacVideoRegistryLimits.valid(try start(#","maxFps":60,"maxBitrate":400000"#), videoProfile: 1))
    XCTAssertFalse(MacVideoRegistryLimits.valid(try start(#","maxFps":60,"maxBitrate":20000001"#), videoProfile: 1))
    XCTAssertFalse(MacVideoRegistryLimits.valid(try start(#","maxFps":61,"maxBitrate":null"#), videoProfile: 1))

    func demand(_ extra: String) throws -> MacWindowVideoRegistry.DemandParams {
      try JSONDecoder().decode(MacWindowVideoRegistry.DemandParams.self, from: Data("""
        {"streamId":"dsp_x","revision":2,"sources":[]\(extra)}
        """.utf8))
    }
    XCTAssertNil(try demand("").linkCap(negotiated: false) as Int??, "Absent leaves the cap alone")
    XCTAssertEqual(try demand(#","maxBitrate":null"#).linkCap(negotiated: true), .some(nil))
    XCTAssertEqual(try demand(#","maxBitrate":900000"#).linkCap(negotiated: true), .some(900_000))
    XCTAssertThrowsError(try demand(#","maxBitrate":900000"#).linkCap(negotiated: false))
    XCTAssertThrowsError(try demand(#","maxBitrate":100"#).linkCap(negotiated: true))
  }

  /// A distant Host is not a congested one: only delay beyond the path's own
  /// round trip is queueing, so a fast 300 ms path keeps its full budget.
  func testUplinkJudgesQueueingAboveThePathsOwnRoundTrip() {
    var rate = MacVideoRate(maxFps: 60, mode: .negotiated(cap: 4_000_000))
    for step in 0..<40 {
      _ = rate.acknowledged(delay: 0.3, now: Double(step) * 0.25, width: 1180, height: 766)
    }
    XCTAssertNil(rate.uplink.estimate)
    XCTAssertTrue(rate.acknowledged(delay: 0.6, now: 10.5, width: 1180, height: 766))
    XCTAssertEqual(rate.plan(width: 1180, height: 766).bitrate, 3_000_000)
  }

  /// A queueing uplink lowers the budget at most once a second; sustained
  /// healthy acknowledgements restore it until the estimate disappears.
  func testUplinkEstimateBacksOffAndRecovers() {
    var rate = MacVideoRate(maxFps: 60, mode: .negotiated(cap: 4_000_000))
    XCTAssertFalse(rate.acknowledged(delay: 0.02, now: 0, width: 1180, height: 766))
    XCTAssertTrue(rate.acknowledged(delay: 0.3, now: 1, width: 1180, height: 766))
    XCTAssertEqual(rate.plan(width: 1180, height: 766).bitrate, 3_000_000)
    XCTAssertFalse(rate.acknowledged(delay: 0.3, now: 1.5, width: 1180, height: 766))
    XCTAssertTrue(rate.acknowledged(delay: 0.3, now: 2, width: 1180, height: 766))
    XCTAssertEqual(rate.plan(width: 1180, height: 766).bitrate, 2_250_000)
    XCTAssertFalse(rate.acknowledged(delay: 0.02, now: 2.1, width: 1180, height: 766))
    XCTAssertFalse(rate.acknowledged(delay: 0.02, now: 9, width: 1180, height: 766))
    XCTAssertTrue(rate.acknowledged(delay: 0.02, now: 10.2, width: 1180, height: 766))
    XCTAssertEqual(rate.plan(width: 1180, height: 766).bitrate, 2_475_000)
    for step in 1...6 {
      _ = rate.acknowledged(delay: 0.02, now: 10.2 + Double(step) * 8, width: 1180, height: 766)
    }
    XCTAssertNil(rate.uplink.estimate, "The estimate gives way to the ceiling")
    XCTAssertEqual(rate.plan(width: 1180, height: 766).bitrate, 4_000_000)
  }
}
