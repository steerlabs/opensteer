import AppKit
import QuartzCore

/// The agent's pointer: an ember arrow with a dark edge, a fine white keyline
/// and just enough glow to remain distinct on light and dark windows.
///
/// Every resting look is a `Pose` set straight on the layers, which is also
/// how a snapshot draws one frame; motion is Core Animation added on top.
/// The pill's badge draws the same layers, scaled, so the person knows the
/// badge as the pointer they see in the app.
final class AgentCursorView: NSView {
  // AppKit synchronizes a hosted layer's geometry with its view after layout.
  // The pointer path uses top-left coordinates, so both must stay flipped.
  override var isFlipped: Bool { true }

  struct Pose: Equatable {
    var opacity: Float = 1
    /// The whole pointer, about its tip.
    var scale: CGFloat = 1
    var glowOpacity: Float = OverlayStyle.glowRestOpacity
    var glowScale: CGFloat = 1

    static let rest = Pose()
  }

  let root = CALayer()
  /// The arrow and its glow, scaled about the tip.
  let body = CALayer()
  let glow = CALayer()
  let arrow = CALayer()

  init() {
    let size = OverlayStyle.pointerPanelSize
    super.init(frame: NSRect(origin: .zero, size: size))
    // Layer-hosting: the view never draws; its layers are the pointer.
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
    root.frame = bounds
    Self.build(in: root, body: body, glow: glow, arrow: arrow)
  }

  required init?(coder: NSCoder) { nil }

  /// Draws the pointer into `root`, a flipped layer the size of the pointer
  /// panel, with its tip at `OverlayStyle.pointerTip`.
  static func build(in root: CALayer, body: CALayer, glow: CALayer, arrow: CALayer) {
    let fill = CAGradientLayer()
    let hairline = CAShapeLayer()
    let edge = CAShapeLayer()
    let size = OverlayStyle.pointerPanelSize
    let tip = OverlayStyle.pointerTip
    let scale = OverlayStyle.contentsScale
    var move = CGAffineTransform(translationX: tip.x, y: tip.y)
    let path = OverlayStyle.arrowPath().copy(using: &move) ?? OverlayStyle.arrowPath()
    let box = path.boundingBoxOfPath

    body.bounds = CGRect(origin: .zero, size: size)
    body.anchorPoint = CGPoint(x: tip.x / size.width, y: tip.y / size.height)
    body.position = tip
    root.addSublayer(body)

    // A narrow, low-opacity glow separates the arrow from a busy window.
    glow.frame = body.bounds
    glow.anchorPoint = CGPoint(x: box.midX / size.width, y: box.midY / size.height)
    glow.frame = body.bounds
    glow.shadowPath = path.copy(
      strokingWithWidth: OverlayStyle.glowSpread, lineCap: .round, lineJoin: .round,
      miterLimit: 1)
    glow.shadowColor = OverlayStyle.emberGlow.cgColor
    glow.shadowOpacity = 1
    glow.shadowRadius = OverlayStyle.glowRadius
    glow.shadowOffset = .zero
    glow.opacity = OverlayStyle.glowRestOpacity
    body.addSublayer(glow)

    // The arrow floats a hair above the page, as the system pointer does.
    arrow.frame = body.bounds
    arrow.shadowPath = path
    arrow.shadowColor = NSColor.black.cgColor
    arrow.shadowOpacity = 0.22
    arrow.shadowRadius = 1.5
    arrow.shadowOffset = CGSize(width: 0, height: 1)
    body.addSublayer(arrow)

    // Dark edge outside a fine white keyline keeps the shape legible on white.
    hairline.frame = body.bounds
    hairline.path = path
    hairline.fillColor = nil
    hairline.strokeColor = OverlayStyle.emberEdge.withAlphaComponent(0.9).cgColor
    hairline.lineWidth = 2
    hairline.lineJoin = .round
    arrow.addSublayer(hairline)

    // Ember, brighter at the tip and deeper toward the tail.
    fill.frame = body.bounds
    fill.colors = [OverlayStyle.emberBright.cgColor, OverlayStyle.emberDeep.cgColor]
    fill.startPoint = CGPoint(x: 0.5, y: box.minY / size.height)
    fill.endPoint = CGPoint(x: 0.5, y: box.maxY / size.height)
    fill.opacity = 1
    let fillMask = CAShapeLayer()
    fillMask.frame = body.bounds
    fillMask.path = path
    fill.mask = fillMask
    arrow.addSublayer(fill)

    edge.frame = body.bounds
    edge.path = path
    edge.fillColor = nil
    edge.strokeColor = NSColor.white.withAlphaComponent(0.95).cgColor
    edge.lineWidth = 1
    edge.lineJoin = .round
    arrow.addSublayer(edge)

    for layer in [
      root, body, glow, arrow, hairline, fill, fillMask, edge,
    ] {
      layer.contentsScale = scale
    }
  }

  /// Sets a look at once, with no implicit animation.
  func apply(_ pose: Pose) {
    Self.apply(pose, body: body, glow: glow)
  }

  static func apply(_ pose: Pose, body: CALayer, glow: CALayer) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    body.opacity = pose.opacity
    body.transform = CATransform3DMakeScale(pose.scale, pose.scale, 1)
    glow.opacity = pose.glowOpacity
    glow.transform = CATransform3DMakeScale(pose.glowScale, pose.glowScale, 1)
    CATransaction.commit()
  }

  /// The pointer pressing, for its body.
  static func pressAnimation() -> CAAnimation {
    let press = CAKeyframeAnimation(keyPath: "transform.scale")
    press.values = [1, OverlayStyle.pressScale, 1]
    press.keyTimes = [0, 0.28, 1]
    press.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeOut),
    ]
    press.duration = OverlayStyle.pressDuration / 0.28
    return press
  }

  /// A beat of the glow, from the opacity it has now.
  static func pulseAnimation(from base: Float) -> CAAnimation {
    let pulse = CAKeyframeAnimation(keyPath: "opacity")
    pulse.values = [base, 0.85, base]
    pulse.keyTimes = [0, 0.35, 1]
    pulse.duration = OverlayStyle.pulseDuration
    pulse.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut),
    ]
    return pulse
  }

  /// A ring spreading from `center` and fading, for a layer from
  /// `ring(progress:center:)`.
  static func rippleAnimation(center: CGPoint) -> CAAnimation {
    let grow = CABasicAnimation(keyPath: "path")
    grow.fromValue = ringPath(progress: 0, center: center)
    grow.toValue = ringPath(progress: 1, center: center)
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = OverlayStyle.rippleDuration
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
    return group
  }

  /// A ring around the tip. `progress` runs from a small bright ring at 0 to
  /// a wide faded one at 1.
  static func ring(progress: CGFloat, center: CGPoint) -> CAShapeLayer {
    let ring = CAShapeLayer()
    ring.fillColor = nil
    ring.strokeColor = OverlayStyle.emberRing.cgColor
    ring.lineWidth = OverlayStyle.rippleWidth
    ring.contentsScale = OverlayStyle.contentsScale
    ring.path = ringPath(progress: progress, center: center)
    ring.opacity = Float(1 - progress)
    ring.shadowColor = OverlayStyle.emberGlow.cgColor
    ring.shadowOpacity = 0.8
    ring.shadowRadius = 2.5
    ring.shadowOffset = .zero
    return ring
  }

  static func ringPath(progress: CGFloat, center: CGPoint) -> CGPath {
    let radii = OverlayStyle.rippleRadii
    let radius = radii.from + (radii.to - radii.from) * progress
    return CGPath(
      ellipseIn: CGRect(
        x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2),
      transform: nil)
  }
}
