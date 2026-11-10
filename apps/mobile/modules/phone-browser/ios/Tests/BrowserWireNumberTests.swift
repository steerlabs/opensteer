import XCTest
@testable import PhoneBrowserCore

final class BrowserWireNumberTests: XCTestCase {
  func testExpoUntypedNumbersAreExactIntegersWithoutAcceptingBooleanOrFractions() {
    XCTAssertEqual(BrowserWireNumber.integer(10000.0), 10000)
    XCTAssertEqual(BrowserWireNumber.integer(NSNumber(value: 8)), 8)
    XCTAssertNil(BrowserWireNumber.integer(true))
    XCTAssertNil(BrowserWireNumber.integer(NSNumber(value: false)))
    XCTAssertNil(BrowserWireNumber.integer(1.5))
    XCTAssertNil(BrowserWireNumber.integer(Double.infinity))
    XCTAssertNil(BrowserWireNumber.integer(Double.nan))
    XCTAssertNil(BrowserWireNumber.integer(Double.greatestFiniteMagnitude))
    XCTAssertNil(BrowserWireNumber.integer("8"))
  }
}
