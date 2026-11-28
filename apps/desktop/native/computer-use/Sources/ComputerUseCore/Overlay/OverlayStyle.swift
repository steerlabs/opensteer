import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// The agent's look on the Mac, in one place.
///
/// One small dark chip tucked onto the top edge of the window agents work in,
/// a dot per agent in Opensteer's ember, and nothing else at rest: the
/// person's pointer is black and white and macOS's focus rings are blue, so
/// ember reads as the agent.
enum OverlayStyle {
  // MARK: - Palette (apps/web/src/styles/tokens.css)

  static let ember = rgb(0xE6BEB0)
  static let inkOnEmber = rgb(0x1B120E)
  static let text = rgb(0xF5F4F2)
  static let surface = rgb(0x101010)
  static let red = rgb(0xE77E76)
  static let amber = rgb(0xDFB36B)
  /// The click ring: ember pulled toward clay, so a thin line still reads on
  /// a white page as well as a dark one.
  static let emberRing = mix(ember, rgb(0xC8674B), 0.5)

  // MARK: - Chip

  /// The chip on the window's top edge, half above it.
  static let chipHeight: CGFloat = 22
  /// Inside the window, where there is no room above it: the dots only,
  /// hanging from the edge, short enough to stay in the 8-point strip
  /// Safari leaves above its address field on macOS 26.
  static let notchHeight: CGFloat = 9
  static let chipPadding: CGFloat = 7
  static let dotSize: CGFloat = 8
  static let notchDotSize: CGFloat = 5
  /// How far each dot tucks under the one before it.
  static let dotOverlap: CGFloat = 2
  /// The ring of chip colour around each dot that keeps overlapping dots
  /// apart.
  static let dotRing: CGFloat = 1.5
  /// A still dot: lit, but a step below a working one at its brightest.
  static let stillDotOpacity: Float = 0.85
  /// The low end of a working dot's breath.
  static let breathLow: Float = 0.4
  static let breathPeriod: TimeInterval = 1.6
  static let hairlineOpacity: CGFloat = 0.16
  static let shadowOpacity: Float = 0.28
  static let shadowRadius: CGFloat = 2
  static let shadowOffset: CGFloat = 1
  /// Room around the chip in its panel for the shadow.
  static let chipMargin: CGFloat = 4
  /// Between the dots and `+N` or the word.
  static let chipGap: CGFloat = 6
  static var wordFont: NSFont { .systemFont(ofSize: 11, weight: .semibold) }
  static var countFont: NSFont { .systemFont(ofSize: 10, weight: .medium) }
  static let countOpacity: CGFloat = 0.62
  static let expandDuration: TimeInterval = 0.22
  /// A click lands on `Stop` only once it has shown this long, so a click
  /// aimed at the toolbar as the chip appeared under it stops nothing.
  static let stopArmDelay: TimeInterval = 0.3
  /// The chip returns this long after its window stops moving.
  static let settleDelay: TimeInterval = 0.15
  static let fadeDuration: TimeInterval = 0.15

  // MARK: - Click ring

  /// The one thing the agent's work draws in the app: a thin ring where it
  /// clicks. Setting this to false removes it.
  static let showsClickRing = true
  static let ringRadii: (from: CGFloat, to: CGFloat) = (4, 18)
  static let ringWidth: CGFloat = 1.25
  static let ringDuration: TimeInterval = 0.5

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
}

/// CoreGraphics puts the origin at the top left of the primary display and
/// counts y downwards; AppKit puts it at the bottom left and counts upwards.
enum OverlayGeometry {
  static func appKitRect(fromCoreGraphics rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(
      x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
  }

  /// Where the chip sits on a window.
  enum ChipPlacement: Equatable {
    /// Half above the top edge, like a tab tucked onto the window.
    case edge
    /// Inside the window, hanging from the top edge: the edge touches the
    /// menu bar or the top of its screen, or the window is full screen.
    case notch
  }

  /// One fixed rule: the chip goes on the edge when its upper half clears the
  /// top of the usable area of the screen the window's top edge is on, and
  /// hangs inside otherwise. `usableTops` are each screen's frame with the
  /// top of the area below its menu bar, all in CoreGraphics coordinates.
  static func chipPlacement(
    window: CGRect, usableTops: [(screen: CGRect, top: CGFloat)]
  ) -> ChipPlacement {
    let anchor = CGPoint(x: window.midX, y: window.minY)
    guard
      let screen = usableTops.first(where: {
        anchor.x >= $0.screen.minX && anchor.x < $0.screen.maxX
          && anchor.y >= $0.screen.minY && anchor.y < $0.screen.maxY
      })
    else { return .notch }
    return window.minY - OverlayStyle.chipHeight / 2 >= screen.top ? .edge : .notch
  }

  /// The chip's own frame, in CoreGraphics coordinates, centred on the
  /// window's top edge and on whole device pixels. On the edge it is centred
  /// on the edge line; as a notch its top is the edge.
  static func chipFrame(
    window: CGRect, size: CGSize, placement: ChipPlacement, scale: CGFloat
  ) -> CGRect {
    func pixel(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }
    let x = pixel(window.midX - size.width / 2)
    let top: CGFloat
    switch placement {
    case .edge: top = pixel(window.minY - OverlayStyle.chipHeight / 2)
    case .notch: top = pixel(window.minY)
    }
    return CGRect(x: x, y: top, width: size.width, height: size.height)
  }
}

/// Reduce Motion makes every overlay transition immediate.
@MainActor
enum OverlayMotion {
  static var reduced: Bool {
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  static func fade(
    _ window: NSWindow,
    to alpha: CGFloat,
    duration: TimeInterval,
    completion: (@MainActor @Sendable () -> Void)? = nil
  ) {
    guard duration > 0, !reduced else {
      window.alphaValue = alpha
      completion?()
      return
    }
    NSAnimationContext.runAnimationGroup(
      { context in
        context.duration = duration
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        window.animator().alphaValue = alpha
      },
      completionHandler: {
        MainActor.assumeIsolated { completion?() }
      }
    )
  }
}

/// A working dot's slow breath. Dots in every chip share a beat.
///
/// It runs for as long as work does, so it asks Core Animation for a low
/// frame rate: at display rate the window server would recomposite the chip
/// 60 to 120 times a second for a change too slow to see between frames.
enum Breath {
  static let frameRate = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 12)

  static func animation(low: Float, high: Float) -> CABasicAnimation {
    let half = OverlayStyle.breathPeriod / 2
    let now = CACurrentMediaTime()
    let beat = now - now.truncatingRemainder(dividingBy: OverlayStyle.breathPeriod)
    let animation = CABasicAnimation(keyPath: "opacity")
    animation.fromValue = low
    animation.toValue = high
    animation.duration = half
    animation.autoreverses = true
    animation.repeatCount = .infinity
    animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    animation.beginTime = beat
    animation.fillMode = .both
    animation.preferredFrameRateRange = frameRate
    return animation
  }
}
