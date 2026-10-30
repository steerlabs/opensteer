import CoreGraphics
import XCTest
@testable import ComputerUseCore

final class OwnerInputStateTests: XCTestCase {
  func testAgentWaitsForPersonBatchAndIdleAttachmentDoesNotExclude() async throws {
    let lane = AppMutationCoordinator()
    await lane.beginPerson()
    let started = expectation(description: "agent submitted")
    let entered = Locked(false)
    let agent = Task {
      started.fulfill()
      try await lane.beginAgent()
      entered.withLock { $0 = true }
      lane.endAgent()
    }
    await fulfillment(of: [started], timeout: 1)
    XCTAssertFalse(entered.current)
    lane.endPerson()
    try await agent.value
    XCTAssertTrue(entered.current)
    try await lane.beginAgent()
    lane.endAgent()
  }

  func testAgentFailsOnlyWhilePersonContactIsHeld() async throws {
    let lane = AppMutationCoordinator()
    await lane.beginPerson()
    lane.setHeld(true, attachment: "person")
    lane.endPerson()
    do {
      try await lane.beginAgent()
      lane.endAgent()
      XCTFail("An agent must not enter a held contact")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .failed)
      XCTAssertEqual(error.message, "A person is pressing in this app; try again.")
    }
    await lane.beginPerson()
    lane.setHeld(false, attachment: "person")
    lane.endPerson()
    try await lane.beginAgent()
    lane.endAgent()
  }

  func testPersonBatchWaitsForAgentAXMutation() async throws {
    let lane = AppMutationCoordinator()
    try await lane.beginAgent()
    let submitted = expectation(description: "person submitted")
    let effects = Locked<[String]>([])
    let person = Task {
      submitted.fulfill()
      await lane.beginPerson()
      effects.withLock { $0.append("person") }
      lane.endPerson()
    }
    await fulfillment(of: [submitted], timeout: 1)
    XCTAssertTrue(effects.current.isEmpty)
    effects.withLock { $0.append("AX value") }
    lane.endAgent()
    await person.value
    XCTAssertEqual(effects.current, ["AX value", "person"])
    XCTAssertEqual(lane.revision, 1)
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

  func testIndependentPersonInputHasVisibleStopPill() {
    var model = OverlayModel()
    let app = OverlayModel.App(key: "fixture", name: "Fixture", access: .readWrite, path: "/Fixture.app")
    let now = Date()
    model.update(sessions: [.init(id: "owner", threadTitle: nil, apps: [app], ownerInput: true)],
      ending: .ended, at: now, pointerNear: false)
    let pill = model.presentation(at: now).pill
    XCTAssertEqual(pill?.controls, .session)
    XCTAssertEqual(pill?.status, "Sharing Fixture")
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
