import CoreGraphics
import Foundation

/// The person's keys reach their app in the order they typed them.
///
/// A key on its way to an app the person did not choose (the target while it
/// is prepared, or an app that took the keyboard) is sent on to the person's
/// app. That takes a longer path than the person's next key, which their app
/// receives directly, so the next key could land first: "0014" arrived as "14"
/// then "00" (Chrome journey R0, VM job 20261028T160412Z-d8bed7a4). So the
/// person's app is watched before anything can be sent on, and while a key sent
/// on has not reached it, their own keys are sent on behind it through the
/// same path. That delays nothing, and nothing is held back or dropped.
final class PersonKeyOrder: @unchecked Sendable {
  static let shared = PersonKeyOrder()
  /// Known limit: a key sent on and not delivered within this counts as lost,
  /// so the person's keys stop following it.
  static let lost: TimeInterval = 1

  typealias Post = (pid_t, CGEvent) -> Void
  /// Watches keys on their way to one process; returns how to stop watching.
  typealias Install = (pid_t, @escaping (CGEvent) -> CGEvent?) -> (() -> Void)?
  typealias Schedule = (TimeInterval, @escaping @Sendable () -> Void) -> Void

  /// One key event, as it keeps its timestamp when sent on.
  private struct Key: Hashable {
    let timestamp: UInt64
    let type: UInt32
    let keyCode: Int64

    init(_ event: CGEvent) {
      timestamp = event.timestamp
      type = event.type.rawValue
      keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    }
  }

  private struct Person {
    let stop: () -> Void
    var holds = 0
    /// Keys sent on that have not reached the person's app yet, with when.
    var pending: [Key: TimeInterval] = [:]
  }

  private let post: Post?
  private let install: Install
  private let schedule: Schedule
  private let now: () -> TimeInterval
  private let lock = NSLock()
  private var people: [pid_t: Person] = [:]

  init(
    post: Post? = PrivateAPI.postToPid.map { postToPid in { pid, event in postToPid(pid, event) } },
    install: @escaping Install = PersonKeyOrder.tap,
    schedule: @escaping Schedule = { delay, body in
      DispatchQueue.global(qos: .userInteractive).asyncAfter(deadline: .now() + delay, execute: body)
    },
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.post = post
    self.install = install
    self.schedule = schedule
    self.now = now
  }

  /// Watches the person's app before any key can be sent on to it. False when
  /// it cannot be watched: their keys would not stay in order.
  func hold(_ pid: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if people[pid] == nil {
      guard post != nil,
        let stop = install(pid, { [weak self] event in
          // nil from `arriving` drops a key sent on behind the others; only a
          // missing order passes the key untouched.
          guard let self else { return event }
          return self.arriving(event, at: pid)
        })
      else { return false }
      people[pid] = Person(stop: stop)
    }
    people[pid]!.holds += 1
    return true
  }

  /// Ends one hold; the watch stops once none is left and every key sent on
  /// has arrived.
  func release(_ pid: pid_t) {
    lock.lock()
    if people[pid] != nil { people[pid]!.holds = max(0, people[pid]!.holds - 1) }
    lock.unlock()
    retire(pid)
  }

  /// Sends a key on to the person's app, behind any already on the way. False
  /// when keys cannot be addressed to one process; nothing is sent.
  func sendOn(_ event: CGEvent, to pid: pid_t) -> Bool {
    guard let post else { return false }
    lock.lock()
    if people[pid] != nil { people[pid]!.pending[Key(event)] = now() }
    post(pid, event)
    lock.unlock()
    return true
  }

  /// A key reaching the person's app: one sent on, or one they typed.
  private func arriving(_ event: CGEvent, at pid: pid_t) -> CGEvent? {
    lock.lock()
    defer { lock.unlock() }
    guard var person = people[pid] else { return event }
    let time = now()
    person.pending = person.pending.filter { time - $0.value < Self.lost }
    defer { people[pid] = person }
    if person.pending.removeValue(forKey: Key(event)) != nil
      || pid_t(truncatingIfNeeded: event.getIntegerValueField(FocusEvents.sourcePIDField)) == getpid()
    {
      if person.pending.isEmpty, person.holds == 0 {
        schedule(0) { [weak self] in self?.retire(pid) }
      }
      return event
    }
    // One they typed while a key sent on is still on its way: it goes the same
    // way, behind it.
    guard !person.pending.isEmpty, let post else { return event }
    person.pending[Key(event)] = time
    post(pid, event)
    return nil
  }

  /// Stops watching once nothing holds the watch and nothing is on the way.
  private func retire(_ pid: pid_t) {
    lock.lock()
    guard let person = people[pid], person.holds == 0 else {
      lock.unlock()
      return
    }
    let time = now()
    // Only keys not yet lost keep the watch; a newer one on its way does.
    let live = person.pending.filter { time - $0.value < Self.lost }
    people[pid]?.pending = live
    if let oldest = live.values.min() {
      lock.unlock()
      schedule(Self.lost - (time - oldest)) { [weak self] in self?.retire(pid) }
      return
    }
    people[pid] = nil
    lock.unlock()
    person.stop()
  }

  private static func tap(_ pid: pid_t, _ handler: @escaping (CGEvent) -> CGEvent?) -> (() -> Void)? {
    guard
      let tap = EventTap(
        .process(pid), place: .headInsertEventTap, options: .defaultTap,
        types: FocusStealPreventer.keyboardTypes, handler: { _, event in handler(event) })
    else { return nil }
    return { tap.stop() }
  }
}
