import CoreGraphics
import Foundation

/// Everything the person sees on this Mac, worked out without AppKit.
///
/// The runtime reports what happens (sessions opening and closing, work
/// starting and ending, text being typed, the pointer moving) and the windows
/// draw `presentation(at:)`. Time is always passed in,
/// so every state, the timed ones included, is a plain value a test can check.
///
/// A held app keeps its window outlined. Work in flight (and the short hold
/// after it) lights the outline's moving accent and the pointer's steady glow;
/// between calls the border stays and the pointer breathes.
///
/// The pointer appears at its first target and stays for as long as a session
/// holds the app; releasing the app removes it at once.
///
/// The pill is expanded until the person minimizes it, and stays minimized for
/// the helper's lifetime. A new task or app shows the full status for a moment
/// even then, but never under the person's pointer, and never ends while the
/// pointer is over the pill.
struct OverlayModel {
  /// How long an app still counts as in use after its work ends. Back-to-back
  /// calls, or two Runs taking turns on the serial executor, read as one
  /// stretch of work instead of a flicker between working and thinking.
  static let holdAfterWork: TimeInterval = 0.3
  /// `Computer use stopped` and `Computer use ended` stay this long.
  static let noticeDuration: TimeInterval = 2
  /// The pointer materializes at its first point in this long; input waits
  /// for it.
  static let appearDuration: TimeInterval = 0.16
  /// Under Reduce Motion the pointer never travels: it fades out where it was
  /// and in where it goes.
  static let crossfadeDuration: TimeInterval = 0.12
  static let shortestTravel: TimeInterval = 0.12
  static let longestTravel: TimeInterval = 0.34
  /// How long a minimized pill shows a new task or app in full.
  static let revealDuration: TimeInterval = 3
  /// How long a reveal the pointer held stays after the pointer leaves.
  static let revealAfterPointer: TimeInterval = 1

  struct App: Equatable {
    /// The lowercased bundle id, the key the session registry uses.
    let key: String
    let name: String
    let access: AppAccess
    /// The app bundle, whose icon the pill draws.
    let path: String
  }

  /// One live session and the apps it holds. An app a session was opened with
  /// but has not observed yet is not held, so it has no pointer and is not
  /// named.
  struct Session: Equatable {
    let id: String
    let threadTitle: String?
    let apps: [App]
    var ownerInput = false
  }

  /// Why the sessions that just went away ended.
  enum Ending: Equatable {
    /// Closed by the Host, the idle sweep or the app quitting.
    case ended
    /// The person pressed `Stop`.
    case stopped
    /// The connection that opened them dropped.
    case connectionLost
  }

  enum Activity: Equatable {
    /// Work in flight, or just finished.
    case working
    /// Sessions hold apps, and nothing is in flight.
    case thinking
  }

  struct Presentation: Equatable {
    var pill: Pill?
    /// The pointer in every held app it has pointed into, keyed by app.
    var cursors: [String: Cursor]
    /// The apps whose key window is outlined: all apps held by sessions.
    var outlined: Set<String>
    /// The apps whose outline carries the traveling accent.
    var sweeping: Set<String>
  }

  struct Cursor: Equatable {
    /// The tip, in CoreGraphics screen coordinates, where it last went.
    let point: CGPoint
    let activity: Activity
  }

  struct Pill: Equatable {
    enum Controls: Equatable {
      case session
      case dismiss
      case none
    }

    /// What sits on the front app's icon.
    enum Badge: Equatable {
      /// The agent's pointer: it can act in the app.
      case pointer
      /// The agent can only see the app.
      case eye
    }

    struct Icon: Equatable {
      let key: String
      let path: String
    }

    let status: String
    /// Short wording that still names the front app, for the minimized
    /// pill's hover label.
    let compactStatus: String
    let detail: String?
    let controls: Controls
    /// The apps drawn, front first, at most two. None draws the Opensteer
    /// mark.
    let icons: [Icon]
    /// None on a notice: the agent has let go.
    let badge: Badge?
    let activity: Activity
    /// The status and detail show; otherwise only the app and `Stop`.
    let expanded: Bool
  }

