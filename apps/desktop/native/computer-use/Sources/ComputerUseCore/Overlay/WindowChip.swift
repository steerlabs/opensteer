import AppKit
import QuartzCore

/// What a press on the chip does.
enum ChipAction: Equatable {
  case nothing
  /// Widen the chip to show its word.
  case open
  /// Stop the agent working in the app.
  case stop
  /// Dismiss the amber notice.
  case dismiss
}

/// The one mark an agent leaves on a window it works in: a short dark
/// capsule tucked onto the middle of the window's top edge, one dot.
///
/// Pointing at it widens it to show `Stop`; pressing that stops the agent
/// working in that app. It lives inside the app like the window it marks: its
/// panel is ordered directly above that window, so whatever covers the window
/// covers it, and it is never seen chasing the window: the moment the window
/// moves or resizes it is gone, and it fades back in at the new place once
/// the window has been still for a moment. Its panel is exactly the chip, so
/// it takes no click meant for the app around it.
@MainActor
final class WindowChip {
  private let panel = WindowOverlayPanel(size: NSSize(width: 28, height: 22), ignoresMouse: false)
  let view = ChipView()
  private let clock = FrameClock()
  /// The window it marks, and that window as last read.
  private var windowID: CGWindowID?
  private(set) var window: TrackedWindow?
  private var wanted = false
  /// The window frame the panel is placed for; nil while it is not showing.
  private(set) var placedFor: CGRect?
  private var anchor: OverlayGeometry.ChipAnchor?
  private var settling = ChipSettling()
  private var gesture = ChipGesture()
  private var onScreen = false
  private var hovering = false
  /// Bumped whenever the pointer leaves or the chip goes, so a dwell timer
  /// that something newer superseded opens nothing.
  private var dwell = 0
  /// The person pressed `Stop`, or dismissed the notice.
  var onAction: (@MainActor (ChipAction) -> Void)?
  /// The clock, the mouse buttons and the screens. A test stands in for
  /// each.
  var now: () -> CFTimeInterval = CACurrentMediaTime
  var mouseButtonsDown: () -> Bool = { NSEvent.pressedMouseButtons != 0 }
  var usableAreas: @MainActor () -> [CGRect] = WindowChip.screenAreas

