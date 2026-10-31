import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The screenshot of §2 "Observation".
///
/// The filter includes only windows owned by the target process, so nothing the
/// person has in front ever occludes the picture and nothing of theirs ever
/// ends up in it. ScreenCaptureKit captures the target windows at native scale;
/// that content is cropped to the key window together with the app's own
/// sheets, popovers and menus that overlap it — which is how those appear at
/// all.
///
/// Capture happens in two steps. `plan` decides the crop, which the tree walk
/// needs to know what is in the picture; `take` renders it afterwards.
public enum WindowCapture {
  /// `computerUseScreenshotMaxLongSide` and `computerUseScreenshotMaxPixels`:
  /// the largest picture every current vision model reads without resizing it
  /// first. A picture a model resizes moves every point it reads off it, so a
  /// point target would land beside what it chose.
  public static let maxLongSide = 1_440
  public static let maxPixelCount = 1_150_000
  /// Above this, the same picture is encoded again at a lower quality. This is
  /// a documented bound of the protocol, not a fallback.
  public static let maxBase64Bytes = 600_000
  static let primaryQuality: CGFloat = 0.72
  static let reducedQuality: CGFloat = 0.5

  public struct Capture: Sendable {
    public let screenshot: Observation.Screenshot?
    /// Pixels per point in the delivered image.
    public let coordinates: ObservationCoordinates
    public var scale: CGFloat { coordinates.scale }
  }

  /// What one observation's picture will show, decided before the tree is
  /// read so the tree names what the picture shows.
  public struct Plan: @unchecked Sendable {
    /// Screen points, top-left origin: the part of the screen in the picture.
    public let cropPoints: CGRect
    public let keyWindowFrame: CGRect
    /// The key window is on another Space and is captured on its own.
    public let alone: Bool
    let composition: Composition
    let captureScale: CGFloat
    let filter: SCContentFilter
    let configuration: SCStreamConfiguration
    let takeImage: () async throws -> CGImage

    /// The coordinate space the picture will have, even if taking it fails.
    public var plannedCoordinates: ObservationCoordinates {
      let size = WindowCapture.targetSize(points: cropPoints.size, captureScale: captureScale)
      return ObservationCoordinates(
        cropOrigin: WindowCapture.cropOrigin(cropPoints, keyWindowFrame: keyWindowFrame),
        scale: CGFloat(size.width) / cropPoints.width,
        geometry: Observation.Geometry(width: size.width, height: size.height))
    }
  }

  /// A capture plan inside one app grant, changeable while the exact root stays fixed.
  /// Timing and geometry do not identify the filter that produced a sample.
  struct Composition: Equatable, Sendable {
    let windowIDs: [CGWindowID]
    let displayID: CGDirectDisplayID?
    let crop: CGRect
  }

  /// The sentence for the missing grant, by the name the product uses for it.
  public static let screenRecordingRequired = HelperError(
    .permissionRequired,
    "Opensteer Computer Use needs macOS Screen Recording to see this app's window. "
      + "Turn it on for Opensteer Computer Use in System Settings."
  )

  /// `screenRecordingGranted` is a parameter only so a test can take the denied
  /// path on a machine where the test runner happens to hold the grant.
  @WorkActor
  public static func plan(
    processIdentifier: pid_t, keyWindow: WindowIdentity,
    screenRecordingGranted: Bool = CGPreflightScreenCaptureAccess(), outputMaxLongSide: Int? = nil
  ) async throws -> Plan {
    try await plan(
      processIdentifier: processIdentifier, keyWindow: keyWindow,
      screenRecordingGranted: screenRecordingGranted, outputMaxLongSide: outputMaxLongSide,
      group: nil)
  }

