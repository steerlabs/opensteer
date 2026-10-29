import Foundation
import XCTest

@testable import ComputerUseCore

final class FrameCodecTests: XCTestCase {
  func testEncodesBigEndianLengthPrefix() throws {
    let framed = try Frame.encode(Data("hi".utf8))
    XCTAssertEqual([UInt8](framed), [0, 0, 0, 2, 0x68, 0x69])
  }

  func testDecodesOneFrame() throws {
    var decoder = FrameDecoder()
    decoder.append(try Frame.encode(Data(#"{"id":1}"#.utf8)))
    let frame = try decoder.next()
    XCTAssertEqual(frame.map { String(decoding: $0, as: UTF8.self) }, #"{"id":1}"#)
    XCTAssertNil(try decoder.next())
  }

  func testWaitsForTheWholeBody() throws {
    var decoder = FrameDecoder()
    let framed = try Frame.encode(Data("abcdef".utf8))
    decoder.append(framed.prefix(5))
    XCTAssertNil(try decoder.next())
    decoder.append(framed.suffix(from: 5))
    XCTAssertEqual(try decoder.next().map { String(decoding: $0, as: UTF8.self) }, "abcdef")
  }

  func testYieldsSeveralFramesFromOneRead() throws {
    var decoder = FrameDecoder()
    var buffer = try Frame.encode(Data("one".utf8))
    buffer.append(try Frame.encode(Data("two".utf8)))
    decoder.append(buffer)
    XCTAssertEqual(try decoder.next().map { String(decoding: $0, as: UTF8.self) }, "one")
    XCTAssertEqual(try decoder.next().map { String(decoding: $0, as: UTF8.self) }, "two")
    XCTAssertNil(try decoder.next())
  }

  func testRefusesAnAnnouncedFrameOverFourMebibytes() {
    var decoder = FrameDecoder()
    let length = Frame.maxBytes + 1
    decoder.append(
      Data([
        UInt8(truncatingIfNeeded: length >> 24),
        UInt8(truncatingIfNeeded: length >> 16),
        UInt8(truncatingIfNeeded: length >> 8),
        UInt8(truncatingIfNeeded: length),
      ]))
    XCTAssertThrowsError(try decoder.next()) { error in
      XCTAssertEqual(error as? FrameError, .oversize(length))
    }
    // It stays failed: a decoder that lost the boundary cannot find it again.
    XCTAssertThrowsError(try decoder.next())
  }

  func testRefusesToEncodeAnOversizePayload() {
    XCTAssertThrowsError(
      try Frame.encode(Data(repeating: 0x41, count: Frame.maxBytes + 1))
    )
  }
}
