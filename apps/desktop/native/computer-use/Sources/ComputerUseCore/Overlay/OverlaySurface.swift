import AppKit

/// The pill's dark glass: the HUD material, dark
/// whatever the system appearance, tinted toward Opensteer's near-black, with
/// a hairline edge. It also drags its window, and says when the pointer
/// enters or leaves it.
///
/// `isMovableByWindowBackground` hands the drag to the window server and says
/// nothing when it ends, and the pill has to settle into a corner when the
/// person lets go, so the drag is tracked here instead. It takes every press,
/// buttons' too: minimized, the pill is almost all buttons, and a press that
/// moves is a drag, so a person who grabs `Stop` to move the pill moves it
/// and stops nothing.
final class OverlaySurface: NSView {
  var onDragStarted: (@MainActor () -> Void)?
  var onDragEnded: (@MainActor () -> Void)?
  /// The pointer entered (true) or left the surface.
  var onPointer: (@MainActor (Bool) -> Void)?
  /// Whether a button may take a press now. One that may not is just more
  /// surface to drag by.
  var accepts: ((NSButton) -> Bool)?
  /// The corner radius for a height, for a surface that changes shape.
  var radius: ((CGFloat) -> CGFloat)?
  /// Where the pointer is on screen. A test stands in for the person's.
  var mouseLocation: () -> NSPoint = { NSEvent.mouseLocation }
  private(set) var isDragging = false
  /// Where the press began, on screen and in the window. A press is a click
  /// only if neither the events nor the pointer moved: queued events can lag
  /// the pointer, and the pointer can lag queued events. Wrongly dropping a
  /// click is the safe mistake.
  private var dragStart: (mouse: NSPoint, origin: NSPoint, location: NSPoint, button: NSButton?)?
  private(set) var cornerRadius: CGFloat
  private let material = NSVisualEffectView()
  private let tint = NSView()
  private let edge = NSView()

  static let tintOpacity: CGFloat = 0.62
  /// How far a press may wander and still be a click.
  static let dragThreshold: CGFloat = 3

