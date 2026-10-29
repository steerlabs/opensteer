import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

final class DeliveryFailureTests: XCTestCase {
  func testStaleAfterDeliveryIsNeverRetryable() {
    let stale = HelperError(.staleObservation, "moved")
    XCTAssertEqual(
      ActionRunner.failureAfter(stale, performed: [], delivered: true).code, .outcomeUnknown)
    XCTAssertEqual(
      ActionRunner.failureAfter(stale, performed: [], delivered: false).code, .staleObservation)
  }
}
