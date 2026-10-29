import AppKit
import QuartzCore

/// A pill control drawn on a layer so its hover and first click work while
/// the overlay remains nonactivating.
final class PillButton: NSButton {
  enum Style {
    case stop
    case neutral
    case disclosure
  }

  let style: Style
  private var hovering = false
  private var pressing = false
  private var widthConstraint: NSLayoutConstraint!
  private var heightConstraint: NSLayoutConstraint!
  var symbol: String? {
    didSet { updateImage() }
  }
  /// Shorter, for the minimized pill. The width stays, so `Stop` covers the
  /// same span of the pill's outer side either way.
  var compact = false {
    didSet {
      guard compact != oldValue else { return }
      resize()
      updateImage()
      refresh()
    }
  }

  init(style: Style, title: String, symbol: String? = nil) {
    self.style = style
    self.symbol = symbol
    super.init(frame: .zero)
    isBordered = false
    bezelStyle = .regularSquare
    setButtonType(.momentaryChange)
    wantsLayer = true
    focusRingType = .none
    translatesAutoresizingMaskIntoConstraints = false
    layer?.cornerCurve = .continuous
    setAccessibilityLabel(title)
    self.title = style == .disclosure ? "" : title
    imagePosition = style == .disclosure ? .imageOnly : .noImage
    widthConstraint = widthAnchor.constraint(equalToConstant: 0)
    heightConstraint = heightAnchor.constraint(equalToConstant: 0)
    NSLayoutConstraint.activate([widthConstraint, heightConstraint])
    setContentHuggingPriority(.required, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .horizontal)
    resize()
    updateImage()
    refresh()
  }

  required init?(coder: NSCoder) { nil }

  static let font = NSFont.systemFont(ofSize: 13, weight: .semibold)
  static let compactFont = NSFont.systemFont(ofSize: 12.5, weight: .semibold)

  private var titleFont: NSFont { compact ? Self.compactFont : Self.font }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// The fill is the whole frame, so the frame has to be exactly the size the
  /// constraints give; a symbol image would otherwise pad it out of round.
  override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsetsZero }

  override func layout() {
    super.layout()
    layer?.cornerRadius = bounds.height / 2
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
        owner: self))
  }

  override func mouseEntered(with event: NSEvent) {
    hovering = true
    refresh()
  }

  override func mouseExited(with event: NSEvent) {
    hovering = false
    refresh()
  }

  override func highlight(_ flag: Bool) {
    pressing = flag
    refresh()
  }

  func show(hover: Bool, press: Bool) {
    hovering = hover
    pressing = press
    refresh()
  }

  private func resize() {
    let height: CGFloat = compact ? 28 : 34
    heightConstraint.constant = height
    guard style != .disclosure else {
      widthConstraint.constant = height
      return
    }
    let width = (title as NSString).size(withAttributes: [.font: Self.font]).width
    widthConstraint.constant = ceil(width) + (style == .stop ? 28 : 26)
  }

  private func updateImage() {
    guard let symbol else { return }
    image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
      .withSymbolConfiguration(.init(pointSize: compact ? 11 : 12, weight: .semibold))
  }

  private func refresh() {
    let fill: NSColor
    let foreground: NSColor
    switch style {
    case .stop:
      fill = OverlayStyle.ember.withAlphaComponent(pressing ? 0.78 : hovering ? 0.96 : 1)
      foreground = OverlayStyle.inkOnEmber
    case .neutral:
      fill = NSColor.white.withAlphaComponent(pressing ? 0.22 : hovering ? 0.17 : 0.12)
      foreground = OverlayStyle.text
    case .disclosure:
      fill = NSColor.white.withAlphaComponent(pressing ? 0.18 : hovering ? 0.13 : 0.07)
      foreground = OverlayStyle.text
    }
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.12)
    layer?.backgroundColor = fill.cgColor
    layer?.transform = pressing ? CATransform3DMakeScale(0.96, 0.96, 1) : CATransform3DIdentity
    CATransaction.commit()
    contentTintColor = foreground
    if style != .disclosure {
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      attributedTitle = NSAttributedString(
        string: title,
        attributes: [.font: titleFont, .foregroundColor: foreground, .paragraphStyle: paragraph])
    }
  }
}

/// The pill's app: the icon of the app the agent is in, with the agent's
/// pointer on it. Minimized, pressed and released without moving, it expands
/// the pill; the surface turns a drag that starts on it into moving the pill,
/// since minimized there is little else to hold.
final class PillAppButton: NSButton {
  let mark = PillMarkView()
  /// The pointer entered (true) or left the app.
  var onHover: (@MainActor (Bool) -> Void)?
  private var hovering = false
  private var pressing = false
  private var widthConstraint: NSLayoutConstraint!
  private var heightConstraint: NSLayoutConstraint!

