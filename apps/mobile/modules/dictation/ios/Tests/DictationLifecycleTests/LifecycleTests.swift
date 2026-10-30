import XCTest
@testable import DictationLifecycle
final class LifecycleTests: XCTestCase {
  func testIdleRestoreAndStaleSession() {
    var state = DictationLifecycle()
    state.begin("one"); state.begin("busy")
    XCTAssertFalse(state.listening("busy", previous: false))
    XCTAssertTrue(state.listening("one", previous: true))
    XCTAssertNil(state.ended("busy"))
    XCTAssertEqual(state.expire(), "one")
    XCTAssertEqual(state.expiring, "one")
    XCTAssertEqual(state.ended("one"), true)
    XCTAssertNil(state.session); XCTAssertNil(state.expiring)
    XCTAssertNil(state.ended("one"))
    state.begin("two")
    XCTAssertTrue(state.listening("two", previous: false))
    XCTAssertEqual(state.stopListening(), false)
    XCTAssertFalse(state.listening("two", previous: true))
    XCTAssertNil(state.ended("two"))
  }
}
