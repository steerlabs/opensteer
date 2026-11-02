import XCTest
@testable import PhoneDisplayCore
final class KeyframeFenceTests: XCTestCase {
  func testFailureDuringKeyEnqueueCannotBeClearedByThatKey() {
    var fence = KeyframeFence()
    let keyAdmission = fence.captureLoss()
    fence.lost()
    fence.enqueued(key: true, lossAtAdmission: keyAdmission)
    XCTAssertFalse(fence.allows(key: false))
    fence.enqueued(key: true, lossAtAdmission: fence.captureLoss())
    XCTAssertTrue(fence.allows(key: false))
  }
  func testOnlySuccessfulKeyAdmissionRestoresReferences() {
    var fence = KeyframeFence()
    XCTAssertFalse(fence.allows(key: false))
    XCTAssertTrue(fence.allows(key: true))
    // Merely attempting a key (or admitting a delta) cannot repair loss.
    fence.enqueued(key: false, lossAtAdmission: fence.captureLoss())
    XCTAssertFalse(fence.allows(key: false))
    fence.enqueued(key: true, lossAtAdmission: fence.captureLoss())
    XCTAssertTrue(fence.allows(key: false))
    fence.lost()
    XCTAssertFalse(fence.allows(key: false))
    XCTAssertTrue(fence.allows(key: true))
    fence.enqueued(key: true, lossAtAdmission: fence.captureLoss()) // Hidden replay keys also restore references.
    XCTAssertTrue(fence.allows(key: false))
  }
}
