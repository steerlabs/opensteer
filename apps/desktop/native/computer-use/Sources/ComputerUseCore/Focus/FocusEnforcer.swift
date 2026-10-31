// Maintains the target app's synthetic activation state during guarded input.
// The transaction and timing below are Opensteer's current implementation;
// they are not a public macOS API contract.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

protocol FocusGuard: AnyObject, Sendable {
  var pid: pid_t { get }
  func stop()
  @WorkActor func guarded<Result>(
    window: AXUIElement?, prepare: Bool, keys: Bool,
    finalCheck: @escaping @Sendable () throws -> Void,
    deliveryCheck: @escaping @Sendable () throws -> Void,
    check: () throws -> Void, prepared: (Bool) -> Void,
    deliver: (@escaping @Sendable () throws -> Void) async throws -> Result
  ) async throws -> Result
}

/// One app the agent types into, believing it is the active app with the
/// observed window key, while the person's app stays in front (§1 invariant 4).
///
/// The app's belief is kept apart from the truth: `believesActive` and
/// `believesFocus` follow the activation notices the app itself receives,
/// `isActive` follows the real front app. While the app believes it is active
/// but is not, a click the person makes into it would not activate it — the app
/// thinks it already is — so such a click is turned into a real activation.
final class FocusEnforcer: FocusGuard, @unchecked Sendable {
  let pid: pid_t

  /// The app's belief, the truth, and what follows from both — one lock, so a
  /// belief change and the click tap it calls for are one step.
  private struct State {
    var active: Bool
    var focus: Bool
    var isActive: Bool
    var stopped = false
    var clickTap: EventTap?
  }

  private let state: Locked<State>
  private let suppression = Locked<(@Sendable (UInt32, Int64) -> Bool)?>(nil)
  private let personRound = Locked<Round?>(nil)
  private let personDeliveryWindow = Locked<(id: CGWindowID, lost: Bool)?>(nil)
  private var activationTap: EventTap?
  private var registration: FocusStealPreventer.Registration?
  private var observers: [any NSObjectProtocol] = []

  static let activationTypes = [
    FocusEvents.appKitDefined, FocusEvents.appActivated, FocusEvents.appDeactivated,
  ]

