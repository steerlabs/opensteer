import AppKit
import QuartzCore

/// The one mark the agents leave on a window they work in: a small dark chip
/// tucked onto the middle of its top edge, a dot per agent.
///
/// Pointing at it widens it to show `Stop`; pressing that stops the agents
/// working in that app. It lives inside the app like the window it marks: its
/// panel is ordered directly above that window, so whatever covers the window
/// covers it, and it is never seen chasing the window: the moment the window
/// moves or resizes it is gone, and it fades back in at the new place once
/// the window has been still for a moment.
@MainActor
final class WindowChip {
  private let panel = WindowOverlayPanel(size: NSSize(width: 30, height: 30), ignoresMouse: false)
  let view = ChipView()
  private let clock = FrameClock()
  /// The window it marks, and that window as last read.
  private var windowID: CGWindowID?
  private(set) var window: TrackedWindow?
  private var wanted = false
  /// The window frame the panel is placed for; nil while it is not showing.
  private(set) var placedFor: CGRect?
  private var settling = ChipSettling()
  private var onScreen = false
  private var hovering = false
  /// When `Stop` (or the notice's sentence) finished widening into view.
  private var expandedAt: CFTimeInterval?
  /// The person pressed `Stop`, or dismissed the notice.
  var onAction: (@MainActor () -> Void)?
  /// The clock and the mouse buttons. A test stands in for both.
  var now: () -> CFTimeInterval = CACurrentMediaTime
  var mouseButtonsDown: () -> Bool = { NSEvent.pressedMouseButtons != 0 }

  init() {
    panel.contentView = view
    view.onHover = { [weak self] inside in self?.hover(inside) }
    view.onClick = { [weak self] in self?.click() }
    view.onPress = { [weak self] in self?.onAction?() }
  }

  var panelWindowNumber: Int { panel.windowNumber }
  var isWanted: Bool { wanted }
  /// Shown, or hidden only while its window moves: the tracker keeps
  /// following its window's events.
  var isDrawn: Bool { wanted && onScreen }
  var isShowing: Bool { placedFor != nil }
  /// The window it follows.
  var trackedWindowID: CGWindowID? { wanted ? windowID : nil }
  var frame: NSRect { panel.frame }

  /// Marks `windowID` with `chip`.
  func show(_ chip: OverlayModel.Chip, on windowID: CGWindowID, in snapshot: WindowSnapshot) {
    if self.windowID != windowID {
      conceal()
      self.windowID = windowID
      settling = ChipSettling()
    }
    wanted = true
    let resized = view.configure(chip, reduceMotion: OverlayMotion.reduced)
    if resized, let window, placedFor != nil { setExpansion(view.expansion, on: window) }
    place(in: snapshot, .verify)
  }

  /// Follows the window, as `snapshot` read it. Returns whether the window
  /// moved or resized since the last read.
  @discardableResult
  func place(in snapshot: WindowSnapshot, _ ordering: WindowOrdering) -> Bool {
    guard wanted else { return false }
    window = snapshot.window(windowID)
    let visible = window.flatMap { $0.onScreen ? $0 : nil }
    onScreen = visible != nil
    let (step, moved) = settling.step(
      frame: visible?.frame, showing: placedFor != nil, at: now(), buttonsDown: mouseButtonsDown)
    switch step {
    case .conceal: conceal()
    case .reveal: if let visible { reveal(on: visible, in: snapshot) }
    case .keep: if let visible { panel.order(above: visible, ordering, in: snapshot) }
    case .wait: break
    }
    return moved
  }

  func hide() {
    wanted = false
    windowID = nil
    window = nil
    settling = ChipSettling()
    onScreen = false
    conceal()
  }

  func motionChanged() {
    view.applyMotion(reduceMotion: OverlayMotion.reduced)
  }

  // MARK: - Drawing

  private func reveal(on window: TrackedWindow, in snapshot: WindowSnapshot) {
    view.placement = OverlayGeometry.chipPlacement(
      window: window.frame, usableTops: Self.usableTops())
    view.scale = Self.scale(for: window.frame)
    placedFor = window.frame
    setExpansion(0, on: window)
    panel.alphaValue = 0
    panel.order(above: window, .always, in: snapshot)
    OverlayMotion.fade(panel, to: 1, duration: OverlayStyle.fadeDuration)
  }

