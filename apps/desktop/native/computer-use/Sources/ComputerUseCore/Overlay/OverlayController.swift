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

/// Everything the person sees on this Mac: the pill, and in each held app
/// the agent's pointer and the outline of its window. `OverlayModel` decides
/// what shows; this draws it, keeps the clock
/// that moves the timed states along, and keeps what is drawn over an app's
/// windows following those windows.
@MainActor
public final class OverlayController: ActionFeedback {
  private var model = OverlayModel()
  private let onStop: @MainActor () -> Void
  private(set) var pill: PillWindow?
  private var cursors: [String: AgentCursor] = [:]
  private var outlines: [String: WorkingOutline] = [:]
  /// Each app's key window, as its latest observation or action found it.
  private var keyWindows: [String: CGWindowID] = [:]
  private var appInstances: [String: ObjectIdentifier] = [:]
  private var timer: Timer?
  private let tracker = WindowTracker()

  public init(onStop: @escaping @MainActor () -> Void) {
    self.onStop = onStop
    tracker.refresh = { [weak self] ordering in self?.placeOverWindows(ordering) ?? false }
    tracker.onWorkspaceEvent = { [weak self] event in self?.workspaceChanged(event) }
  }

  // MARK: - What the runtime reports

  /// After a session opens, changes, claims an app or closes. `ending` says
  /// why the sessions that are no longer listed went away.
  func update(
    sessions: some Collection<HelperSession>,
    owners: [String: String],
    ending: OverlayModel.Ending,
    ownerInput: [OverlayModel.Session] = []
  ) {
    let controlled = Set(ownerInput.flatMap(\.apps).map(\.key))
    let next = Self.sessions(sessions, owners: owners).map {
      OverlayModel.Session(id: $0.id, threadTitle: $0.threadTitle, apps: $0.apps.filter { !controlled.contains($0.key) })
    } + ownerInput
    let previousOwners = OverlayModel.owners(model.sessions)
    let nextOwners = OverlayModel.owners(next)
    let nextInstances = Dictionary(
      uniqueKeysWithValues: sessions.flatMap { session in
        session.orderedApps.compactMap { app in
          let key = Self.key(app)
          return owners[key] == session.sessionId ? (key, ObjectIdentifier(app)) : nil
        }
      })
    keyWindows = keyWindows.filter {
      nextOwners[$0.key] != nil && previousOwners[$0.key] == nextOwners[$0.key]
        && appInstances[$0.key] == nextInstances[$0.key]
    }
    appInstances = nextInstances
    model.update(
      sessions: next, ending: ending, at: Date(), pointerNear: pill?.pointerIsNear() ?? false)
    render()
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
          threadTitle: session.threadTitle,
          apps: session.orderedApps
            .filter { owners[key($0)] == session.sessionId }
            .map {
              OverlayModel.App(
                key: key($0), name: $0.identity.displayName,
                access: session.access[key($0)] ?? .read, path: $0.path)
            }
        )
      }
  }

  /// An observation or an action batch, including its closing observation.
  func workStarted(on app: AppSessionState) {
    model.workStarted(app: Self.key(app), at: Date())
    render()
  }

  func workEnded(on app: AppSessionState) {
    model.workEnded(app: Self.key(app), at: Date())
    render()
  }

  func typingStarted(in app: AppSessionState) {
    model.typingStarted(app: Self.key(app))
    render()
  }

  func typingEnded(in app: AppSessionState) {
    model.typingEnded(app: Self.key(app))
    render()
  }

  /// Sends the pointer to a screen point inside `window` — the frontmost of
  /// the app's windows under that point, which is the one the input is
  /// stamped with — and returns once it has arrived, so input is never posted
  /// ahead of what the person sees.
  func movePointer(
    in app: AppSessionState, toScreenPoint point: CGPoint, window: CGWindowID,
    keyWindow: CGWindowID
  ) async {
    let key = Self.key(app)
    keyWindows[key] = keyWindow
    guard
      let move = model.movePointer(
        app: key, to: point, at: Date(), reduceMotion: OverlayMotion.reduced)
    else { return }
    let cursor = cursors[key] ?? AgentCursor()
    cursors[key] = cursor
    let wait = cursor.move(
      move, window: window, keyWindow: keyWindow,
      in: WindowSnapshot.read([window, keyWindow]))
    render()
    guard wait > 0 else { return }
    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
  }

  func show(_ feedback: OverlayFeedback, in app: AppSessionState) {
    // The badge shows the work even where no pointer is drawn: a window on
    // another Space.
    pill?.mirror(feedback, app: Self.key(app))
    guard let cursor = cursors[Self.key(app)] else { return }
    switch feedback {
    case .click: cursor.click()
    case .pulse: cursor.pulse()
    case .scroll(let direction): cursor.scrolled(direction)
    }
  }

  func bound(_ app: AppSessionState, windowID: CGWindowID) {
    keyWindows[app.key] = windowID
    cursors[app.key]?.bind(windowID, in: WindowSnapshot.read([windowID]))
    render()
    windowsChanged()
  }

  func captured(_: Observation, in app: AppSessionState, keyWindow: CGWindowID?) {
    let key = Self.key(app)
    if let keyWindow {
      keyWindows[key] = keyWindow
      cursors[key]?.bind(keyWindow, in: WindowSnapshot.read([keyWindow]))
    }
    render()
  }

  /// One of the watched apps' windows moved, resized, closed or changed
  /// focus.
  func windowsChanged() {
    tracker.windowEvent()
  }

  /// The pill keeps to the screen the person is working on, and every
  /// surface takes up a new Reduce Motion setting as it changes.
  private func workspaceChanged(_ event: WorkspaceEvent) {
    switch event {
    case .activated, .spaceChanged, .screensChanged:
      pill?.follow()
    case .motionPreferenceChanged:
      for cursor in cursors.values { cursor.motionChanged() }
      for outline in outlines.values { outline.motionChanged() }
      pill?.motionChanged()
    case .deactivated, .hidden, .unhidden, .terminated:
      break
    }
  }

  // MARK: - Drawing

  private func render() {
    let now = Date()
    let presentation = model.presentation(at: now)
    if let state = presentation.pill {
      pillWindow().show(state)
    } else {
      pill?.hide()
    }
    // A pointer can finish its fade. An outline leaves immediately when its
    // app is released; it must never remain over a window another task owns.
    for (key, cursor) in cursors where presentation.cursors[key] == nil {
      cursor.hide()
    }
    for (key, state) in presentation.cursors {
      cursors[key]?.setActivity(state.activity)
    }
    for (key, outline) in outlines where !presentation.outlined.contains(key) {
      outline.hide()
    }
    let outlined = presentation.outlined.compactMap { key in keyWindows[key].map { (key, $0) } }
    if !outlined.isEmpty {
      let snapshot = WindowSnapshot.read(outlined.map(\.1))
      for (key, window) in outlined {
        let outline = outlines[key] ?? WorkingOutline()
        outlines[key] = outline
        outline.setWorking(presentation.sweeping.contains(key))
        outline.show(window, in: snapshot)
      }
    }
    let held = Set(model.sessions.flatMap { $0.apps.map(\.key) })
    keyWindows = keyWindows.filter { held.contains($0.key) }
    updateTracking()
    schedule(model.nextChange(after: now))
  }

  private func updateTracking() {
    tracker.isActive =
      cursors.values.contains { $0.isWanted } || outlines.values.contains { $0.isWanted }
    tracker.isDrawing =
      cursors.values.contains { $0.isDrawn } || outlines.values.contains { $0.isDrawn }
  }

  /// Follows every app window something is drawn over, from one read of the
  /// window server. Returns whether any of them moved.
  private func placeOverWindows(_ ordering: WindowOrdering) -> Bool {
    let ids =
      outlines.values.compactMap(\.trackedWindowID) + cursors.values.flatMap(\.trackedWindowIDs)
    guard !ids.isEmpty else { return false }
    let snapshot = WindowSnapshot.read(ids)
    var moved = false
    for outline in outlines.values {
      let before = outline.window?.frame
      outline.place(in: snapshot, ordering)
      if outline.window?.frame != before { moved = true }
    }
    for cursor in cursors.values {
      let before = cursor.anchor?.frame
      cursor.place(in: snapshot, ordering)
      if cursor.anchor?.frame != before { moved = true }
    }
    updateTracking()
    return moved
  }

  private func pillWindow() -> PillWindow {
    if let pill { return pill }
    let created = PillWindow(
      onStop: { [weak self] in self?.onStop() },
      onDismiss: { [weak self] in
        self?.model.dismiss()
        self?.render()
      },
      onToggle: { [weak self] in
        self?.model.toggleExpanded(at: Date())
        self?.render()
      },
      onPointer: { [weak self] inside in
        self?.model.pointerOverPill(inside, at: Date())
        self?.render()
      }
    )
    pill = created
    return created
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
