import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

final class CancellationLogicTests: XCTestCase {
  func testTheFirstReasonWins() {
    let cancellation = SessionCancellation()
    XCTAssertFalse(cancellation.isCancelled)
    XCTAssertNoThrow(try cancellation.check())

    cancellation.cancel(.stoppedByUser)
    cancellation.cancel(.closed)
    XCTAssertEqual(cancellation.reason, .stoppedByUser)
    XCTAssertThrowsError(try cancellation.check()) { error in
      XCTAssertEqual((error as? HelperError)?.code, .stoppedByUser)
    }
  }

  func testClosingReportsNoSession() {
    let cancellation = SessionCancellation()
    cancellation.cancel(.closed)
    XCTAssertThrowsError(try cancellation.check()) { error in
      XCTAssertEqual((error as? HelperError)?.code, .noSession)
    }
  }

  /// The earlier clock names the stop: a request deadline inside the batch's
  /// thirty seconds says the request ran out of time.
  func testTheEarlierClockDecidesTheSentence() {
    let now = Date()
    let request = WorkBudget(
      batchEnd: now.addingTimeInterval(30), requestEnd: now.addingTimeInterval(-1))
    XCTAssertThrowsError(try request.check(now: now)) { error in
      XCTAssertEqual(error as? HelperError, WorkBudget.requestExpired)
    }
    let batch = WorkBudget(
      batchEnd: now.addingTimeInterval(-1), requestEnd: now.addingTimeInterval(10))
    XCTAssertThrowsError(try batch.check(now: now)) { error in
      XCTAssertEqual(error as? HelperError, WorkBudget.batchExpired)
    }
    XCTAssertNoThrow(try WorkBudget.unlimited.check(now: now))
    XCTAssertEqual(
      WorkBudget(requestEnd: now.addingTimeInterval(5)).startingBatch(30, now: now).end,
      now.addingTimeInterval(5))
  }

  /// Bookkeeping and passive health inspection never queue behind the work
  /// they need to stop or inspect; work and prompting stay in order.
  func testOnlyBookkeepingAndPassiveInspectionLeaveTheSerialLane() {
    for method in [
      "session.close", "session.open", "permissions.get",
      "data.status", "data.request", "data.invoke",
    ] {
      XCTAssertTrue(HelperRuntime.outOfBandMethods.contains(method), method)
    }
    for method in ["permissions.request", "session.act", "session.observe", "app.resolve"] {
      XCTAssertFalse(HelperRuntime.outOfBandMethods.contains(method), method)
    }
  }
}
