import Foundation

/// What one window encoder spends and how often it submits a frame.
///
/// Low-latency rate control keeps each frame sharp by skipping frames when bits
/// are short, so a scarce budget is better spent on fewer, evenly spaced frames
/// than on frames the encoder would drop unevenly. The budget is the least of a
/// size-based ceiling, the Host's cap for its slowest visible viewer and this
/// Mac's own estimate of its link to the Host.
struct MacVideoRate: Equatable {
  enum Mode: Equatable {
    /// A Host without the negotiated profile: today's fixed budget.
    case legacy
    /// The Host's cap for its slowest visible viewer; nil while uncapped.
    case negotiated(cap: Int?)
  }

  struct Plan: Equatable {
    let bitrate: Int
    let fps: Int
  }

  static let minBitrate = 400_000
  static let maxBitrate = 20_000_000
  static let legacyBitrate = 2_500_000
  static let ceilingBitsPerPixel = 0.15
  static let cadenceBitsPerPixel = 0.05
  static let cadences = [60, 30, 20, 15, 10]

  let maxFps: Int
  private(set) var mode: Mode
  private(set) var uplink = MacVideoUplink()

  init(maxFps: Int, mode: Mode) {
    self.maxFps = maxFps
    self.mode = mode
  }

  /// A legacy start never accepts a cap later.
  mutating func setLinkCap(_ cap: Int?) {
    guard case .negotiated = mode else { return }
    mode = .negotiated(cap: cap)
  }

  /// The budget before this Mac's own link estimate.
  func ceiling(width: Int, height: Int) -> Int {
    guard case .negotiated(let cap) = mode else { return Self.legacyBitrate }
    let sized = Int(Double(max(1, width * height)) * Double(maxFps) * Self.ceilingBitsPerPixel)
    return max(Self.minBitrate, min(max(sized, 1_500_000), cap ?? Self.maxBitrate, Self.maxBitrate))
  }

  func plan(width: Int, height: Int) -> Plan {
    let bitrate = min(ceiling(width: width, height: height), uplink.estimate ?? .max)
    let pixels = Double(max(1, width * height))
    let fps = Self.cadences.first {
      $0 <= maxFps && Double(bitrate) / (pixels * Double($0)) >= Self.cadenceBitsPerPixel
    } ?? min(maxFps, Self.cadences.last!)
    return Plan(bitrate: bitrate, fps: fps)
  }

  /// One Host acknowledgement of this producer's media, `delay` after sending.
  /// Returns whether the plan may have changed.
  mutating func acknowledged(delay: TimeInterval, now: TimeInterval, width: Int, height: Int) -> Bool {
    uplink.acknowledged(delay: delay, now: now, ceiling: ceiling(width: width, height: height))
  }
}

/// This Mac's estimate of its own link to the Host. Loopback never queues; an
/// enrolled Mac reaching a remote Host over a slow uplink does. The rule matches
/// Agent Phone's producer estimate: a quarter less on queueing, a tenth more
/// after sustained healthy flow, and no estimate once back at the ceiling.
struct MacVideoUplink: Equatable {
  static let queueing: TimeInterval = 0.25
  static let reduceInterval: TimeInterval = 1
  static let recoverAfter: TimeInterval = 8

  private(set) var estimate: Int?
  private var reducedAt = -TimeInterval.infinity
  private var healthySince: TimeInterval?

  /// Returns whether the estimate changed.
  mutating func acknowledged(delay: TimeInterval, now: TimeInterval, ceiling: Int) -> Bool {
    if delay >= Self.queueing {
      healthySince = nil
      guard now - reducedAt >= Self.reduceInterval else { return false }
      reducedAt = now
      let next = max(MacVideoRate.minBitrate, Int(Double(min(ceiling, estimate ?? .max)) * 0.75))
      defer { estimate = next }
      return next != estimate
    }
    guard let value = estimate else { return false }
    guard let since = healthySince else {
      healthySince = now
      return false
    }
    guard now - since >= Self.recoverAfter else { return false }
    healthySince = now
    let next = Int(Double(value) * 1.1)
    estimate = next >= ceiling ? nil : next
    return true
  }
}
