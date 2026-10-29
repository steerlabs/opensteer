import AppKit
import QuartzCore

/// A steady ember line around the key window held by a session. During work,
/// a short light travels around it without redrawing the border on the CPU.
///
/// Like the pointer it lives inside the app: its panel is ordered directly
/// above the window and follows it as it moves and resizes, and it is out of
/// sight whenever the window is.
@MainActor
final class WorkingOutline {
  private let panel = WindowOverlayPanel(size: NSSize(width: 100, height: 100))
  let view = WorkingOutlineView()
  /// The window it outlines, and that window as last read.
  private var windowID: CGWindowID?
  private(set) var window: TrackedWindow?
  private var wanted = false
  private var drawn = false
  /// The window size the outline's paths were made for.
  private var laidOut: CGSize?
  private var working = false

  init() {
    panel.contentView = view
  }

  var panelWindowNumber: Int { panel.windowNumber }
  var isWanted: Bool { wanted }
  var isDrawn: Bool { drawn }

  /// The window it follows.
  var trackedWindowID: CGWindowID? { wanted ? windowID : nil }

  /// Outlines `windowID`, fading in if it was not showing.
  func show(_ windowID: CGWindowID, in snapshot: WindowSnapshot) {
    self.windowID = windowID
    wanted = true
    place(in: snapshot, .verify)
  }

  func setWorking(_ value: Bool) {
    guard working != value else { return }
    working = value
    view.configure(working: value, visible: drawn, reduceMotion: OverlayMotion.reduced)
  }

  func motionChanged() {
    view.configure(working: working, visible: drawn, reduceMotion: OverlayMotion.reduced)
  }

  /// Follows the window, as `snapshot` read it.
  func place(in snapshot: WindowSnapshot, _ ordering: WindowOrdering) {
    guard wanted else { return }
    window = snapshot.window(windowID)
    guard let now = window, now.onScreen else {
      suspend()
      return
    }
    window = now
    let frame = OverlayGeometry.outlinePanelFrame(
      window: now.frame, primaryHeight: ScreenGeometry.primaryHeight)
    if panel.frame != frame { panel.setFrame(frame, display: false) }
    if laidOut != now.frame.size {
      laidOut = now.frame.size
      view.layout(windowSize: now.frame.size)
    }
    panel.order(above: now, ordering, in: snapshot)
    guard !drawn else { return }
    drawn = true
    view.configure(working: working, visible: true, reduceMotion: OverlayMotion.reduced)
    fade(to: 1, duration: OverlayStyle.outlineFadeIn)
  }

  func hide() {
    wanted = false
    drawn = false
    windowID = nil
    window = nil
    view.configure(working: false, visible: false, reduceMotion: OverlayMotion.reduced)
    panel.orderOut(nil)
  }

  private func suspend() {
    guard drawn else { return }
    drawn = false
    view.configure(working: working, visible: false, reduceMotion: OverlayMotion.reduced)
    panel.orderOut(nil)
  }

  private func fade(
    to opacity: Float, duration: TimeInterval, done: (@MainActor () -> Void)? = nil
  ) {
    let layer = view.root
    let reduced = OverlayMotion.reduced
    CATransaction.begin()
    CATransaction.setCompletionBlock {
      MainActor.assumeIsolated { done?() }
    }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = layer.presentation()?.opacity ?? layer.opacity
    fade.toValue = opacity
    fade.duration = reduced ? 0 : duration
    fade.timingFunction = CAMediaTimingFunction(name: opacity > 0 ? .easeOut : .easeInEaseOut)
    CATransaction.setDisableActions(true)
    layer.opacity = opacity
    layer.add(fade, forKey: "fade")
    CATransaction.commit()
  }
}

/// A steady border and a two-layer traveling glint. The glint uses an
/// animatable dash phase on the same closed path, so its lap wraps cleanly.
final class WorkingOutlineView: NSView {
  let root = CALayer()
  private let glow = CAShapeLayer()
  private let glowMask = CAShapeLayer()
  private let line = CAShapeLayer()
  private let accentGlow = CAShapeLayer()
  private let accent = CAShapeLayer()
  private var perimeter: CGFloat = 0
  private var working = false
  private var visible = false
  private var reduceMotion = false

  var sweepAnimation: CAAnimation? { accent.animation(forKey: "sweep") }
  var borderOpacity: Float { line.opacity }

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
    root.opacity = 0
    let scale = OverlayStyle.contentsScale

    glow.fillColor = nil
    glow.strokeColor = OverlayStyle.emberGlow.cgColor
    glow.lineWidth = 4
    glow.shadowColor = OverlayStyle.emberGlow.cgColor
    glow.shadowOpacity = 1
    glow.shadowRadius = OverlayStyle.outlineGlowRadius
    glow.shadowOffset = .zero
    glow.opacity = OverlayStyle.outlineGlowOpacity
    // Only the outside: the window's own content stays untinted.
    glowMask.fillRule = .evenOdd
    glow.mask = glowMask
    root.addSublayer(glow)