  /// Nil when macOS refuses the taps that guard the person's focus; no input
  /// is then sent.
  init?(pid: pid_t) {
    self.pid = pid
    let active = NSRunningApplication(processIdentifier: pid)?.isActive ?? false
    state = Locked(
      State(active: active, focus: PrivateAPI.focusPID(front: false) == pid, isActive: active))
    guard
      let tap = EventTap(
        .process(pid), place: .tailAppendEventTap, options: .defaultTap,
        types: Self.activationTypes,
        handler: { [weak self] type, event in
          guard let self else { return event }
          return self.noteActivation(type, event)
        }),
      let registration = FocusStealPreventer.register(
        pid, lost: { [weak self] in self?.update { $0.focus = false } },
        gained: { [weak self] in self?.update { $0.focus = true } })
    else { return nil }
    activationTap = tap
    self.registration = registration
    let center = NSWorkspace.shared.notificationCenter
    for name in [
      NSWorkspace.didActivateApplicationNotification,
      NSWorkspace.didDeactivateApplicationNotification,
    ] {
      observers.append(
        center.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
          guard let self,
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
            app.processIdentifier == self.pid
          else { return }
          let active = name == NSWorkspace.didActivateApplicationNotification
          self.update { $0.isActive = active }
        })
    }
  }

  deinit { stop() }

  /// The app no longer pretends: one left believing it is active would not
  /// come forward when the person clicks it. An activation still on its way
  /// takes itself back (`enforce`).
  func stop() {
    let (wasStopped, believedActive, clickTap) = state.withLock {
      current -> (Bool, Bool, EventTap?) in
      defer {
        current.stopped = true
        current.clickTap = nil
      }
      return (current.stopped, current.active, current.clickTap)
    }
    guard !wasStopped else { return }
    clickTap?.stop()
    for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    observers = []
    activationTap?.stop()
    registration?.stop()
    if believedActive { Self.undoActivation(of: pid) }
  }

  /// Unless the app really is active now, it hears it no longer is.
  private static func undoActivation(of pid: pid_t) {
    let send: @MainActor @Sendable () -> Void = {
      guard NSRunningApplication(processIdentifier: pid)?.isActive != true else { return }
      FocusEvents.sendDeactivated(to: pid)
    }
    if Thread.isMainThread {
      MainActor.assumeIsolated { send() }
    } else {
      DispatchQueue.main.async { send() }
    }
  }

  // MARK: - Guarded input

  /// Input to the app after preparation restores the person's front app
  /// and keyboard ownership, before delivery.
  ///
  /// When `prepare` asks and the app does not already believe its window has
  /// the keyboard, it is first told it is active with `window` key. While that
  /// settles, and only then, screen updates are held, a key on its way to the
  /// app that the helper did not send goes to the person's app instead, and
  /// the notices that would tell either app of the round trip are dropped: an
  /// app that comes forward is sent back before it is drawn in front, and
  /// keeps believing it is active. `prepared` hears, before any input, whether
  /// it came forward only while the screen was held, so the person never saw it.
  ///
  /// The input goes out after that, with nothing redirected or sent back:
  /// the person's keys and clicks go wherever they naturally go, and nothing
  /// the person does stops or fails the input once it has started.
  ///
  /// Keys and menu commands go to the app's key window, whichever window
  /// their events name: with `keys`, an app that believes it is active with
  /// another window key has the keyboard moved to `window`, and the input is
  /// refused unless it then is there. The key window of an app the person is
  /// using is never moved.
  ///
  /// `check` runs while the app is prepared, before anything is posted, and
  /// `finalCheck` immediately before the activation notices; a failure there
  /// puts the person's app back and nothing is sent. `deliver` is given
  /// `proceed` to run between parts of the input: it stops only for a session
  /// that ended and what `deliveryCheck` refuses.
  @WorkActor
  func guarded<Result>(
    window: AXUIElement?, prepare: Bool, keys: Bool,
    finalCheck: @escaping @Sendable () throws -> Void = {},
    deliveryCheck: @escaping @Sendable () throws -> Void = {},
    check: () throws -> Void,
    prepared: (_ unseen: Bool) -> Void = { _ in },
    deliver: (_ proceed: @escaping @Sendable () throws -> Void) async throws -> Result
  ) async throws -> Result {
    await OwnerFocusGate.shared.acquire()
    defer { OwnerFocusGate.shared.release() }
    let target = keys && prepare ? window.flatMap(KeyWindow.windowID) : nil
    // An app that believes it is active keeps its key window until told
    // otherwise; one that does not is activated with `window` key.
    let keyWindow =
      target != nil && state.current.active ? keyWindowID(timeout: axMessagingTimeout) : nil
    let switching = target != nil && state.current.active && keyWindow != target
    let preparing = prepare && (!state.current.focus || switching)
    let front = PrivateAPI.focusPID(front: true)
    if switching, front == pid { throw Self.personsWindow }
    func ready() throws { try gate(check, switching: switching) }
    var unseen = false
    if preparing, let front, front != pid,
      let original = NSRunningApplication(processIdentifier: front)
    {
      unseen = try await safelyEnforce(
        window, switching: switching, resigning: keyWindow, target: target, original: original,
        finalCheck: finalCheck, check: check, gate: ready)
    } else {
      if preparing {
        try await enforce(
          window, switching: switching, resigning: keyWindow, finalCheck: finalCheck, gate: ready)
        await waitUntilBelievedFrontmost(timeout: 0.25)
        if switching, let target { try await requireKey(target, gate: ready) }
      }
      try ready()
    }
    prepared(unseen)
    return try await deliver {
      try self.proceed()
      try deliveryCheck()
    }
  }

  /// Remote person input protects each bounded burst through its delivery and
  /// watches for an input-caused activation afterwards. Agent delivery above
  /// deliberately ends that protection before input starts. The shared gate
  /// keeps either lane's preparation from overlapping the other lane's burst.
  func guardedPerson<Result>(
    isolation: isolated (any Actor)? = #isolation,
    window: AXUIElement?, prepare: Bool, keys: Bool,
    finalCheck: @escaping @Sendable () throws -> Void = {},
    check: () throws -> Void,
    hasPendingInput: () -> Bool = { false },
    deliver: (_ proceed: @escaping @Sendable () throws -> Void) async throws -> Result
  ) async throws -> (result: Result, unseen: Bool) {
    await OwnerFocusGate.shared.acquire()
    defer { OwnerFocusGate.shared.release() }
    try check(); try finalCheck()
    let target = keys && prepare ? window.flatMap(KeyWindow.windowID) : nil
    // An app that believes it is active keeps its key window until told
    // otherwise; one that does not is activated with `window` key.
    let keyWindow =
      target != nil && state.current.active ? keyWindowID(timeout: axMessagingTimeout) : nil
    let switching = target != nil && state.current.active && keyWindow != target
    let preparing = prepare && (!state.current.focus || switching)
    defer { personDeliveryWindow.withLock { $0 = nil } }
    func deliverGuarded(_ round: Round?) async throws -> Result {
      if let target {
        personDeliveryWindow.withLock { if $0 == nil { $0 = (target, false) } }
      }
      return try await deliver {
        try self.proceed()
        if round?.relinquished == true || self.personDeliveryWindow.current?.lost == true {
          throw Self.personTookOver
        }
        try finalCheck()
      }
    }
    let front = PrivateAPI.focusPID(front: true)
    guard let front, front != pid, let original = NSRunningApplication(processIdentifier: front)
    else {
      if switching, front == pid { throw Self.personsWindow }
      func ready() throws { try gate(check, switching: switching) }
      if preparing {
        try await enforce(
          window, switching: switching, resigning: keyWindow, finalCheck: finalCheck,
          gate: ready)
        await waitUntilBelievedFrontmost(timeout: 0.25)
        if switching, let target { try await requireKey(target, gate: ready) }
      }
      try ready()
      return (try await deliverGuarded(nil), false)
    }
    let round = try Round(target: pid, original: original)
    suppression.withLock { $0 = round.suppress }
    self.personRound.withLock { $0 = round }
    defer {
      self.personRound.withLock { $0 = nil }
      suppression.withLock { $0 = nil }
      round.end()
    }
    // Screen updates are held only while the app is prepared.
    var release: () -> Void = {}
    if preparing {
      guard let held = PrivateAPI.holdScreenUpdates() else { throw Self.unguarded }
      release = held
    }
    defer { release() }
    func ready() throws {
      if round.relinquished { throw Self.personSwitched }
      try gate(check, switching: switching)
    }
    var unseen = false
    do {
      if preparing {
        var enforcement: (any Error)?
        do {
          try await enforce(
            window, switching: switching, resigning: keyWindow, round: round,
            finalCheck: finalCheck, gate: ready)
        } catch {
          enforcement = error
        }
        unseen = try await round.settle(check: check, enforcement: enforcement, afterInput: false)
        if let enforcement { throw enforcement }
        if switching, let target { try await requireKey(target, gate: ready) }
      }
      try ready()
    } catch {
      // Settling that failed has already tried; anything else stopped first.
      let tried = [Self.unsettled, Self.notRestored].contains { $0 == error as? HelperError }
      if preparing, !tried {
        _ = try await round.settle(check: {}, enforcement: error, afterInput: false)
      }
      throw error
    }
    release()
    release = {}
    round.begin()
    var result: Result
    do {
      result = try await deliverGuarded(round)
    } catch {
      _ = try? await round.settle(check: {}, enforcement: nil, afterInput: true)
      throw error
    }
    // Input is out: nothing stops the person's app being put back, and an app
    // left in front is reported, never passed off as delivered quietly.
    do {
      if try await round.settle(check: {}, enforcement: nil, afterInput: true, additionalInput: {
        guard self.personDeliveryWindow.current?.lost != true,
          !OwnerFocusGate.shared.hasWaiters, hasPendingInput() else { return false }
        result = try await deliverGuarded(round)
        return true
      }) {
        unseen = false
      }
    } catch let error as HelperError where error == Self.personSwitched {
      unseen = false
    } catch {
      throw Self.leftInFront
    }
    return (result, unseen)
  }

  /// Preparing the app while the person's app is in front: the round's taps,
  /// its notice suppression and the screen hold last until the app is
  /// prepared and the person's app is back, and end before any input.
  private func safelyEnforce(
    _ window: AXUIElement?, switching: Bool, resigning: CGWindowID?, target: CGWindowID?,
    isolation: isolated (any Actor)? = #isolation,
    original: NSRunningApplication, finalCheck: @escaping @Sendable () throws -> Void,
    check: () throws -> Void, gate: () throws -> Void
  ) async throws -> Bool {
    let round = try Round(target: pid, original: original)
    suppression.withLock { $0 = round.suppress }
    defer {
      suppression.withLock { $0 = nil }
      round.end()
    }
    guard let release = PrivateAPI.holdScreenUpdates() else { throw Self.unguarded }
    defer { release() }
    do {
      var enforcement: (any Error)?
      do {
        try await enforce(
          window, switching: switching, resigning: resigning, finalCheck: finalCheck, gate: gate)
      } catch {
        enforcement = error
      }
      let unseen = try await round.settle(check: check, enforcement: enforcement)
      if let enforcement { throw enforcement }
      if switching, let target { try await requireKey(target, gate: gate) }
      try gate()
      return unseen
    } catch {
      // Settling that failed has already tried; anything else stopped first.
      let tried = [Self.unsettled, Self.notRestored].contains { $0 == error as? HelperError }
      if !tried { _ = try? await round.settle(check: {}, enforcement: error) }
      throw error
    }
  }

  /// Before anything is posted: the check, and `mayPost`.
  private func gate(_ check: () throws -> Void, switching: Bool) throws {
    try check()
    try mayPost(switching: switching)
  }

  /// The session is open and, for a window switch, the person has not
  /// brought the app forward. Safe on any thread, so it also has the last
  /// word on the main thread, right before events are posted.
  private func mayPost(switching: Bool) throws {
    guard !state.current.stopped else { throw Self.ended }
    if switching, PrivateAPI.focusPID(front: true) == pid { throw Self.personsWindow }
  }

  /// Between parts of an input already under way.
  private func proceed() throws {
    guard !state.current.stopped else { throw Self.endedPartWay }
  }

  /// What the app is told: nothing when it already believes its window has
  /// the keyboard, that the keyboard is back when it believes it is active,
  /// else that it was activated with `window` key. A window is named only
  /// with the point a click activates it at. `switching` moves the keyboard
  /// to `window` from `resigning`, the app's key window, which needs it named.
  /// `gate` runs once everything is read, just before anything is posted.
  private func enforce(
    _ window: AXUIElement?, switching: Bool, resigning: CGWindowID?, round: Round? = nil,
    isolation: isolated (any Actor)? = #isolation,
    finalCheck: @Sendable () throws -> Void, gate: () throws -> Void
  ) async throws {
    let current = state.current
    guard !current.stopped else { throw Self.ended }
    let lastWord: @Sendable () throws -> Void = { [self] in
      try finalCheck()
      if round?.relinquished == true { throw Self.personSwitched }
      try mayPost(switching: switching)
    }
    if !switching {
      if current.focus { return }
      if current.active {
        try gate()
        guard try await FocusEvents.sendKeyFocusReturned(to: pid, gate: lastWord) else {
          throw Self.unbuilt
        }
        update { $0.focus = true }
        return
      }
    }
    let named = window.flatMap { window -> (CGWindowID, CGRect?, CGPoint)? in
      guard let id = KeyWindow.windowID(of: window), let point = Self.activationPoint(of: window)
      else { return nil }
      return (id, AXValueReader.copyFrame(window), point)
    }
    if switching, named == nil { throw WindowKey.unconfirmed }
    try gate()
    guard
      try await FocusEvents.sendActivated(
        to: pid, resigning: switching ? resigning : nil, window: named?.0 ?? 0, frame: named?.1,
        activationPoint: named?.2, gate: lastWord)
    else { throw Self.unbuilt }
    let stopped = state.withLock { current -> Bool in
      current.active = true
      current.focus = true
      return current.stopped
    }
    // The session ended while this was on its way: take it back.
    if stopped {
      await FocusEvents.sendDeactivated(to: pid)
      throw Self.ended
    }
    update { _ in }
  }

  /// The window the app's keys go to now.
  private func keyWindowID(timeout: Float) -> CGWindowID? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, timeout)
    return AXValueReader.copyElement(app, kAXFocusedWindowAttribute).flatMap(KeyWindow.windowID)
  }

  /// Keys are sent only once `window` has the keyboard, within half a second.
  private func requireKey(_ window: CGWindowID, isolation: isolated (any Actor)? = #isolation, gate: () throws -> Void) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 0.5
    while true {
      try gate()
      let remaining = deadline - ProcessInfo.processInfo.systemUptime
      guard remaining > 0 else { throw WindowKey.unconfirmed }
      if keyWindowID(timeout: Float(min(0.1, remaining))) == window { return }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  private func waitUntilBelievedFrontmost(timeout: TimeInterval, isolation: isolated (any Actor)? = #isolation) async {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.1)
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while ProcessInfo.processInfo.systemUptime < deadline {
      if AXValueReader.copyBool(app, "AXFrontmost") == true { return }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  // MARK: - Belief (the tap thread and the work lane)

  private func noteActivation(_ type: CGEventType, _ event: CGEvent) -> CGEvent? {
    let kind = type.rawValue
    let subtype = event.getIntegerValueField(FocusEvents.appKitSubtypeField)
    let fromHelper = pid_t(exactly: event.getIntegerValueField(FocusEvents.sourcePIDField)) == getpid()
    let window = CGWindowID(
      truncatingIfNeeded: event.getIntegerValueField(FocusEvents.windowNumberField))
    guard case .pass(let believesActive, let endsDelivery) = Self.notice(fromHelper: fromHelper,
      kind, subtype, window: window, suppress: suppression.current) else { return nil }
    personDeliveryWindow.withLock { delivery in
      guard endsDelivery, let expected = delivery else { return }
      if FocusEvents.isDeactivation(kind, subtype)
        || (kind == FocusEvents.appKitDefined && subtype == FocusEvents.resignedKey
          && (window == expected.id || window == 0))
        || (FocusEvents.isActivation(kind, subtype) && window != 0 && window != expected.id)
      {
        delivery?.lost = true
      }
    }
    if let active = believesActive {
      update {
        $0.active = active
        $0.focus = active
      }
    }
    return event
  }

  enum Notice: Equatable { case drop, pass(believesActive: Bool?, endsDelivery: Bool) }
  /// No round drops what the helper sends — `enforce` and `undoActivation`
  /// must reach the app — but every enforcer for the app records it. Another
  /// view's enforcer ending (`undoActivation`, app-level) really deactivates
  /// the app this one serves, so it also ends a live delivery. A helper key
  /// switch never does: taps may see it late, during a later round's delivery
  /// (its own or a sibling's), yet it was posted to the app before that
  /// round's own preparation. Person and app focus changes are never the
  /// helper's and keep full loss detection.
  static func notice(fromHelper: Bool, _ kind: UInt32, _ subtype: Int64, window: CGWindowID,
                     suppress: ((UInt32, Int64) -> Bool)?) -> Notice {
    if !fromHelper, let suppress, suppress(kind, subtype) { return .drop }
    let appLevelUndo = FocusEvents.isDeactivation(kind, subtype) && window == 0
    let believesActive: Bool? = FocusEvents.isActivation(kind, subtype) ? true
      : FocusEvents.isDeactivation(kind, subtype) && (!fromHelper || appLevelUndo) ? false : nil
    return .pass(believesActive: believesActive, endsDelivery: !fromHelper || appLevelUndo)
  }

  /// A belief change, and the click tap it calls for: present exactly while
  /// the app believes it is active but is not.
  private func update(_ change: (inout State) -> Void) {
    let removed = state.withLock { current -> EventTap? in
      change(&current)
      let pretending = !current.stopped && current.active && !current.isActive
      if pretending, current.clickTap == nil {
        current.clickTap = EventTap(
          .session, place: .headInsertEventTap, options: .listenOnly,
          types: [CGEventType.leftMouseDown.rawValue],
          handler: { [weak self] _, event in
            self?.personClicked(event)
            return event
          })
      } else if !pretending, let tap = current.clickTap {
        current.clickTap = nil
        return tap
      }
      return nil
    }
    removed?.stop()
  }

  /// A person’s click activates the app unless its synthetic active state
  /// ended before main-thread handling. A click already addressed to the app
  /// needs no reconciliation. This does not cancel input already under way.
  private func personClicked(_ event: CGEvent) {
    guard
      pid_t(exactly: event.getIntegerValueField(FocusEvents.sourcePIDField)) != getpid(),
      pid_t(exactly: event.getIntegerValueField(FocusEvents.targetPIDField)) != pid,
      let window = CGWindowID(exactly: event.getIntegerValueField(FocusEvents.windowNumberField)),
      window != 0,
      let info =
        (CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], window)
        as? [[String: Any]])?.first,
      ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
      (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
    else { return }
    personRound.current?.relinquish()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let current = self.state.current
      guard !current.stopped, current.active, !current.isActive else { return }
      _ = NSRunningApplication(processIdentifier: self.pid)?.activate(options: [])
    }
  }

  // MARK: - Helpers

  private static func activationPoint(of window: AXUIElement) -> CGPoint? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(window, "AXActivationPoint" as CFString, &value) == .success,
      let value, CFGetTypeID(value) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point)
      ? point : nil
  }

  static func raiseOriginalWindow(
    _ window: AXUIElement, originalPID: pid_t, relinquished: () -> Bool,
    frontPID: () -> pid_t? = { PrivateAPI.focusPID(front: true) },
    focusedWindow: (pid_t) -> AXUIElement? = { pid in
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
      return AXValueReader.copyElement(app, kAXFocusedWindowAttribute)
    },
    raise: (AXUIElement) -> AXError = { AXUIElementPerformAction($0, kAXRaiseAction as CFString) }
  ) throws -> AXError {
    guard let focused = focusedWindow(originalPID), CFEqual(focused, window),
      frontPID() == originalPID, !relinquished() else { throw personSwitched }
    return raise(window)
  }

  static let personsWindow = HelperError(
    .unsupported,
    "The person is using this app in another of its windows, and Opensteer does not move their "
      + "keyboard, so no keys were sent.")
  static let personTookOver = HelperError(
    .outcomeUnknown,
    "The person started using this app, so Opensteer stopped part way through the input.")
  static let endedPartWay = HelperError(
    .noSession, "This session ended part way through the input.")
  static let leftInFront = HelperError(
    .outcomeUnknown,
    "The input was sent, but this app came to the front and the person's app could not be put "
      + "back.")
  static let unguarded = HelperError(
    .unsupported,
    "This Mac would not let Opensteer guard the person's keyboard, so nothing was sent.")
  static let unbuilt = HelperError(
    .failed, "This Mac could not prepare the app for input, so nothing was sent.")
  static let ended = HelperError(.noSession, "This session ended, so nothing was sent.")
  static let notRestored = HelperError(
    .failed,
    "This app came to the front and the person's app could not be brought back; nothing was sent.")
  static let personSwitched = HelperError(
    .failed, "The person switched apps while this app was being prepared; nothing was sent.")
  static let unsettled = HelperError(
    .failed, "This app did not settle in the background in time, so nothing was sent.")
}

