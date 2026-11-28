import Foundation

/// Everything the person sees on this Mac, worked out without AppKit.
///
/// The runtime reports what happens (sessions opening and closing, work
/// starting and ending, a connection dropping) and the windows draw
/// `presentation(at:)`. Time is always passed in, so every state, the timed
/// ones included, is a plain value a test can check.
///
/// What it draws is one chip per held app, on the window the agent works in:
/// one dot, breathing while the agent's work is in flight (or in its short
/// hold), still between calls. The session registry admits one holder per
/// app, so a window never has more than one agent. A connection that dropped
/// with an action under way leaves that app's chip amber until that app is
/// reached again or the person dismisses it. The person's own viewing and
/// typing through Opensteer is never shown here.
struct OverlayModel {
  /// How long an agent still counts as working after its work ends.
  /// Back-to-back calls, or two Runs taking turns on the serial executor,
  /// read as one stretch of work instead of a flicker.
  static let holdAfterWork: TimeInterval = 0.3
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

  /// One session's hold on one app.
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
      /// The agent holding the app.
      case agent(Activity)
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
  /// Apps whose last action is unconfirmed, until that app is reached again
  /// or the person dismisses them.
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
    sessions = next
    inFlight = inFlight.filter { nextHolders.contains($0.key) }
    workEndedAt = workEndedAt.filter { nextHolders.contains($0.key) }
    if ending == .connectionLost {
      let apps = previous.flatMap(\.apps)
      for holder in unconfirmed {
        if let app = apps.first(where: { $0.key == holder.app }) { notices[app.key] = app }
      }
    }
    // A held app shows its agent: the live session is what the person may
    // need to stop. Sessions in other apps leave the notice alone.
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

  /// The person dismissed an amber chip, or reached its app again through
  /// Opensteer. Returns whether there was a notice to clear: a second
  /// dismissal changes nothing.
  mutating func clearNotice(app key: String) -> Bool {
    notices.removeValue(forKey: key) != nil
  }

  // MARK: - What the windows draw

  func presentation(at now: Date) -> Presentation {
    var chips: [String: Chip] = [:]
    for session in sessions {
      for app in session.apps {
        let working = isWorking(Holder(session: session.id, app: app.key), at: now)
        if case .agent(.working) = chips[app.key]?.look { continue }
        chips[app.key] = Chip(app: app, look: .agent(working ? .working : .still))
      }
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
