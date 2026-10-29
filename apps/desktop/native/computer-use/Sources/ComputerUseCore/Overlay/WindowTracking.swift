import AppKit
import CoreGraphics
import Foundation
import QuartzCore

/// One window of the app being used, as the window server has it now.
///
/// Reading it sends the app nothing and needs no Screen Recording, so the
/// main actor can read it every frame while a window moves.
struct TrackedWindow: Equatable {
  let id: CGWindowID
  /// Screen points, top-left origin (CoreGraphics space).
  let frame: CGRect
  /// The window server layer, which the drawn pointer and outline share so
  /// they can be ordered directly above the window.
  let level: Int
  /// On the Space the person is looking at, not minimized, and its app not
  /// hidden: whether the person can see it at all.
  let onScreen: Bool

  init(id: CGWindowID, frame: CGRect, level: Int, onScreen: Bool) {
    self.id = id
    self.frame = frame
    self.level = level
    self.onScreen = onScreen
  }

  init?(info: [String: Any]) {
    guard let number = info[kCGWindowNumber as String] as? NSNumber,
      let frame = AppWindows.bounds(info), frame.width > 0, frame.height > 0
    else { return nil }
    self.init(
      id: CGWindowID(number.uint32Value),
      frame: frame,
      level: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
      onScreen: (info[kCGWindowIsOnscreen as String] as? Bool) == true
        && (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0)
  }
}

/// How much ordering one placement of the drawn panels may do.
///
/// Ordering a panel is a round trip to the window server that recomposites
/// the windows around it, so a panel is ordered only when something says it
/// has to be.
enum WindowOrdering: Equatable {
  /// Only a panel whose window or level changed, or that is not showing.
  case ifChanged
  /// Also a panel the window server's stacking shows is no longer directly
  /// above its window: the person raised that window inside its own app.
  case verify
  /// Every panel: an app came forward, was shown, or the Space changed, and
  /// the window server may have restacked everything.
  case always
}

/// The windows something is drawn over, read from the window server once per
/// placement and shared by every pointer and outline.
@MainActor
final class WindowSnapshot {
  private let windows: [CGWindowID: TrackedWindow]
  private let readStacking: @MainActor () -> [CGWindowID]
  private let readOwn: @MainActor () -> Set<CGWindowID>
  private var stacking: [CGWindowID]?
  private var own: Set<CGWindowID>?

  /// `stacking` is every window on screen, front to back; `own` the
  /// helper's windows. Both are read only if a placement verifies the order.
  init(
    windows: [TrackedWindow],
    stacking: @escaping @MainActor () -> [CGWindowID] = WindowSnapshot.onScreenStacking,
    own: @escaping @MainActor () -> Set<CGWindowID> = WindowSnapshot.helperWindows
  ) {
    self.windows = Dictionary(windows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    readStacking = stacking
    readOwn = own
  }

  /// One window-server read for all of `ids`.
  static func read(_ ids: some Sequence<CGWindowID>) -> WindowSnapshot {
    let unique = Array(Set(ids.filter { $0 != 0 }))
    guard !unique.isEmpty else { return WindowSnapshot(windows: []) }
    var values = unique.map { UnsafeRawPointer(bitPattern: UInt($0)) }
    let list = values.withUnsafeMutableBufferPointer { buffer in
      CFArrayCreate(nil, buffer.baseAddress, buffer.count, nil)
    }
    let infos = list.flatMap { CGWindowListCreateDescriptionFromArray($0) as? [[String: Any]] }
    return WindowSnapshot(windows: (infos ?? []).compactMap(TrackedWindow.init(info:)))
  }

  func window(_ id: CGWindowID?) -> TrackedWindow? {
    id.flatMap { windows[$0] }
  }

  /// Whether `panel` is directly above `window`, with nothing between them
  /// but the helper's own panels.
  func isDirectlyAbove(panel: Int, window: CGWindowID) -> Bool {
    let stacking = self.stacking ?? readStacking()
    self.stacking = stacking
    let own = self.own ?? readOwn()
    self.own = own
    return Self.isDirectlyAbove(
      panel: CGWindowID(clamping: panel), window: window, frontToBack: stacking, own: own)
  }

  nonisolated static func isDirectlyAbove(
    panel: CGWindowID, window: CGWindowID, frontToBack: [CGWindowID], own: Set<CGWindowID>
  ) -> Bool {
    guard let index = frontToBack.firstIndex(of: window) else { return false }
    for above in frontToBack[..<index].reversed() {
      if above == panel { return true }
      if !own.contains(above) { return false }
    }
    return false
  }

  static func onScreenStacking() -> [CGWindowID] {
    (NSWindow.windowNumbers(options: [.allApplications]) ?? []).map {
      CGWindowID(clamping: $0.intValue)
    }
  }

  static func helperWindows() -> Set<CGWindowID> {
    Set(NSApplication.shared.windows.map(\.windowNumber).filter { $0 > 0 }.map(CGWindowID.init))
  }
}

/// Calls back once per display frame until the callback says it is done.
@MainActor
protocol FrameDriving: AnyObject {
  var isRunning: Bool { get }
  func run(_ step: @escaping @MainActor (CFTimeInterval) -> Bool)
  func stop()
}

@MainActor
final class FrameClock: NSObject, FrameDriving {
  private var link: CADisplayLink?
  private var timer: Timer?
  private var step: (@MainActor (CFTimeInterval) -> Bool)?
  /// Bumped by every `run`, so a step that finishes by starting the next
  /// one does not stop it.
  private var generation = 0

