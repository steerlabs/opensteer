import Foundation
import XCTest
@testable import PhoneDisplayCore

final class BrowserVideoTests: XCTestCase {
  func testRealBaselineKeyAndResourceRefusals() throws {
    let module = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let key = try Data(contentsOf: module.appendingPathComponent("tests/native/fixtures/lime-key-128x128.h264"))
    XCTAssertTrue(BrowserVideoSPS.valid(key, width: 128, height: 128))
    XCTAssertFalse(BrowserVideoSPS.valid(key, width: 3840, height: 2160))
    XCTAssertFalse(BrowserVideoSPS.valid(key, width: Int.max, height: Int.max))
    XCTAssertFalse(BrowserVideoSPS.valid(Data([0,0,0,1,0x67,66,0,31,0,0,0]), width: 128, height: 128))
    for length in 0..<24 { XCTAssertFalse(BrowserVideoSPS.valid(key.prefix(length), width: 128, height: 128)) }
  }
}
