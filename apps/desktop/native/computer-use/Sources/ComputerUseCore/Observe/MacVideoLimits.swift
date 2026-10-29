import Foundation

// Wire limits shared with packages/protocol/src/display-stream.ts.
enum MacVideoLimits {
  static let maxWindows = 2
  static let maxWarmWindows = 1
  static let warmMs = 30_000
  static let startupSeconds: TimeInterval = 30
  static let maxLongSide = 1_920
  static let maxFps = 30
}
