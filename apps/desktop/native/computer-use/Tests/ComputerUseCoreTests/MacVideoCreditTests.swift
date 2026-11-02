import XCTest
@testable import ComputerUseCore

final class MacVideoCreditTests: XCTestCase {
  func testFinalStaticSampleWaitsForBothEncoderAndPeerCredit() {
    var credit = MacVideoCredit()
    var samples = MacVideoPendingSample<Int>()
    for sample in 1...3 {
      samples.replace(sample)
      guard case .submit = credit.admit(now: 0) else { return XCTFail("Initial sample withheld") }
    }
    for sample in 4...5 {
      samples.replace(sample)
      XCTAssertEqual(credit.admit(now: 0), .withheld("inFlight"))
      samples.hold()
    }
    // The callback reserves its output before returning submission credit.
    XCTAssertTrue(credit.reserve(sequence: 1, bytes: MacVideoCredit.maxOutstandingBytes, now: 0))
    credit.returned()
    XCTAssertTrue(samples.schedule())
    XCTAssertFalse(samples.schedule(), "Credit events coalesce without retaining more buffers")
    XCTAssertEqual(samples.take(), 5, "Retry the newest sample, not the first withheld one")
    samples.replace(5)
    XCTAssertEqual(credit.admit(now: 0.1), .withheld("bytes"))
    samples.hold()
    XCTAssertNil(credit.acknowledge(99), "Unknown receipt released the waiting sample")
    XCTAssertNotNil(credit.acknowledge(1))
    XCTAssertTrue(samples.schedule())
    XCTAssertEqual(samples.take(), 5)
    samples.replace(5)
    XCTAssertEqual(credit.admit(now: 0.2), .submit(key: false))
    XCTAssertFalse(samples.schedule(), "No later capture is needed and no sample is duplicated")
    XCTAssertNil(credit.acknowledge(1))
  }

  func testFinalStaticSampleResumesAfterOldestReceiptReturns() {
    var credit = MacVideoCredit()
    var samples = MacVideoPendingSample<(pts: Int, generation: Int)>()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    XCTAssertTrue(credit.reserve(sequence: 1, bytes: 10, now: 0))
    credit.returned()
    samples.replace((pts: 1234, generation: 2))
    XCTAssertEqual(credit.admit(now: 1), .withheld("ack-age"))
    samples.hold()
    XCTAssertNotNil(credit.acknowledge(1))
    XCTAssertTrue(samples.schedule())
    let pending = samples.take()
    XCTAssertEqual(pending?.pts, 1234)
    XCTAssertEqual(pending?.generation, 2, "The original sample metadata travels with the retry")
    samples.replace(pending!)
    XCTAssertEqual(credit.admit(now: 1.1), .submit(key: false))
    XCTAssertFalse(samples.schedule())
  }

  func testRetirementAndNewAdmissionCancelAQueuedSample() {
    var samples = MacVideoPendingSample<Int>()
    samples.replace(1); samples.hold()
    XCTAssertTrue(samples.schedule())
    samples.replace(2) // A newer capture was admitted before the queued task ran.
    XCTAssertNil(samples.take())
    samples.hold()
    XCTAssertTrue(samples.schedule())
    samples.clear(keepingCurrent: true) // Warming keeps a refresh source, never a pending retry.
    XCTAssertEqual(samples.current, 2)
    XCTAssertNil(samples.take())
    samples.hold()
    XCTAssertTrue(samples.schedule())
    samples.clear() // A geometry/source change retires the buffer as well.
    XCTAssertNil(samples.current)
    samples.replace(3); samples.hold()
    XCTAssertFalse(samples.schedule(), "The queued task still owns the only scheduling slot")
    XCTAssertEqual(samples.take(), 3)
  }

