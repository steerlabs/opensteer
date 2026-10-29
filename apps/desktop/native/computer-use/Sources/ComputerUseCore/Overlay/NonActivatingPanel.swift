import AppKit

/// Nothing the helper draws may take the keyboard (§2 "What the person sees").
///
/// A panel that can become key would put the person's insertion point in the
/// helper's window the moment they clicked `Stop`, which is exactly the focus
/// theft invariant 4 forbids.
class NonActivatingPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }

  init(contentRect: NSRect, ignoresMouse: Bool) {
    super.init(
      contentRect: contentRect,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    ignoresMouseEvents = ignoresMouse
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    animationBehavior = .none
  }
}

/// A click-through panel that lives inside the app it draws over: ordered
/// directly above one of that app's windows, at that window's level, so
/// whatever covers the window covers it too, and never on top of the
/// person's other apps.
///
/// It is shown only while that window is on the Space being looked at: the
/// tracker orders it out the moment the window is not on screen, and back in
/// above the window when it returns. It is `.transient` rather than
/// `.managed`, because a managed window takes part in Mission Control, App
/// Exposé and Stage Manager — the pointer and outline would show there as
/// windows of their own, and Stage Manager would treat the helper as an app
/// with a window to bring forward. A transient window is hidden by them.
final class WindowOverlayPanel: NonActivatingPanel {
  /// The window and level it was last ordered directly above.
  struct Placement: Equatable {
    let window: CGWindowID
    let level: Int
  }

  /// Forgotten when the panel is ordered out.
  private(set) var placement: Placement?

  init(size: NSSize) {
    super.init(contentRect: NSRect(origin: .zero, size: size), ignoresMouse: true)
    isFloatingPanel = false
    level = .normal
    collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
  }

  // AppKit otherwise moves the panel below the menu bar when its transparent
  // padding crosses a screen edge, separating the border or pointer from its
  // target. These panels follow window-server coordinates, not the work area.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }

  /// Directly above `window`, at its level, now.
  func order(above window: TrackedWindow) {
    let level = NSWindow.Level(rawValue: window.level)
    if self.level != level { self.level = level }
    order(.above, relativeTo: Int(window.id))
    placement = Placement(window: window.id, level: window.level)
  }

  /// Directly above `window`, ordering only when `ordering` and what
  /// `snapshot` shows say it has to.
  func order(above window: TrackedWindow, _ ordering: WindowOrdering, in snapshot: WindowSnapshot) {
    let needed = Self.needsOrdering(
      placement, window: window, ordering: ordering, isVisible: isVisible
    ) { [windowNumber] in
      snapshot.isDirectlyAbove(panel: windowNumber, window: window.id)
    }
    if needed { order(above: window) }
  }

  override func orderOut(_ sender: Any?) {
    placement = nil
    super.orderOut(sender)
  }

  static func needsOrdering(
    _ placement: Placement?, window: TrackedWindow, ordering: WindowOrdering, isVisible: Bool,
    isDirectlyAbove: () -> Bool
  ) -> Bool {
    guard isVisible, placement == Placement(window: window.id, level: window.level) else {
      return true
    }
    switch ordering {
    case .always: return true
    case .ifChanged: return false
    case .verify: return !isDirectlyAbove()
    }
  }
}