  init(cornerRadius: CGFloat) {
    self.cornerRadius = cornerRadius
    super.init(frame: .zero)
    appearance = NSAppearance(named: .darkAqua)
    wantsLayer = true

    material.material = .hudWindow
    material.blendingMode = .behindWindow
    material.state = .active
    tint.wantsLayer = true
    tint.layer?.backgroundColor =
      OverlayStyle.surface.withAlphaComponent(Self.tintOpacity).cgColor
    tint.layer?.cornerCurve = .continuous
    edge.wantsLayer = true
    edge.layer?.cornerCurve = .continuous
    edge.layer?.borderWidth = 1
    edge.layer?.borderColor = NSColor.white.withAlphaComponent(0.1).cgColor
    for view in [material, tint, edge] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: leadingAnchor),
        view.trailingAnchor.constraint(equalTo: trailingAnchor),
        view.topAnchor.constraint(equalTo: topAnchor),
        view.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
    }
    shape(cornerRadius)
  }

  required init?(coder: NSCoder) { nil }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    if let radius, radius(newSize.height) != cornerRadius {
      shape(radius(newSize.height))
      window?.invalidateShadow()
    }
  }

  private func shape(_ radius: CGFloat) {
    cornerRadius = radius
    material.maskImage = Self.mask(radius: radius)
    tint.layer?.cornerRadius = radius
    edge.layer?.cornerRadius = radius
  }

  /// A stretchable rounded mask, which is how a material takes a shape and
  /// how the window's shadow learns it.
  static func mask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
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
    onPointer?(true)
  }

  override func mouseExited(with event: NSEvent) {
    onPointer?(false)
  }

  /// The panels never become key, so the first click has to count.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    super.hitTest(point) == nil ? nil : self
  }

  /// The enabled button under a point of the window, if any.
  func button(at locationInWindow: NSPoint) -> NSButton? {
    guard let superview else { return nil }
    var view = super.hitTest(superview.convert(locationInWindow, from: nil))
    while let current = view, current !== self {
      if let button = current as? NSButton {
        return button.isEnabled && !button.isHiddenOrHasHiddenAncestor ? button : nil
      }
      view = current.superview
    }
    return nil
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    let button = button(at: event.locationInWindow).flatMap { accepts?($0) ?? true ? $0 : nil }
    dragStart = (mouseLocation(), window.frame.origin, event.locationInWindow, button)
    button?.highlight(true)
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window, let dragStart else { return }
    let mouse = mouseLocation()
    if !isDragging {
      guard moved(event, since: dragStart) else { return }
      isDragging = true
      dragStart.button?.highlight(false)
      onDragStarted?()
    }
    window.setFrameOrigin(
      NSPoint(
        x: dragStart.origin.x + mouse.x - dragStart.mouse.x,
        y: dragStart.origin.y + mouse.y - dragStart.mouse.y
      )
    )
  }

  /// Forgets a press or drag whose release will never come: the window went
  /// away under it.
  func cancelDrag() {
    dragStart?.button?.highlight(false)
    dragStart = nil
    isDragging = false
  }

  override func mouseUp(with event: NSEvent) {
    let start = dragStart
    dragStart = nil
    if isDragging {
      isDragging = false
      onDragEnded?()
      return
    }
    guard let start, let pressed = start.button else { return }
    pressed.highlight(false)
    if !moved(event, since: start), button(at: event.locationInWindow) === pressed {
      pressed.performClick(nil)
    }
  }

  /// Before a drag the window has not moved, so points in it still compare.
  private func moved(
    _ event: NSEvent, since start: (mouse: NSPoint, origin: NSPoint, location: NSPoint, button: NSButton?)
  ) -> Bool {
    let point = event.locationInWindow
    let mouse = mouseLocation()
    return hypot(point.x - start.location.x, point.y - start.location.y) >= Self.dragThreshold
      || hypot(mouse.x - start.mouse.x, mouse.y - start.mouse.y) >= Self.dragThreshold
  }
}

/// Reduce Motion makes every overlay transition immediate or a short fade.
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

  /// Moves and resizes a window to `frame` along a spring, one display frame
  /// at a time, since a window's frame is not a layer Core Animation can
  /// drive. Starting another replaces it from wherever it has got to.
  static func spring(
    _ window: NSWindow, to frame: NSRect, duration: TimeInterval, clock: FrameClock,
    curve: @escaping (TimeInterval, TimeInterval) -> Double = { Spring.critical($0, duration: $1) },
    alpha: (from: CGFloat, to: CGFloat)? = nil,
    completion: (@MainActor () -> Void)? = nil
  ) {
    let start = window.frame
    guard !reduced, duration > 0, start != frame || alpha != nil else {
      clock.stop()
      if start != frame { window.setFrame(frame, display: true) }
      if start.size != frame.size { window.invalidateShadow() }
      if let alpha { window.alphaValue = alpha.to }
      completion?()
      return
    }
    let resizes = start.size != frame.size
    let began = CACurrentMediaTime()
    clock.run { time in
      let elapsed = time - began
      let progress = curve(elapsed, duration)
      func mix(_ from: CGFloat, _ to: CGFloat) -> CGFloat { from + (to - from) * progress }
      let next = NSRect(
        x: mix(start.minX, frame.minX), y: mix(start.minY, frame.minY),
        width: mix(start.width, frame.width), height: mix(start.height, frame.height))
      if resizes {
        window.setFrame(next, display: true)
        window.invalidateShadow()
      } else {
        window.setFrameOrigin(next.origin)
      }
      if let alpha {
        let eased = 1 - pow(1 - min(elapsed / (duration * 0.8), 1), 2)
        window.alphaValue = alpha.from + (alpha.to - alpha.from) * eased
      }
      guard elapsed < duration else {
        completion?()
        return false
      }
      return true
    }
  }
}