  @WorkActor
  static func plan(
    processIdentifier: pid_t,
    keyWindow: WindowIdentity,
    screenRecordingGranted: Bool = CGPreflightScreenCaptureAccess(),
    outputMaxLongSide: Int? = nil,
    group suppliedGroup: WindowGroup?
  ) async throws -> Plan {
    guard screenRecordingGranted else { throw screenRecordingRequired }

    let group: WindowGroup
    if let supplied = suppliedGroup {
      group = supplied
    } else {
      guard let process = ProcessStamp.of(processIdentifier) else { throw SessionWindows.closed }
      let app = AXUIElementCreateApplication(processIdentifier)
      guard
        let window = AXValueReader.copyElements(app, kAXWindowsAttribute).first(where: {
          KeyWindow.windowID(of: $0) == keyWindow.windowID
        })
      else { throw SessionWindows.closed }
      group = try WindowGroup.resolve(window: window, process: process, lifecycleRevision: 0)
    }
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(
        true,
        onScreenWindowsOnly: false
      )
    } catch {
      let nativeError = error as NSError
      Log.observe.error(
        "Window content enumeration failed: domain=\(nativeError.domain, privacy: .public) code=\(nativeError.code, privacy: .public)"
      )
      throw HelperError(
        .permissionRequired,
        "Opensteer Computer Use could not read this Mac's windows. Check that macOS Screen "
          + "Recording is on for Opensteer Computer Use in System Settings."
      )
    }

    guard
      let root = content.windows.first(where: {
        $0.windowID == keyWindow.windowID && $0.owningApplication?.processID == processIdentifier
      })
    else {
      // Capture enumeration can lag behind the retained window's liveness read.
      // Only that identity check may declare the selected window closed.
      throw HelperError(.staleObservation, "This app changed while it was being observed.")
    }
    if group.alone {
      return planAlone(root, keyWindow: group.root, outputMaxLongSide: outputMaxLongSide)
    }
    guard let display = content.displays.first(where: { $0.displayID == group.displayID }) else {
      throw HelperError(
        .unsupported,
        "The window is not on a display this Mac can capture; ask the person to move it.")
    }
    let memberIDs = Set(group.members.map(\.window.windowID))
    let capturedWindows = content.windows.filter {
      memberIDs.contains($0.windowID) && $0.owningApplication?.processID == processIdentifier
        && $0.isOnScreen && $0.frame.width > 0 && $0.frame.height > 0
    }
    guard Set(capturedWindows.map(\.windowID)) == memberIDs else {
      MacVideoDiagnostic.write(["event": "capture-plan-members-stale", "root": keyWindow.windowID,
        "members": group.members.count, "captured": capturedWindows.count,
        "rootOnScreen": root.isOnScreen, "alone": group.alone])
      throw HelperError(.staleObservation, "This app changed while it was being observed.")
    }
    let cropPoints = group.crop
    let filter = SCContentFilter(display: display, including: capturedWindows)
    let nativeScale = CGFloat(filter.pointPixelScale)
    let captureScale =
      outputMaxLongSide.map {
        min(nativeScale, CGFloat($0) / max(cropPoints.width, cropPoints.height))
      } ?? nativeScale
    guard
      let sourcePoints = sourceRect(captureRect: cropPoints, displayFrame: display.frame),
      captureScale > 0
    else {
      throw HelperError(.failed, "This app's window could not be framed for a screen capture.")
    }

    let configuration = SCStreamConfiguration()
    configuration.sourceRect = sourcePoints
    let rounding: FloatingPointRoundingRule = outputMaxLongSide == nil ? .up : .down
    configuration.width = max(1, Int((sourcePoints.width * captureScale).rounded(rounding)))
    configuration.height = max(1, Int((sourcePoints.height * captureScale).rounded(rounding)))
    configuration.showsCursor = false
    configuration.captureResolution = .best
    configuration.scalesToFit = outputMaxLongSide != nil

