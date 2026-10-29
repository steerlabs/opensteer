import AppKit
import QuartzCore

/// The native control surface for computer use. It draws the pill
/// `OverlayModel` decides — expanded or minimized included — and reports the
/// person's clicks and pointer back; it never changes a session itself.
///
/// Expanded: the app, the status and its Threads, minimize, `Stop`.
/// Minimized: the app and `Stop`; clicking the app expands it. `Stop` sits at
/// the end nearest the screen's edge — in a left-hand corner the controls lead
/// — and keeps its width, so its place depends on the corner and the size
/// alone: no word, app or resize the agent causes moves it under a still
/// pointer. Minimize takes the place the minimized app had, so a click that
/// changes the size lands on the control that changes it back. The expanded
/// app is not a control, so a stray click on it changes nothing.
@MainActor
final class PillWindow {
  private static let minWidth: CGFloat = 330
  private static let maxWidth: CGFloat = 500
  /// Every constraint that can ask for width stays below the window's own
  /// size (`windowSizeStayPut`, 500): above it, AppKit would widen the window
  /// to fit its content in the middle of a resize. Within that, a line
  /// truncates only when the pill is as wide as it gets, the far edge gives
  /// way before the corner side, and the row fills an expanded pill but holds
  /// to the corner side of a minimized one.
  private static let textResistance = NSLayoutConstraint.Priority(450)
  private static let farEdge = NSLayoutConstraint.Priority(490)
  private static let rowHugging = NSLayoutConstraint.Priority(300)
  /// Where the person last put it, for this process's lifetime.
  static var corner: PillCorner = .topRight
  /// Where the pointer is on screen. A test stands in for the person's.
  static var mouseLocation: () -> NSPoint = { NSEvent.mouseLocation }
  /// The time `Stop`'s arming is measured in. A test stands in for it.
  static var now: () -> TimeInterval = { CACurrentMediaTime() }

  let panel: NonActivatingPanel
  let surface = OverlaySurface(cornerRadius: OverlayStyle.pillRadius)
  let app = PillAppButton()
  let peek = PillPeek()
  private let statusLabel = NSTextField(labelWithString: "")
  private let detailLabel = NSTextField(labelWithString: "")
  private let text: NSStackView
  private let spacer = NSView()
  private let row: NSStackView
  /// The row's edges: the one on the pill's corner side never gives, so
  /// while the pill grows or shrinks what is there — `Stop` — stays put.
  private var rowLeft: NSLayoutConstraint!
  private var rowRight: NSLayoutConstraint!
  private let minimizeButton = PillButton(
    style: .disclosure, title: "Minimize computer use status",
    symbol: "arrow.down.right.and.arrow.up.left")
  private let stopButton = PillButton(style: .stop, title: "Stop")
  private let dismissButton = PillButton(style: .neutral, title: "Dismiss")
  private let icons = PillIcons()
  private let actions: PillActions
  private let onPointer: @MainActor (Bool) -> Void
  private let clock = FrameClock()
  /// Where the running spring is taking the panel.
  private var springTarget: NSRect?
  private var rendered: OverlayModel.Pill?
  private var shown = false
  /// What the owner was last told about the pointer over the pill.
  private var pointerInside = false
  private var pointerOnApp = false
  /// Until when `Stop` ignores presses: it just appeared, maybe under a
  /// pointer that was aimed at something else.
  private var stopArmedAt: TimeInterval = 0