  struct PointerMove: Equatable {
    enum Kind: Equatable {
      /// Not showing yet: it materializes at `to`.
      case appear
      /// Travels from `from` to `to`.
      case travel
      /// Reduce Motion: fades out at `from` and in at `to`.
      case crossfade
    }

    let kind: Kind
    let from: CGPoint?
    let to: CGPoint
    /// How long input waits for the pointer to arrive.
    let duration: TimeInterval
  }

  private enum Notice: Equatable {
    /// `Stop` ended every session, and work already under way has not
    /// returned yet.
    case stopping
    case stopped(until: Date)
    case ended(until: Date)
    case connectionLost
  }

  private(set) var sessions: [Session] = []
  private var inFlight: [String: Int] = [:]
  private var workStartedAt: [String: Date] = [:]
  private var workEndedAt: [String: Date] = [:]
  private var typing: Set<String> = []
  private var pointers: [String: CGPoint] = [:]
  private var notice: Notice?
  private var noticeTitles: [String] = []
  private var noticeIcons: [Pill.Icon] = []
  /// The person's choice, for the helper's lifetime.
  private var minimized = false
  /// While minimized, until when a new task or app shows in full.
  private var revealUntil: Date?
  private var pointerOverPill = false

  // MARK: - Events

  /// `pointerNear` is whether the pointer is where the expanded pill would
  /// be, read as the update arrives.
  mutating func update(
    sessions next: [Session], ending: Ending, at now: Date, pointerNear: Bool = false
  ) {
    let previous = sessions
    let previousOwners = Dictionary(
      uniqueKeysWithValues: previous.flatMap { session in
        session.apps.map { ($0.key, session.id) }
      })
    let nextOwners = Dictionary(
      uniqueKeysWithValues: next.flatMap { session in
        session.apps.map { ($0.key, session.id) }
      })
    let arrived =
      !Set(next.map(\.id)).isSubset(of: previous.map(\.id))
      || nextOwners.contains { previousOwners[$0.key] != $0.value }
    let endingIcons = Self.icons(frontOrder(at: now))
    sessions = next
    let held = Set(next.flatMap { $0.apps.map(\.key) })
    let sameOwner = Set(held.filter { previousOwners[$0] == nextOwners[$0] })
    // A released app loses its pointer at once: nothing the person sees may
    // outlive the session that drew it.
    pointers = pointers.filter { sameOwner.contains($0.key) }
    workStartedAt = workStartedAt.filter { sameOwner.contains($0.key) }
    workEndedAt = workEndedAt.filter { sameOwner.contains($0.key) }
    typing = typing.intersection(sameOwner)
    // Work already under way may still return before the stopped notice, even
    // if the runtime sends another empty session update in the meantime.
    if !(next.isEmpty && (ending == .stopped || notice == .stopping)) {
      inFlight = inFlight.filter { sameOwner.contains($0.key) }
    }

    // A live session always wins: it is what the person may need to stop.
    guard next.isEmpty else {
      notice = nil
      noticeTitles = []
      noticeIcons = []
      // Expanding under the pointer would move what it is about to click.
      if arrived, minimized, !pointerOverPill, !pointerNear {
        revealUntil = now + Self.revealDuration
      }
      return
    }
    revealUntil = nil
    guard !previous.isEmpty else { return }
    noticeTitles = Self.titles(of: previous)
    noticeIcons = endingIcons
    switch ending {
    case .stopped:
      notice = inFlight.isEmpty ? .stopped(until: now + Self.noticeDuration) : .stopping
    case .ended:
      notice = .ended(until: now + Self.noticeDuration)
    case .connectionLost:
      notice = .connectionLost
    }
  }

  /// An observation or an action batch started on this app.
  mutating func workStarted(app key: String, at now: Date) {
    guard heldApps.contains(where: { $0.key == key }) else { return }
    inFlight[key, default: 0] += 1
    workStartedAt[key] = now
  }