    line.fillColor = nil
    line.strokeColor =
      OverlayStyle.outlineColor.withAlphaComponent(OverlayStyle.outlineOpacity)
      .cgColor
    line.lineWidth = OverlayStyle.outlineWidth
    root.addSublayer(line)

    for layer in [accentGlow, accent] {
      layer.fillColor = nil
      layer.lineCap = .round
      layer.opacity = 0
      root.addSublayer(layer)
    }
    accentGlow.strokeColor = OverlayStyle.emberBright.withAlphaComponent(0.45).cgColor
    accentGlow.lineWidth = 5
    accentGlow.shadowColor = OverlayStyle.emberBright.cgColor
    accentGlow.shadowOpacity = 0.8
    accentGlow.shadowRadius = 7
    accentGlow.shadowOffset = .zero
    accent.strokeColor = NSColor.white.withAlphaComponent(0.9).cgColor
    accent.lineWidth = 1.7

    for layer in [root, glow, glowMask, line, accentGlow, accent] {
      layer.contentsScale = scale
    }
  }

  required init?(coder: NSCoder) { nil }

  /// Lays the outline out for a window of `windowSize` points, centred in a
  /// panel `outlineMargin` larger on every side.
  func layout(windowSize: CGSize) {
    let margin = OverlayStyle.outlineMargin
    let panelSize = CGSize(
      width: windowSize.width + margin * 2, height: windowSize.height + margin * 2)
    let bounds = CGRect(origin: .zero, size: panelSize)
    let windowRect = CGRect(
      x: margin, y: margin, width: windowSize.width, height: windowSize.height)
    let radius = OverlayStyle.windowCornerRadius()
    // The line sits just outside the window's own edge, so it never covers
    // the app's pixels.
    let lineRect = windowRect.insetBy(dx: -0.75, dy: -0.75)
    let linePath = CGPath(
      roundedRect: lineRect, cornerWidth: radius + 0.75, cornerHeight: radius + 0.75,
      transform: nil)
    let outside = CGMutablePath()
    outside.addRect(bounds)
    outside.addPath(
      CGPath(roundedRect: windowRect, cornerWidth: radius, cornerHeight: radius, transform: nil))

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    frame.size = panelSize
    root.frame = bounds
    for layer in [glow, glowMask, line, accentGlow, accent] { layer.frame = bounds }
    glow.path = linePath
    // The shadow's shape, given rather than found: without it Core Animation
    // derives the shadow from the masked stroke's pixels, again on every
    // frame of a live resize.
    glow.shadowPath = linePath.copy(
      strokingWithWidth: glow.lineWidth, lineCap: .butt, lineJoin: .miter, miterLimit: 10)
    glowMask.path = outside
    line.path = linePath
    accentGlow.path = linePath
    accent.path = linePath
    let lineRadius = radius + 0.75
    perimeter = 2 * (lineRect.width + lineRect.height - 4 * lineRadius)
      + 2 * .pi * lineRadius
    let length = min(76, perimeter * 0.17)
    let dashes: [NSNumber] = [NSNumber(value: Double(length)), NSNumber(value: Double(perimeter - length))]
    accentGlow.lineDashPattern = dashes
    accent.lineDashPattern = dashes
    CATransaction.commit()
    syncSweep(restart: true)
  }

  func configure(working: Bool, visible: Bool, reduceMotion: Bool) {
    guard self.working != working || self.visible != visible || self.reduceMotion != reduceMotion
    else { return }
    self.working = working
    self.visible = visible
    self.reduceMotion = reduceMotion
    syncSweep(restart: false)
  }

  private func syncSweep(restart: Bool) {
    let moving = working && visible && !reduceMotion && perimeter > 0
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glow.opacity = working ? OverlayStyle.outlineGlowOpacity : 0.22
    line.opacity = working ? 1 : 0.65
    accentGlow.opacity = moving ? 1 : 0
    accent.opacity = moving ? 1 : 0
    CATransaction.commit()

    guard moving else {
      accentGlow.removeAnimation(forKey: "sweep")
      accent.removeAnimation(forKey: "sweep")
      return
    }
    guard restart || sweepAnimation == nil else { return }
    // One full lap is an identical dash arrangement. Core Animation repeats
    // it in the compositor; ordinary render and tracking calls never restart.
    let begin = CACurrentMediaTime()
    for layer in [accentGlow, accent] {
      layer.removeAnimation(forKey: "sweep")
      let animation = CABasicAnimation(keyPath: "lineDashPhase")
      animation.fromValue = 0
      animation.toValue = -perimeter
      animation.duration = 3.2
      animation.repeatCount = .infinity
      animation.timingFunction = CAMediaTimingFunction(name: .linear)
      animation.beginTime = begin
      layer.add(animation, forKey: "sweep")
    }
  }
}
