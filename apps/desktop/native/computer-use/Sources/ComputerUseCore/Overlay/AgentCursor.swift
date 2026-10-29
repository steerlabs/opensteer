import AppKit
import QuartzCore

/// The agent's pointer in one app.
///
/// The helper never moves the system pointer (invariant 4), so without this
/// the person could not see where the agent is about to click. It lives inside
/// the app it operates: its panel is ordered directly above the window it
/// points into, so whatever covers that window covers the pointer, and it
/// keeps its place in that window as the window moves. It shows only while
/// that window is visible to the person, and goes the moment the session
/// releases the app.
@MainActor
final class AgentCursor {
  private let panel = WindowOverlayPanel(size: OverlayStyle.pointerPanelSize)
  let view = AgentCursorView()
  private let clock = FrameClock()
  private var ripples: [RipplePanel] = []

  /// The window it points into, as last read.
  private(set) var anchor: TrackedWindow?
  /// The key window, which it falls back to when the window it pointed into
  /// goes away — a menu that closed on the click.
  private var keyWindowID: CGWindowID?
  /// The tip, relative to the anchor's top-left.
  private var offset: CGPoint = .zero
  private var travel: (from: CGPoint, started: CFTimeInterval, duration: TimeInterval)?
  private var activity: OverlayModel.Activity?
  /// The model wants it drawn.
  private var wanted = false
  /// Drawn right now: wanted, and its window is visible.
  private var drawn = false
  /// Bumped by every move and by `hide`, so a crossfade's delayed landing
  /// that something newer superseded does nothing.
  private var generation = 0

  init() {
    panel.contentView = view
  }

  var isDrawn: Bool { drawn }
  var liveRippleCount: Int { ripples.filter(\.isLive).count }

  /// The windows it follows: the one it points into, and the key window it
  /// falls back to.
  var trackedWindowIDs: [CGWindowID] {
    guard wanted else { return [] }
    return [anchor?.id, keyWindowID].compactMap { $0 }
  }

  /// Where the tip is on screen now, in CoreGraphics coordinates.
  var tip: CGPoint? {
    anchor.map {
      OverlayGeometry.tip(offset: currentOffset(at: CACurrentMediaTime()), in: $0.frame)
    }
  }

  // MARK: - What the controller asks for

  /// Explicit binding moves the helper's marker only; it never moves the
  /// person's pointer. Preserve the window-local offset until the next action.
  func bind(_ window: CGWindowID, in snapshot: WindowSnapshot) {
    guard keyWindowID != window else { return }
    keyWindowID = window
    guard wanted, let next = snapshot.window(window) else { return }
    supersedeCrossfade()
    clock.stop()
    travel = nil
    endRipples()
    anchor = next
    offset = CGPoint(x: min(max(0, offset.x), next.frame.width),
      y: min(max(0, offset.y), next.frame.height))
    place(in: snapshot, .verify)
  }

  /// Goes to `point` inside `window`, and returns how long input should wait
  /// for it to get there.
  func move(
    _ move: OverlayModel.PointerMove, window: CGWindowID, keyWindow: CGWindowID,
    in snapshot: WindowSnapshot
  ) -> TimeInterval {
    keyWindowID = keyWindow
    guard let target = snapshot.window(window) ?? snapshot.window(keyWindow) else {
      return 0
    }
    supersedeCrossfade()
    let now = CACurrentMediaTime()
    let current = tip
    anchor = target
    let destination = CGPoint(x: move.to.x - target.frame.minX, y: move.to.y - target.frame.minY)
    wanted = true
    let reduced = OverlayMotion.reduced

    guard drawn, let current, move.kind != .appear else {
      // Not showing: it materializes where it is going.
      travel = nil
      offset = destination
      place(in: snapshot, .verify)
      guard drawn else { return 0 }
      appear(reduced: reduced)
      return reduced ? OverlayModel.crossfadeDuration : OverlayModel.appearDuration
    }
    let from = CGPoint(x: current.x - target.frame.minX, y: current.y - target.frame.minY)
    // The target window may have moved since the model's last requested point.
    // Time this trip from where the cursor is now, keeping repeated clicks immediate.
    let duration = OverlayModel.travelDuration(from: current, to: move.to)
    guard duration > 0 else {
      clock.stop()
      travel = nil
      offset = destination
      place(in: snapshot, .verify)
      return 0
    }
    if move.kind == .crossfade || reduced {
      crossfade(to: destination)
      return OverlayModel.crossfadeDuration
    }
    offset = destination
    travel = (from, now, duration)
    place(in: snapshot, .verify)
    clock.run { [weak self] time in
      guard let self, let travel = self.travel else { return false }
      if time - travel.started >= travel.duration { self.travel = nil }
      self.position(at: time)
      return self.travel != nil
    }
    return duration
  }