  mutating func workEnded(app key: String, at now: Date) {
    guard let count = inFlight[key] else { return }
    let remaining = count - 1
    inFlight[key] = remaining > 0 ? remaining : nil
    if heldApps.contains(where: { $0.key == key }) { workEndedAt[key] = now }
    if notice == .stopping, inFlight.isEmpty {
      notice = .stopped(until: now + Self.noticeDuration)
    }
  }

  mutating func typingStarted(app key: String) {
    guard inFlight[key] != nil else { return }
    typing.insert(key)
  }

  mutating func typingEnded(app key: String) {
    typing.remove(key)
  }

  /// Where the pointer goes next, and how. Only an app a session holds has a
  /// pointer.
  mutating func movePointer(
    app key: String,
    to point: CGPoint,
    at now: Date,
    reduceMotion: Bool
  ) -> PointerMove? {
    guard heldApps.contains(where: { $0.key == key }) else { return nil }
    let from = pointers[key]
    pointers[key] = point
    guard let from else {
      return PointerMove(
        kind: .appear, from: nil, to: point,
        duration: reduceMotion ? Self.crossfadeDuration : Self.appearDuration)
    }
    if reduceMotion {
      return PointerMove(kind: .crossfade, from: from, to: point, duration: Self.crossfadeDuration)
    }
    return PointerMove(
      kind: .travel, from: from, to: point, duration: Self.travelDuration(from: from, to: point))
  }

  mutating func dismiss() {
    guard notice == .connectionLost else { return }
    notice = nil
    noticeTitles = []
    noticeIcons = []
  }

  /// The person minimized or expanded the pill: whichever it shows, it
  /// becomes the other, and stays so. A notice has no such control.
  mutating func toggleExpanded(at now: Date) {
    guard !sessions.isEmpty else { return }
    minimized = isExpanded(at: now)
    revealUntil = nil
  }

  /// The pointer entered or left the pill.
  mutating func pointerOverPill(_ inside: Bool, at now: Date) {
    guard inside != pointerOverPill else { return }
    pointerOverPill = inside
    if inside {
      // A reveal that already ended stays ended.
      if let until = revealUntil, now >= until { revealUntil = nil }
    } else if let until = revealUntil {
      revealUntil = max(until, now + Self.revealAfterPointer)
    }
  }

  // MARK: - What the windows draw

  func presentation(at now: Date) -> Presentation {
    guard !sessions.isEmpty else {
      return Presentation(pill: noticePill(at: now), cursors: [:], outlined: [], sweeping: [])
    }
    let active = activeApps(at: now)
    let detailSessions =
      active.isEmpty
      ? sessions
      : active.compactMap { app in sessions.first { $0.apps.contains(app) } }
    let ordered = frontOrder(at: now)
    let pill = Pill(
      status: sessions.contains(where: \.ownerInput)
        ? "Remote control of " + Self.list(sessions.filter(\.ownerInput).flatMap(\.apps).map(\.name))
        : Self.status(active: active, held: heldApps, typing: typing),
      compactStatus: sessions.contains(where: \.ownerInput)
        ? "Remote control · " + Self.list(sessions.filter(\.ownerInput).flatMap(\.apps).map(\.name))
        : compactStatus(active: active, front: ordered.first),
      detail: Self.detail(Self.titles(of: detailSessions)),
      controls: .session,
      icons: Self.icons(ordered),
      badge: ordered.first?.access == .read ? .eye : .pointer,
      activity: ordered.first.map { isActive($0.key, at: now) } == true ? .working : .thinking,
      expanded: isExpanded(at: now)
    )
    let activeKeys = Set(active.map(\.key))
    var cursors: [String: Cursor] = [:]
    for app in heldApps {
      guard let point = pointers[app.key] else { continue }
      cursors[app.key] = Cursor(
        point: point, activity: activeKeys.contains(app.key) ? .working : .thinking)
    }
    return Presentation(
      pill: pill, cursors: cursors, outlined: Set(heldApps.map(\.key)), sweeping: activeKeys)
  }

