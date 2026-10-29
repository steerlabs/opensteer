@testable import OpensteerAppleData
import XCTest

/// Every way a listing can page wrongly, written before the pager: a page is
/// bounded by count and by size, so it always fits the integrations frame
/// whatever the items hold, and a cursor continues only the listing it came
/// from.
final class PagingTests: XCTestCase {
  private struct Item: Codable, Equatable {
    let id: Int
    let text: String
  }

  private func items(_ count: Int, text: String = "x") -> [Item] {
    (0..<count).map { Item(id: $0, text: text) }
  }

  private func page(
    _ items: [Item], cursor: String? = nil, limit: Int? = nil, listing: [String?] = ["a"],
    byteBudget: Int = Paging.byteBudget
  ) throws -> Page<Item> {
    try Paging.page(
      items, cursor: cursor, limit: limit, defaultLimit: 3, maxLimit: 10, listing: listing,
      byteBudget: byteBudget)
  }

  func testALimitOutsideItsRangeIsRefused() {
    for limit in [0, 11, -1] {
      XCTAssertThrowsError(try page(items(5), limit: limit)) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
  }

  func testWithoutALimitAPageHoldsTheDefault() throws {
    XCTAssertEqual(try page(items(5)).items.map(\.id), [0, 1, 2])
  }

  func testPagesTogetherHoldEveryItemOnceInOrderUnderBothBounds() throws {
    // Each item encodes to about 60 bytes, so the budget, not the limit,
    // ends most pages.
    let all = items(23, text: String(repeating: "y", count: 40))
    var seen: [Int] = []
    var cursor: String?
    var pages = 0
    repeat {
      let next = try page(all, cursor: cursor, limit: 10, byteBudget: 200)
      XCTAssertFalse(next.items.isEmpty)
      let bytes = try next.items.reduce(0) { $0 + (try JSONCoding.encoder.encode($1).count) }
      XCTAssertLessThanOrEqual(bytes, 200)
      seen += next.items.map(\.id)
      cursor = next.nextCursor
      pages += 1
    } while cursor != nil
    XCTAssertEqual(seen, Array(0..<23))
    XCTAssertGreaterThan(pages, 3)
  }

  /// An item bigger than the budget still goes out on a page of its own,
  /// or the listing could never get past it.
  func testAnItemLargerThanTheBudgetStillMovesTheListingOn() throws {
    let all = [Item(id: 0, text: String(repeating: "z", count: 500)), Item(id: 1, text: "")]
    let first = try page(all, byteBudget: 100)
    XCTAssertEqual(first.items.map(\.id), [0])
    let second = try page(all, cursor: first.nextCursor, byteBudget: 100)
    XCTAssertEqual(second.items.map(\.id), [1])
    XCTAssertNil(second.nextCursor)
  }

  func testACursorContinuesOnlyTheListingThatIssuedIt() throws {
    let cursor = try XCTUnwrap(try page(items(5), listing: ["a", nil]).nextCursor)
    XCTAssertEqual(try page(items(5), cursor: cursor, listing: ["a", nil]).items.map(\.id), [3, 4])
    for other in [["b", nil], ["a", ""], ["a"], [nil, "a"]] as [[String?]] {
      XCTAssertThrowsError(try page(items(5), cursor: cursor, listing: other)) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
  }

  func testAForgedCursorIsRefused() throws {
    let cursor = try XCTUnwrap(try page(items(5)).nextCursor)
    for forged in ["", "not a cursor", "\(cursor)0.1", "\(cursor).", "\(cursor)x", ".3", "-1"] {
      XCTAssertThrowsError(try page(items(5), cursor: forged), forged) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
  }

  /// Items removed since the cursor was issued end the listing, not fail it.
  func testACursorPastTheEndEndsTheListing() throws {
    let cursor = try XCTUnwrap(try page(items(5)).nextCursor)
    let ended = try page(items(2), cursor: cursor)
    XCTAssertEqual(ended.items, [])
    XCTAssertNil(ended.nextCursor)
  }

  func testTheSameListingAlwaysGivesTheSameCursor() throws {
    XCTAssertEqual(try page(items(5)).nextCursor, try page(items(5)).nextCursor)
  }
}