  init(
    onStop: @escaping @MainActor () -> Void,
    onDismiss: @escaping @MainActor () -> Void,
    onToggle: @escaping @MainActor () -> Void,
    onPointer: @escaping @MainActor (Bool) -> Void
  ) {
    actions = PillActions(onStop: onStop, onDismiss: onDismiss, onToggle: onToggle)
    self.onPointer = onPointer
    panel = NonActivatingPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.minWidth, height: OverlayStyle.pillHeight),
      ignoresMouse: false
    )
    panel.level = .statusBar
    panel.hasShadow = true
    panel.appearance = NSAppearance(named: .darkAqua)
    // The helper never becomes the active app; without this, AppKit would
    // never show `Stop`'s or minimize's tooltip.
    panel.allowsToolTipsWhenApplicationIsInactive = true
    panel.contentView = surface
    surface.radius = OverlayStyle.pillRadius(forHeight:)
    surface.mouseLocation = { PillWindow.mouseLocation() }

    statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
    statusLabel.textColor = OverlayStyle.text
    detailLabel.font = .systemFont(ofSize: 12)
    detailLabel.textColor = NSColor.white.withAlphaComponent(0.68)
    for label in [statusLabel, detailLabel] {
      label.lineBreakMode = .byTruncatingTail
      label.maximumNumberOfLines = 1
      label.cell?.truncatesLastVisibleLine = true
      label.setContentCompressionResistancePriority(Self.textResistance, for: .horizontal)
      label.wantsLayer = true
    }

    app.target = actions
    app.action = #selector(PillActions.toggle)
    stopButton.target = actions
    stopButton.action = #selector(PillActions.stop)
    stopButton.setAccessibilityLabel("Stop all computer use on this Mac")
    stopButton.toolTip = "Stop all computer use on this Mac"
    minimizeButton.target = actions
    minimizeButton.action = #selector(PillActions.toggle)
    minimizeButton.toolTip = "Minimize"
    dismissButton.target = actions
    dismissButton.action = #selector(PillActions.dismiss)

    text = NSStackView(views: [statusLabel, detailLabel])
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 2
    // Without this the column fills the row's height and its first line sits
    // against the top edge.
    text.setHuggingPriority(.required, for: .vertical)
    text.setHuggingPriority(.defaultLow, for: .horizontal)
    text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

    spacer.setContentHuggingPriority(.init(1), for: .horizontal)
    row = NSStackView(views: [app, text, spacer, minimizeButton, stopButton, dismissButton])
    row.orientation = .horizontal
    row.alignment = .centerY
    row.translatesAutoresizingMaskIntoConstraints = false
    row.setHuggingPriority(Self.rowHugging, for: .horizontal)
    // Wider than the pill mid-resize, the row itself overflows the far edge
    // rather than letting its views spill past the corner side.
    row.setClippingResistancePriority(.required, for: .horizontal)
    surface.addSubview(row)
    rowLeft = row.leftAnchor.constraint(equalTo: surface.leftAnchor)
    rowRight = row.rightAnchor.constraint(equalTo: surface.rightAnchor)
    NSLayoutConstraint.activate([
      row.topAnchor.constraint(equalTo: surface.topAnchor),
      row.bottomAnchor.constraint(equalTo: surface.bottomAnchor),
    ])
    layOut(expanded: true)

    surface.onPointer = { [weak self] inside in self?.setPointer(inside) }
    surface.accepts = { [weak self] button in
      guard let self, button === self.stopButton else { return true }
      return Self.now() >= self.stopArmedAt
    }
    surface.onDragStarted = { [weak self] in
      guard let self else { return }
      // The person has it now: no spring may fight the drag.
      self.clock.stop()
      self.springTarget = nil
      self.panel.alphaValue = 1
      self.updatePeek()
    }
    surface.onDragEnded = { [weak self] in self?.settleAfterDrag() }
    app.onHover = { [weak self] inside in
      self?.pointerOnApp = inside
      self?.updatePeek()
    }
  }

  var frame: NSRect { panel.frame }
  var isShown: Bool { shown }

  func show(_ pill: OverlayModel.Pill) {
    let resized = rendered?.expanded != pill.expanded
    if pill != rendered { apply(pill, animated: shown) }
    guard shown else {
      appear()
      return
    }
    place(animated: resized)
  }

  func hide() {
    guard shown else { return }
    shown = false
    clock.stop()
    springTarget = nil
    surface.cancelDrag()
    pointerOnApp = false
    peek.hide()
    setPointer(false)
    icons.clear()
    OverlayMotion.fade(panel, to: 0, duration: OverlayStyle.crossfadeDuration) { [weak self] in
      guard let self, !self.shown else { return }
      self.panel.orderOut(nil)
    }
  }

  /// Draws a pill's content without showing the panel, for a snapshot.
  func render(_ pill: OverlayModel.Pill) -> NSView {
    apply(pill, animated: false)
    panel.setFrame(targetFrame(), display: false)
    surface.layoutSubtreeIfNeeded()
    return surface
  }

  /// Draws the minimized pill's hover label for `pill`, for a snapshot.
  func renderPeek(_ pill: OverlayModel.Pill) -> NSView {
    peek.render(Self.peekText(pill))
  }

  func showStop(hover: Bool, press: Bool) {
    stopButton.show(hover: hover, press: press)
  }

  /// What the agent just did in `key`, on the badge when that app is in
  /// front.
  func mirror(_ feedback: OverlayFeedback, app key: String) {
    guard shown, let rendered, rendered.controls == .session, rendered.icons.first?.key == key
    else { return }
    app.mark.mirror(feedback)
  }

  func motionChanged() {
    app.mark.motionChanged()
    guard OverlayMotion.reduced, shown, clock.isRunning else { return }
    clock.stop()
    springTarget = nil
    place(animated: false)
  }

  /// Whether the pointer is where the pill is, or where it would be at its
  /// largest — shown or not: the place a reveal must not appear under.
  func pointerIsNear() -> Bool {
    let mouse = Self.mouseLocation()
    if shown, panel.frame.contains(mouse) { return true }
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return false }
    let largest = Self.corner.frame(
      size: CGSize(width: Self.maxWidth, height: OverlayStyle.pillHeight),
      in: screen.visibleFrame)
    return largest.insetBy(dx: -8, dy: -8).contains(mouse)
  }

  /// The pill keeps to the screen the person is working on.
  func follow() {
    guard shown else { return }
    let before = panel.frame.origin
    place(animated: false)
    if panel.frame.origin != before, rendered?.controls == .session { armStop() }
  }

  // MARK: - Drawing

  private func apply(_ pill: OverlayModel.Pill, animated: Bool) {
    let previous = rendered
    let expanded = pill.expanded
    let animate = animated && !OverlayMotion.reduced
    if animate, previous?.expanded == true, expanded, statusLabel.stringValue != pill.status {
      let fade = CATransition()
      fade.type = .fade
      fade.duration = OverlayStyle.crossfadeDuration
      statusLabel.layer?.add(fade, forKey: "status")
      detailLabel.layer?.add(fade, forKey: "detail")
    }
    statusLabel.stringValue = pill.status
    detailLabel.stringValue = pill.detail ?? ""
    detailLabel.isHidden = pill.detail == nil
    text.isHidden = !expanded
    spacer.isHidden = !expanded
    minimizeButton.isHidden = !(expanded && pill.controls == .session)
    if pill.controls == .session, stopButton.isHidden { armStop() }
    stopButton.isHidden = pill.controls != .session
    stopButton.compact = !expanded
    dismissButton.isHidden = pill.controls != .dismiss
    row.spacing = expanded ? 12 : 10
    layOut(expanded: expanded)
    row.edgeInsets =
      expanded
      ? NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
      : NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)

    let side = expanded ? OverlayStyle.pillIconSide : OverlayStyle.minimizedPillIconSide
    let images = pill.icons.isEmpty ? [icons.mark(side: side)] : pill.icons.map { icons.image($0, side: side) }
    app.configure(icons: images, side: side, badge: pill.badge, released: pill.badge == nil)
    app.mark.setActivity(pill.activity)
    let expands = pill.controls == .session && !expanded
    app.isEnabled = expands
    app.setAccessibilityElement(expands)
    app.setAccessibilityLabel("Expand computer use status")
    app.setAccessibilityHelp([pill.status, pill.detail].compactMap { $0 }.joined(separator: ". "))

    if animate, previous?.expanded == false, expanded {
      text.alphaValue = 0
      NSAnimationContext.runAnimationGroup { context in
        context.duration = OverlayStyle.pillResizeDuration
        context.timingFunction = CAMediaTimingFunction(name: .easeIn)
        text.animator().alphaValue = 1
      }
    } else {
      text.alphaValue = 1
    }
    rendered = pill
    updatePeek()
  }

  private func appear() {
    shown = true
    if rendered?.controls == .session { armStop() }
    layOut(expanded: rendered?.expanded ?? true)
    // A fade-out still under way would otherwise carry on over this.
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0
      panel.animator().alphaValue = 0
    }
    let target = targetFrame()
    if OverlayMotion.reduced {
      panel.setFrame(target, display: true)
      panel.invalidateShadow()
      panel.orderFrontRegardless()
      OverlayMotion.fade(panel, to: 1, duration: OverlayStyle.pillAppearDuration)
      refreshPointerSoon()
      return
    }
    let offset = Self.corner.isTop ? OverlayStyle.pillAppearOffset : -OverlayStyle.pillAppearOffset
    panel.setFrame(target.offsetBy(dx: 0, dy: offset), display: true)
    panel.invalidateShadow()
    panel.alphaValue = 0
    panel.orderFrontRegardless()
    spring(to: target, duration: OverlayStyle.pillAppearDuration * 1.3, alpha: (0, 1))
  }

  /// Puts the panel where and as big as the pill it draws should be: at once,
  /// or along a spring for a change of size and while one is already
  /// running, so a change mid-flight retargets it rather than jumping.
  private func place(animated: Bool) {
    guard shown, !surface.isDragging else { return }
    layOut(expanded: rendered?.expanded ?? true)
    let target = targetFrame()
    let springing = clock.isRunning
    if springing, springTarget == target { return }
    guard target != panel.frame || springing else { return }
    if (animated || springing) && !OverlayMotion.reduced {
      spring(
        to: target, duration: OverlayStyle.pillResizeDuration,
        alpha: panel.alphaValue < 1 ? (panel.alphaValue, 1) : nil)
      return
    }
    clock.stop()
    springTarget = nil
    panel.setFrame(target, display: true)
    panel.alphaValue = 1
    panel.invalidateShadow()
    settled()
  }

  private func spring(
    to target: NSRect, duration: TimeInterval,
    curve: @escaping (TimeInterval, TimeInterval) -> Double = { Spring.critical($0, duration: $1) },
    alpha: (from: CGFloat, to: CGFloat)? = nil
  ) {
    springTarget = target
    OverlayMotion.spring(
      panel, to: target, duration: duration, clock: clock, curve: curve, alpha: alpha
    ) { [weak self] in
      self?.springTarget = nil
      self?.settled()
    }
  }

  /// The panel stopped where it belongs: the pointer may be over it now, or
  /// no longer, without having moved.
  private func settled() {
    updatePeek()
    refreshPointerSoon()
  }

  private func targetFrame() -> NSRect {
    let size = targetSize()
    guard let screen = NSScreen.main ?? NSScreen.screens.first else {
      return NSRect(origin: .zero, size: size)
    }
    return Self.corner.frame(size: size, in: screen.visibleFrame)
  }

  private func targetSize() -> CGSize {
    let expanded = rendered?.expanded ?? true
    for label in [statusLabel, detailLabel] {
      label.setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    surface.layoutSubtreeIfNeeded()
    let fitting = row.fittingSize.width
    for label in [statusLabel, detailLabel] {
      label.setContentCompressionResistancePriority(Self.textResistance, for: .horizontal)
    }
    let width = expanded ? min(max(fitting, Self.minWidth), Self.maxWidth) : fitting
    return CGSize(
      width: ceil(width),
      height: expanded ? OverlayStyle.pillHeight : OverlayStyle.minimizedPillHeight)
  }

  func settleAfterDrag() {
    let center = CGPoint(x: panel.frame.midX, y: panel.frame.midY)
    guard
      let screen = NSScreen.screens.first(where: { $0.frame.contains(center) })
        ?? NSScreen.main ?? NSScreen.screens.first
    else { return }
    Self.corner = PillCorner.nearest(to: center, in: screen.visibleFrame)
    layOut(expanded: rendered?.expanded ?? true)
    let target = Self.corner.frame(size: targetSize(), in: screen.visibleFrame)
    spring(to: target, duration: 0.42, curve: { Spring.settle($0, duration: $1) })
  }

  /// `Stop` comes into a place the pointer may already be: it takes no press
  /// for a moment, and fades in over that moment so it looks it.
  private func armStop() {
    stopArmedAt = Self.now() + OverlayStyle.stopArmDelay
    guard !OverlayMotion.reduced else {
      stopButton.alphaValue = 1
      return
    }
    stopButton.alphaValue = 0.35
    NSAnimationContext.runAnimationGroup { context in
      context.duration = OverlayStyle.stopArmDelay
      context.timingFunction = CAMediaTimingFunction(name: .easeIn)
      stopButton.animator().alphaValue = 1
    }
  }

  /// The controls at the corner's end, the app and its words after them,
  /// and the row held to that end.
  private func layOut(expanded: Bool) {
    let isRight = Self.corner.isRight
    let order: [NSView] =
      isRight
      ? [app, text, spacer, minimizeButton, stopButton, dismissButton]
      : [dismissButton, stopButton, minimizeButton, app, text, spacer]
    if row.arrangedSubviews != order {
      for view in order { row.removeArrangedSubview(view) }
      for view in order { row.addArrangedSubview(view) }
    }
    // Minimize sits close to `Stop`; minimized, the app keeps its distance.
    let close = expanded ? 8 : NSStackView.useDefaultSpacing
    row.setCustomSpacing(isRight ? 8 : NSStackView.useDefaultSpacing, after: minimizeButton)
    row.setCustomSpacing(isRight ? NSStackView.useDefaultSpacing : close, after: stopButton)

    let far: NSLayoutConstraint.Priority = expanded ? Self.farEdge : .init(1)
    let left: NSLayoutConstraint.Priority = isRight ? far : .required
    let right: NSLayoutConstraint.Priority = isRight ? .required : far
    guard !rowLeft.isActive || rowLeft.priority != left || rowRight.priority != right else {
      return
    }
    // A constraint cannot move to or from required while it is active.
    NSLayoutConstraint.deactivate([rowLeft, rowRight])
    rowLeft.priority = left
    rowRight.priority = right
    NSLayoutConstraint.activate([rowLeft, rowRight])
  }

  // MARK: - The pointer

  /// Reads the pointer once the current event is handled: a window that
  /// appears, moves or changes size under a still pointer hears nothing from
  /// its tracking areas.
  private func refreshPointerSoon() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let inside = self.shown && self.panel.frame.contains(Self.mouseLocation())
      self.setPointer(inside)
      let overApp =
        inside && self.app.isEnabled
        && self.app.bounds.contains(
          self.app.convert(
            self.panel.convertPoint(fromScreen: Self.mouseLocation()), from: nil))
      self.app.hover(overApp)
    }
  }

  /// Told to the owner after the current event, never in the middle of the
  /// owner drawing the pill.
  private func setPointer(_ inside: Bool) {
    guard inside != pointerInside else { return }
    pointerInside = inside
    DispatchQueue.main.async { [onPointer] in onPointer(inside) }
  }

  private func updatePeek() {
    guard shown, pointerOnApp, !surface.isDragging, let pill = rendered, !pill.expanded,
      pill.controls == .session
    else {
      peek.hide()
      return
    }
    peek.show(Self.peekText(pill), beside: springTarget ?? panel.frame, corner: Self.corner)
  }

  static func peekText(_ pill: OverlayModel.Pill) -> NSAttributedString {
    let text = NSMutableAttributedString(
      string: pill.compactStatus,
      attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
        .foregroundColor: OverlayStyle.text,
      ])
    if let detail = pill.detail {
      text.append(
        NSAttributedString(
          string: " · \(detail)",
          attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.white.withAlphaComponent(0.62),
          ]))
    }
    return text
  }
}

