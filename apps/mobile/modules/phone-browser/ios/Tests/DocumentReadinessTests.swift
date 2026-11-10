import XCTest
@testable import PhoneBrowserCore

final class DocumentReadinessTests: XCTestCase {
  func testBlankAndEachCommittedFrameRequireHelperReadiness() throws {
    var readiness = DocumentReadiness()
    XCTAssertThrowsError(try readiness.require(frame: "main"))
    readiness.provisional()
    readiness.helper(frame: "main", token: "blank-helper")
    XCTAssertThrowsError(try readiness.require(frame: "main"))
    readiness.commit(document: "blank")
    XCTAssertEqual(try readiness.require(frame: "main"), "blank-helper")
    XCTAssertThrowsError(try readiness.require(frame: "child"))
    readiness.helper(frame: "child", token: "child-helper")
    XCTAssertEqual(try readiness.require(frame: "child"), "child-helper")
    readiness.provisional()
    readiness.commit(document: "next")
    XCTAssertThrowsError(try readiness.require(frame: "main"))
    readiness.helper(frame: "main", token: "next-helper")
    XCTAssertEqual(try readiness.require(frame: "main"), "next-helper")
    XCTAssertThrowsError(try readiness.require(frame: "main", document: "blank")) { error in
      XCTAssertEqual(error as? BrowserRefusal, .staleDocument)
    }
    XCTAssertEqual(try readiness.require(frame: "main", document: "next"), "next-helper")
    readiness.provisional()
    readiness.failed()
    XCTAssertEqual(try readiness.require(frame: "main", document: "next"), "next-helper")
    readiness.invalidate()
    XCTAssertThrowsError(try readiness.require(frame: "main"))
  }
}