  /// When `presentation(at:)` next changes without another event.
  func nextChange(after now: Date) -> Date? {
    var candidates: [Date] = []
    for (key, ended) in workEndedAt where inFlight[key] == nil {
      candidates.append(ended + Self.holdAfterWork)
    }
    switch notice {
    case .stopped(let until), .ended(let until):
      candidates.append(until)
    case .stopping, .connectionLost, nil:
      break
    }
    if let revealUntil, !pointerOverPill { candidates.append(revealUntil) }
    return candidates.filter { $0 > now }.min()
  }

  // MARK: - Rules

  private var heldApps: [App] {
    sessions.flatMap(\.apps)
  }

  private func isActive(_ key: String, at now: Date) -> Bool {
    if inFlight[key] != nil { return true }
    guard let ended = workEndedAt[key] else { return false }
    return now < ended + Self.holdAfterWork
  }

  /// The apps in use, most recently started first, for the pill's status.
  private func activeApps(at now: Date) -> [App] {
    frontOrder(at: now).filter { isActive($0.key, at: now) }
  }

  /// Every held app, the one the agent is in or was last in first: an app
  /// being typed in, then apps in use, then the rest, each by when its work
  /// last started, ties in the order the sessions report them. The icons,
  /// the badge and the words all follow it.
  private func frontOrder(at now: Date) -> [App] {
    heldApps.enumerated()
      .map { (index: $0.offset, app: $0.element, active: isActive($0.element.key, at: now)) }
      .sorted { left, right in
        let leftTyping = left.active && typing.contains(left.app.key)
        let rightTyping = right.active && typing.contains(right.app.key)
        if leftTyping != rightTyping { return leftTyping }
        if left.active != right.active { return left.active }
        let leftStart = workStartedAt[left.app.key] ?? .distantPast
        let rightStart = workStartedAt[right.app.key] ?? .distantPast
        if leftStart != rightStart { return leftStart > rightStart }
        return left.index < right.index
      }
      .map(\.app)
  }

  private func isExpanded(at now: Date) -> Bool {
    guard minimized else { return true }
    guard let revealUntil else { return false }
    return pointerOverPill || now < revealUntil
  }

  private static func icons(_ ordered: [App]) -> [Pill.Icon] {
    var icons: [Pill.Icon] = []
    for app in ordered where !icons.contains(where: { $0.key == app.key }) {
      icons.append(Pill.Icon(key: app.key, path: app.path))
      if icons.count == 2 { break }
    }
    return icons
  }

  private func noticePill(at now: Date) -> Pill? {
    func saying(_ status: String, controls: Pill.Controls = .none) -> Pill {
      Pill(
        status: status, compactStatus: status, detail: Self.detail(noticeTitles),
        controls: controls, icons: noticeIcons, badge: nil, activity: .thinking, expanded: true)
    }
    switch notice {
    case .stopping:
      return saying("Stopping…")
    case .stopped(let until) where now < until:
      return saying("Computer use stopped")
    case .ended(let until) where now < until:
      return saying("Computer use ended")
    case .connectionLost:
      return saying("Connection lost · last action unconfirmed", controls: .dismiss)
    case .stopped, .ended, nil:
      return nil
    }
  }

  static func status(active: [App], held: [App], typing: Set<String>) -> String {
    guard !active.isEmpty else {
      guard !held.isEmpty else { return "opensteer is waiting for the agent" }
      let verb = held.allSatisfy { $0.access == .read } ? "view" : "use"
      return "opensteer is waiting to \(verb) \(list(held.map(\.name)))"
    }
    if let typed = active.first(where: { typing.contains($0.key) }) {
      return "opensteer is typing in \(typed.name)"
    }
    // `Using` whenever the agent could act in one of them, even while it only
    // looks: the person needs to know control is possible.
    let verb = active.allSatisfy { $0.access == .read } ? "viewing" : "using"
    return "opensteer is \(verb) \(list(active.map(\.name)))"
  }