  init() {
    super.init(frame: .zero)
    isBordered = false
    bezelStyle = .regularSquare
    setButtonType(.momentaryChange)
    title = ""
    imagePosition = .noImage
    wantsLayer = true
    focusRingType = .none
    translatesAutoresizingMaskIntoConstraints = false
    mark.translatesAutoresizingMaskIntoConstraints = false
    addSubview(mark)
    let side = OverlayStyle.pillIconSide
    widthConstraint = widthAnchor.constraint(equalToConstant: side)
    heightConstraint = heightAnchor.constraint(equalToConstant: side)
    NSLayoutConstraint.activate([
      widthConstraint, heightConstraint,
      mark.leadingAnchor.constraint(equalTo: leadingAnchor),
      mark.trailingAnchor.constraint(equalTo: trailingAnchor),
      mark.topAnchor.constraint(equalTo: topAnchor),
      mark.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    setContentHuggingPriority(.required, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .horizontal)
  }

  required init?(coder: NSCoder) { nil }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override var isEnabled: Bool {
    didSet { refresh() }
  }

  func configure(
    icons: [CGImage?], side: CGFloat, badge: OverlayModel.Pill.Badge?, released: Bool
  ) {
    let size = mark.configure(icons: icons, side: side, badge: badge, released: released)
    widthConstraint.constant = size.width
    heightConstraint.constant = size.height
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
        owner: self))
  }

  override func mouseEntered(with event: NSEvent) {
    hover(true)
  }

  override func mouseExited(with event: NSEvent) {
    hover(false)
  }

  /// The pointer is on the app, as the window last knew; also how a test
  /// stands in for the person's pointer.
  func hover(_ inside: Bool) {
    guard inside != hovering else { return }
    hovering = inside
    refresh()
    onHover?(inside)
  }

  override func highlight(_ flag: Bool) {
    pressing = flag
    refresh()
  }

  private func refresh() {
    mark.setHighlight(hover: hovering && isEnabled, press: pressing && isEnabled)
  }
}

/// What the pill's app button draws: the app the agent is in, a second app it
/// holds peeking out from behind, and on the front one the agent's pointer —
/// or an eye, where the agent can only see. It hosts its layers flipped, as
/// the pointer does, so the badge is the very same drawing at a smaller scale.
final class PillMarkView: NSView {
  override var isFlipped: Bool { true }

  let root = CALayer()
  /// The agent's pointer, as `AgentCursorView` draws it, scaled about its tip.
  let pointer = CALayer()
  let body = CALayer()
  let glow = CALayer()
  let arrow = CALayer()
  private let highlight = CALayer()
  private let back = CALayer()
  private let front = CALayer()
  private let eye = CALayer()
  private var badge: OverlayModel.Pill.Badge?
  private var activity: OverlayModel.Activity?

  init() {
    super.init(frame: .zero)
    layer = root
    wantsLayer = true
    root.isGeometryFlipped = true
    let scale = OverlayStyle.contentsScale
    for icon in [back, front, eye] {
      icon.contentsGravity = .resizeAspect
      icon.contentsScale = scale
    }
    highlight.cornerCurve = .continuous
    let size = OverlayStyle.pointerPanelSize
    let tip = OverlayStyle.pointerTip
    pointer.bounds = CGRect(origin: .zero, size: size)
    pointer.anchorPoint = CGPoint(x: tip.x / size.width, y: tip.y / size.height)
    pointer.contentsScale = scale
    AgentCursorView.build(in: pointer, body: body, glow: glow, arrow: arrow)
    for layer in [highlight, back, front, pointer, eye] {
      root.addSublayer(layer)
    }
    setAccessibilityElement(false)
  }

  required init?(coder: NSCoder) { nil }

  /// Clicks belong to the button it sits in.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  /// Lays out `icons`, front first, `side` points square, with `badge` on
  /// the front one; `released` dims a notice's apps. Returns the size it
  /// needs.
  @discardableResult
  func configure(
    icons: [CGImage?], side: CGFloat, badge: OverlayModel.Pill.Badge?, released: Bool
  ) -> CGSize {
    let stacked = icons.count > 1
    let width = side + (stacked ? (side * OverlayStyle.pillIconStackOffset).rounded() : 0)
    let frontFrame = CGRect(x: width - side, y: 0, width: side, height: side)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    front.frame = frontFrame
    front.contents = icons.first ?? nil
    front.opacity = released ? OverlayStyle.pillReleasedIconOpacity : 1
    back.isHidden = !stacked
    if stacked {
      let backSide = (side * 0.86).rounded()
      back.frame = CGRect(x: 0, y: (side - backSide) / 2, width: backSide, height: backSide)
      back.contents = icons[1]
      back.opacity = 0.85 * (released ? OverlayStyle.pillReleasedIconOpacity : 1)
    }
    highlight.frame = CGRect(x: 0, y: 0, width: width, height: side).insetBy(dx: -3, dy: -3)
    highlight.cornerRadius = side * 0.225 + 3

    pointer.isHidden = badge != .pointer
    let tip = OverlayStyle.pillBadgeTip
    pointer.position = CGPoint(x: frontFrame.minX + side * tip.x, y: frontFrame.minY + side * tip.y)
    let scale = side * OverlayStyle.pillBadgeScale
    pointer.transform = CATransform3DMakeScale(scale, scale, 1)

    eye.isHidden = badge != .eye
    if badge == .eye {
      let diameter = (side * OverlayStyle.pillEyeBadge).rounded()
      eye.frame = CGRect(
        x: frontFrame.maxX - diameter * 0.75, y: frontFrame.maxY - diameter * 0.75,
        width: diameter, height: diameter)
      eye.contents = Self.eyeImage(diameter: diameter)
    }
    CATransaction.commit()
    if badge != self.badge {
      self.badge = badge
      applyActivity()
    }
    return CGSize(width: width, height: side)
  }

