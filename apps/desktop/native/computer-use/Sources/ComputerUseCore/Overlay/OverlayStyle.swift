import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// The agent's look on the Mac, in one place.
///
/// Everything the agent does is drawn in Opensteer's ember — the pointer, its
/// glow and the working outline — so it reads at a glance as
/// the agent, never the person: their pointer is black and white, and macOS's
/// own focus rings are blue.
enum OverlayStyle {
  // MARK: - Palette (apps/web/src/styles/tokens.css)

  static let ember = rgb(0xE6BEB0)
  static let emberBright = rgb(0xF1CABE)
  /// Ember mixed toward a warm clay, for the lower half of the pointer: deep
  /// enough that the arrow reads as a lit, solid object on a white page.
  static let emberDeep = mix(ember, rgb(0xC8674B), 0.6)
  /// The pointer's outer edge: a warm dark clay rather than grey ink, so the
  /// silhouette holds on white without reading as a disabled control.
  static let emberEdge = mix(rgb(0xC8674B), inkOnEmber, 0.35)
  /// The glow and the ripple: ember pulled further toward clay, so the halo
  /// still reads as warm light on a white page, where plain ember would
  /// vanish.
  static let emberGlow = mix(ember, rgb(0xC8674B), 0.55)
  /// The click ring: between the two, so it reads as light on a dark page
  /// and as a line on a white one.
  static let emberRing = mix(ember, rgb(0xC8674B), 0.3)
  static let inkOnEmber = rgb(0x1B120E)
  static let text = rgb(0xF5F4F2)
  static let surface = rgb(0x101010)
  static let red = rgb(0xE77E76)
  static let amber = rgb(0xDFB36B)

  // MARK: - Pointer

  /// The pointer's panel, and where the tip sits in it (top-left origin).
  static let pointerPanelSize = CGSize(width: 72, height: 76)
  static let pointerTip = CGPoint(x: 24, y: 24)
  static let glowRadius: CGFloat = 3
  /// How far the glow's source reaches past the arrow's edge.
  static let glowSpread: CGFloat = 1.5
  static let glowRestOpacity: Float = 0.24
  static let glowBreathLow: Float = 0.16
  static let glowBreathHigh: Float = 0.34
  static let glowBreathScale: (low: CGFloat, high: CGFloat)? = nil
  static let breathPeriod: TimeInterval = 3.2
  static let pressScale: CGFloat = 0.9
  static let pressDuration: TimeInterval = 0.05
  static let rippleRadii: (from: CGFloat, to: CGFloat) = (3, 15)
  static let rippleDuration: TimeInterval = 0.28
  static let staticRingDuration: TimeInterval = 0.25
  static let pulseDuration: TimeInterval = 0.22
  static let nudgeDistance: CGFloat = 3
  static let hideDuration: TimeInterval = 0.18
  static let rippleWidth: CGFloat = 1.5

  /// A compact arrow, about 20 × 27 points with its stroke, its tip at
  /// the origin and y counting down. Corners are softened with small arcs so
  /// the silhouette reads as drawn, not stamped.
  static func arrowPath() -> CGPath {
    let points: [(CGPoint, CGFloat)] = [
      (CGPoint(x: 0, y: 0), 1.0),
      (CGPoint(x: 0, y: 29), 1.6),
      (CGPoint(x: 7.2, y: 22), 0.9),
      (CGPoint(x: 11.6, y: 31), 1.5),
      (CGPoint(x: 16, y: 28.8), 1.5),
      (CGPoint(x: 11.7, y: 20.1), 0.9),
      (CGPoint(x: 23.2, y: 20.1), 1.7),
    ]
    // Scale the shape about its tip; panel padding and the input hotspot stay fixed.
    return roundedPolygon(
      points.map { point, radius in
        (CGPoint(x: point.x * 0.82, y: point.y * 0.82), radius * 0.82)
      })
  }