/// Preparation protects both lanes. Agent input ends this round before
/// delivery; person bursts keep it until their after-input watch completes.
private final class Round: @unchecked Sendable {
  private struct Seen {
    var realActivationObserved = false
    var originalActivated = false
    var targetDeactivated = false
    var lastEventTime = ProcessInfo.processInfo.systemUptime
    /// The person chose the target themselves: nothing is undone or redirected.
    var relinquished = false
  }

  /// How long after the input an app is given to come forward on it.
  static let afterInputWatch: TimeInterval = 0.25

  let target: pid_t
  let original: NSRunningApplication
  private let originalWindow: AXUIElement?
  private let originalWindowID: CGWindowID?
  private let seen = Locked(Seen())
  private var taps: [EventTap] = []

  init(target: pid_t, original: NSRunningApplication) throws {
    self.target = target
    self.original = original
    let originalPID = original.processIdentifier
    let app = AXUIElementCreateApplication(originalPID)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    originalWindow = AXValueReader.copyElement(app, kAXFocusedWindowAttribute)
    originalWindowID = originalWindow.flatMap(KeyWindow.windowID)
    let seen = self.seen
    // Watched before any of the person's keys can be sent on, so they stay in
    // order (`PersonKeyOrder`).
    guard PersonKeyOrder.shared.hold(originalPID) else { throw FocusEnforcer.unguarded }
    guard
      let originalTap = EventTap(
        .process(originalPID), place: .headInsertEventTap, options: .defaultTap,
        types: FocusEnforcer.activationTypes,
        handler: { type, event in
          let kind = type.rawValue
          let subtype = event.getIntegerValueField(FocusEvents.appKitSubtypeField)
          return seen.withLock { state -> CGEvent? in
            guard !state.relinquished else { return event }
            state.lastEventTime = Round.now()
            if FocusEvents.isActivation(kind, subtype) {
              state.realActivationObserved = true
              state.originalActivated = true
              return nil
            }
            if FocusEvents.isDeactivation(kind, subtype) {
              state.realActivationObserved = true
              return nil
            }
            return FocusEvents.isResign(kind, subtype) ? nil : event
          }
        }),
      let redirect = EventTap(
        .process(target), place: .headInsertEventTap, options: .defaultTap,
        types: FocusStealPreventer.keyboardTypes,
        handler: { _, event in
          guard
            pid_t(truncatingIfNeeded: event.getIntegerValueField(FocusEvents.sourcePIDField))
              != getpid(),
            pid_t(truncatingIfNeeded: event.getIntegerValueField(FocusEvents.targetPIDField))
              == target,
            !seen.current.relinquished
          else { return event }
          return PersonKeyOrder.shared.sendOn(event, to: originalPID) ? nil : event
        })
    else {
      PersonKeyOrder.shared.release(originalPID)
      throw FocusEnforcer.unguarded
    }
    taps = [originalTap, redirect]
  }

