import AppKit
import CoreGraphics
import Foundation

/// What the person sees for one write to an app, shown immediately before it.
enum OverlayFeedback: Equatable, Sendable {
  /// Each click of an action, as it is posted or pressed.
  case click
  /// A chunk typed, a key pressed or a value set.
  case pulse
  /// One tick of a scroll.
  case scroll(ScrollDirection)
}

/// Where an action shows its `OverlayFeedback`.
@MainActor
protocol ActionFeedback: AnyObject, Sendable {
  func show(_ feedback: OverlayFeedback, in app: AppSessionState)
}

/// Everything the person sees on this Mac: a chip on the window of each held
/// app, and a ring where an agent clicks. `OverlayModel` decides what shows;
/// this draws it, keeps the clock that moves the timed states along, and
/// keeps each chip on its window.
@MainActor
public final class OverlayController: ActionFeedback {
  private var model = OverlayModel()
  /// The person pressed a chip's `Stop`: the app it marks.
  private let onStop: @MainActor (String) -> Void
  private var chips: [String: WindowChip] = [:]
  /// Each app's key window, as its latest observation or action found it.
  private var keyWindows: [String: CGWindowID] = [:]
  /// Where each app's agent last aimed input, and the window there.
  private var aims: [String: (point: CGPoint, window: CGWindowID)] = [:]
  private var rings: [String: [ClickRing]] = [:]
  /// Which session holds each live `AppSessionState`.
  private var holders: [ObjectIdentifier: OverlayModel.Holder] = [:]
  private var timer: Timer?
  private let tracker = WindowTracker()
  private let drawsWindows: Bool

  public convenience init(onStop: @escaping @MainActor (String) -> Void) {
    self.init(drawsWindows: true, onStop: onStop)
  }

  init(drawsWindows: Bool, onStop: @escaping @MainActor (String) -> Void) {
    self.drawsWindows = drawsWindows
    self.onStop = onStop
    tracker.refresh = { [weak self] ordering in self?.placeOverWindows(ordering) ?? false }
    tracker.onWorkspaceEvent = { [weak self] event in self?.workspaceChanged(event) }
  }

  func presentation(at now: Date) -> OverlayModel.Presentation {
    model.presentation(at: now)
  }

  /// The chip drawn for an app, if any.
  func chip(for key: String) -> WindowChip? { chips[key] }

  // MARK: - What the runtime reports

  /// After a session opens, changes, claims an app or closes. `ending` says
  /// why the sessions that are no longer listed went away.
  func update(
    sessions: some Collection<HelperSession>,
    owners: [String: String],
    ending: OverlayModel.Ending
  ) {
    let before = Dictionary(holders.map { ($0.value.app, $0.key) }, uniquingKeysWith: { a, _ in a })
    holders = [:]
    for session in sessions {
      for app in session.orderedApps where owners[Self.key(app)] == session.sessionId {
        holders[ObjectIdentifier(app)] = OverlayModel.Holder(
          session: session.sessionId, app: Self.key(app))
      }
    }
    // A held app whose state was replaced (it restarted as another build) is
    // found again by its next observation.
    for (instance, holder) in holders where before[holder.app].map({ $0 != instance }) == true {
      keyWindows[holder.app] = nil
    }
    present(Self.sessions(sessions, owners: owners), ending: ending)
  }

  /// The sessions as the model takes them. The runtime reaches it through
  /// `update`; a journey can hand it several agents on one app.
  func present(_ next: [OverlayModel.Session], ending: OverlayModel.Ending) {
    let previous = Set(OverlayModel.holders(model.sessions))
    let current = Set(OverlayModel.holders(next))
    model.update(sessions: next, ending: ending, at: Date())
    let kept = model.shownApps
    // A window found for an app stays only while the same sessions hold it,
    // or while its notice sits on it.
    let previousByApp = Dictionary(grouping: previous, by: \.app)
    let currentByApp = Dictionary(grouping: current, by: \.app)
    keyWindows = keyWindows.filter { key, _ in
      kept.contains(key)
        && (currentByApp[key] == nil || previousByApp[key].map(Set.init) == currentByApp[key].map(Set.init))
    }
    let held = Set(current.map(\.app))
    aims = aims.filter { held.contains($0.key) }
    for (key, list) in rings where !held.contains(key) {
      for ring in list { ring.cancel() }
      rings[key] = nil
    }
    render()
  }

  func connectionRestored() {
    if model.connectionRestored() { render() }
  }

  /// The live sessions in the order they opened, each with only the apps it
  /// holds: an app is claimed by its first observe, not by `session.open`.
  static func sessions(
    _ sessions: some Collection<HelperSession>,
    owners: [String: String]
  ) -> [OverlayModel.Session] {
    sessions
      .sorted { ($0.openedAt, $0.sessionId) < ($1.openedAt, $1.sessionId) }
      .map { session in
        OverlayModel.Session(
          id: session.sessionId,
          apps: session.orderedApps
            .filter { owners[key($0)] == session.sessionId }
            .map { OverlayModel.App(key: key($0), name: $0.identity.displayName) }
        )
      }
  }

