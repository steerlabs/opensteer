import Foundation

/// Everything the person sees on this Mac, worked out without AppKit.
///
/// The runtime reports what happens (sessions opening and closing, work
/// starting and ending, a connection dropping) and the windows draw
/// `presentation(at:)`. Time is always passed in, so every state, the timed
/// ones included, is a plain value a test can check.
///
/// What it draws is one chip per held app, on the window the agents work in:
/// a dot per agent session holding the app, breathing while that agent's work
/// is in flight (or in its short hold), still between calls. A connection
/// that dropped with an action under way leaves that app's chip amber until
/// the connection is back or the person dismisses it. The person's own
/// viewing and typing through Opensteer is never shown here.
struct OverlayModel {
  /// How long an agent still counts as working after its work ends.
  /// Back-to-back calls, or two Runs taking turns on the serial executor,
  /// read as one stretch of work instead of a flicker.
  static let holdAfterWork: TimeInterval = 0.3
  /// A chip shows this many dots, then a count.
  static let maxDots = 3
  /// What the amber chip says when the person points at it.
  static let connectionLostSentence = "Connection lost · last action unconfirmed"

  struct App: Equatable {
    /// The lowercased bundle id, the key the session registry uses.
    let key: String
    /// For the chip's accessibility name; never drawn.
    let name: String
  }

  /// One live agent session and the apps it holds. An app a session was
  /// opened with but has not observed yet is not held.
  struct Session: Equatable {
    let id: String
    let apps: [App]
  }

  /// One session's hold on one app: what a dot stands for.
  struct Holder: Hashable {
    let session: String
    let app: String
  }

  /// Why the sessions that just went away ended.
  enum Ending: Equatable {
    /// Closed by the Host, the idle sweep, the app quitting or the person's
    /// `Stop`.
    case ended
    /// The connection that opened them dropped. An action under way in one of
    /// them may or may not have happened.
    case connectionLost
  }

  enum Activity: Equatable {
    /// Work in flight, or just finished: the dot breathes.
    case working
    /// Held, nothing in flight: the dot is still.
    case still
  }

  struct Chip: Equatable {
    enum Look: Equatable {
      /// The first `maxDots` agents, then how many more.
      case agents(dots: [Activity], more: Int)
      /// The connection dropped with an action under way here.
      case connectionLost
    }

    /// The app, for the chip's accessibility name.
    let app: App
    let look: Look
  }

  struct Presentation: Equatable {
    /// Keyed by app.
    var chips: [String: Chip]
  }

  private(set) var sessions: [Session] = []
  private var inFlight: [Holder: Int] = [:]
  private var workEndedAt: [Holder: Date] = [:]
  /// Apps whose last action is unconfirmed, until the connection is back or
  /// the person dismisses them.
  private var notices: [String: App] = [:]

  static func holders(_ sessions: [Session]) -> [Holder] {
    sessions.flatMap { session in session.apps.map { Holder(session: session.id, app: $0.key) } }
  }

  // MARK: - Events

  mutating func update(sessions next: [Session], ending: Ending, at now: Date) {
    let previous = sessions
    let nextHolders = Set(Self.holders(next))
    // Only an action still under way when its session went away can have an
    // outcome no one confirmed; a dropped connection with nothing in flight
    // lost nothing.
    let unconfirmed = inFlight.keys.filter { !nextHolders.contains($0) }
    let arrived = !Set(next.map(\.id)).isSubset(of: Set(previous.map(\.id)))
    sessions = next
    inFlight = inFlight.filter { nextHolders.contains($0.key) }
    workEndedAt = workEndedAt.filter { nextHolders.contains($0.key) }
    // An agent connection back with a live session is the connection back.
    if arrived { notices = [:] }
    if ending == .connectionLost {
      let apps = previous.flatMap(\.apps)
      for holder in unconfirmed {
        if let app = apps.first(where: { $0.key == holder.app }) { notices[app.key] = app }
      }
    }
    // A held app shows its agents: the live session is what the person may
    // need to stop.
    for app in next.flatMap(\.apps) { notices[app.key] = nil }
  }

  /// An observation or an action batch started for this session in this app.
  mutating func workStarted(_ holder: Holder) {
    guard Self.holders(sessions).contains(holder) else { return }
    inFlight[holder, default: 0] += 1
  }

  mutating func workEnded(_ holder: Holder, at now: Date) {
    guard let count = inFlight[holder] else { return }
    inFlight[holder] = count > 1 ? count - 1 : nil
    workEndedAt[holder] = now
  }

  /// The person clicked an amber chip. Returns whether it changed anything.
  mutating func dismiss(app key: String) -> Bool {
    notices.removeValue(forKey: key) != nil
  }

  /// The person's viewer reached this Mac again.
  mutating func connectionRestored() -> Bool {
    guard !notices.isEmpty else { return false }
    notices = [:]
    return true
  }

  // MARK: - What the windows draw

  func presentation(at now: Date) -> Presentation {
    var dots: [String: [Activity]] = [:]
    var apps: [String: App] = [:]
    for session in sessions {
      for app in session.apps {
        apps[app.key] = app
        let holder = Holder(session: session.id, app: app.key)
        dots[app.key, default: []].append(isWorking(holder, at: now) ? .working : .still)
      }
    }
    var chips: [String: Chip] = [:]
    for (key, all) in dots {
      guard let app = apps[key] else { continue }
      chips[key] = Chip(
        app: app,
        look: .agents(
          dots: Array(all.prefix(Self.maxDots)), more: max(0, all.count - Self.maxDots)))
    }
    for (key, app) in notices where chips[key] == nil {
      chips[key] = Chip(app: app, look: .connectionLost)
    }
    return Presentation(chips: chips)
  }

  /// The apps whose chip sits on a window that the controller must remember.
  var shownApps: Set<String> {
    Set(sessions.flatMap(\.apps).map(\.key)).union(notices.keys)
  }

  /// When `presentation(at:)` next changes without another event.
  func nextChange(after now: Date) -> Date? {
    workEndedAt
      .filter { inFlight[$0.key] == nil }
      .map { $0.value + Self.holdAfterWork }
      .filter { $0 > now }
      .min()
  }

  private func isWorking(_ holder: Holder, at now: Date) -> Bool {
    if inFlight[holder] != nil { return true }
    guard let ended = workEndedAt[holder] else { return false }
    return now < ended + Self.holdAfterWork
  }
}
