import XCTest
@testable import PhoneBrowserCore

final class TabPoolTests: XCTestCase {
  func testLiveSlotsRetainedLRUAndPressure() throws {
    var pool = TabPoolState()
    for index in 0..<7 { try pool.create("tab-\(index)") }
    try pool.activate("tab-0", covered: false)
    try pool.activate("tab-1", covered: true)
    XCTAssertThrowsError(try pool.activate("tab-2", covered: true))
    for index in 1..<6 {
      if index > 1 { try pool.activate("tab-\(index)", covered: true) }
      let evicted = try pool.suspend("tab-\(index)")
      XCTAssertEqual(evicted, index == 5 ? ["tab-1"] : [])
    }
    XCTAssertEqual(pool.tabs["tab-1"], .discarded)
    try pool.activate("tab-2", covered: true)
    XCTAssertEqual(try pool.suspend("tab-2"), [])
    XCTAssertEqual(pool.retained, ["tab-3", "tab-4", "tab-5", "tab-2"])
    try pool.activate("tab-6", covered: true)
    XCTAssertEqual(pool.memoryPressure(), ["tab-3", "tab-4", "tab-5", "tab-2", "tab-6"])
    XCTAssertEqual(pool.visible, "tab-0")
    XCTAssertEqual(pool.tabs.values.filter { $0 == .live }.count, 1)
  }

  func testEpochRejectsWorkQueuedBeforeFence() throws {
    let gate = EpochGate()
    let issued = gate.current
    let queue = DispatchQueue(label: "phone-browser-epoch-test")
    let rejected = expectation(description: "Queued browser mutation rejected after fence")
    queue.suspend()
    queue.async {
      do {
        try gate.perform(issued) { XCTFail("Stale mutation ran") }
        XCTFail("Stale epoch was admitted")
      } catch {
        XCTAssertEqual(error as? BrowserRefusal, .staleEpoch)
      }
      rejected.fulfill()
    }
    XCTAssertEqual(gate.advance(), issued + 1)
    queue.resume()
    wait(for: [rejected], timeout: 1)
    XCTAssertEqual(try gate.perform(gate.current) { "admitted" }, "admitted")
  }
}
