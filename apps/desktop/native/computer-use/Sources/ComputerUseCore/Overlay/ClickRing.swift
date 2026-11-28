import AppKit
import QuartzCore

/// Where an agent's click landed: one thin ember ring that spreads from the
/// point and fades, in a small panel ordered directly above the window it
/// landed in. It is the only thing the agent's work draws in the app, behind
/// `OverlayStyle.showsClickRing`.
@MainActor
final class ClickRing {
  static let size = NSSize(width: 48, height: 48)

  let center: CGPoint
  private let panel = WindowOverlayPanel(size: size)
  private let root = CALayer()
  private(set) var isLive = true

  /// `center` is a CoreGraphics screen point.
  init(center: CGPoint) {
    self.center = center
    let view = NSView(frame: NSRect(origin: .zero, size: Self.size))
    view.layer = root
    view.wantsLayer = true
    root.isGeometryFlipped = true
    root.frame = view.bounds
    panel.contentView = view
    panel.setFrame(
      OverlayGeometry.appKitRect(
        fromCoreGraphics: CGRect(
          x: center.x - Self.size.width / 2, y: center.y - Self.size.height / 2,
          width: Self.size.width, height: Self.size.height),
        primaryHeight: ScreenGeometry.primaryHeight),
      display: false)
  }

  /// Takes the ring away now, finished or not.
  func cancel() {
    guard isLive else { return }
    isLive = false
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for ring in root.sublayers ?? [] {
      ring.removeAllAnimations()
      ring.removeFromSuperlayer()
    }
    CATransaction.commit()
    panel.orderOut(nil)
  }

  /// Spreads and fades over `window`, then takes itself away. Under Reduce
  /// Motion it only fades.
  func show(above window: TrackedWindow, reduced: Bool, done: @escaping @MainActor () -> Void) {
    let middle = CGPoint(x: Self.size.width / 2, y: Self.size.height / 2)
    panel.order(above: window)
    let ring = Self.ring(progress: reduced ? 0.5 : 1, center: middle)
    ring.opacity = 0
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      MainActor.assumeIsolated {
        ring.removeFromSuperlayer()
        guard let self, self.isLive else { return }
        self.isLive = false
        self.panel.orderOut(nil)
        done()
      }
    }
    root.addSublayer(ring)
    ring.add(Self.animation(center: middle, grows: !reduced), forKey: "ring")
    CATransaction.commit()
  }

  /// A ring spreading from `center` and fading.
  static func animation(center: CGPoint, grows: Bool) -> CAAnimation {
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let group = CAAnimationGroup()
    if grows {
      let grow = CABasicAnimation(keyPath: "path")
      grow.fromValue = path(progress: 0, center: center)
      grow.toValue = path(progress: 1, center: center)
      group.animations = [grow, fade]
    } else {
      group.animations = [fade]
    }
    group.duration = OverlayStyle.ringDuration
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
    return group
  }

  /// `progress` runs from a small ring at 0 to a wide one at 1.
  static func ring(progress: CGFloat, center: CGPoint) -> CAShapeLayer {
    let ring = CAShapeLayer()
    ring.fillColor = nil
    ring.strokeColor = OverlayStyle.emberRing.cgColor
    ring.lineWidth = OverlayStyle.ringWidth
    ring.contentsScale = OverlayStyle.contentsScale
    ring.path = path(progress: progress, center: center)
    return ring
  }

  static func path(progress: CGFloat, center: CGPoint) -> CGPath {
    let radii = OverlayStyle.ringRadii
    let radius = radii.from + (radii.to - radii.from) * progress
    return CGPath(
      ellipseIn: CGRect(
        x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2),
      transform: nil)
  }
}