  /// Follows the window it points into, as `snapshot` read it: its place,
  /// its level, its order, and whether the person can see it.
  func place(in snapshot: WindowSnapshot, _ ordering: WindowOrdering) {
    guard wanted else { return }
    if let anchor, let now = snapshot.window(anchor.id) {
      self.anchor = now
    } else if let key = snapshot.window(keyWindowID) {
      // The window it pointed into is gone: stay where it was, now inside the
      // key window.
      let tip = self.tip ?? CGPoint(x: key.frame.midX, y: key.frame.midY)
      travel = nil
      offset = CGPoint(x: tip.x - key.frame.minX, y: tip.y - key.frame.minY)
      anchor = key
    } else {
      anchor = nil
    }
    guard let anchor, anchor.onScreen else {
      suspend()
      return
    }
    position(at: CACurrentMediaTime())
    panel.order(above: anchor, ordering, in: snapshot)
    if !drawn {
      drawn = true
      panel.alphaValue = 1
      resumeLook()
    }
  }

  func setActivity(_ next: OverlayModel.Activity) {
    guard next != activity else { return }
    activity = next
    guard drawn else { return }
    applyActivity(animated: true)
  }

  /// The pointer presses and an ember ring spreads from its tip.
  func click() {
    guard drawn, let tip else { return }
    let reduced = OverlayMotion.reduced
    if !reduced {
      view.body.add(AgentCursorView.pressAnimation(), forKey: "press")
    }
    ripple(at: tip, reduced: reduced)
  }

  /// A beat of the glow: a chunk typed, a key pressed, a value set.
  func pulse() {
    guard drawn, !OverlayMotion.reduced else { return }
    let base = view.glow.presentation()?.opacity ?? view.glow.opacity
    view.glow.add(AgentCursorView.pulseAnimation(from: base), forKey: "pulse")
  }

