import CoreGraphics
import Foundation

/// The crop in window points and its delivered pixel size define both directions.
public struct ObservationCoordinates: Sendable {
  public let cropOrigin: CGPoint
  public let scale: CGFloat
  public let geometry: Observation.Geometry

  public func pixelFrame(from frame: CGRect) -> CGRect {
    CGRect(
      x: (frame.minX - cropOrigin.x) * scale,
      y: (frame.minY - cropOrigin.y) * scale,
      width: frame.width * scale, height: frame.height * scale)
  }

  public func pixelPoint(from point: CGPoint) -> CGPoint {
    CGPoint(x: (point.x - cropOrigin.x) * scale, y: (point.y - cropOrigin.y) * scale)
  }

  public func windowPoint(from point: CGPoint) -> CGPoint {
    CGPoint(x: point.x / scale + cropOrigin.x, y: point.y / scale + cropOrigin.y)
  }

  public func contains(_ point: CGPoint) -> Bool {
    point.x >= 0 && point.y >= 0
      && point.x < CGFloat(geometry.width) && point.y < CGFloat(geometry.height)
  }
}