  /// Out of sight at once, at rest.
  private func conceal() {
    clock.stop()
    hovering = false
    expandedAt = nil
    view.expansion = 0
    guard placedFor != nil || panel.isVisible else { return }
    placedFor = nil
    panel.alphaValue = 0
    panel.orderOut(nil)
  }

  private func hover(_ inside: Bool) {
    guard placedFor != nil, inside != hovering else { return }
    hovering = inside
    expand(inside)
  }

  /// A click on `Stop` once it has shown long enough stops; a click before
  /// that only opens it.
  private func click() {
    guard placedFor != nil else { return }
    if let expandedAt, view.expansion >= 1, now() - expandedAt >= OverlayStyle.stopArmDelay {
      onAction?()
      return
    }
    hovering = true
    expand(true)
  }

  private func expand(_ open: Bool) {
    guard let window else { return }
    let target: CGFloat = open ? 1 : 0
    let start = view.expansion
    expandedAt = nil
    guard !OverlayMotion.reduced, start != target else {
      clock.stop()
      setExpansion(target, on: window)
      if open { expandedAt = now() }
      return
    }
    let began = now()
    clock.run { [weak self] time in
      guard let self, let window = self.window, self.placedFor != nil else { return false }
      let progress = CGFloat(Spring.critical(time - began, duration: OverlayStyle.expandDuration))
      self.setExpansion(start + (target - start) * progress, on: window)
      guard progress < 1 else {
        if open { self.expandedAt = self.now() }
        return false
      }
      return true
    }
  }

  private func setExpansion(_ expansion: CGFloat, on window: TrackedWindow) {
    view.expansion = expansion
    let chip = OverlayGeometry.chipFrame(
      window: window.frame, size: view.chipSize(expansion: expansion),
      placement: view.placement, scale: view.scale)
    let margin = OverlayStyle.chipMargin
    let frame = OverlayGeometry.appKitRect(
      fromCoreGraphics: chip.insetBy(dx: -margin, dy: -margin),
      primaryHeight: ScreenGeometry.primaryHeight)
    if panel.frame != frame { panel.setFrame(frame, display: true) }
    view.needsLayout = true
    view.layoutSubtreeIfNeeded()
  }

  /// Each screen, with the top of the area below its menu bar, in
  /// CoreGraphics coordinates.
  private static func usableTops() -> [(screen: CGRect, top: CGFloat)] {
    let primary = ScreenGeometry.primaryHeight
    return NSScreen.screens.map { screen in
      (
        OverlayGeometry.appKitRect(fromCoreGraphics: screen.frame, primaryHeight: primary),
        primary - screen.visibleFrame.maxY
      )
    }
  }

  /// The pixel density of the screen the window's top edge is on.
  private static func scale(for window: CGRect) -> CGFloat {
    let primary = ScreenGeometry.primaryHeight
    // Just inside the edge, so a window flush with the screen's top is on it.
    let anchor = CGPoint(x: window.midX, y: primary - window.minY - 1)
    return NSScreen.screens.first { $0.frame.contains(anchor) }?.backingScaleFactor
      ?? OverlayStyle.contentsScale
  }
}

/// When a chip shows on its window: never while the window moves.
///
/// The moment a read finds the window somewhere new, or a new size, the chip
/// goes; it comes back at the new place once the window has kept still for
/// `OverlayStyle.settleDelay` and no mouse button is down (a person holding a
/// window still mid-drag has not let go of it). A window out of sight takes
/// the chip with it, and back in sight it shows at once.
struct ChipSettling {
  enum Step: Equatable {
    /// Out of sight now.
    case conceal
    /// Place it on the window and fade it in.
    case reveal
    /// Showing, and stays where it is.
    case keep
    /// Hidden until the window settles.
    case wait
  }

  private var lastSeen: CGRect?
  private var movedAt: CFTimeInterval = -.infinity

