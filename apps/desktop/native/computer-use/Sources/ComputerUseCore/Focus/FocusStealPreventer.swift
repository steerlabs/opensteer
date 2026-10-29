// Tracks key-focus notifications and attempts to return keyboard ownership
// to the person's app while registered targets receive agent input.
// The private notification protocol has no verified public source here.
import AppKit
import CoreGraphics
import Darwin
import Foundation

/// While an agent works in apps on this Mac, none of them may take the keyboard
/// from the app the person is using.
///
/// An app that believes it is active can open a menu or a remote view that
/// claims the keyboard without ever coming to the front. The window server
/// announces each claim with a process notification: one session-wide tap
/// reads them, drops the "your key focus was taken" notice before the
/// person's app sees it, releases the theft by the id the window server gave
/// it, and sends every key the person types meanwhile back to their own app.
final class FocusStealPreventer: @unchecked Sendable {
  /// What one app the agent works in registered; stopping it unregisters.
  final class Registration: @unchecked Sendable {
    fileprivate let pid: pid_t
    private let stopped = Locked(false)

    fileprivate init(pid: pid_t) { self.pid = pid }

    func stop() {
      guard !stopped.withLock({ was in defer { was = true }; return was }) else { return }
      FocusStealPreventer.unregister(self)
    }
  }

  /// Who holds the keyboard: an app, or a view service hosted by one.
  enum Focus: Equatable {
    case app(pid_t)
    case viewService(host: pid_t)

    var owner: pid_t {
      switch self {
      case .app(let pid): return pid
      case .viewService(let host): return host
      }
    }
  }

  private struct Target {
    let registration: Registration
    let lost: @Sendable () -> Void
    let gained: @Sendable () -> Void
    let keyboard: EventTap
  }

  /// A theft being undone: the thief keeps nothing the person types.
  private struct Suppression {
    let thief: pid_t
    let thiefOwner: pid_t
    let victim: pid_t
    var released = false
    var suppressedReturn = false
  }

  private static let lock = NSLock()
  private nonisolated(unsafe) static var shared: FocusStealPreventer?

  private let lock = NSLock()
  private var targets: [Target] = []
  private var current: Focus
  private var suppression: Suppression? {
    didSet {
      guard oldValue?.victim != suppression?.victim else { return }
      if let held = heldVictim { PersonKeyOrder.shared.release(held) }
      heldVictim = nil
      // Watched before any key can be sent on to it, so the person's keys stay
      // in order; without the watch they are still kept from the thief.
      guard let victim = suppression?.victim else { return }
      if PersonKeyOrder.shared.hold(victim) {
        heldVictim = victim
      } else {
        Log.focus.error("The person's keys are not kept in order during this theft: no watch on \(victim).")
      }
    }
  }
  private var heldVictim: pid_t?
  private var notifications: EventTap?
  /// ViewBridge's shared helper: every key focus change is announced to it.
  private let viewBridge: pid_t?

  /// Nil when macOS refuses the taps; the caller then sends no input.
  static func register(
    _ pid: pid_t, lost: @escaping @Sendable () -> Void, gained: @escaping @Sendable () -> Void
  ) -> Registration? {
    lock.lock()
    defer { lock.unlock() }
    guard let preventer = shared ?? FocusStealPreventer() else { return nil }
    let registration = Registration(pid: pid)
    guard
      let keyboard = EventTap(
        .process(pid), place: .tailAppendEventTap, options: .defaultTap,
        types: keyboardTypes,
        handler: { [weak preventer] _, event in
          guard let preventer else { return event }
          return preventer.keyboard(event)
        })
    else {
      if shared == nil { preventer.shutDown() }
      return nil
    }
    shared = preventer
    preventer.lock.lock()
    preventer.targets.append(
      Target(registration: registration, lost: lost, gained: gained, keyboard: keyboard))
    preventer.lock.unlock()
    return registration
  }

  private static func unregister(_ registration: Registration) {
    lock.lock()
    defer { lock.unlock() }
    guard let preventer = shared else { return }
    preventer.lock.lock()
    let removed = preventer.targets.filter { $0.registration === registration }
    preventer.targets.removeAll { $0.registration === registration }
    let empty = preventer.targets.isEmpty
    preventer.lock.unlock()
    for target in removed { target.keyboard.stop() }
    if empty {
      preventer.shutDown()
      shared = nil
    }
  }

  static let keyboardTypes: [UInt32] = [
    CGEventType.keyDown.rawValue, CGEventType.keyUp.rawValue, CGEventType.flagsChanged.rawValue,
  ]

