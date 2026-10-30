import XCTest
@testable import ComputerUseCore

final class MacVideoCreditTests: XCTestCase {
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
    XCTAssertTrue(credit.acknowledge(1))
    XCTAssertEqual(credit.admit(now: 0.1), .submit(key: false))
    credit.returned()

    XCTAssertTrue(credit.reserve(sequence: 2, bytes: 100, now: 1))
    XCTAssertEqual(credit.admit(now: 1 + MacVideoCredit.maxAckAge), .withheld("ack-age"))
    XCTAssertTrue(credit.acknowledge(2))
    XCTAssertEqual(credit.admit(now: 2), .submit(key: false))
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
    XCTAssertFalse(credit.acknowledge(3), "acknowledgements arrive only in send order")
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
    credit.returned()

    credit.lost()
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
    credit.reset()
    XCTAssertTrue(credit.outstanding.isEmpty)
    XCTAssertEqual(credit.admit(now: 0.3), .submit(key: true))
  }
}
