import CoreGraphics
import XCTest

@testable import ComputerUseCore

/// The one grant path that can be exercised without granting anything: with
/// macOS Screen Recording denied, a capture must refuse before it touches
/// ScreenCaptureKit, with a sentence naming the grant by the name the product
/// uses for it.
final class ScreenRecordingTests: XCTestCase {
  func testACaptureWithoutScreenRecordingIsPermissionRequired() async throws {
    let window = WindowIdentity(
      windowID: 1,
      title: nil,
      frame: CGRect(x: 0, y: 0, width: 100, height: 100)
    )
    do {
      _ = try await WindowCapture.plan(
        processIdentifier: 1,
        keyWindow: window,
        screenRecordingGranted: false
      )
      XCTFail("A capture without the grant must not succeed.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .permissionRequired)
      XCTAssertTrue(
        error.message.contains("macOS Screen Recording"),
        "The sentence must name the grant: \(error.message)"
      )
      XCTAssertFalse(error.message.contains("/"), "No error carries a path.")
    }
  }

  func testTheDeliveredPictureBoundsAreTheDocumentedOnes() {
    XCTAssertEqual(WindowCapture.maxLongSide, 1_440)
    XCTAssertEqual(WindowCapture.maxPixelCount, 1_150_000)
    XCTAssertEqual(WindowCapture.maxBase64Bytes, 600_000)
    XCTAssertEqual(TreeFormatter.maxBytes, 32_000)
    XCTAssertEqual(ElementTreeWalker.elementLimit, 1_500)
  }

  /// The picture fits both bounds, so no vision model resizes it, and it is
  /// never enlarged past what the display captured.
  func testThePictureFitsTheLongSideAndThePixelCount() {
    // A 1,512×982 point window on a 2× display: native would be 3,024×1,964.
    let full = WindowCapture.targetSize(
      points: CGSize(width: 1_512, height: 982), captureScale: 2)
    XCTAssertLessThanOrEqual(max(full.width, full.height), WindowCapture.maxLongSide)
    XCTAssertLessThanOrEqual(full.width * full.height, WindowCapture.maxPixelCount)
    XCTAssertGreaterThan(full.width * full.height, WindowCapture.maxPixelCount * 98 / 100)
    // A tall, narrow window is held by its long side.
    let tall = WindowCapture.targetSize(points: CGSize(width: 300, height: 2_000), captureScale: 2)
    XCTAssertEqual(tall.height, 1_440)
    XCTAssertEqual(tall.width, 216)
    // A small window stays at native resolution.
    let small = WindowCapture.targetSize(points: CGSize(width: 400, height: 300), captureScale: 2)
    XCTAssertEqual(small.width, 800)
    XCTAssertEqual(small.height, 600)
  }

  /// The tree, `window.scale` and point targets follow the delivered size,
  /// whether or not the picture itself could be taken.
  func testCoordinatesFollowTheFinalPixelSize() async throws {
    let crop = CGRect(x: 100, y: 100, width: 1_512, height: 982)
    let size = WindowCapture.targetSize(points: crop.size, captureScale: 2)
    let failed = await WindowCapture.render(
      cropPoints: crop, keyWindowFrame: crop, captureScale: 2,
      takeImage: { throw HelperError(.failed, "No picture.") })
    XCTAssertNil(failed.screenshot)
    XCTAssertEqual(
      failed.coordinates.geometry,
      Observation.Geometry(width: size.width, height: size.height))

    let native = try XCTUnwrap(
      CGContext(
        data: nil, width: 3_024, height: 1_964, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)?.makeImage())
    let taken = await WindowCapture.render(
      cropPoints: crop, keyWindowFrame: crop, captureScale: 2, takeImage: { native })
    let screenshot = try XCTUnwrap(taken.screenshot)
    XCTAssertEqual(screenshot.width, taken.coordinates.geometry.width)
    XCTAssertEqual(screenshot.height, taken.coordinates.geometry.height)
    XCTAssertLessThanOrEqual(screenshot.width * screenshot.height, WindowCapture.maxPixelCount)
    XCTAssertEqual(taken.coordinates.scale, CGFloat(screenshot.width) / crop.width)
    // The far corner of the window is the far corner of the picture.
    let corner = taken.coordinates.pixelPoint(from: CGPoint(x: crop.width, y: crop.height))
    XCTAssertEqual(corner.x, CGFloat(screenshot.width), accuracy: 0.5)
    XCTAssertEqual(corner.y, CGFloat(screenshot.height), accuracy: 1.5)
  }

  func testIncludedWindowCaptureUsesItsOwnNonzeroOrigin() throws {
    let frame = CGRect(x: 396, y: 93, width: 720, height: 712)
    let source = try XCTUnwrap(
      WindowCapture.sourceRect(
        captureRect: frame,
        displayFrame: CGRect(x: 0, y: 0, width: 1_512, height: 982)
      ))

    XCTAssertEqual(source, frame)
    XCTAssertEqual(Int((source.width * 2).rounded(.up)), 1_440)
    XCTAssertEqual(Int((source.height * 2).rounded(.up)), 1_424)
  }

  func testAssociatedMembersGrowTheCaptureEvenWithoutOverlap() {
    let capture = WindowCapture.captureRect(
      keyWindowFrame: CGRect(x: 400, y: 100, width: 700, height: 700),
      appWindowFrames: [
        CGRect(x: 500, y: 50, width: 300, height: 100),
        CGRect(x: 1_200, y: 100, width: 200, height: 200),
      ],
      displayFrame: CGRect(x: 0, y: 0, width: 1_512, height: 982)
    )

    XCTAssertEqual(capture, CGRect(x: 400, y: 50, width: 1_000, height: 750))
  }

  func testASecondaryDisplayWithNegativeCoordinatesRemainsRelativeToCapturedContent() throws {
    let source = try XCTUnwrap(
      WindowCapture.sourceRect(
        captureRect: CGRect(x: -1_400, y: -100, width: 600, height: 500),
        displayFrame: CGRect(x: -1_512, y: -200, width: 1_512, height: 982)
      ))

    XCTAssertEqual(source, CGRect(x: 112, y: 100, width: 600, height: 500))
  }

  func testCaptureIsClippedToTheSelectedDisplay() throws {
    let source = try XCTUnwrap(
      WindowCapture.sourceRect(
        captureRect: CGRect(x: -20, y: 40, width: 70, height: 90),
        displayFrame: CGRect(x: 0, y: 0, width: 100, height: 100)
      ))

    XCTAssertEqual(source, CGRect(x: 0, y: 40, width: 50, height: 60))
  }

  func testCropOutsideCapturedContentIsRejected() {
    XCTAssertNil(
      WindowCapture.sourceRect(
        captureRect: CGRect(x: 200, y: 200, width: 50, height: 50),
        displayFrame: CGRect(x: 0, y: 0, width: 100, height: 100)
      ))
  }
}
