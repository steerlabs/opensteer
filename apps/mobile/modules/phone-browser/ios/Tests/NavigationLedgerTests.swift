import XCTest
@testable import PhoneBrowserCore

final class NavigationLedgerTests: XCTestCase {
  func testSupersededNavigationCannotCommitOrFailTheNewRequest() {
    var ledger = NavigationLedger<Int>()
    ledger.submit(1, id: "first")
    XCTAssertEqual(ledger.started(1, id: "generated"), "first")
    ledger.submit(2, id: "second")
    XCTAssertNil(ledger.current(1), "Late cancellation must not be attributed to the new navigation")
    XCTAssertNil(ledger.started(1, id: "late-start"))
    ledger.finish(1)
    XCTAssertEqual(ledger.current(2), "second")
    ledger.finish(2)
    XCTAssertNil(ledger.current(2))
    XCTAssertEqual(ledger.started(3, id: "person-link"), "person-link")
  }
}