@MainActor
private final class PillActions: NSObject {
  private let onStop: @MainActor () -> Void
  private let onDismiss: @MainActor () -> Void
  private let onToggle: @MainActor () -> Void

  init(
    onStop: @escaping @MainActor () -> Void,
    onDismiss: @escaping @MainActor () -> Void,
    onToggle: @escaping @MainActor () -> Void
  ) {
    self.onStop = onStop
    self.onDismiss = onDismiss
    self.onToggle = onToggle
  }

  @objc func stop() { onStop() }
  @objc func dismiss() { onDismiss() }
  @objc func toggle() { onToggle() }
}

/// The minimized pill's hover label: what the agent is doing, and for which
/// task, hung beside the pill so nothing in the pill moves.
@MainActor
final class PillPeek {
  let panel = NonActivatingPanel(contentRect: .zero, ignoresMouse: true)
  private let surface = OverlaySurface(cornerRadius: 9)
  private let label = NSTextField(labelWithString: "")
  private var pending: Timer?
  private var anchor: (pill: NSRect, corner: PillCorner)?
  private(set) var isShown = false

  init() {
    panel.level = .statusBar
    panel.hasShadow = true
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.contentView = surface
    label.lineBreakMode = .byTruncatingTail
    label.maximumNumberOfLines = 1
    label.cell?.truncatesLastVisibleLine = true
    label.translatesAutoresizingMaskIntoConstraints = false
    surface.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 10),
      label.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -10),
      label.centerYAnchor.constraint(equalTo: surface.centerYAnchor),
    ])
  }

  /// Shows `text` beside `pill` once the pointer has rested a moment, or
  /// moves and rewords it at once if it already shows.
  func show(_ text: NSAttributedString, beside pill: NSRect, corner: PillCorner) {
    label.attributedStringValue = text
    anchor = (pill, corner)
    if isShown {
      place()
      return
    }
    guard pending == nil else { return }
    let timer = Timer(timeInterval: OverlayStyle.peekDelay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.reveal() }
    }
    RunLoop.main.add(timer, forMode: .common)
    pending = timer
  }

  func hide() {
    pending?.invalidate()
    pending = nil
    anchor = nil
    guard isShown else { return }
    isShown = false
    panel.orderOut(nil)
  }

  /// Draws `text` without showing the panel, for a snapshot.
  func render(_ text: NSAttributedString) -> NSView {
    label.attributedStringValue = text
    panel.setFrame(NSRect(origin: .zero, size: size()), display: false)
    surface.layoutSubtreeIfNeeded()
    return surface
  }

  private func reveal() {
    pending = nil
    guard anchor != nil else { return }
    isShown = true
    place()
    panel.alphaValue = 0
    panel.orderFrontRegardless()
    OverlayMotion.fade(panel, to: 1, duration: 0.12)
  }

  private func size() -> CGSize {
    let natural = label.attributedStringValue.size()
    return CGSize(
      width: min(ceil(natural.width) + 20, OverlayStyle.peekMaxWidth),
      height: ceil(natural.height) + 10)
  }

  private func place() {
    guard let anchor else { return }
    let center = CGPoint(x: anchor.pill.midX, y: anchor.pill.midY)
    let visible =
      (NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main)?.visibleFrame
      ?? anchor.pill
    let frame = Self.frame(size: size(), beside: anchor.pill, corner: anchor.corner, in: visible)
    panel.setFrame(frame, display: true)
    panel.invalidateShadow()
  }

  /// Under the pill in a top corner and over it in a bottom one, flush with
  /// its outer side, and on the screen.
  static func frame(
    size: CGSize, beside pill: NSRect, corner: PillCorner, in visible: NSRect
  ) -> NSRect {
    let x = corner.isRight ? pill.maxX - size.width : pill.minX
    let y =
      corner.isTop
      ? pill.minY - OverlayStyle.peekGap - size.height : pill.maxY + OverlayStyle.peekGap
    // Where it cannot fit, its start stays on screen.
    return NSRect(
      x: max(visible.minX, min(x, visible.maxX - size.width)),
      y: max(visible.minY, min(y, visible.maxY - size.height)),
      width: size.width, height: size.height)
  }
}

/// App icons drawn at the pill's sizes, kept while the pill shows.
@MainActor
final class PillIcons {
  private var drawn: [String: CGImage] = [:]

  func image(_ icon: OverlayModel.Pill.Icon, side: CGFloat) -> CGImage? {
    draw(icon.path, side: side) { NSWorkspace.shared.icon(forFile: icon.path) }
  }

  /// The Opensteer mark, the helper's own icon, before any app is in use.
  func mark(side: CGFloat) -> CGImage? {
    draw("", side: side) { NSApplication.shared.applicationIconImage }
  }

  func clear() {
    drawn.removeAll()
  }

  private func draw(_ path: String, side: CGFloat, source: () -> NSImage?) -> CGImage? {
    let pixels = Int((side * OverlayStyle.contentsScale).rounded())
    let key = "\(pixels):\(path)"
    if let image = drawn[key] { return image }
    guard let icon = source(), let image = AppIcons.bitmap(icon, pixels: pixels)?.cgImage
    else { return nil }
    drawn[key] = image
    return image
  }
}