  /// A withheld sample never reaches the encoder, so the reference chain is
  /// intact and the next submission stays a cheap delta frame.
  func testWithheldSamplesDoNotForceKeyFrames() {
    var credit = MacVideoCredit()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    XCTAssertEqual(credit.admit(now: 0), .submit(key: false))
    XCTAssertEqual(credit.admit(now: 0), .submit(key: false))
    XCTAssertEqual(credit.admit(now: 0), .withheld("inFlight"))
    credit.returned()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: false))
    (0..<3).forEach { _ in credit.returned() }

    XCTAssertTrue(credit.reserve(sequence: 1, bytes: MacVideoCredit.maxOutstandingBytes, now: 0))
    XCTAssertEqual(credit.admit(now: 0.1), .withheld("bytes"))
    XCTAssertNotNil(credit.acknowledge(1))
    XCTAssertEqual(credit.admit(now: 0.1), .submit(key: false))
    credit.returned()

    XCTAssertTrue(credit.reserve(sequence: 2, bytes: 100, now: 1))
    XCTAssertEqual(credit.admit(now: 1 + MacVideoCredit.maxAckAge), .withheld("ack-age"))
    XCTAssertNotNil(credit.acknowledge(2))
    XCTAssertEqual(credit.admit(now: 2), .submit(key: false))
  }

  /// Refusing a legal keyframe larger than the byte budget would only request
  /// another keyframe of the same size, so a detailed window would never show.
  func testOversizedEnvelopePassesOnlyAnEmptyLane() {
    var credit = MacVideoCredit()
    let large = MacVideoCredit.maxOutstandingBytes + 512 * 1_024
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    credit.returned()
    XCTAssertTrue(credit.reserve(sequence: 1, bytes: large, now: 0))
    XCTAssertEqual(credit.admit(now: 0.01), .withheld("bytes"), "Nothing is encoded behind it")
    XCTAssertNotNil(credit.acknowledge(1))
    XCTAssertEqual(credit.admit(now: 0.02), .submit(key: false), "The delivered key needs no repeat")
    credit.returned()
    XCTAssertTrue(credit.reserve(sequence: 2, bytes: 10, now: 0.02))
    XCTAssertFalse(credit.reserve(sequence: 3, bytes: large, now: 0.02), "A busy lane keeps its bound")
    XCTAssertEqual(credit.admit(now: 0.03), .submit(key: true))
  }

  /// Submissions keep their cadence; a sample arriving early waits for its
  /// slot, and capture jitter of a few milliseconds never costs a whole slot.
  func testCadenceSpacesSubmissions() {
    var credit = MacVideoCredit()
    let interval = 1.0 / 30
    XCTAssertEqual(credit.admit(now: 0, interval: interval), .submit(key: true))
    credit.returned()
    XCTAssertEqual(credit.admit(now: 1.0 / 60, interval: interval), .withheld("cadence"))
    XCTAssertEqual(credit.cadenceWait(now: 1.0 / 60, interval: interval), interval - 1.0 / 120 - 1.0 / 60, accuracy: 1e-9)
    XCTAssertEqual(credit.admit(now: 0.031, interval: interval), .submit(key: false), "Jitter keeps the slot")
    credit.returned()
    XCTAssertEqual(credit.admit(now: 0.04, interval: 0), .submit(key: false), "Full cadence never waits")
  }

  /// The helper's media write queue follows the same rule as producer credit.
  func testMediaQueueTakesOneLargeFrameOnlyWhenEmpty() {
    let large = 1_048_576 + 4
    XCTAssertTrue(IPCConnection.mediaAdmits(queued: 0, framed: large))
    XCTAssertFalse(IPCConnection.mediaAdmits(queued: 10, framed: large))
    XCTAssertTrue(IPCConnection.mediaAdmits(queued: 10, framed: 1_048_566))
    XCTAssertFalse(IPCConnection.mediaAdmits(queued: 10, framed: 1_048_567))
  }

  /// An encoder drop emits nothing, so the peer's references stay intact. Only
  /// a requested key must be asked for again; a dropped delta changes nothing.
  func testEncoderDropsKeepReferencesButRetryARequestedKey() {
    var credit = MacVideoCredit()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    credit.dropped(key: true)
    credit.returned()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    credit.returned()
    XCTAssertTrue(credit.reserve(sequence: 1, bytes: 10, now: 0))
    XCTAssertEqual(credit.admit(now: 0), .submit(key: false))
    credit.dropped(key: false)
    credit.returned()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: false))
  }

  /// Encoded output the peer never receives, and every reset, needs a key.
  func testLostEncodedOutputAndResetForceKeyFrames() {
    var credit = MacVideoCredit()
    XCTAssertEqual(credit.admit(now: 0), .submit(key: true))
    credit.returned()
    XCTAssertTrue(credit.reserve(sequence: 1, bytes: MacVideoCredit.maxOutstandingBytes - 10, now: 0))
    XCTAssertFalse(credit.reserve(sequence: 2, bytes: 11, now: 0))
    XCTAssertEqual(credit.outstanding.map(\.sequence), [1])
    XCTAssertEqual(credit.admit(now: 0.1), .submit(key: true))
    credit.returned()

    XCTAssertTrue(credit.reserve(sequence: 3, bytes: 10, now: 0.2))
    credit.lost(3)
    XCTAssertEqual(credit.outstanding.map(\.sequence), [1])
    XCTAssertNil(credit.acknowledge(3), "acknowledgements arrive only in send order")
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
    credit.returned()

    credit.lost()
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
    credit.reset()
    XCTAssertTrue(credit.outstanding.isEmpty)
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
  }
}
