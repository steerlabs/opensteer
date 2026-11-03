import XCTest
@testable import OpensteerAppleData

final class ContactsStoreTests: XCTestCase {
  func testExpiredBudgetStopsBeforeOpeningContacts() {
    XCTAssertThrowsError(try ContactsStore.records(
      budget: WorkBudget(requestEnd: .distantPast)))
  }
}
