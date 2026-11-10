import XCTest
@testable import PhoneBrowserCore

final class StorageAndCaptureTests: XCTestCase {
  func testReenrollmentDoesNotAdvertiseTheRemovedRunnersErasureRecords() throws {
    var manifest = ProfileManifest()
    let removed = ProfileBinding(deploymentId: "deployment", profileId: "old", runnerId: "removed",
      storageInstanceId: manifest.storageInstanceId, bindingId: UUID(), engine: "wkwebview")
    var current = removed
    current.profileId = "new"; current.runnerId = "current"; current.bindingId = UUID()
    _ = try manifest.ensure(removed, initialized: false, identifiers: [])
    try manifest.beginErasure(removed, deletionId: UUID())
    _ = try manifest.ensure(current, initialized: false, identifiers: [])
    manifest = try JSONDecoder().decode(ProfileManifest.self, from: JSONEncoder().encode(manifest))
    XCTAssertEqual(manifest.inventory(deploymentId: "deployment", runnerId: "current").map(\.binding), [current])
    XCTAssertTrue(manifest.entries.contains { $0.binding == removed && $0.deletionId != nil })
  }
  func testManifestSurvivesRestartAndNeverRecreatesDeletedOrMissingStorage() throws {
    let binding = ProfileBinding(deploymentId: "deployment", profileId: "profile", runnerId: "runner",
      storageInstanceId: UUID(), bindingId: UUID(), engine: "wkwebview")
    var manifest = ProfileManifest()
    XCTAssertThrowsError(try manifest.ensure(binding, initialized: true, identifiers: []))
    let identifier = try manifest.ensure(binding, initialized: false, identifiers: [])
    try manifest.markInitialized(binding)
    manifest = try JSONDecoder().decode(ProfileManifest.self, from: JSONEncoder().encode(manifest))
    XCTAssertThrowsError(try manifest.ensure(binding, initialized: true, identifiers: []))
    XCTAssertEqual(try manifest.ensure(binding, initialized: true, identifiers: [identifier]), identifier)
    let deletion = UUID()
    try manifest.beginErasure(binding, deletionId: deletion)
    manifest = try JSONDecoder().decode(ProfileManifest.self, from: JSONEncoder().encode(manifest))
    XCTAssertEqual(manifest.entries.first?.deletionId, deletion)
    XCTAssertThrowsError(try manifest.ensure(binding, initialized: false, identifiers: [identifier]))
    try manifest.completeErasure(binding)
    XCTAssertTrue(manifest.entries.first?.erased == true)
    XCTAssertThrowsError(try manifest.ensure(binding, initialized: false, identifiers: []))
    var wrong = binding
    wrong.runnerId = "other-runner"
    XCTAssertThrowsError(try manifest.beginErasure(wrong, deletionId: UUID()))
  }

  func testCaptureCreditSingleFlightForegroundAndStaleAcknowledgements() throws {
    var capture = CaptureDemandState()
    try capture.set(channel: "viewer", density: 1, frames: true, window: 1)
    XCTAssertTrue(capture.begin(now: 0, foreground: true))
    XCTAssertFalse(capture.begin(now: 1, foreground: true))
    capture.complete(token: "one")
    XCTAssertFalse(capture.begin(now: 1, foreground: true))
    capture.ack(channel: "viewer", token: "old")
    XCTAssertFalse(capture.begin(now: 1, foreground: true))
    capture.ack(channel: "viewer", token: "one")
    XCTAssertFalse(capture.begin(now: 1, foreground: false))
    XCTAssertTrue(capture.begin(now: 1, foreground: true))
    capture.cancel()
    XCTAssertFalse(capture.begin(now: 1.01, foreground: true))
    try capture.set(channel: "viewer", density: 1, frames: false, window: 1)
    XCTAssertFalse(capture.begin(now: 3, foreground: true))
    XCTAssertThrowsError(try capture.set(channel: "bad", density: 9, frames: true, window: 2))
  }

  func testAnchorClampsToPlayableScrollRangeAfterResize() {
    XCTAssertEqual(ScrollAnchor.clamped(target: 900, content: 1000, viewport: 400, leadingInset: 0), 600)
    XCTAssertEqual(ScrollAnchor.clamped(target: -40, content: 200, viewport: 400, leadingInset: 12), -12)
    XCTAssertEqual(ScrollAnchor.clamped(target: .nan, content: 1000, viewport: 400, leadingInset: 0), 0)
  }

  func testNewDemandCannotReceiveAnOlderInFlightHeaderCapture() throws {
    var capture = CaptureDemandState()
    XCTAssertTrue(capture.begin(now: 0, foreground: true, picture: true))
    try capture.set(channel: "new-viewer", density: 2, frames: true, window: 1)
    capture.complete(token: "small-header-frame")
    XCTAssertNil(capture.channels["new-viewer"]?.token)
  }
}