  var isRunning: Bool { step != nil }

  /// Replaces whatever was running. `step` gets the media time of the frame
  /// and returns false to stop.
  func run(_ step: @escaping @MainActor (CFTimeInterval) -> Bool) {
    self.step = step
    generation += 1
    guard link == nil, timer == nil else { return }
    if let screen = NSScreen.main ?? NSScreen.screens.first {
      let link = screen.displayLink(target: self, selector: #selector(frame(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
    } else {
      let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.advance(CACurrentMediaTime()) }
      }
      RunLoop.main.add(timer, forMode: .common)
      self.timer = timer
    }
  }

  func stop() {
    step = nil
    link?.invalidate()
    link = nil
    timer?.invalidate()
    timer = nil
  }

  @objc private func frame(_ link: CADisplayLink) {
    advance(link.targetTimestamp)
  }

  private func advance(_ time: CFTimeInterval) {
    guard let step else {
      stop()
      return
    }
    let running = generation
    if !step(time), generation == running { stop() }
  }
}

/// A change on this Mac that the overlay answers to.
enum WorkspaceEvent: Equatable, CaseIterable {
  case activated
  case deactivated
  case hidden
  case unhidden
  case spaceChanged
  case terminated
  case screensChanged
  /// Reduce Motion was turned on or off.
  case motionPreferenceChanged

  var name: Notification.Name {
    switch self {
    case .activated: NSWorkspace.didActivateApplicationNotification
    case .deactivated: NSWorkspace.didDeactivateApplicationNotification
    case .hidden: NSWorkspace.didHideApplicationNotification
    case .unhidden: NSWorkspace.didUnhideApplicationNotification
    case .spaceChanged: NSWorkspace.activeSpaceDidChangeNotification
    case .terminated: NSWorkspace.didTerminateApplicationNotification
    case .screensChanged: NSApplication.didChangeScreenParametersNotification
    case .motionPreferenceChanged: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification
    }
  }

  var center: NotificationCenter {
    self == .screensChanged ? .default : NSWorkspace.shared.notificationCenter
  }

  /// Windows may have moved, appeared or gone.
  var movesWindows: Bool { self != .motionPreferenceChanged }

  /// The window server may have restacked the windows: an app came forward
  /// or was shown, or the person moved to another Space.
  var restacksWindows: Bool { [.activated, .unhidden, .spaceChanged].contains(self) }
}

/// Notification observers that are removed when their owner goes.
final class NotificationObservations: @unchecked Sendable {
  private var tokens: [(NotificationCenter, any NSObjectProtocol)] = []

  func observe(
    _ name: Notification.Name, on center: NotificationCenter,
    _ handler: @escaping @Sendable (Notification) -> Void
  ) {
    tokens.append((center, center.addObserver(forName: name, object: nil, queue: .main, using: handler)))
  }

