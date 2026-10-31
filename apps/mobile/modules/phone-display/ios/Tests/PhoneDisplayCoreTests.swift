import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import PhoneDisplayCore

final class H264AccessUnitTests: XCTestCase {
  func testSplitsParameterSetsAndWritesLengthPrefixedUnits() {
    let annexB: [UInt8] = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6, 0, 0, 1, 0x06, 7]
    annexB.withUnsafeBytes { bytes in
      let unit = H264AccessUnit(bytes)
      XCTAssertEqual(unit.sps.map { Array(bytes[$0]) }, [0x67, 1, 2])
      XCTAssertEqual(unit.pps.map { Array(bytes[$0]) }, [0x68, 3])
      XCTAssertEqual(unit.sampleLength, 4 + 4 + 4 + 2)
      var sample = [UInt8](repeating: 0xEE, count: unit.sampleLength)
      sample.withUnsafeMutableBytes { unit.writeSample(from: bytes, into: $0) }
      XCTAssertEqual(sample, [0, 0, 0, 4, 0x65, 4, 5, 6, 0, 0, 0, 2, 0x06, 7])
    }
  }

  func testIgnoresEmptyUnitsAndBytesBeforeTheFirstStartCode() {
    let annexB: [UInt8] = [9, 9, 0, 0, 1, 0, 0, 1, 0x41, 8]
    annexB.withUnsafeBytes { bytes in
      let unit = H264AccessUnit(bytes)
      XCTAssertNil(unit.sps)
      XCTAssertEqual(unit.units.map { Array(bytes[$0]) }, [[0x41, 8]])
    }
  }
}

final class PictureQueueTests: XCTestCase {
  private var outcomes: [String: [PictureOutcome]] = [:]
  private func request(_ generation: Int = 0, fence: String = "a") -> PictureRequest {
    PictureRequest(generation: generation, fence: fence, width: 8, height: 6, regionWidth: 8, regionHeight: 6, upscale: true, cornerRadius: 0)
  }
  private func receipt(_ key: String) -> PictureReceipt {
    PictureReceipt { [unowned self] in self.outcomes[key, default: []].append($0) }
  }

  func testKeepsOneDecodingAndOnlyTheNewestWaitingAndSettlesEachOnce() {
    let queue = PictureQueue<String>()
    XCTAssertEqual(queue.submit(request(), "1", receipt("1"))?.payload, "1")
    XCTAssertNil(queue.submit(request(), "2", receipt("2")))
    XCTAssertNil(queue.submit(request(), "3", receipt("3")))
    XCTAssertEqual(outcomes["2"], [.dropped])
    // The decode in progress is protected from starvation under the same fence.
    let first = queue.complete(decoded: true)
    XCTAssertEqual(first.shown?.payload, "1")
    XCTAssertEqual(first.next?.payload, "3")
    first.shown?.receipt(.presented)
    first.shown?.receipt(.dropped)
    let second = queue.complete(decoded: false)
    XCTAssertNil(second.shown)
    XCTAssertNil(second.next)
    XCTAssertEqual(outcomes, ["1": [.presented], "2": [.dropped], "3": [.failed]])
  }

  func testANewerFenceSupersedesTheDecodeInProgress() {
    let queue = PictureQueue<String>()
    _ = queue.submit(request(fence: "old"), "1", receipt("1"))
    _ = queue.submit(request(fence: "new"), "2", receipt("2"))
    let result = queue.complete(decoded: true)
    XCTAssertNil(result.shown)
    XCTAssertEqual(result.next?.payload, "2")
    XCTAssertEqual(outcomes["1"], [.dropped])
  }

  func testClearDropsEverythingAndNeverRunsTwoDecodesOrDrawsTheOldGeneration() {
    let queue = PictureQueue<String>()
    _ = queue.submit(request(), "1", receipt("1"))
    _ = queue.submit(request(), "2", receipt("2"))
    queue.clear(1)
    XCTAssertEqual(outcomes, ["1": [.dropped], "2": [.dropped]])
    XCTAssertNil(queue.submit(request(0), "late", receipt("late")))
    XCTAssertEqual(outcomes["late"], [.dropped])
    // The abandoned decode is still running, so the next one waits for it.
    XCTAssertNil(queue.submit(request(1), "3", receipt("3")))
    let abandoned = queue.complete(decoded: true)
    XCTAssertNil(abandoned.shown)
    XCTAssertEqual(abandoned.next?.payload, "3")
    XCTAssertEqual(queue.complete(decoded: true).shown?.payload, "3")
    XCTAssertEqual(outcomes["1"], [.dropped])
  }

  func testLaysOutLikeTheSharedBrowserPresentation() {
    // Mirrors browserFrameContentRect: aspect-fit and centred; a crop never grows past native size.
    XCTAssertEqual(request().rect(in: CGSize(width: 400, height: 600)), CGRect(x: 0, y: 150, width: 400, height: 300))
    var crop = request()
    crop.upscale = false
    XCTAssertEqual(crop.rect(in: CGSize(width: 400, height: 600)), CGRect(x: 196, y: 297, width: 8, height: 6))
    crop.regionWidth = 0
    XCTAssertNil(crop.rect(in: CGSize(width: 400, height: 600)))
    XCTAssertNil(request().rect(in: .zero))
  }
}

final class PictureDecoderTests: XCTestCase {
  private func jpeg(width: Int, height: Int) throws -> Data {
    let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }

  func testDecodesOnlyTheDeclaredRaster() throws {
    let data = try jpeg(width: 32, height: 24)
    XCTAssertEqual(PictureDecoder.decode(data, width: 32, height: 24).map { [$0.width, $0.height] }, [32, 24])
    XCTAssertNil(PictureDecoder.decode(data, width: 24, height: 32))
    XCTAssertNil(PictureDecoder.decode(Data([0xFF, 0xD8, 0xFF]), width: 32, height: 24))
    // A header that declares the size but whose scan data is cut off never draws a partial picture.
    XCTAssertNil(PictureDecoder.decode(data.prefix(data.count / 2), width: 32, height: 24))
  }
}
