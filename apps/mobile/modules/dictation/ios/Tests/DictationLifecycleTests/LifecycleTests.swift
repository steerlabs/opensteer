import XCTest
@testable import DictationLifecycle
final class LifecycleTests: XCTestCase {
  func testIdleRestoreAndStaleSession() {
    var state = DictationLifecycle()
    state.begin("one"); state.begin("busy")
    XCTAssertFalse(state.listening("busy", previous: false))
    XCTAssertTrue(state.listening("one", previous: true))
    XCTAssertNil(state.ended("busy"))
    XCTAssertEqual(state.expire("one"), "one")
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

extension LifecycleTests {
  func testCancelRestartBeforeDelayedEndKeepsNewOwnership() {
    var state = DictationLifecycle()
    state.begin("old")
    XCTAssertTrue(state.listening("old", previous: false))
    XCTAssertEqual(state.cancelled("old"), false)
    state.begin("new")
    XCTAssertNil(state.ended("old"))
    XCTAssertEqual(state.session, "new")
    XCTAssertTrue(state.listening("new", previous: true))
    XCTAssertEqual(state.stopListening(), true)
    XCTAssertEqual(state.expire("new"), "new")
    XCTAssertNil(state.cancelled("new"))
    XCTAssertTrue(state.isExpiring("new"))
    state.begin("third")
    XCTAssertNil(state.ended("new"))
    XCTAssertFalse(state.isExpiring("new"))
    XCTAssertEqual(state.session, "third")
    XCTAssertNil(state.expire("new"))
    XCTAssertNil(state.cancelled("third"))
    XCTAssertNil(state.session)
    XCTAssertFalse(state.listening("third", previous: false))
  }
}

extension LifecycleTests {
  @MainActor func testAdmissionAndTeardownWaitForCancellationCleanup() async {
    let cancellation = DictationCancellation()
    var release: CheckedContinuation<Void, Never>?
    var started: CheckedContinuation<Void, Never>?
    var order: [String] = []
    let cancel = Task { @MainActor in
      await cancellation.run {
        order.append("cancel native")
        started?.resume()
        await withCheckedContinuation { release = $0 }
        order.append("cleanup")
      }
    }
    await withCheckedContinuation { started = $0 }
    let start = Task { @MainActor in
      await cancellation.wait()
      order.append("admit")
    }
    let teardown = Task { @MainActor in
      await cancellation.run { order.append("teardown") }
    }
    XCTAssertEqual(order, ["cancel native"])
    release?.resume()
    await cancel.value
    await start.value
    await teardown.value
    XCTAssertEqual(order.first, "cancel native")
    XCTAssertEqual(order[1], "cleanup")
    XCTAssertEqual(Set(order.suffix(2)), Set(["admit", "teardown"]))
  }
}