    return Plan(
      cropPoints: cropPoints, keyWindowFrame: keyWindow.frame, alone: false,
      composition: Composition(
        windowIDs: capturedWindows.map(\.windowID).sorted(), displayID: display.displayID,
        crop: cropPoints),
      captureScale: captureScale,
      filter: filter, configuration: configuration
    ) {
      try await SCScreenshotManager.captureImage(
        contentFilter: filter, configuration: configuration)
    }
  }

  /// A window that is not on the Space being shown is captured by itself.
  /// Its sheets and menus are separate windows, excluded from picture and tree.
  static func planAlone(
    _ window: SCWindow, keyWindow: WindowIdentity, outputMaxLongSide: Int? = nil
  ) -> Plan {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let nativeScale = max(1, CGFloat(filter.pointPixelScale))
    let captureScale =
      outputMaxLongSide.map {
        min(nativeScale, CGFloat($0) / max(keyWindow.frame.width, keyWindow.frame.height))
      } ?? nativeScale
    let configuration = SCStreamConfiguration()
    let rounding: FloatingPointRoundingRule = outputMaxLongSide == nil ? .up : .down
    configuration.width = max(1, Int((keyWindow.frame.width * captureScale).rounded(rounding)))
    configuration.height = max(1, Int((keyWindow.frame.height * captureScale).rounded(rounding)))
    configuration.showsCursor = false
    configuration.captureResolution = .best
    configuration.scalesToFit = outputMaxLongSide != nil
    return Plan(
      cropPoints: keyWindow.frame, keyWindowFrame: keyWindow.frame, alone: true,
      composition: Composition(windowIDs: [window.windowID], displayID: nil, crop: keyWindow.frame),
      captureScale: captureScale,
      filter: filter, configuration: configuration
    ) {
      try await SCScreenshotManager.captureImage(
        contentFilter: filter, configuration: configuration)
    }
  }

  public static func take(
    _ plan: Plan,
    maxLongSide: Int = WindowCapture.maxLongSide,
    maxPixelCount: Int = WindowCapture.maxPixelCount,
    maxBase64Bytes: Int = WindowCapture.maxBase64Bytes
  ) async -> Capture {
    await render(
      cropPoints: plan.cropPoints, keyWindowFrame: plan.keyWindowFrame,
      captureScale: plan.captureScale, takeImage: plan.takeImage,
      maxLongSide: maxLongSide, maxPixelCount: maxPixelCount,
      maxBase64Bytes: maxBase64Bytes)
  }

  /// The picture's exact pixel size: native resolution when it fits, else
  /// the largest size inside both the long-side and the pixel-count bounds.
  /// Tree frames, `window.scale` and point targets all follow this size.
  public static func targetSize(
    points: CGSize, captureScale: CGFloat,
    maxLongSide: Int = WindowCapture.maxLongSide,
    maxPixelCount: Int = WindowCapture.maxPixelCount
  ) -> (
    width: Int, height: Int
  ) {
    let width = max(points.width, 1)
    let height = max(points.height, 1)
    let scale = min(
      captureScale,
      CGFloat(maxLongSide) / max(width, height),
      sqrt(CGFloat(maxPixelCount) / (width * height)))
    return (
      width: max(1, Int((width * scale).rounded(.down))),
      height: max(1, Int((height * scale).rounded(.down)))
    )
  }

  static func cropOrigin(_ cropPoints: CGRect, keyWindowFrame: CGRect) -> CGPoint {
    CGPoint(x: cropPoints.minX - keyWindowFrame.minX, y: cropPoints.minY - keyWindowFrame.minY)
  }

  static func render(
    cropPoints: CGRect,
    keyWindowFrame: CGRect,
    captureScale: CGFloat,
    takeImage: () async throws -> CGImage,
    maxLongSide: Int = WindowCapture.maxLongSide,
    maxPixelCount: Int = WindowCapture.maxPixelCount,
    maxBase64Bytes: Int = WindowCapture.maxBase64Bytes
  ) async -> Capture {
    let size = targetSize(
      points: cropPoints.size, captureScale: captureScale,
      maxLongSide: maxLongSide, maxPixelCount: maxPixelCount)
    let origin = cropOrigin(cropPoints, keyWindowFrame: keyWindowFrame)
    do {
      let image = try await takeImage()
      let bounded = try boundedJPEG(
        try resize(image, width: size.width, height: size.height),
        maxBase64Bytes: maxBase64Bytes)
      let resized = bounded.image
      return Capture(
        screenshot: Observation.Screenshot(
          mime: "image/jpeg", base64: bounded.base64,
          width: resized.width, height: resized.height),
        coordinates: ObservationCoordinates(
          cropOrigin: origin,
          scale: CGFloat(resized.width) / cropPoints.width,
          geometry: Observation.Geometry(width: resized.width, height: resized.height)))
    } catch {
      // Capture can fail after the crop is known; the tree still uses its planned pixels.
      let native = error as NSError
      Log.observe.error(
        "Screen capture failed: domain=\(native.domain, privacy: .public) code=\(native.code, privacy: .public) description=\(native.localizedDescription, privacy: .public)"
      )
      return Capture(
        screenshot: nil,
        coordinates: ObservationCoordinates(
          cropOrigin: origin,
          scale: CGFloat(size.width) / cropPoints.width,
          geometry: Observation.Geometry(width: size.width, height: size.height)))
    }
  }

  /// The already-qualified group members, unioned and clipped to the root display.
  static func captureRect(
    keyWindowFrame: CGRect,
    appWindowFrames: [CGRect],
    displayFrame: CGRect
  ) -> CGRect {
    var capture = keyWindowFrame
    for frame in appWindowFrames {
      capture = capture.union(frame)
    }
    let clipped = capture.intersection(displayFrame)
    return clipped.isNull || clipped.isEmpty
      ? keyWindowFrame.intersection(displayFrame) : clipped
  }

  /// `SCStreamConfiguration.sourceRect` uses points relative to the selected
  /// display, while window frames use the global CoreGraphics screen space.
  static func sourceRect(
    captureRect: CGRect,
    displayFrame: CGRect
  ) -> CGRect? {
    let clipped = captureRect.intersection(displayFrame)
    guard !clipped.isNull, !clipped.isEmpty else { return nil }
    return CGRect(
      x: clipped.minX - displayFrame.minX,
      y: clipped.minY - displayFrame.minY,
      width: clipped.width,
      height: clipped.height
    )
  }

  static func resize(_ image: CGImage, longerSide: Int) throws -> CGImage {
    let longer = max(image.width, image.height)
    guard longer > longerSide else { return image }
    let ratio = CGFloat(longerSide) / CGFloat(longer)
    return try resize(
      image,
      width: max(1, Int((CGFloat(image.width) * ratio).rounded())),
      height: max(1, Int((CGFloat(image.height) * ratio).rounded())))
  }

  static func resize(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    guard image.width != width || image.height != height else { return image }
    guard
      let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    else {
      throw HelperError(.failed, "This app's window could not be resized for an observation.")
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let resized = context.makeImage() else {
      throw HelperError(.failed, "This app's window could not be resized for an observation.")
    }
    return resized
  }

  /// Encode under the protocol's hard byte bound. Quality is reduced once;
  /// incompressible content is then scaled down deterministically until the
  /// actual base64 payload fits. The bound is checked on every returned path.
  static func boundedJPEG(
    _ original: CGImage, maxBase64Bytes: Int = WindowCapture.maxBase64Bytes
  ) throws -> (image: CGImage, base64: String) {
    var image = original
    var quality = primaryQuality
    while true {
      guard let data = encodeJPEG(image, quality: quality) else {
        throw HelperError(.failed, "This app's window could not be encoded as an image.")
      }
      let base64 = data.base64EncodedString()
      if base64.utf8.count <= maxBase64Bytes { return (image, base64) }

      if quality != reducedQuality {
        quality = reducedQuality
        continue
      }

      let ratio = sqrt(CGFloat(maxBase64Bytes) / CGFloat(base64.utf8.count)) * 0.94
      let currentLongerSide = max(image.width, image.height)
      let nextLongerSide = max(
        1, min(currentLongerSide - 1, Int(CGFloat(currentLongerSide) * ratio)))
      guard nextLongerSide < currentLongerSide else {
        throw HelperError(.failed, "This app's window could not fit in an observation.")
      }
      image = try resize(image, longerSide: nextLongerSide)
    }
  }

  static func encodeJPEG(_ image: CGImage, quality: CGFloat) -> Data? {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        UTType.jpeg.identifier as CFString,
        1,
        nil
      )
    else { return nil }
    CGImageDestinationAddImage(
      destination,
      image,
      [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
    )
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
