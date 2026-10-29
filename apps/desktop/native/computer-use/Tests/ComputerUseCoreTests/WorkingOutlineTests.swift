import AppKit
import XCTest

@testable import ComputerUseCore

@MainActor
final class WorkingOutlineTests: XCTestCase {
  func testSweepRunsOnlyForVisibleWorkWithoutReduceMotion() {
    let view = WorkingOutlineView()
    view.layout(windowSize: CGSize(width: 400, height: 240))
    XCTAssertGreaterThan(view.borderOpacity, 0)
    XCTAssertNil(view.sweepAnimation)

    view.configure(working: true, visible: true, reduceMotion: false)
    let firstStart = view.sweepAnimation?.beginTime
    XCTAssertNotNil(firstStart)
    view.configure(working: true, visible: true, reduceMotion: false)
    XCTAssertEqual(view.sweepAnimation?.beginTime, firstStart)

    view.configure(working: false, visible: true, reduceMotion: false)
    XCTAssertNil(view.sweepAnimation)
    XCTAssertGreaterThan(view.borderOpacity, 0)

    view.configure(working: true, visible: true, reduceMotion: true)
    XCTAssertNil(view.sweepAnimation)
    XCTAssertGreaterThan(view.borderOpacity, 0)

    view.configure(working: true, visible: true, reduceMotion: false)
    XCTAssertNotNil(view.sweepAnimation)
    view.configure(working: true, visible: false, reduceMotion: false)
    XCTAssertNil(view.sweepAnimation)
  }
}