  /// A scroll tick: a pulse and a small nudge the way the page moves.
  func scrolled(_ direction: ScrollDirection) {
    pulse()
    guard drawn, !OverlayMotion.reduced else { return }
    let distance = OverlayStyle.nudgeDistance
    let (keyPath, value): (String, CGFloat) = {
      switch direction {
      case .up: return ("transform.translation.y", -distance)
      case .down: return ("transform.translation.y", distance)
      case .left: return ("transform.translation.x", -distance)
      case .right: return ("transform.translation.x", distance)
      }
    }()
    let nudge = CAKeyframeAnimation(keyPath: keyPath)
    nudge.values = [0, value, 0]
    nudge.keyTimes = [0, 0.3, 1]
    nudge.isAdditive = true
    nudge.duration = 0.2
    nudge.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut),
    ]
    view.body.add(nudge, forKey: "nudge")
  }

  /// The session let go of the app: fade and shrink away, and forget the
  /// window.
  var isWanted: Bool { wanted }

  func hide() {
    guard wanted else { return }
    wanted = false
    travel = nil
    generation += 1
    clock.stop()
    anchor = nil
    // Nothing outlives the session: a ring still spreading goes with it.
    endRipples()
    guard drawn else {
      panel.orderOut(nil)
      return
    }
    drawn = false
    let reduced = OverlayMotion.reduced
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.drawn else { return }
        self.panel.orderOut(nil)
        self.view.body.removeAllAnimations()
        self.view.glow.removeAllAnimations()
      }
    }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = view.body.presentation()?.opacity ?? 1
    fade.toValue = 0
    fade.duration = reduced ? 0.1 : OverlayStyle.hideDuration
    fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
    view.body.add(fade, forKey: "hide")
    if !reduced {
      let shrink = CABasicAnimation(keyPath: "transform.scale")
      shrink.fromValue = 1
      shrink.toValue = 0.85
      shrink.duration = OverlayStyle.hideDuration
      shrink.timingFunction = CAMediaTimingFunction(name: .easeIn)
      view.body.add(shrink, forKey: "shrink")
    }
    view.apply(AgentCursorView.Pose(opacity: 0, scale: reduced ? 1 : 0.85))
    CATransaction.commit()
  }

  // MARK: - Drawing

  /// The window it points into is not visible: out of sight at once, and
  /// back where it was when the window returns.
  private func suspend() {
    guard drawn else { return }
    drawn = false
    panel.orderOut(nil)
    endRipples()
  }

  private func endRipples() {
    for ripple in ripples { ripple.cancel() }
    ripples.removeAll()
  }

  /// A preference change takes effect during a move as well as between calls.
  func motionChanged() {
    guard drawn else { return }
    if OverlayMotion.reduced {
      view.body.removeAnimation(forKey: "press")
      view.body.removeAnimation(forKey: "nudge")
      view.body.removeAnimation(forKey: "appear.grow")
      view.glow.removeAnimation(forKey: "pulse")
      endRipples()
      if travel != nil {
        clock.stop()
        travel = nil
        // Input is already waiting for this trip. Land now so changing the
        // preference cannot extend the animation past that action's wait.
        position(at: CACurrentMediaTime())
      }
    }
    applyActivity(animated: false)
  }

  /// A move supersedes a crossfade still on its way: it will not land, and
  /// the pointer it faded out is back.
  private func supersedeCrossfade() {
    generation += 1
    view.body.removeAnimation(forKey: "crossfade")
    view.body.removeAnimation(forKey: "crossfade.in")
  }

  private func currentOffset(at time: CFTimeInterval) -> CGPoint {
    guard let travel else { return offset }
    let progress = OverlayModel.travelProgress(time - travel.started, duration: travel.duration)
    return OverlayGeometry.interpolate(travel.from, offset, progress)
  }

  private func position(at time: CFTimeInterval) {
    guard let anchor else { return }
    let tip = OverlayGeometry.tip(offset: currentOffset(at: time), in: anchor.frame)
    let frame = OverlayGeometry.pointerPanelFrame(
      tip: tip, primaryHeight: ScreenGeometry.primaryHeight)
    if panel.frame.origin != frame.origin { panel.setFrameOrigin(frame.origin) }
  }

  private func appear(reduced: Bool) {
    view.body.removeAllAnimations()
    view.glow.removeAllAnimations()
    view.apply(.rest)
    CATransaction.begin()
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.toValue = 1
    fade.duration = reduced ? OverlayModel.crossfadeDuration : 0.16
    fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
    view.body.add(fade, forKey: "appear.fade")
    if !reduced {
      let grow = Spring.animation(
        "transform.scale", from: 0.88, to: 1, duration: OverlayModel.appearDuration)
      view.body.add(grow, forKey: "appear.grow")
    }
    CATransaction.commit()
    applyActivity(animated: false)
  }

  /// Back after its window was out of sight: a quick fade, no fanfare.
  private func resumeLook() {
    view.apply(.rest)
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.toValue = 1
    fade.duration = 0.12
    view.body.add(fade, forKey: "resume")
    applyActivity(animated: false)
  }

  private func crossfade(to destination: CGPoint) {
    travel = nil
    let landing = generation
    let out = CABasicAnimation(keyPath: "opacity")
    out.fromValue = 1
    out.toValue = 0
    out.duration = OverlayModel.crossfadeDuration / 2
    out.fillMode = .forwards
    out.isRemovedOnCompletion = false
    view.body.add(out, forKey: "crossfade")
    DispatchQueue.main.asyncAfter(deadline: .now() + OverlayModel.crossfadeDuration / 2) {
      [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.wanted, self.generation == landing else { return }
        self.offset = destination
        self.position(at: CACurrentMediaTime())
        let back = CABasicAnimation(keyPath: "opacity")
        back.fromValue = 0
        back.toValue = 1
        back.duration = OverlayModel.crossfadeDuration / 2
        self.view.body.removeAnimation(forKey: "crossfade")
        self.view.body.add(back, forKey: "crossfade.in")
      }
    }
  }

  /// Working holds the glow steady; thinking lets it breathe slowly.
  /// The arrow itself stays still either way.
  private func applyActivity(animated: Bool) {
    let glow = view.glow
    let opacity = glow.presentation()?.opacity ?? glow.opacity
    glow.removeAnimation(forKey: "breathe.opacity")
    glow.removeAnimation(forKey: "breathe.scale")
    glow.removeAnimation(forKey: "settle")
    guard activity == .thinking, !OverlayMotion.reduced else {
      if animated {
        let settle = CABasicAnimation(keyPath: "opacity")
        settle.fromValue = opacity
        settle.toValue = OverlayStyle.glowRestOpacity
        settle.duration = 0.12
        glow.add(settle, forKey: "settle")
      }
      view.apply(.rest)
      return
    }
    for animation in Breath.animations() {
      glow.add(animation, forKey: "breathe.\(animation.keyPath ?? "")")
    }
  }

  private func ripple(at tip: CGPoint, reduced: Bool) {
    guard let anchor else { return }
    let panel =
      ripples.first { $0.isLive && $0.center == tip }
      ?? {
        let created = RipplePanel(center: tip)
        ripples.append(created)
        return created
      }()
    panel.show(below: self.panel, anchor: anchor, reduced: reduced) { [weak self, weak panel] in
      self?.ripples.removeAll { $0 === panel }
    }
  }
}

