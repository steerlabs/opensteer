import Foundation
import XCTest
@testable import MacOSSigning

final class FrameTests: XCTestCase {
  func testFragmentedFramesAndPoisonedDecoder() throws {
    let payload = Data("hello".utf8)
    let framed = try Frame.encode(payload)
    var decoder = FrameDecoder()
    decoder.append(framed.prefix(3))
    XCTAssertNil(try decoder.next())
    decoder.append(framed.dropFirst(3))
    XCTAssertEqual(try decoder.next(), payload)
    XCTAssertNil(try decoder.next())
    decoder.append(Data([0, 4, 0, 1]))
    XCTAssertThrowsError(try decoder.next())
    XCTAssertThrowsError(try decoder.next())
    XCTAssertThrowsError(try Frame.encode(Data(repeating: 0, count: Frame.maxBytes + 1)))
  }
}
