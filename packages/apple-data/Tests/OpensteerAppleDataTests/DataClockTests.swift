@testable import OpensteerAppleData
import XCTest

/// Every way a day or a time an agent names can be misread, written before
/// the clock: Calendar and Reminders take whole days and exact instants, and a
/// time without an offset is the Mac's wall clock, daylight saving included.
final class DataClockTests: XCTestCase {
  /// A zone with daylight saving: 2026 springs forward on 8 March at 02:00
  /// and falls back on 1 November at 02:00.
  private let clock = DataClock(timeZone: TimeZone(identifier: "America/Los_Angeles")!)

  private func instant(_ text: String) -> Date {
    ISO8601DateFormatter().date(from: text)!
  }

  private func refusal(_ text: String) -> HelperError? {
    do {
      _ = try clock.moment(text, field: "start")
      return nil
    } catch {
      return error as? HelperError
    }
  }

  func testADateIsAWholeDay() throws {
    XCTAssertEqual(
      try clock.moment("2026-10-01", field: "start"),
      .day(DataDay(year: 2026, month: 10, day: 1)))
    XCTAssertEqual(
      clock.startOfDay(DataDay(year: 2026, month: 10, day: 1)), instant("2026-10-01T07:00:00Z"))
  }

  func testADateThatDoesNotExistIsRefused() {
    for text in ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29"] {
      XCTAssertEqual(refusal(text)?.code, .failed, text)
    }
  }

  func testATimeWithoutAnOffsetIsTheMacsWallClockInEitherSeason() throws {
    XCTAssertEqual(
      try clock.moment("2026-07-01T09:00", field: "start"),
      .instant(instant("2026-07-01T16:00:00Z")))
    XCTAssertEqual(
      try clock.moment("2026-12-01T09:00:30", field: "start"),
      .instant(instant("2026-12-01T17:00:30Z")))
  }

  func testATimeWithAnOffsetIsThatInstantWhateverTheMacsZone() throws {
    XCTAssertEqual(
      try clock.moment("2026-07-01T09:00:00+09:00", field: "start"),
      .instant(instant("2026-07-01T00:00:00Z")))
    XCTAssertEqual(
      try clock.moment("2026-07-01T09:00Z", field: "start"),
      .instant(instant("2026-07-01T09:00:00Z")))
    guard case .instant(let fractional) = try clock.moment("2026-07-01T09:00:00.250Z", field: "start")
    else { return XCTFail("A fractional second is still a time") }
    XCTAssertEqual(fractional.timeIntervalSince(instant("2026-07-01T09:00:00Z")), 0.25, accuracy: 0.001)
  }

  /// 02:30 on the morning the clocks go forward never happens there.
  func testAWallClockTimeTheMacSkipsIsRefusedRatherThanMoved() {
    let error = refusal("2026-03-08T02:30")
    XCTAssertEqual(error?.code, .failed)
    XCTAssertTrue(error?.message.contains("daylight saving") ?? false, error?.message ?? "")
  }

  /// 01:30 on the morning the clocks go back happens twice; the first is meant.
  func testAWallClockTimeThatHappensTwiceIsTheFirst() throws {
    XCTAssertEqual(
      try clock.moment("2026-11-01T01:30", field: "start"),
      .instant(instant("2026-11-01T08:30:00Z")))
  }

  func testAnythingElseIsRefusedNamingTheField() {
    for text in [
      "tomorrow", "2026-10-01 09:00", "2026-10-01T9:00", "2026-10-01T25:00", "2026-10-01T09:60",
      "2026-10-01T09:00+25:00", "", "2026-10-01T09:00:00.Z",
    ] {
      let error = refusal(text)
      XCTAssertEqual(error?.code, .failed, text)
      XCTAssertTrue(error?.message.hasPrefix("start") ?? false, error?.message ?? text)
    }
  }

  func testAnInstantReadsWithTheOffsetInForceThen() {
    XCTAssertEqual(clock.text(instant("2026-07-01T16:00:00Z")), "2026-07-01T09:00:00-07:00")
    XCTAssertEqual(clock.text(instant("2026-12-01T17:00:30Z")), "2026-12-01T09:00:30-08:00")
    XCTAssertEqual(
      DataClock(timeZone: TimeZone(identifier: "UTC")!).text(instant("2026-12-01T17:00:30Z")),
      "2026-12-01T17:00:30Z")
  }

  /// 06:00 UTC on 1 October is still 30 September in California.
  func testTheDayOfAnInstantIsTheMacsDay() {
    XCTAssertEqual(
      clock.day(of: instant("2026-10-01T06:00:00Z")), DataDay(year: 2026, month: 9, day: 30))
    XCTAssertEqual(clock.text(DataDay(year: 2026, month: 9, day: 30)), "2026-09-30")
  }

  /// Days are counted on the calendar, so a range across the change of
  /// clocks is still whole days.
  func testDaysAreCountedOnTheCalendarAcrossDaylightSaving() {
    let before = DataDay(year: 2026, month: 3, day: 7)
    let after = clock.adding(days: 2, to: before)
    XCTAssertEqual(after, DataDay(year: 2026, month: 3, day: 9))
    XCTAssertEqual(clock.days(from: before, to: after), 2)
    XCTAssertEqual(
      clock.startOfDay(after).timeIntervalSince(clock.startOfDay(before)), 47 * 3600)
  }
}