  /// An observation or an action batch, including its closing observation.
  func workStarted(on app: AppSessionState) {
    guard let holder = holders[ObjectIdentifier(app)] else { return }
    workStarted(holder)
  }

  func workEnded(on app: AppSessionState) {
    guard let holder = holders[ObjectIdentifier(app)] else { return }
    workEnded(holder)
  }

  func workStarted(_ holder: OverlayModel.Holder) {
    model.workStarted(holder)
    render()
  }

  func workEnded(_ holder: OverlayModel.Holder) {
    model.workEnded(holder, at: Date())
    render()
  }

  /// Input is about to land at a screen point inside `window` — the
  /// frontmost of the app's windows under that point, which is the one the
  /// input is stamped with. Nothing moves to it: a click there draws its
  /// ring, and nothing else does.
  func aim(
    in app: AppSessionState, at point: CGPoint, window: CGWindowID, keyWindow: CGWindowID
  ) {
    let key = Self.key(app)
    aims[key] = (point, window)
    bind(app: key, window: keyWindow)
  }

  func show(_ feedback: OverlayFeedback, in app: AppSessionState) {
    guard OverlayStyle.showsClickRing, feedback == .click, drawsWindows else { return }
    let key = Self.key(app)
    guard model.shownApps.contains(key), let aim = aims[key],
      let window = WindowSnapshot.read([aim.window]).window(aim.window), window.onScreen
    else { return }
    let ring = ClickRing(center: aim.point)
    rings[key, default: []].append(ring)
    ring.show(above: window, reduced: OverlayMotion.reduced) { [weak self, weak ring] in
      self?.rings[key]?.removeAll { $0 === ring }
    }
  }

  func bound(_ app: AppSessionState, windowID: CGWindowID) {
    bind(app: Self.key(app), window: windowID)
  }

  func captured(_: Observation, in app: AppSessionState, keyWindow: CGWindowID?) {
    guard let keyWindow else { return }
    bind(app: Self.key(app), window: keyWindow)
  }

  /// The window the agents in an app work in.
  func bind(app key: String, window: CGWindowID) {
    guard keyWindows[key] != window else { return }
    keyWindows[key] = window
    render()
  }

  /// One of the watched apps' windows moved, resized, closed or changed
  /// focus.
  func windowsChanged() {
    tracker.windowEvent()
  }

  private func workspaceChanged(_ event: WorkspaceEvent) {
    guard event == .motionPreferenceChanged else { return }
    for chip in chips.values { chip.motionChanged() }
  }

  // MARK: - Drawing

  private func render() {
    guard drawsWindows else { return }
    let now = Date()
    let presentation = model.presentation(at: now)
    // A chip leaves at once when its app is released: it must never remain
    // over a window another task owns.
    for (key, chip) in chips where presentation.chips[key] == nil || keyWindows[key] == nil {
      chip.hide()
    }
    let shown = presentation.chips.compactMap { key, state in
      keyWindows[key].map { (key, state, $0) }
    }
    if !shown.isEmpty {
      let snapshot = WindowSnapshot.read(shown.map(\.2))
      for (key, state, window) in shown {
        let chip = chips[key] ?? makeChip(key)
        chip.show(state, on: window, in: snapshot)
      }
    }
    updateTracking()
    schedule(model.nextChange(after: now))
  }

  private func makeChip(_ key: String) -> WindowChip {
    let chip = WindowChip()
    chip.onAction = { [weak self] in self?.press(app: key) }
    chips[key] = chip
    return chip
  }

  /// The person pressed the chip of the app `key`: `Stop` on an agents'
  /// chip; on an amber one, dismissing its notice.
  func press(app key: String) {
    if case .connectionLost = model.presentation(at: Date()).chips[key]?.look {
      if model.dismiss(app: key) { render() }
      return
    }
    onStop(key)
  }

  private func updateTracking() {
    tracker.isActive = chips.values.contains { $0.isWanted }
    tracker.isDrawing = chips.values.contains { $0.isDrawn }
  }

  /// Follows every window a chip is on, from one read of the window server.
  /// Returns whether any of them moved.
  private func placeOverWindows(_ ordering: WindowOrdering) -> Bool {
    let ids = chips.values.compactMap(\.trackedWindowID)
    guard !ids.isEmpty else { return false }
    let snapshot = WindowSnapshot.read(ids)
    var moved = false
    for chip in chips.values where chip.place(in: snapshot, ordering) { moved = true }
    updateTracking()
    return moved
  }

  private func schedule(_ date: Date?) {
    timer?.invalidate()
    timer = nil
    guard let date else { return }
    let timer = Timer(fire: date, interval: 0, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.render() }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  private static func key(_ app: AppSessionState) -> String {
    app.identity.bundleId.lowercased()
  }
}