  private func compactStatus(active: [App], front: App?) -> String {
    guard !active.isEmpty else {
      guard let front else { return "Waiting for agent" }
      return "Waiting · \(Self.compactApps(front.name, count: heldApps.count))"
    }
    if let typed = active.first(where: { typing.contains($0.key) }) {
      return "Typing in \(typed.name)"
    }
    let verb = active.allSatisfy { $0.access == .read } ? "Viewing" : "Using"
    return "\(verb) \(Self.compactApps(active[0].name, count: active.count))"
  }

  private static func compactApps(_ first: String, count: Int) -> String {
    count > 1 ? "\(first) +\(count - 1)" : first
  }

  /// `Notes`, `Notes and Calendar`, `Notes, Calendar and Mail`.
  static func list(_ names: [String]) -> String {
    var unique: [String] = []
    for name in names where !unique.contains(name) { unique.append(name) }
    guard let last = unique.last else { return "" }
    guard unique.count > 1 else { return last }
    return "\(unique.dropLast().joined(separator: ", ")) and \(last)"
  }

  static func titles(of sessions: [Session]) -> [String] {
    var titles: [String] = []
    for session in sessions {
      guard
        let title = session.threadTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
        !title.isEmpty, !titles.contains(title)
      else { continue }
      titles.append(title)
    }
    return titles
  }

  static func detail(_ titles: [String]) -> String? {
    titles.isEmpty ? nil : titles.joined(separator: " · ")
  }

  /// Short hops are quick; longer trips grow logarithmically to stay legible
  /// without making input wait more than 340 ms. Sub-point moves need no travel.
  static func travelDuration(from: CGPoint, to: CGPoint) -> TimeInterval {
    let distance = hypot(to.x - from.x, to.y - from.y)
    guard distance >= 1 else { return 0 }
    let duration = 0.11 + 0.045 * log2(1 + Double(distance) / 32)
    return min(longestTravel, max(shortestTravel, duration))
  }

  /// Minimum-jerk travel accelerates and decelerates evenly, reaching its
  /// exact target at rest instead of spending most of the time settling.
  static func travelProgress(_ time: TimeInterval, duration: TimeInterval) -> Double {
    guard duration > 0 else { return 1 }
    let t = min(1, max(0, time / duration))
    return t * t * t * (10 + t * (-15 + 6 * t))
  }
}

/// The corner of the active screen the pill sits in. The person picks it by
/// dragging; it is kept for the process's lifetime.
enum PillCorner: Equatable, CaseIterable {
  case topRight
  case topLeft
  case bottomRight
  case bottomLeft

  static let margin: CGFloat = 12

  var isTop: Bool { self == .topRight || self == .topLeft }
  var isRight: Bool { self == .topRight || self == .bottomRight }

  /// In AppKit coordinates, where y grows upwards.
  func frame(size: CGSize, in visible: CGRect) -> CGRect {
    let left = visible.minX + Self.margin
    let right = visible.maxX - Self.margin - size.width
    let bottom = visible.minY + Self.margin
    let top = visible.maxY - Self.margin - size.height
    switch self {
    case .topRight: return CGRect(x: right, y: top, width: size.width, height: size.height)
    case .topLeft: return CGRect(x: left, y: top, width: size.width, height: size.height)
    case .bottomRight: return CGRect(x: right, y: bottom, width: size.width, height: size.height)
    case .bottomLeft: return CGRect(x: left, y: bottom, width: size.width, height: size.height)
    }
  }

  /// The corner a pill dropped with its centre at `center` belongs to.
  static func nearest(to center: CGPoint, in visible: CGRect) -> PillCorner {
    let isRight = center.x >= visible.midX
    let isTop = center.y >= visible.midY
    switch (isTop, isRight) {
    case (true, true): return .topRight
    case (true, false): return .topLeft
    case (false, true): return .bottomRight
    case (false, false): return .bottomLeft
    }
  }
}