  init() {
    panel.contentView = view
    view.onHover = { [weak self] inside in self?.hover(inside) }
    view.onMouse = { [weak self] phase, inside in self?.mouse(phase, inside: inside) }
    view.onPress = { [weak self] in self?.accessibilityPress() ?? false }
  }

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
    guard
      let anchor = OverlayGeometry.chipAnchor(window: window.frame, usable: usableAreas())
    else {
      conceal()
      return
    }
    self.anchor = anchor
    view.placement = anchor.placement
    view.scale = Self.scale(at: CGPoint(x: anchor.midX, y: anchor.top + 1))
    placedFor = window.frame
    gesture.reset()
    setExpansion(0, on: window)
    panel.alphaValue = 0
    panel.order(above: window, .always, in: snapshot)
    OverlayMotion.fade(panel, to: 1, duration: OverlayStyle.fadeDuration)
  }

  /// Out of sight at once, at rest; a press under way does nothing.
  private func conceal() {
    clock.stop()
    hovering = false
    dwell += 1
    gesture.reset()
    view.expansion = 0
    guard placedFor != nil || panel.isVisible else { return }
    placedFor = nil
    anchor = nil
    panel.alphaValue = 0
    panel.orderOut(nil)
  }

  /// The edge chip opens as the pointer arrives; the notch, which hangs over
  /// the app's toolbar, only once the pointer has rested on it.
  private func hover(_ inside: Bool) {
    guard placedFor != nil, inside != hovering else { return }
    hovering = inside
    dwell += 1
    guard inside else {
      expand(false)
      return
    }
    guard view.placement == .notch else {
      expand(true)
      return
    }
    let mark = dwell
    DispatchQueue.main.asyncAfter(deadline: .now() + OverlayStyle.notchDwell) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.dwell == mark, self.hovering, self.placedFor != nil else { return }
        self.expand(true)
      }
    }
  }

  /// One press: decided as it begins from what the chip shows under the
  /// pointer, carried to its release, and dropped if the pointer leaves the
  /// chip first or the chip goes.
  private func mouse(_ phase: ChipView.MousePhase, inside: Bool) {
    guard placedFor != nil else {
      gesture.reset()
      return
    }
    switch phase {
    case .down:
      gesture.down(ChipGesture.action(look: view.chip?.look, expansion: view.expansion, inside: inside))
    case .dragged:
      gesture.dragged(inside: inside)
    case .up:
      let action = gesture.up(inside: inside)
      switch action {
      case .nothing: break
      case .open:
        hovering = true
        expand(true)
      case .stop, .dismiss: onAction?(action)
      }
    }
  }

  /// VoiceOver presses the chip as the button it names: `Stop`, or dismiss.
  private func accessibilityPress() -> Bool {
    guard placedFor != nil, let look = view.chip?.look else { return false }
    let action = gesture.press(look)
    guard action != .nothing else { return false }
    onAction?(action)
    return true
  }

  private func expand(_ open: Bool) {
    guard let window else { return }
    let target: CGFloat = open ? 1 : 0
    let start = view.expansion
    guard !OverlayMotion.reduced, start != target else {
      clock.stop()
      setExpansion(target, on: window)
      return
    }
    let began = now()
    clock.run { [weak self] time in
      guard let self, let window = self.window, self.placedFor != nil else { return false }
      let progress = CGFloat(Spring.critical(time - began, duration: OverlayStyle.expandDuration))
      self.setExpansion(start + (target - start) * progress, on: window)
      return progress < 1
    }
  }

  private func setExpansion(_ expansion: CGFloat, on window: TrackedWindow) {
    guard let anchor else { return }
    view.expansion = expansion
    let chip = OverlayGeometry.chipFrame(
      anchor: anchor, size: view.chipSize(expansion: expansion), scale: view.scale)
    let frame = OverlayGeometry.appKitRect(
      fromCoreGraphics: chip, primaryHeight: ScreenGeometry.primaryHeight)
    if panel.frame != frame { panel.setFrame(frame, display: true) }
    view.needsLayout = true
    view.layoutSubtreeIfNeeded()
  }

  /// Each screen's area below its menu bar, in CoreGraphics coordinates.
  static func screenAreas() -> [CGRect] {
    let primary = ScreenGeometry.primaryHeight
    return NSScreen.screens.map { screen in
      let frame = OverlayGeometry.appKitRect(fromCoreGraphics: screen.frame, primaryHeight: primary)
      let top = primary - screen.visibleFrame.maxY
      return CGRect(x: frame.minX, y: top, width: frame.width, height: frame.maxY - top)
    }
  }

  /// The pixel density of the screen a CoreGraphics point is on.
  private static func scale(at point: CGPoint) -> CGFloat {
    let anchor = CGPoint(x: point.x, y: ScreenGeometry.primaryHeight - point.y)
    return NSScreen.screens.first { $0.frame.contains(anchor) }?.backingScaleFactor
      ?? OverlayStyle.contentsScale
  }
}

/// One press on the chip, as a plain value.
///
/// What a press does is decided at mouse-down from what the chip shows under
/// the pointer then: nothing, open, `Stop` (only once the word is fully
/// shown) or dismiss (the amber notice, at rest or open). It is carried to
/// mouse-up and dropped if the pointer leaves the chip's shape before the
/// release, even if it comes back. `Stop` and dismiss act once per showing:
/// a double click stops once.
struct ChipGesture {
  /// The press under way and what it will do.
  private(set) var pending: ChipAction?
  /// `Stop` or dismiss already acted for this showing.
  private(set) var spent = false

  static func action(
    look: OverlayModel.Chip.Look?, expansion: CGFloat, inside: Bool
  ) -> ChipAction {
    guard inside, let look else { return .nothing }
    switch look {
    case .connectionLost: return .dismiss
    case .agent: return expansion >= 1 ? .stop : .open
    }
  }

  mutating func down(_ action: ChipAction) {
    pending = spent && action != .open ? ChipAction.nothing : action
  }

  mutating func dragged(inside: Bool) {
    if !inside, pending != nil { pending = .nothing }
  }