/// The pointer glow's slow breath. Pointers in concurrent apps share a beat.
///
/// It runs for the whole of a session, so it asks Core Animation for a low
/// frame rate: at display rate the window server would recomposite the
/// pointer 60 to 120 times a second for a change too slow to
/// see between frames. A 3.2 s breath over a fifth of opacity moves under
/// 2% a frame at 12 fps, which still reads as smooth. Everything else — the
/// travel, a click, a nudge — keeps the display's rate.
enum Breath {
  static let frameRate = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 12)

  static func animations(
    opacity: (Float, Float) = (OverlayStyle.glowBreathLow, OverlayStyle.glowBreathHigh),
    scale: (CGFloat, CGFloat)? = OverlayStyle.glowBreathScale
  ) -> [CABasicAnimation] {
    let half = OverlayStyle.breathPeriod / 2
    let now = CACurrentMediaTime()
    let beat = now - now.truncatingRemainder(dividingBy: OverlayStyle.breathPeriod)
    func breathe(_ keyPath: String, _ low: Any, _ high: Any) -> CABasicAnimation {
      let animation = CABasicAnimation(keyPath: keyPath)
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
    var list = [breathe("opacity", opacity.0, opacity.1)]
    if let scale { list.append(breathe("transform.scale", scale.0, scale.1)) }
    return list
  }
}

/// Where a click landed: a ring spreading from the tip, in its own small
/// panel just under the pointer so it stays where the click was while the
/// pointer moves on.
@MainActor
final class RipplePanel {
  static let size = NSSize(width: 64, height: 64)

  let center: CGPoint
  private let panel = WindowOverlayPanel(size: size)
  private let root = CALayer()
  private var running = 0
  private(set) var isLive = true

  init(center: CGPoint) {
    self.center = center
    let view = NSView(frame: NSRect(origin: .zero, size: Self.size))
    view.layer = root
    view.wantsLayer = true
    root.isGeometryFlipped = true
    root.frame = view.bounds
    panel.contentView = view
    let frame = OverlayGeometry.appKitRect(
      fromCoreGraphics: CGRect(
        x: center.x - Self.size.width / 2, y: center.y - Self.size.height / 2,
        width: Self.size.width, height: Self.size.height),
      primaryHeight: ScreenGeometry.primaryHeight)
    panel.setFrame(frame, display: false)
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

  func show(
    below cursor: WindowOverlayPanel, anchor: TrackedWindow, reduced: Bool,
    done: @escaping @MainActor () -> Void
  ) {
    let middle = CGPoint(x: Self.size.width / 2, y: Self.size.height / 2)
    panel.order(above: anchor)
    panel.order(.below, relativeTo: cursor.windowNumber)
    running += 1
    let ring = AgentCursorView.ring(progress: reduced ? 0.55 : 1, center: middle)
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      MainActor.assumeIsolated {
        ring.removeFromSuperlayer()
        guard let self, self.isLive else { return }
        self.running -= 1
        guard self.running == 0 else { return }
        self.isLive = false
        self.panel.orderOut(nil)
        done()
      }
    }
    root.addSublayer(ring)
    if reduced {
      // Shown, not animated: the click is still marked.
      ring.opacity = 1
      let hold = CABasicAnimation(keyPath: "opacity")
      hold.fromValue = 1
      hold.toValue = 1
      hold.duration = OverlayStyle.staticRingDuration
      ring.add(hold, forKey: "ring")
    } else {
      ring.opacity = 0
      ring.add(AgentCursorView.rippleAnimation(center: middle), forKey: "ring")
    }
    CATransaction.commit()
  }
}
