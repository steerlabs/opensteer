import XCTest
@testable import PhoneDisplayCore
final class KeyframeFenceTests: XCTestCase {
  func testOnlySuccessfulKeyAdmissionRestoresReferences() {
    var fence = KeyframeFence()
    XCTAssertFalse(fence.allows(key: false))
    XCTAssertTrue(fence.allows(key: true))
    // Merely attempting a key (or admitting a delta) cannot repair loss.
    fence.enqueued(key: false)
    XCTAssertFalse(fence.allows(key: false))
    fence.enqueued(key: true)
    XCTAssertTrue(fence.allows(key: false))
    fence.lost()
    XCTAssertFalse(fence.allows(key: false))
    XCTAssertTrue(fence.allows(key: true))
    fence.enqueued(key: true) // Hidden replay keys also restore references.
    XCTAssertTrue(fence.allows(key: false))
  }
}