  /// What the target's own activation tap drops: its deactivation and
  /// resign notices, so it keeps believing it is active.
  var suppress: @Sendable (UInt32, Int64) -> Bool {
    let seen = self.seen
    return { kind, subtype in
      seen.withLock { state in
        guard !state.relinquished else { return false }
        state.lastEventTime = Round.now()
        if kind == FocusEvents.appActivated {
          state.realActivationObserved = true
          return false
        }
        if FocusEvents.isDeactivation(kind, subtype) {
          state.realActivationObserved = true
          state.targetDeactivated = true
          return true
        }
        return FocusEvents.isResign(kind, subtype)
      }
    }
  }

  /// The input is about to go out; only what it causes counts from here.
  func begin() { seen.withLock { $0 = Seen(relinquished: $0.relinquished) } }

  /// The person clicked into the target to use it: it stays in front, and
  /// their keys reach it.
  func relinquish() { seen.withLock { $0.relinquished = true } }

  var relinquished: Bool { seen.current.relinquished }

  func end() {
    guard !taps.isEmpty else { return }
    for tap in taps { tap.stop() }
    taps = []
    PersonKeyOrder.shared.release(original.processIdentifier)
  }

  /// Until both apps are where the person left them. Before the input, until
  /// the target reports itself frontmost; after it, for `afterInputWatch`. If
  /// the target came forward, the person's app is activated again — at most
  /// every 50 ms — their window is raised over the target's, and the round
  /// ends once both apps heard of it and 100 ms passed without a notice.
  /// Returns whether the person's app had to be put back. A person who chose
  /// the target is never sent back; before the input that ends the round.
  func settle(isolation: isolated (any Actor)? = #isolation, check: () throws -> Void, enforcement: (any Error)?, afterInput: Bool = false,
              additionalInput: () async throws -> Bool = { false })
    async throws -> Bool
  {
    seen.withLock { $0.lastEventTime = Round.now() }
    var started = Round.now()
    var lastRestore = 0.0
    var restored = false
    let targetApp = AXUIElementCreateApplication(target)
    AXUIElementSetMessagingTimeout(targetApp, 0.1)
    while true {
      try check()
      if seen.current.relinquished {
        if afterInput { return false }
        throw FocusEnforcer.personSwitched
      }
      let time = Round.now()
      let elapsed = time - started
      // The window server's answer, not NSWorkspace's, which follows it late.
      let front = PrivateAPI.focusPID(front: true)
      // Reads above and below wait on apps; a person's choice made meanwhile wins.
      if front == target {
        if time - lastRestore >= 0.05, !relinquished {
          seen.withLock {
            $0.originalActivated = false
            $0.targetDeactivated = false
            $0.lastEventTime = time
          }
          guard original.activate(options: []) else { throw FocusEnforcer.notRestored }
          restored = true
          lastRestore = time
        }
      } else {
        guard front == original.processIdentifier else { throw FocusEnforcer.personSwitched }
        let ready =
          afterInput
          ? elapsed >= Self.afterInputWatch
          : enforcement != nil || AXValueReader.copyBool(targetApp, "AXFrontmost") == true
        var raised = false
        if let originalWindow, let originalWindowID,
          Self.targetWindowIsAbove(originalWindowID, target: target)
        {
          // A raise that keeps failing leaves the target over the person's
          // window: that is not settled.
          let status: AXError
          if original.processIdentifier == getpid() {
            // In-process AX invokes AppKit directly; window ordering needs its main thread.
            status = try await MainActor.run {
              try FocusEnforcer.raiseOriginalWindow(originalWindow,
                originalPID: original.processIdentifier, relinquished: { self.relinquished })
            }
          } else {
            status = try FocusEnforcer.raiseOriginalWindow(originalWindow,
              originalPID: original.processIdentifier, relinquished: { self.relinquished })
          }
          if status == .success {
            seen.withLock { $0.lastEventTime = time }
          } else if elapsed >= 1 {
            throw FocusEnforcer.notRestored
          }
          raised = status != .success || elapsed < 1
        }
        // The reads above wait on apps; the front app is read again before
        // the round can end.
        if !raised, PrivateAPI.focusPID(front: true) == original.processIdentifier {
          let state = seen.current
          let acknowledged = !restored || state.originalActivated && state.targetDeactivated
          let quiet = !(enforcement != nil || restored || state.realActivationObserved)
            || Round.now() - state.lastEventTime >= 0.1
          if acknowledged && quiet {
            // The same guarded round can deliver another queued batch while
            // watching for activation. The final input still gets a full watch.
            if afterInput, !relinquished, try await additionalInput() {
              started = Round.now()
              continue
            }
            if ready || elapsed >= 1 { break }
          }
        }
      }
      if elapsed >= 2 { throw FocusEnforcer.unsettled }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    if restored {
      Log.focus.notice(
        "App \(self.target, privacy: .public) came forward and was sent back.")
    }
    return restored
  }

  static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  /// A window of the target drawn in front of the person's window, at its level.
  private static func targetWindowIsAbove(_ windowID: CGWindowID, target: pid_t) -> Bool {
    let windows =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    guard
      let index = windows.firstIndex(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
      })
    else { return false }
    let layer = windows[index][kCGWindowLayer as String] as? Int
    return windows[..<index].contains {
      ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target
        && (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0
        && $0[kCGWindowLayer as String] as? Int == layer
    }
  }
}

/// An app's enforcer, for the process the app runs in now. A restarted app
/// gets a new one; the old process is no longer pretended for.
public final class FocusSlot: @unchecked Sendable {
  private let current = Locked<(enforcer: (any FocusGuard)?, closed: Bool)>((nil, false))

  private let make: @Sendable (pid_t) -> (any FocusGuard)?

  public convenience init() { self.init(make: { FocusEnforcer(pid: $0) }) }

  init(make: @escaping @Sendable (pid_t) -> (any FocusGuard)?) { self.make = make }

  /// Nil once the slot is stopped, or when the taps cannot be made.
  func enforcer(for pid: pid_t) -> (any FocusGuard)? {
    current.withLock { slot in
      guard !slot.closed else { return nil }
      if let existing = slot.enforcer, existing.pid == pid { return existing }
      slot.enforcer?.stop()
      slot.enforcer = make(pid)
      return slot.enforcer
    }
  }

  /// The person lane deliberately stays outside the FocusGuard seam: nil, so
  /// the caller refuses, unless this slot holds the live FocusEnforcer.
  func personEnforcer(for pid: pid_t) -> FocusEnforcer? { enforcer(for: pid) as? FocusEnforcer }

  public func stop() {
    current.withLock { slot in
      slot.enforcer?.stop()
      slot = (nil, true)
    }
  }
}
