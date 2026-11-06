import XCTest
@testable import BrowserPopupCore
final class BrowserPopupTests: XCTestCase {
  func testOpeningReleaseBelongsToTheOriginalProxyExactlyOnce() {
    var keys=PopupKeyReleases()
    XCTAssertTrue(keys.ended(44));XCTAssertFalse(keys.ended(44))
    keys.began(40);XCTAssertFalse(keys.ended(40))
  }

  func testLateNativeDelegateAndProgrammaticDismiss() {
    var fence = PopupFence(); fence.present("a", "9007199254740993")
    XCTAssertFalse(fence.accept("a", "9007199254740992"))
    XCTAssertTrue(fence.accept("a", "9007199254740993"))
    fence.present("a", "9007199254740994"); fence.dismiss("a")
    XCTAssertFalse(fence.accept("a", "9007199254740994"))
    fence.present("b", "1"); fence.dismiss("a"); XCTAssertTrue(fence.accept("b", "1"))
  }
  func testCalendarValuesHaveNoTimezoneShiftOrRounding() {
    XCTAssertEqual(PopupCalendar.parts("2024-03-10T01:59:59.123", kind: "datetime-local")?.second, 59)
    XCTAssertEqual(PopupCalendar.parts("2024-11-03T01:30:00.125", kind: "datetime-local")?.fraction, ".125")
    XCTAssertNil(PopupCalendar.parts("2023-02-29", kind: "date"))
    XCTAssertNotNil(PopupCalendar.parts("2020-W53", kind: "week"))
    XCTAssertNil(PopupCalendar.parts("2021-W53", kind: "week"))
    XCTAssertEqual(PopupCalendar.parts("12024-12", kind: "month")?.year,12024)
  }
}