  deinit {
    for (center, token) in tokens { center.removeObserver(token) }
  }
}

/// Tells the overlay when the windows it draws over may have moved, changed
/// Space, been hidden or been brought forward, and forwards the other
/// workspace changes the overlay answers to. It is the one owner of those
/// observers.
///
/// Window moves come from the app's own Accessibility notifications (through
/// `WindowMonitor`) and are then followed every frame until the window has
/// been still for a moment; activation, hiding and Space changes come from
/// `NSWorkspace`; and a slow poll catches what nothing announces, such as the
/// person raising the window inside its own app.
@MainActor
final class WindowTracker {
  /// A poll this often while anything is drawn over a window.
  static let pollInterval: TimeInterval = 0.25
  /// After the last sign of movement, follow every frame this long.
  static let followDuration: TimeInterval = 0.45
  /// While following, the stacking is checked at most this often; between
  /// checks only a panel whose window changed is ordered.
  static let verifyInterval: TimeInterval = 0.1

  /// Re-reads every tracked window once, places what is drawn over it with
  /// at most the given ordering, and returns whether any of them moved.
  var refresh: (@MainActor (WindowOrdering) -> Bool)?
  /// Every workspace change, including those that move no window.
  var onWorkspaceEvent: (@MainActor (WorkspaceEvent) -> Void)?

  private let clock: any FrameDriving
  private let now: () -> CFTimeInterval
  private var poll: Timer?
  private var followUntil: CFTimeInterval = 0
  private var restacked = false
  private var lastVerified: CFTimeInterval = -.infinity
  private let observations = NotificationObservations()

  convenience init() {
    self.init(clock: FrameClock(), now: CACurrentMediaTime, center: { $0.center })
  }

  init(
    clock: any FrameDriving, now: @escaping () -> CFTimeInterval,
    center: (WorkspaceEvent) -> NotificationCenter
  ) {
    self.clock = clock
    self.now = now
    for event in WorkspaceEvent.allCases {
      observations.observe(event.name, on: center(event)) { [weak self] _ in
        MainActor.assumeIsolated { self?.workspaceChanged(event) }
      }
    }
  }

  /// Whether anything is meant to be drawn over a window, so the poll runs
  /// only then.
  var isActive = false {
    didSet {
      guard isActive != oldValue else { return }
      poll?.invalidate()
      poll = nil
      guard isActive else {
        clock.stop()
        return
      }
      let timer = Timer(timeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.tick() }
      }
      RunLoop.main.add(timer, forMode: .common)
      poll = timer
    }
  }

  /// Whether anything is drawn right now. A window that nothing is drawn
  /// over is not followed through its app's events; the poll brings back
  /// what returns to view.
  var isDrawing = false

  var isFollowing: Bool { clock.isRunning }

  /// One of the watched apps' windows moved, resized, closed or changed
  /// focus.
  func windowEvent() {
    guard isDrawing else { return }
    follow()
  }

  /// Something may have moved: follow every frame for a moment. The next
  /// frame places everything; nothing is placed here, because a drag sends
  /// an event for every step and the frame clock already places each frame.
  /// Activation reorders windows a beat after its notification, and a drag
  /// keeps moving after the first event.
  func follow(restacked: Bool = false) {
    guard isActive else { return }
    if restacked { self.restacked = true }
    followUntil = max(followUntil, now() + Self.followDuration)
    startClock()
  }

  /// The poll: one placement, and a follow when something moved. While the
  /// clock is following, every frame already places everything.
  func tick() {
    guard isActive, !clock.isRunning else { return }
    let now = now()
    guard place(at: now) else { return }
    followUntil = now + Self.followDuration
    startClock()
  }

  private func startClock() {
    guard !clock.isRunning else { return }
    clock.run { [weak self] time in
      guard let self, self.isActive else { return false }
      if self.place(at: time) { self.followUntil = time + Self.followDuration }
      return time < self.followUntil
    }
  }

  private func place(at time: CFTimeInterval) -> Bool {
    let ordering: WindowOrdering
    if restacked {
      restacked = false
      ordering = .always
      lastVerified = time
    } else if time - lastVerified >= Self.verifyInterval {
      ordering = .verify
      lastVerified = time
    } else {
      ordering = .ifChanged
    }
    return refresh?(ordering) ?? false
  }

  private func workspaceChanged(_ event: WorkspaceEvent) {
    onWorkspaceEvent?(event)
    if event.movesWindows { follow(restacked: event.restacksWindows) }
  }
}