  /// `frame` is the window as just read, nil when it is not on screen.
  /// Returns what to do and whether the window moved since the last read.
  mutating func step(
    frame: CGRect?, showing: Bool, at time: CFTimeInterval, buttonsDown: () -> Bool
  ) -> (Step, moved: Bool) {
    guard let frame else {
      lastSeen = nil
      return (.conceal, false)
    }
    let moved = lastSeen.map { $0 != frame } ?? false
    lastSeen = frame
    if moved { movedAt = time }
    if showing { return (moved ? .conceal : .keep, moved) }
    guard movedAt != -.infinity else { return (.reveal, moved) }
    let settled = time - movedAt >= OverlayStyle.settleDelay && !buttonsDown()
    return (settled ? .reveal : .wait, moved)
  }
}

/// The chip's drawing: a near-black capsule with a hairline edge, the dots,
/// and the one word that widens into view when the person points at it.
///
/// `expansion` runs from 0, at rest, to 1, with the word showing; every
/// frame of the widening is a plain layout of it.
final class ChipView: NSView {
  override var isFlipped: Bool { true }

  var onHover: (@MainActor (Bool) -> Void)?
  var onClick: (@MainActor () -> Void)?
  /// An accessibility press: it acts at once.
  var onPress: (@MainActor () -> Void)?
  var placement: OverlayGeometry.ChipPlacement = .edge {
    didSet { if placement != oldValue { rebuildDots() } }
  }
  var scale: CGFloat = 2 {
    didSet { if scale != oldValue { applyScale() } }
  }
  var expansion: CGFloat = 0 {
    didSet { if expansion != oldValue { needsLayout = true } }
  }
  private(set) var chip: OverlayModel.Chip?