  static func roundedPolygon(_ points: [(CGPoint, CGFloat)]) -> CGPath {
    let path = CGMutablePath()
    let count = points.count
    func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
      CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }
    path.move(to: mid(points[count - 1].0, points[0].0))
    for index in 0..<count {
      let (corner, radius) = points[index]
      let next = points[(index + 1) % count].0
      path.addArc(tangent1End: corner, tangent2End: next, radius: radius)
    }
    path.closeSubpath()
    return path
  }

  // MARK: - Outline

  static let outlineWidth: CGFloat = 1.5
  static let outlineOpacity: CGFloat = 0.8
  /// The line: ember deepened a little, so it holds on a white window.
  static let outlineColor = mix(ember, rgb(0xC8674B), 0.25)
  static let outlineGlowRadius: CGFloat = 10
  static let outlineGlowOpacity: Float = 0.42
  /// Room around the window for the glow.
  static let outlineMargin: CGFloat = 28
  static let outlineFadeIn: TimeInterval = 0.18

  /// The corner radius of an app's window on this macOS. macOS 26 rounded
  /// windows well past the 10 points of earlier releases; the glow forgives
  /// the difference between a toolbar window and a plain one.
  static func windowCornerRadius(
    majorVersion: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
  ) -> CGFloat {
    majorVersion >= 26 ? 16 : 10
  }

  // MARK: - Pill

  static let pillRadius: CGFloat = 14
  static let pillHeight: CGFloat = 64
  /// Minimized, the pill is a capsule just tall enough for the app and `Stop`.
  static let minimizedPillHeight: CGFloat = 40
  static let pillAppearOffset: CGFloat = 8
  static let pillAppearDuration: TimeInterval = 0.22
  static let pillResizeDuration: TimeInterval = 0.32
  static let crossfadeDuration: TimeInterval = 0.18
  /// The app icon, expanded and minimized.
  static let pillIconSide: CGFloat = 36
  static let minimizedPillIconSide: CGFloat = 28
  /// How far a second app's icon shows from behind the first, as a share of
  /// the icon's side.
  static let pillIconStackOffset: CGFloat = 0.3
  /// The pointer badge's tip on the icon, as shares of its side. The badge is
  /// the agent's pointer, scaled this much per point of the icon's side.
  static let pillBadgeTip = CGPoint(x: 0.56, y: 0.44)
  static let pillBadgeScale: CGFloat = 0.022
  /// The eye badge's diameter, as a share of the icon's side.
  static let pillEyeBadge: CGFloat = 0.5
  /// A notice's apps, which the agent has let go of.
  static let pillReleasedIconOpacity: Float = 0.5
  /// How long `Stop` ignores presses after it appears or jumps to another
  /// screen, so a click aimed at whatever was there before cannot land on it.
  static let stopArmDelay: TimeInterval = 0.6
  static let peekDelay: TimeInterval = 0.3
  static let peekGap: CGFloat = 6
  static let peekMaxWidth: CGFloat = 360

  /// A capsule at the minimized height, easing into the expanded corners as
  /// it grows, so a resize never shows a corner sharper than either end.
  static func pillRadius(forHeight height: CGFloat) -> CGFloat {
    let span = pillHeight - minimizedPillHeight
    let progress = min(1, max(0, (height - minimizedPillHeight) / span))
    let capsule = min(height, minimizedPillHeight) / 2
    return capsule + (pillRadius - capsule) * progress
  }

  // MARK: - Colors

  static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha)
  }

  /// `color-mix(in srgb, a, b weight)`.
  static func mix(_ a: NSColor, _ b: NSColor, _ weight: CGFloat) -> NSColor {
    let a = a.usingColorSpace(.sRGB) ?? a
    let b = b.usingColorSpace(.sRGB) ?? b
    return NSColor(
      srgbRed: a.redComponent + (b.redComponent - a.redComponent) * weight,
      green: a.greenComponent + (b.greenComponent - a.greenComponent) * weight,
      blue: a.blueComponent + (b.blueComponent - a.blueComponent) * weight,
      alpha: a.alphaComponent + (b.alphaComponent - a.alphaComponent) * weight)
  }

  /// The pixel density every layer draws at: the densest screen, so nothing
  /// is soft on a Retina display.
  @MainActor
  static var contentsScale: CGFloat {
    NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
  }
}

/// Springs, in closed form, so motion is a plain function of time.
enum Spring {
  /// A critically damped spring from 0 to 1 that is within 0.3% of its end
  /// at `duration`: it leaves at rest, gathers speed, and settles without
  /// overshoot.
  static func critical(_ time: TimeInterval, duration: TimeInterval) -> Double {
    guard duration > 0, time < duration else { return 1 }
    let omega = 8 / duration
    let t = max(time, 0)
    return 1 - (1 + omega * t) * exp(-omega * t)
  }

  /// A lightly underdamped spring from 0 to 1 — a small, soft overshoot — for
  /// the pill settling into its corner.
  static func settle(_ time: TimeInterval, duration: TimeInterval, damping: Double = 0.78)
    -> Double
  {
    guard duration > 0, time < duration else { return 1 }
    let omega = 6.5 / duration
    let t = max(time, 0)
    let damped = omega * (1 - damping * damping).squareRoot()
    let envelope = exp(-damping * omega * t)
    return 1
      - envelope * (cos(damped * t) + (damping * omega / damped) * sin(damped * t))
  }

  /// A `CASpringAnimation` for a key path, critically damped unless
  /// `damping` is below 1, that settles in about `duration`.
  static func animation(
    _ keyPath: String, from: Any?, to: Any?, duration: TimeInterval, damping: Double = 1
  ) -> CASpringAnimation {
    let animation = CASpringAnimation(keyPath: keyPath)
    let omega = 8 / max(duration, 0.01)
    animation.mass = 1
    animation.stiffness = omega * omega
    animation.damping = 2 * damping * omega
    animation.initialVelocity = 0
    animation.fromValue = from
    animation.toValue = to
    animation.duration = duration
    return animation
  }
}

/// CoreGraphics puts the origin at the top left of the primary display and
/// counts y downwards; AppKit puts it at the bottom left and counts upwards.
enum OverlayGeometry {
  static func appKitRect(fromCoreGraphics rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(
      x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
  }

  /// The pointer panel's frame, in AppKit coordinates, that puts the tip on
  /// a CoreGraphics screen point.
  static func pointerPanelFrame(tip: CGPoint, primaryHeight: CGFloat) -> CGRect {
    let size = OverlayStyle.pointerPanelSize
    let offset = OverlayStyle.pointerTip
    return appKitRect(
      fromCoreGraphics: CGRect(
        x: tip.x - offset.x, y: tip.y - offset.y, width: size.width, height: size.height),
      primaryHeight: primaryHeight)
  }

  /// The outline panel's frame: the window with room for the glow.
  static func outlinePanelFrame(window: CGRect, primaryHeight: CGFloat) -> CGRect {
    appKitRect(
      fromCoreGraphics: window.insetBy(
        dx: -OverlayStyle.outlineMargin, dy: -OverlayStyle.outlineMargin),
      primaryHeight: primaryHeight)
  }

  /// Where the pointer is drawn: the same spot of the window it points into,
  /// wherever that window has moved.
  static func tip(offset: CGPoint, in window: CGRect) -> CGPoint {
    CGPoint(x: window.minX + offset.x, y: window.minY + offset.y)
  }

  /// A point along the way from `from` to `to`.
  static func interpolate(_ from: CGPoint, _ to: CGPoint, _ progress: Double) -> CGPoint {
    CGPoint(
      x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
  }
}