  private init?() {
    current = .app(
      PrivateAPI.focusPID(front: false)
        ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
    viewBridge = Self.processIdentifier(named: "ViewBridgeAuxiliary")
    guard
      let notifications = EventTap(
        .session, place: .tailAppendEventTap, options: .defaultTap,
        types: [FocusEvents.processNotification],
        handler: { [weak self] _, event in
          guard let self else { return event }
          return self.notification(event)
        })
    else { return nil }
    self.notifications = notifications
  }

  private func shutDown() {
    notifications?.stop()
    // Ends any theft undo, releasing its watch on the person's app.
    lock.lock()
    suppression = nil
    lock.unlock()
  }

  // MARK: - Tap handlers (the tap thread)

  private func notification(_ event: CGEvent) -> CGEvent? {
    // Values a notification cannot carry make it one this does not handle.
    guard let subtype = UInt16(exactly: event.getIntegerValueField(FocusEvents.notificationSubtypeField)),
      let destination = Self.pid(event, FocusEvents.targetPIDField)
    else { return event }
    lock.lock()
    defer { lock.unlock() }
    switch Int64(subtype) {
    case FocusEvents.keyFocusTaken:
      guard let thief = Self.pid(event, FocusEvents.notificationPIDField) else { return event }
      let taker = classify(thief)
      if registered(taker.owner), current.owner != taker.owner {
        // The person's app never hears its keyboard was taken.
        suppression = Suppression(thief: thief, thiefOwner: taker.owner, victim: destination)
        return nil
      }
      suppression = nil
      return event
    case FocusEvents.keyFocusReturned:
      // The matching "returned" notice would answer a "taken" it never got.
      guard var undone = suppression, !undone.suppressedReturn, destination == undone.victim
      else { return event }
      undone.suppressedReturn = true
      suppression = undone
      return nil
    case FocusEvents.keyFocusChanged:
      guard let viewBridge, destination == viewBridge,
        let holder = Self.pid(event, FocusEvents.notificationPIDField)
      else { return event }
      changed(to: classify(holder), holder: holder, event: event)
      return event
    case FocusEvents.newFront:
      guard let viewBridge, destination == viewBridge else { return event }
      if suppression?.thief == Self.pid(event, FocusEvents.notificationPIDField) {
        suppression = nil
      }
      return event
    default:
      return event
    }
  }

  /// A key on its way to the thief goes to the person's app instead.
  private func keyboard(_ event: CGEvent) -> CGEvent? {
    guard Self.pid(event, FocusEvents.sourcePIDField) != getpid() else { return event }
    // Held until the key is sent on, so ending the undo (which releases the
    // watch on the person's app) cannot come between reading it and sending.
    // Same order as `suppression`'s didSet: this lock, then PersonKeyOrder's.
    lock.lock()
    defer { lock.unlock() }
    guard let undone = suppression, Self.pid(event, FocusEvents.targetPIDField) == undone.thief
    else { return event }
    return PersonKeyOrder.shared.sendOn(event, to: undone.victim) ? nil : event
  }

  /// Called with the lock held.
  private func changed(to focus: Focus, holder: pid_t, event: CGEvent) {
    let previous = current
    current = focus
    let quiet = suppression?.thiefOwner
    for target in targets where target.registration.pid != quiet {
      let pid = target.registration.pid
      if focus.owner == pid, previous.owner != pid {
        DispatchQueue.global(qos: .userInteractive).async(execute: target.gained)
      } else if previous.owner == pid, focus.owner != pid {
        DispatchQueue.global(qos: .userInteractive).async(execute: target.lost)
      }
    }
    var release = false
    if var undone = suppression {
      if holder == undone.thief {
        if !undone.released {
          undone.released = true
          release = true
          suppression = undone
        }
      } else if holder != undone.victim {
        suppression = nil
      }
    }
    if release { Self.releaseTheft(event) }
  }

  /// The window server names the theft in the notice that reports it.
  private static func releaseTheft(_ event: CGEvent) {
    guard let release = PrivateAPI.releaseKeyFocus,
      let id = UInt32(exactly: event.getIntegerValueField(FocusEvents.keyFocusIDField))
    else { return }
    let status = release(id)
    if status != 0 { Log.focus.error("A key focus theft could not be released (\(status)).") }
  }

  /// Called with the lock held.
  private func registered(_ pid: pid_t) -> Bool {
    pid != 0 && targets.contains { $0.registration.pid == pid }
  }

  /// A process with no Dock presence is a view service working for the app
  /// macOS holds responsible for it. ViewBridge's shared helper works for
  /// whichever app's remote view it shows, which nothing here can tell apart
  /// from the person's own, so it counts as no app's: a theft through it is
  /// never undone on a guess.
  private func classify(_ pid: pid_t) -> Focus {
    if let viewBridge, pid == viewBridge { return .viewService(host: 0) }
    guard let app = NSRunningApplication(processIdentifier: pid),
      app.activationPolicy == .prohibited
    else { return .app(pid) }
    return .viewService(host: Self.responsible(for: pid) ?? 0)
  }

  private static func pid(_ event: CGEvent, _ field: CGEventField) -> pid_t? {
    pid_t(exactly: event.getIntegerValueField(field))
  }

  private typealias Responsible = @convention(c) (pid_t) -> pid_t
  private static let responsibleFor: Responsible? = {
    guard
      let symbol = dlsym(
        UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
    else { return nil }
    return unsafeBitCast(symbol, to: Responsible.self)
  }()

  private static func responsible(for pid: pid_t) -> pid_t? {
    guard let responsibleFor else { return nil }
    let owner = responsibleFor(pid)
    return owner > 0 && owner != pid ? owner : nil
  }

  private static func processIdentifier(named name: String) -> pid_t? {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(count) * 2)
    let listed = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    guard listed > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: 1024)
    for pid in pids.prefix(Int(listed)) where pid > 0 {
      guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { continue }
      if String(cString: buffer) == name { return pid }
    }
    return nil
  }
}