  mutating func up(inside: Bool) -> ChipAction {
    defer { pending = nil }
    guard let action = pending, inside else { return .nothing }
    if action == .stop || action == .dismiss { spent = true }
    return action
  }

  /// VoiceOver's press: the action the chip names, once.
  mutating func press(_ look: OverlayModel.Chip.Look) -> ChipAction {
    guard !spent else { return .nothing }
    spent = true
    return look == .connectionLost ? .dismiss : .stop
  }

  /// The chip went, moved to another window, or appeared anew.
  mutating func reset() {
    pending = nil
    spent = false
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

/// The chip's drawing: a near-black capsule with a one-pixel rim, one dot,
/// and the one word that widens into view when the person points at it.
///
/// `expansion` runs from 0, at rest, to 1, with the word showing; every
/// frame of the widening is a plain layout of it. The view is the whole
/// panel, so its shape is everything the chip takes from the person's
/// pointer.
final class ChipView: NSView {
  override var isFlipped: Bool { true }

  enum MousePhase { case down, dragged, up }

  var onHover: (@MainActor (Bool) -> Void)?
  /// A press's phase, and whether the pointer is on the chip's shape.
  var onMouse: (@MainActor (MousePhase, Bool) -> Void)?
  /// An accessibility press. Returns whether it acted.
  var onPress: (@MainActor () -> Bool)?
  var placement: OverlayGeometry.ChipPlacement = .edge {
    didSet { if placement != oldValue { needsLayout = true } }
  }
  var scale: CGFloat = 2 {
    didSet { if scale != oldValue { applyScale() } }
  }
  var expansion: CGFloat = 0 {
    didSet { if expansion != oldValue { needsLayout = true } }
  }
  private(set) var chip: OverlayModel.Chip?

  let root = CALayer()
  /// The capsule, its dot and its word.
  let body = CALayer()
  let dot = CALayer()
  let word = CATextLayer()
  private var reduceMotion = false

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 28, height: 22))
    // Layer-hosting, in the view's own top-left coordinates.
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
    root.frame = bounds
    body.cornerCurve = .continuous
    body.masksToBounds = true
    body.backgroundColor = OverlayStyle.surface.cgColor
    word.alignmentMode = .left
    word.truncationMode = .none
    word.isWrapped = false
    body.addSublayer(dot)
    body.addSublayer(word)
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
    chip = next
    self.reduceMotion = reduceMotion
    let notice = next.look == .connectionLost
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    body.borderColor =
      (notice
      ? OverlayStyle.amber.withAlphaComponent(0.9)
      : NSColor.white.withAlphaComponent(OverlayStyle.rimOpacity)).cgColor
    dot.backgroundColor = (notice ? OverlayStyle.amber : OverlayStyle.ember).cgColor
    word.string = NSAttributedString(
      string: notice ? OverlayModel.connectionLostSentence : "Stop",
      attributes: [
        .font: OverlayStyle.wordFont, .foregroundColor: notice ? OverlayStyle.text : OverlayStyle.red,
      ])
    CATransaction.commit()
    applyMotion(reduceMotion: reduceMotion)
    needsLayout = true
    return before != (chipSize(expansion: 0), chipSize(expansion: 1))
  }

  /// A working dot breathes; a still one is lit and still, as is the
  /// notice's. Under Reduce Motion a working dot is simply bright.
  func applyMotion(reduceMotion: Bool) {
    self.reduceMotion = reduceMotion
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    switch chip?.look {
    case .agent(.working)?:
      dot.opacity = 1
      if reduceMotion {
        dot.removeAnimation(forKey: "breath")
      } else if dot.animation(forKey: "breath") == nil {
        dot.add(Breath.animation(low: OverlayStyle.breathLow, high: 1), forKey: "breath")
      }
    case .agent(.still)?:
      dot.removeAnimation(forKey: "breath")
      dot.opacity = OverlayStyle.stillDotOpacity
    case .connectionLost?, nil:
      dot.removeAnimation(forKey: "breath")
      dot.opacity = 1
    }
    CATransaction.commit()
  }

  // MARK: - Size and layout

  private var isNotch: Bool { placement == .notch }
  private var dotSize: CGFloat { isNotch ? OverlayStyle.notchDotSize : OverlayStyle.dotSize }

  private var wordWidth: CGFloat {
    ceil((word.string as? NSAttributedString)?.size().width ?? 0)
  }

  /// The chip's size: a short capsule at rest; open, as wide as the dot and
  /// the word and, as a notch, only as tall as the word needs.
  func chipSize(expansion: CGFloat) -> CGSize {
    let rest =
      isNotch
      ? CGSize(width: OverlayStyle.notchRestWidth, height: OverlayStyle.notchHeight)
      : CGSize(width: OverlayStyle.chipRestWidth, height: OverlayStyle.chipHeight)
    let open = CGSize(
      width: OverlayStyle.chipPadding + dotSize + OverlayStyle.chipGap + wordWidth
        + OverlayStyle.chipPadding,
      height: isNotch ? OverlayStyle.notchOpenHeight : OverlayStyle.chipHeight)
    return CGSize(
      width: rest.width + (max(open.width, rest.width) - rest.width) * expansion,
      height: rest.height + (open.height - rest.height) * expansion)
  }

  /// The chip's shape in the view: a capsule, or a notch square where it
  /// meets the window's edge.
  func shape() -> CGPath {
    let rect = bounds
    let radius = min(rect.height / 2, rect.width / 2)
    guard isNotch else {
      return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }
    let path = CGMutablePath()
    path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    path.addArc(
      tangent1End: CGPoint(x: rect.maxX, y: rect.maxY),
      tangent2End: CGPoint(x: rect.minX, y: rect.maxY), radius: radius)
    path.addArc(
      tangent1End: CGPoint(x: rect.minX, y: rect.maxY),
      tangent2End: CGPoint(x: rect.minX, y: rect.minY), radius: radius)
    path.closeSubpath()
    return path
  }

  override func layout() {
    super.layout()
    let size = bounds.size
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.frame = bounds
    body.frame = bounds
    body.cornerRadius = min(size.height / 2, size.width / 2)
    // A notch hangs from the window's edge: square where it meets it.
    body.maskedCorners =
      isNotch
      ? [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
      : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    let restWidth = chipSize(expansion: 0).width
    let restX = (restWidth - dotSize) / 2
    let openX = OverlayStyle.chipPadding
    let x = pixel(restX + (openX - restX) * expansion)
    let centerY = size.height / 2
    dot.frame = CGRect(x: x, y: pixel(centerY - dotSize / 2), width: dotSize, height: dotSize)
    dot.cornerRadius = dotSize / 2
    let font = OverlayStyle.wordFont
    // The capitals' middle on the centre line.
    word.frame = CGRect(
      x: pixel(x + dotSize + OverlayStyle.chipGap),
      y: pixel(centerY + font.capHeight / 2 - font.ascender),
      width: wordWidth + 1, height: ceil(font.ascender - font.descender + font.leading))
    word.opacity = Float(min(1, max(0, (expansion - 0.35) / 0.65)))
    CATransaction.commit()
  }

  private func pixel(_ value: CGFloat) -> CGFloat { (value * scale).rounded() / scale }

  private func applyScale() {
    for layer in [root, body, dot, word] { layer.contentsScale = scale }
    body.borderWidth = 1 / scale
  }

  // MARK: - The person

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  private func inside(_ event: NSEvent) -> Bool {
    shape().contains(convert(event.locationInWindow, from: nil))
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let superview else { return nil }
    return shape().contains(convert(point, from: superview)) ? self : nil
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
  override func mouseDown(with event: NSEvent) { onMouse?(.down, inside(event)) }
  override func mouseDragged(with event: NSEvent) { onMouse?(.dragged, inside(event)) }
  override func mouseUp(with event: NSEvent) { onMouse?(.up, inside(event)) }

  // MARK: - Accessibility

  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }

  override func accessibilityLabel() -> String? {
    guard let chip else { return nil }
    switch chip.look {
    case .connectionLost: return OverlayModel.connectionLostSentence
    case .agent: return "Stop the agent working in \(chip.app.name)"
    }
  }

  override func accessibilityHelp() -> String? {
    chip?.look == .connectionLost ? "Dismiss" : nil
  }

  override func accessibilityPerformPress() -> Bool {
    onPress?() ?? false
  }
}
