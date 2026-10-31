import CoreGraphics
import Foundation
import ImageIO

enum PictureDecoder {
  /// Decodes fully on the calling thread, so the main thread only swaps a
  /// finished image in. A raster other than the one declared is never shown:
  /// input geometry follows the declaration. The header's size is checked
  /// before any pixels are allocated, so a malformed picture costs no decode.
  static func decode(_ data: Data, width: Int, height: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) == 1,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      (properties[kCGImagePropertyPixelWidth] as? Int) == width,
      (properties[kCGImagePropertyPixelHeight] as? Int) == height,
      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
      image.width == width, image.height == height
    else { return nil }
    return image
  }
}
