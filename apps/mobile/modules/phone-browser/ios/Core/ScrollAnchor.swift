import Foundation

public struct ScrollAnchor: Codable, Sendable {
  public var path: [Int]?
  public var offset: Double
  public var x: Double
  public var y: Double

  public static func clamped(target: Double, content: Double, viewport: Double, leadingInset: Double) -> Double {
    guard target.isFinite, content.isFinite, viewport.isFinite, leadingInset.isFinite else { return 0 }
    return min(max(-leadingInset, target), max(-leadingInset, content - viewport))
  }
}