  func setHighlight(hover: Bool, press: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.12)
    highlight.backgroundColor = NSColor.white.withAlphaComponent(press ? 0.16 : hover ? 0.1 : 0)
      .cgColor
    CATransaction.commit()
  }

  /// Working holds the badge steady; between calls it breathes on the beat
  /// every pointer on the Mac shares — the pointer's glow, or the eye itself.
  func setActivity(_ next: OverlayModel.Activity) {
    guard next != activity else { return }
    activity = next
    applyActivity()
  }

  func motionChanged() {
    if OverlayMotion.reduced {
      body.removeAnimation(forKey: "press")
      glow.removeAnimation(forKey: "pulse")
      for ring in pointer.sublayers ?? [] where ring is CAShapeLayer {
        ring.removeFromSuperlayer()
      }
    }
    applyActivity()
  }

  /// What the agent just did in the front app, played on the badge as the
  /// pointer plays it there.
  func mirror(_ feedback: OverlayFeedback) {
    guard badge == .pointer, !OverlayMotion.reduced else { return }
    switch feedback {
    case .click:
      body.add(AgentCursorView.pressAnimation(), forKey: "press")
      ripple()
    case .pulse, .scroll:
      let base = glow.presentation()?.opacity ?? glow.opacity
      glow.add(AgentCursorView.pulseAnimation(from: base), forKey: "pulse")
    }
  }

  private func applyActivity() {
    for layer in [glow, eye] {
      layer.removeAnimation(forKey: "breathe.opacity")
      layer.removeAnimation(forKey: "breathe.scale")
    }
    AgentCursorView.apply(.rest, body: body, glow: glow)
    guard activity == .thinking, !OverlayMotion.reduced else { return }
    switch badge {
    case .pointer:
      for animation in Breath.animations() {
        glow.add(animation, forKey: "breathe.\(animation.keyPath ?? "")")
      }
    case .eye:
      // The eye is the badge, not a glow around it, so it never fades far.
      for animation in Breath.animations(opacity: Self.eyeBreath, scale: nil) {
        eye.add(animation, forKey: "breathe.\(animation.keyPath ?? "")")
      }
    case nil:
      break
    }
  }

  private static let eyeBreath: (Float, Float) = (0.55, 1)

  private func ripple() {
    let center = OverlayStyle.pointerTip
    let ring = AgentCursorView.ring(progress: 1, center: center)
    ring.opacity = 0
    CATransaction.begin()
    CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
    pointer.insertSublayer(ring, at: 0)
    ring.add(AgentCursorView.rippleAnimation(center: center), forKey: "ring")
    CATransaction.commit()
  }

  private static var eyes: [Int: CGImage] = [:]

  /// An ember disc with the eye in ink, edged like the pointer so it holds
  /// on a light icon and a dark one.
  private static func eyeImage(diameter: CGFloat) -> CGImage? {
    let pixels = Int((diameter * OverlayStyle.contentsScale).rounded())
    if let cached = eyes[pixels] { return cached }
    let image = NSImage(size: NSSize(width: diameter, height: diameter), flipped: false) { rect in
      let disc = NSBezierPath(ovalIn: rect.insetBy(dx: 0.75, dy: 0.75))
      OverlayStyle.ember.setFill()
      disc.fill()
      OverlayStyle.emberEdge.withAlphaComponent(0.9).setStroke()
      disc.lineWidth = 1.5
      disc.stroke()
      let configuration = NSImage.SymbolConfiguration(
        pointSize: diameter * 0.46, weight: .bold
      ).applying(.init(paletteColors: [OverlayStyle.inkOnEmber]))
      if let symbol = NSImage(systemSymbolName: "eye.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration)
      {
        let size = symbol.size
        symbol.draw(
          in: NSRect(
            x: rect.midX - size.width / 2, y: rect.midY - size.height / 2,
            width: size.width, height: size.height))
      }
      return true
    }
    let raster = AppIcons.bitmap(image, pixels: pixels)?.cgImage
    eyes[pixels] = raster
    return raster
  }
}