  /// The capsule, its shadow, and what is in it.
  let root = CALayer()
  let body = CALayer()
  private let shade = CALayer()
  /// Each dot's fill, which is what breathes, in an opaque ring of the
  /// chip's colour that keeps overlapping dots apart.
  private(set) var dots: [CALayer] = []
  private var rings: [CALayer] = []
  let count = CATextLayer()
  let word = CATextLayer()
  private var reduceMotion = false
  private var pressed = false

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 30, height: 30))
    // Layer-hosting, in the view's own top-left coordinates.
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
    root.frame = bounds
    shade.shadowColor = NSColor.black.cgColor
    shade.shadowOpacity = OverlayStyle.shadowOpacity
    shade.shadowRadius = OverlayStyle.shadowRadius
    shade.shadowOffset = CGSize(width: 0, height: -OverlayStyle.shadowOffset)
    body.cornerCurve = .continuous
    body.masksToBounds = true
    for text in [count, word] {
      text.alignmentMode = .left
      text.truncationMode = .none
      text.isWrapped = false
      body.addSublayer(text)
    }
    root.addSublayer(shade)
    root.addSublayer(body)
    applyScale()
  }

  required init?(coder: NSCoder) { nil }

  // MARK: - What it shows

  /// Returns whether the chip's size changed.
  @discardableResult
  func configure(_ next: OverlayModel.Chip, reduceMotion: Bool) -> Bool {
    guard next != chip || reduceMotion != self.reduceMotion else { return false }
    let before = (chipSize(expansion: 0), chipSize(expansion: 1))
    let previous = chip
    chip = next
    self.reduceMotion = reduceMotion
    if previous?.look.dotCount != next.look.dotCount || previous?.look.isNotice != next.look.isNotice {
      rebuildDots()
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let notice = next.look.isNotice
    body.backgroundColor = (notice ? OverlayStyle.amber : OverlayStyle.surface).cgColor
    body.borderColor =
      (notice
      ? NSColor.black.withAlphaComponent(0.25)
      : NSColor.white.withAlphaComponent(OverlayStyle.hairlineOpacity)).cgColor
    colorDots()
    if case .agents(_, let more) = next.look, more > 0 {
      count.string = Self.text("+\(more)", font: OverlayStyle.countFont,
        color: OverlayStyle.text.withAlphaComponent(OverlayStyle.countOpacity))
    } else {
      count.string = nil
    }
    word.string = notice
      ? Self.text(OverlayModel.connectionLostSentence, font: OverlayStyle.wordFont, color: OverlayStyle.inkOnEmber)
      : Self.text("Stop", font: OverlayStyle.wordFont, color: OverlayStyle.red)
    CATransaction.commit()
    applyMotion(reduceMotion: reduceMotion)
    needsLayout = true
    return before != (chipSize(expansion: 0), chipSize(expansion: 1))
  }

  /// Working dots breathe; still ones are lit and still.
  /// Under Reduce Motion a working dot is simply bright.
  func applyMotion(reduceMotion: Bool) {
    self.reduceMotion = reduceMotion
    let activities: [OverlayModel.Activity]
    if case .agents(let shown, _) = chip?.look { activities = shown } else { activities = [] }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (index, dot) in dots.enumerated() {
      let working = index < activities.count && activities[index] == .working
      let notice = chip?.look.isNotice == true
      guard working, !notice else {
        dot.removeAnimation(forKey: "breath")
        dot.opacity = notice ? 1 : OverlayStyle.stillDotOpacity
        continue
      }
      dot.opacity = 1
      if reduceMotion {
        dot.removeAnimation(forKey: "breath")
      } else if dot.animation(forKey: "breath") == nil {
        dot.add(Breath.animation(low: OverlayStyle.breathLow, high: 1), forKey: "breath")
      }
    }
    CATransaction.commit()
  }

  // MARK: - Size and layout

  private var isNotch: Bool { placement == .notch }
  private var dotSize: CGFloat {
    chip?.look.isNotice == true || isNotch ? OverlayStyle.notchDotSize : OverlayStyle.dotSize
  }

  private var dotsWidth: CGFloat {
    let count = CGFloat(max(1, dots.count))
    return count * dotSize - (count - 1) * OverlayStyle.dotOverlap
  }

  private var countWidth: CGFloat {
    guard count.string != nil else { return 0 }
    return OverlayStyle.chipGap - 2 + Self.width(of: count.string)
  }

  /// The chip's own size, without its shadow's margin.
  func chipSize(expansion: CGFloat) -> CGSize {
    let restHeight = isNotch ? OverlayStyle.notchHeight : OverlayStyle.chipHeight
    let restPadding = isNotch ? 8 : OverlayStyle.chipPadding
    // At rest a lone dot is a circle on the edge, and as wide a notch.
    let restWidth = max(
      OverlayStyle.chipHeight, restPadding * 2 + dotsWidth + (isNotch ? 0 : countWidth))
    let openWidth =
      OverlayStyle.chipPadding + dotsWidth + countWidth + OverlayStyle.chipGap
      + Self.width(of: word.string) + OverlayStyle.chipPadding + 2
    let width = restWidth + (max(openWidth, restWidth) - restWidth) * expansion
    let height = restHeight + (OverlayStyle.chipHeight - restHeight) * expansion
    return CGSize(width: width, height: height)
  }

  /// Whether a point of the view is on the chip itself.
  func chipContains(_ point: NSPoint) -> Bool {
    body.frame.contains(point)
  }

  override func layout() {
    super.layout()
    let margin = OverlayStyle.chipMargin
    let size = chipSize(expansion: expansion)
    let frame = CGRect(x: margin, y: margin, width: size.width, height: size.height)
    let radius = isNotch ? min(size.height / 2, OverlayStyle.chipHeight / 2) : size.height / 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.frame = bounds
    body.frame = frame
    body.cornerRadius = radius
    // A notch hangs from the window's edge: square where it meets it.
    body.maskedCorners =
      isNotch
      ? [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
      : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    shade.frame = frame
    shade.shadowPath = CGPath(
      roundedRect: CGRect(origin: .zero, size: size), cornerWidth: radius, cornerHeight: radius,
      transform: nil)

    // Dots: on the rest centre line, which moves to the open chip's centre as
    // a notch grows.
    let restHeight = isNotch ? OverlayStyle.notchHeight : OverlayStyle.chipHeight
    let centerY = pixel(restHeight / 2 + (size.height - restHeight) / 2 * expansion)
    let openLeading = OverlayStyle.chipPadding
    let restLeading = (chipSize(expansion: 0).width - dotsWidth - (isNotch ? 0 : countWidth)) / 2
    var x = pixel(restLeading + (openLeading - restLeading) * expansion)
    let ring = OverlayStyle.dotRing
    for (dot, holder) in zip(dots, rings) {
      holder.frame = CGRect(
        x: x - ring, y: centerY - dotSize / 2 - ring, width: dotSize + ring * 2,
        height: dotSize + ring * 2)
      holder.cornerRadius = dotSize / 2 + ring
      dot.frame = CGRect(x: ring, y: ring, width: dotSize, height: dotSize)
      dot.cornerRadius = dotSize / 2
      x += dotSize - OverlayStyle.dotOverlap
    }
    x += OverlayStyle.dotOverlap
    if count.string != nil {
      x += OverlayStyle.chipGap - 2
      count.frame = textFrame(count, x: x, centerY: centerY, font: OverlayStyle.countFont)
      count.opacity = isNotch ? Float(expansion) : 1
      x += Self.width(of: count.string)
    }
    x += OverlayStyle.chipGap
    word.frame = textFrame(word, x: x, centerY: centerY, font: OverlayStyle.wordFont)
    word.opacity = Float(min(1, max(0, (expansion - 0.35) / 0.65)))
    CATransaction.commit()
  }

  private func textFrame(_ layer: CATextLayer, x: CGFloat, centerY: CGFloat, font: NSFont) -> CGRect {
    // The capitals' middle on the centre line.
    let top = pixel(centerY + font.capHeight / 2 - font.ascender)
    return CGRect(
      x: pixel(x), y: top, width: ceil(Self.width(of: layer.string)) + 1,
      height: ceil(font.ascender - font.descender + font.leading))
  }

  private func pixel(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }

  private func rebuildDots() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for ring in rings { ring.removeFromSuperlayer() }
    rings = []
    dots = (0..<(chip?.look.dotCount ?? 0)).map { _ in
      let ring = CALayer(), dot = CALayer()
      ring.contentsScale = scale
      dot.contentsScale = scale
      ring.addSublayer(dot)
      body.insertSublayer(ring, below: count)
      rings.append(ring)
      return dot
    }
    colorDots()
    CATransaction.commit()
    applyMotion(reduceMotion: reduceMotion)
    needsLayout = true
  }

  private func colorDots() {
    let notice = chip?.look.isNotice == true
    for (dot, ring) in zip(dots, rings) {
      ring.backgroundColor = (notice ? OverlayStyle.amber : OverlayStyle.surface).cgColor
      dot.backgroundColor = (notice ? OverlayStyle.inkOnEmber : OverlayStyle.ember).cgColor
    }
  }

  private func applyScale() {
    for layer in [root, shade, body, count, word] + dots + rings {
      layer.contentsScale = scale
    }
    body.borderWidth = 1 / scale
  }

  private static func text(_ string: String, font: NSFont, color: NSColor) -> NSAttributedString {
    NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
  }

  private static func width(of string: Any?) -> CGFloat {
    guard let string = string as? NSAttributedString else { return 0 }
    return ceil(string.size().width)
  }

  // MARK: - The person

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let superview else { return nil }
    return chipContains(convert(point, from: superview)) ? self : nil
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
        owner: self))
  }

  override func mouseEntered(with event: NSEvent) { onHover?(true) }
  override func mouseExited(with event: NSEvent) { onHover?(false) }

  override func mouseDown(with event: NSEvent) {
    pressed = chipContains(convert(event.locationInWindow, from: nil))
  }

  override func mouseUp(with event: NSEvent) {
    defer { pressed = false }
    guard pressed, chipContains(convert(event.locationInWindow, from: nil)) else { return }
    onClick?()
  }

  // MARK: - Accessibility

  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }

  override func accessibilityLabel() -> String? {
    guard let chip else { return nil }
    switch chip.look {
    case .connectionLost:
      return OverlayModel.connectionLostSentence
    case .agents(let dots, let more):
      let agents = dots.count + more == 1 ? "the agent" : "the agents"
      return "Stop \(agents) working in \(chip.app.name)"
    }
  }

  override func accessibilityHelp() -> String? {
    chip?.look.isNotice == true ? "Dismiss" : nil
  }

  override func accessibilityPerformPress() -> Bool {
    onPress?()
    return onPress != nil
  }
}

extension OverlayModel.Chip.Look {
  var isNotice: Bool { self == .connectionLost }

  /// The dots drawn: one per agent shown, and one on a notice.
  var dotCount: Int {
    switch self {
    case .agents(let dots, _): return dots.count
    case .connectionLost: return 1
    }
  }
}
