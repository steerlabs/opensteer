import CoreGraphics
import XCTest
@testable import ComputerUseCore

final class OwnerInputStateTests: XCTestCase {
  @WorkActor
  func testEveryAgentBatchRequiresTheCurrentControlObservation() async throws {
    let fence = OwnerInputFence()
    let app = AppSessionState(
      identity: AppIdentity(bundleId: "com.opensteer.epoch-fixture", displayName: "Epoch", teamId: nil),
      path: "/absent/Epoch.app", ownerInputFence: fence)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    func batch(_ actions: [ActionRequest] = []) async throws -> ActionRunner.RunResult {
      try await ActionRunner.run(actions: actions, app: app, observationId: "",
        cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    }
    func observe() {
      app.record(LatestObservation(
        observationId: UUID().uuidString, processIdentifier: 1, windowID: 1,
        windowFrame: CGRect(x: 0, y: 0, width: 100, height: 100),
        coordinates: ObservationCoordinates(cropOrigin: .zero, scale: 1,
          geometry: Observation.Geometry(width: 100, height: 100)),
        elements: [], takenAt: Date()))
    }
    let initial = try await batch()
    XCTAssertNil(initial.error)
    XCTAssertEqual(app.observationControlEpoch, 0)
    for controller in ["first", "second"] {
      let epoch = try fence.acquire(controller)
      try fence.hold(controller, epoch: epoch)
      app.invalidateOwnerInputObservations()
      XCTAssertTrue(fence.release(controller))
      fence.finishRelease(controller)
      let batches: [[ActionRequest]] = [[], [.key(keys: "x")]]
      for actions in batches {
        do {
          _ = try await batch(actions)
          XCTFail("Every batch needs an observation after the person used the app")
        } catch let error as HelperError {
          XCTAssertEqual(error.code, .staleObservation)
          XCTAssertTrue(error.message.localizedCaseInsensitiveContains("person"))
          XCTAssertTrue(error.message.localizedCaseInsensitiveContains("observe"))
        }
      }
      observe()
      let refreshed = try await batch()
      XCTAssertNil(refreshed.error)
      // A stale rejection must have ended its ticket, or the next hold fails.
    }
  }

  @WorkActor
  func testOneAppsLeaseDoesNotStaleAnotherAppsAgentBatch() async throws {
    let leased = OwnerInputFence()
    let other = AppSessionState(
      identity: AppIdentity(bundleId: "com.opensteer.other-fixture", displayName: "Other", teamId: nil),
      path: "/absent/Other.app", ownerInputFence: OwnerInputFence())
    let epoch = try leased.acquire("person")
    try leased.hold("person", epoch: epoch)
    let monitor = WindowMonitor()
    defer { monitor.stop() }
    let result = try await ActionRunner.run(actions: [], app: other, observationId: "",
      cancellation: SessionCancellation(), monitor: monitor, overlay: nil)
    XCTAssertNil(result.error)
    XCTAssertEqual(other.ownerInputFence.epoch, 0)
  }

  func testAdmittedAgentCannotDeliverAfterTakeoverAndHeldWaitsForDrain() async throws {
    let fence = OwnerInputFence()
    let other = OwnerInputFence()
    let agent = try fence.beginAgent()
    let unaffected = try other.beginAgent()
    let epoch = try fence.acquire("person")
    var effects = 0
    XCTAssertThrowsError(try fence.hold("person", epoch: epoch))
    do { try fence.checkAgent(agent); effects += 1 } catch {}
    XCTAssertNoThrow(try other.checkAgent(unaffected))
    fence.endAgent(agent)
    await fence.drain()
    try fence.hold("person", epoch: epoch)
    do { try fence.checkAgent(agent); effects += 1 } catch {}
    XCTAssertEqual(effects, 0)
    XCTAssertTrue(fence.isHeld("person", epoch: epoch))
    other.endAgent(unaffected)
  }

  func testTakeoverFencesAndDrainsBeforeHeld() async throws {
    let fence = OwnerInputFence()
    let agent = try fence.beginAgent()
    let epoch = try fence.acquire("one")
    XCTAssertThrowsError(try fence.beginAgent())
    XCTAssertThrowsError(try fence.checkAgent(agent))
    XCTAssertThrowsError(try fence.hold("one", epoch: epoch))
    fence.endAgent(agent)
    await fence.drain()
    try fence.hold("one", epoch: epoch)
    XCTAssertThrowsError(try fence.acquire("two"))
    XCTAssertTrue(fence.isHeld("one", epoch: epoch))
  }

  func testReleaseRemainsFencedUntilCleanupAndRotatesEpoch() throws {
    let fence = OwnerInputFence()
    let epoch = try fence.acquire("one")
    try fence.hold("one", epoch: epoch)
    XCTAssertFalse(fence.release("wrong"))
    XCTAssertTrue(fence.release("one"))
    XCTAssertFalse(fence.isHeld("one", epoch: epoch))
    XCTAssertThrowsError(try fence.beginAgent())
    fence.finishRelease("one")
    let next = try fence.beginAgent()
    XCTAssertNotEqual(next.epoch, epoch)
    fence.endAgent(next)
  }

  func testQueueBoundsOrderAndInvalidation() throws {
    let lane = OwnerInputAdmission(maxBatches: 2, maxBytes: 100)
    let first = try lane.admit(sequence: 0, bytes: 40)
    XCTAssertThrowsError(try lane.admit(sequence: 0, bytes: 1))
    let second = try lane.admit(sequence: 1, bytes: 50)
    XCTAssertThrowsError(try lane.admit(sequence: 2, bytes: 1))
    lane.complete(first)
    XCTAssertThrowsError(try lane.admit(sequence: 2, bytes: 51))
    lane.invalidate()
    XCTAssertFalse(lane.isCurrent(second))
    XCTAssertEqual(lane.pendingBatches, 0)
    XCTAssertThrowsError(try lane.admit(sequence: 3, bytes: 1))
  }

  func testIndependentOwnerControlHasVisibleStopPill() {
    var model = OverlayModel()
    let app = OverlayModel.App(key: "fixture", name: "Fixture", access: .readWrite, path: "/Fixture.app")
    let now = Date()
    model.update(sessions: [.init(id: "owner", threadTitle: nil, apps: [app], ownerInput: true)],
      ending: .ended, at: now, pointerNear: false)
    let pill = model.presentation(at: now).pill
    XCTAssertEqual(pill?.controls, .session)
    XCTAssertEqual(pill?.status, "Remote control of Fixture")
  }

  func testCaptureIncarnationNeverAcceptsRetiredSamples() {
    let fence = OwnerSampleFence()
    let old = fence.current
    XCTAssertTrue(fence.accepts(old))
    fence.retire()
    XCTAssertFalse(fence.accepts(old))
    let next = fence.start()
    XCTAssertGreaterThan(next.generation, old.generation)
    XCTAssertFalse(fence.accepts(old))
    XCTAssertTrue(fence.accepts(next))
    fence.retire()
    XCTAssertFalse(fence.accepts(next))
  }
  func testRichPasteMetadataRefusesBeforeDispatch() throws {
    let data = Data(#"{"kind":"paste","items":[{"type":"image/png","size":64}]}"#.utf8)
    let event = try JSONDecoder().decode(MacOwnerInput.Event.self, from: data)
    XCTAssertThrowsError(try event.validate()) { error in
      XCTAssertEqual((error as? MacOwnerInput.Refusal)?.reason, "unsupported")
    }
  }

  func testBurstMailboxKeepsOneDrainAndNeverStrandsAnArrival() {
    let mailbox = OwnerInputMailbox<Int>()
    XCTAssertTrue(mailbox.append(1))
    XCTAssertFalse(mailbox.append(2))
    XCTAssertEqual(mailbox.pop(), 1)
    XCTAssertFalse(mailbox.finishIfEmpty())
    XCTAssertEqual(mailbox.pop(), 2)
    XCTAssertTrue(mailbox.finishIfEmpty())
    XCTAssertTrue(mailbox.append(3))
    XCTAssertEqual(mailbox.pop(), 3)
    XCTAssertTrue(mailbox.finishIfEmpty())
  }

  func testFocusRoundsShareOneNonblockingGate() async {
    let gate = OwnerFocusGate()
    await gate.acquire()
    let started = expectation(description: "second focus round started")
    let entered = Locked(false)
    let second = Task {
      started.fulfill()
      await gate.acquire()
      entered.withLock { $0 = true }
      gate.release()
    }
    await fulfillment(of: [started], timeout: 1)
    XCTAssertFalse(entered.current)
    gate.release()
    await second.value
    XCTAssertTrue(entered.current)
  }

  func testHeldPointerCrossesPictureGapsWithoutChangingRecipient() throws {
    let map = MacOwnerInputMap(generation: 1, crop: CGRect(x: 0, y: 0, width: 300, height: 100),
      windows: [.init(windowID: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
        .init(windowID: 2, frame: CGRect(x: 200, y: 0, width: 100, height: 100))], revision: 1)
    let down = try map.target(x: 0.1, y: 0.5, process: 123)
    let gap = try map.target(x: 0.5, y: 0.5, process: 123, pinned: down)
    XCTAssertEqual(gap.windowID, down.windowID)
    XCTAssertEqual(gap.windowPoint.x, 150)
    let sibling = try map.target(x: 0.9, y: 0.5, process: 123, pinned: down)
    XCTAssertEqual(sibling.windowID, down.windowID)
    XCTAssertThrowsError(try map.target(x: 0.5, y: 0.5, process: 123))
  }

}
