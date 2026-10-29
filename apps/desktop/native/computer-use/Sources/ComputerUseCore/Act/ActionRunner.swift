import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import OpensteerAppleData

struct InputCalls {
  typealias Gate = @Sendable () throws -> Void
  var mouse:
    @MainActor (NSEvent.EventType, EventTarget, MouseButton, Int, Float, Gate) throws -> Void
  var scroll: @MainActor (ScrollDirection, Int, EventTarget, Gate) throws -> Void
  var press:
    @MainActor (CGKeyCode, CGEventFlags, String?, EventTarget, UInt64?, Gate) async throws -> Void
  var unicode: @MainActor (String, EventTarget, UInt64?, Gate) async throws -> Void

  static var live: InputCalls {
    InputCalls(
      mouse: {
        try SyntheticEvents.postMouse(
          type: $0, target: $1, button: $2, clickCount: $3, pressure: $4, gate: $5)
      },
      scroll: { try SyntheticEvents.postScroll(direction: $0, amount: $1, target: $2, gate: $3) },
      press: {
        try await SyntheticEvents.press(
          virtualKey: $0, flags: $1, characters: $2, target: $3, pacing: $4, gate: $5)
      },
      unicode: { try await SyntheticEvents.typeUnicode($0, target: $1, pacing: $2, gate: $3) })
  }
}

/// `session.act` (§2 "Actions").
///
/// Actions run in order and stop at the first failure. The route for each one
/// is decided before it delivers anything and never changed after a failure,
/// because a second attempt down a different route would be a second click.
@WorkActor
public enum ActionRunner {
  /// A whole batch may not run longer than this.
  public nonisolated static let batchBudget: TimeInterval = 30
  static let moveToDownDelay: UInt64 = 15_000_000
  static let downToUpDelay: UInt64 = 30_000_000
  static let betweenTicksDelay: UInt64 = 8_000_000

  public struct RunResult: Sendable, Equatable {
    /// What each fully completed action did, in order; its length is the
    /// completed count (§2 "Actions").
    public let performed: [String]
    public let error: HelperError?
  }

  /// `budget` carries the request's deadline, when the Host sent one; the
  /// batch's own thirty seconds start here. Whichever ends first stops the
  /// batch between actions, or between the chunks and ticks of one, and the
  /// result reports what completed — the same shape as `Stop`.
  public static func run(
    actions: [ActionRequest],
    app: AppSessionState,
    observationId: String,
    cancellation: SessionCancellation,
    monitor: WindowMonitor,
    overlay: OverlayController?,
    budget requestBudget: WorkBudget = .unlimited
  ) async throws -> RunResult {
    try await run(
      actions: actions, app: app, observationId: observationId, cancellation: cancellation,
      monitor: monitor, overlay: overlay, budget: requestBudget, accessibility: .live)
  }

  static func run(
    actions: [ActionRequest], app: AppSessionState, window: String, snapshot: String?,
    cancellation: SessionCancellation, monitor: WindowMonitor, overlay: OverlayController?,
    budget: WorkBudget = .unlimited, accessibility: AccessibilityCalls = .live,
    savedBatch: PreparedLoginBatch? = nil
  ) async throws -> RunResult {
    try cancellation.check()
    try budget.check()
    let bound = try SessionWindows.resolve(app: app, ref: window, monitor: monitor)
    if actions.contains(where: \.requiresSnapshot) {
      guard let snapshot else { throw HelperError(.staleObservation, "Observe this window first.") }
      guard bound.latest?.observationId == snapshot,
        monitor.staleReason(
          processIdentifier: bound.process.processIdentifier, windowID: bound.windowID) == nil
      else { throw HelperError(.staleObservation, "Observe this window again.") }
    }
    app.currentWindow = bound
    return try await run(
      actions: actions, app: app, observationId: snapshot ?? "",
      cancellation: cancellation, monitor: monitor, overlay: overlay, budget: budget,
      accessibility: accessibility, savedBatch: savedBatch)
  }

  /// The batch, with the Accessibility calls its routes make.
  static func run(
    actions: [ActionRequest],
    app: AppSessionState,
    observationId: String,
    cancellation: SessionCancellation,
    monitor: WindowMonitor,
    overlay: OverlayController?,
    budget requestBudget: WorkBudget,
    accessibility: AccessibilityCalls,
    savedBatch: PreparedLoginBatch? = nil,
    stamp: @escaping @Sendable (pid_t) -> ProcessStamp? = { ProcessStamp.of($0) },
    isHidden: @escaping @Sendable (pid_t) -> Bool = {
      NSRunningApplication(processIdentifier: $0)?.isHidden == true
    },
    requireUnlocked: @escaping @Sendable () throws -> Void = { try HelperRuntime.requireUnlocked() }
  ) async throws -> RunResult {
    try cancellation.check()
    let ownerTicket = try app.ownerInputFence.beginAgent()
    defer { app.ownerInputFence.endAgent(ownerTicket) }
    if app.observationControlEpoch != ownerTicket.epoch {
      throw HelperError(.staleObservation, "The person used this app; observe this window again before acting.")
    }
    if actions.contains(where: \.requiresSnapshot), app.latest?.observationId != observationId {
      throw HelperError(
        .staleObservation,
        "Observe this window again."
      )
    }
    let budget = requestBudget.startingBatch(batchBudget)
    let context = Context(
      app: app, cancellation: cancellation, monitor: monitor, overlay: overlay, budget: budget,
      accessibility: accessibility, feedback: overlay, requireUnlocked: requireUnlocked,
      stamp: stamp, isHidden: isHidden,
      ownerCheck: { try app.ownerInputFence.checkAgent(ownerTicket) })

    let inputWindow = app.currentWindow
    let inputRevision = inputWindow.map { monitor.helperInputRevision(processIdentifier: $0.process.processIdentifier) }
    defer {
      if let inputWindow, let inputRevision {
        if monitor.helperInputRevision(processIdentifier: inputWindow.process.processIdentifier) != inputRevision {
          inputWindow.inputSinceObservation = true
        } else if !inputWindow.inputSinceObservation { inputWindow.beforeInput = nil }
      }
    }
    // Preserve the pre-input fingerprint across act calls until observe settles.
    if let bound = app.currentWindow, !bound.inputSinceObservation {
      bound.beforeInput = ActionSettle.fingerprint(
        of: bound.element,
        until: ActionSettle.preActionDeadline(budget: budget), cancellation: cancellation)
    }
    var performed: [String] = []
    var failure: HelperError?
    for (index, action) in actions.enumerated() {
      context.deliveryProgress.withLock { $0 = false }
      do {
        // Explicit Stop, locking and deadlines end only the remaining work.
        try cancellation.check()
        try budget.check()
        try context.requireUnlocked()
        performed.append(try await perform(action, context, savedBatch: savedBatch, index: index))
      } catch let error as HelperError {
        failure = failureAfter(
          error, performed: performed, delivered: context.deliveryProgress.current)
        break
      } catch {
        failure = HelperError(.failed, "This Mac could not complete that action.")
        break
      }
    }
    return RunResult(performed: performed, error: failure)
  }

  /// Once an earlier action completed, a later stale window is a partial
  /// failure rather than a claim that the batch sent nothing.
  nonisolated static func failureAfter(
    _ error: HelperError, performed: [String], delivered: Bool = false
  ) -> HelperError {
    if delivered && (error.code == .staleObservation || error.code == .ownerInControl) {
      return HelperError(
        .outcomeUnknown,
        "Input started before the target changed; some input may have arrived. " + error.message)
    }
    guard !performed.isEmpty, error.code == .staleObservation else { return error }
    return HelperError(.failed, error.message)
  }

  /// What every action of one batch shares.
  struct Context {
    let app: AppSessionState
    let cancellation: SessionCancellation
    let monitor: WindowMonitor
    let overlay: OverlayController?
    let budget: WorkBudget
    var accessibility: AccessibilityCalls = .live
    /// Where a write's ripple, nudge or pulse is shown: the overlay, or a
    /// test's recorder.
    var feedback: (any ActionFeedback)? = nil
    var requireUnlocked: @Sendable () throws -> Void = { try HelperRuntime.requireUnlocked() }
    var savedCheck: @Sendable () throws -> Void = {}
    var stamp: @Sendable (pid_t) -> ProcessStamp? = { ProcessStamp.of($0) }
    var isHidden: @Sendable (pid_t) -> Bool = {
      NSRunningApplication(processIdentifier: $0)?.isHidden == true
    }
    var keyOwner: @WorkActor (pid_t, CGWindowID) throws -> (id: CGWindowID, element: AXUIElement) =
      { try WindowKey.owner(pid: $0, destination: $1) }
    var input: InputCalls = .live
    var ownerCheck: @Sendable () throws -> Void = {}
    let deliveryProgress = Locked(false)
    var elementCheck: (@WorkActor (AXUIElement, Binding) throws -> Void)? = nil

    @WorkActor func validateElement(_ element: AXUIElement, _ binding: Binding, restarted: String)
      throws
    {
      if let elementCheck {
        try elementCheck(element, binding)
      } else {
        try ActionRunner.requireElement(
          element, binding: binding,
          check: deliveryGate(binding, restarted: restarted, markDelivery: false))
      }
    }

    /// Captured before an actor hop; contains no AX reads and runs at the
    /// mutation boundary on either executor.
    @WorkActor func deliveryGate(
      _ binding: Binding, restarted: String, markDelivery: Bool = true, event: Bool = false
    ) -> @Sendable () throws -> Void {
      let cancellation = cancellation, budget = budget, saved = savedCheck, owner = ownerCheck
      let unlocked = requireUnlocked, stamp = binding.stamp, readStamp = self.stamp
      let lifetime = binding.bound?.liveness, progress = deliveryProgress
      let isHidden = isHidden
      let monitor = monitor, pid = binding.processIdentifier, id = binding.keyWindow.windowID
      return {
        try cancellation.check(); try owner(); try budget.check(); try saved(); try unlocked()
        try AppProcess.requireSame(stamp, restarted, readStamp: readStamp)
        if monitor.staleReason(processIdentifier: pid, windowID: id) == .closed {
          lifetime?.close()
        }
        if lifetime?.isClosed == true { throw SessionWindows.closed }
        if event && isHidden(pid) {
          throw ActionRunner.hiddenAppRefusal
        }
        if markDelivery { progress.withLock { $0 = true } }
      }
    }

    /// While an action's input is going out: only what ends the session or
    /// makes posting impossible stops it — `Stop`, the clocks, a locked screen,
    /// the saved-login lease and the process. Nothing the person does to the
    /// app or its windows does: the rest goes wherever it naturally goes. An
    /// explicit remote take-over still revokes this batch's authority.
    @WorkActor func deliveryCheck(_ binding: Binding, restarted: String)
      -> @Sendable () throws -> Void
    {
      let cancellation = cancellation, budget = budget, saved = savedCheck, owner = ownerCheck
      let unlocked = requireUnlocked, stamp = binding.stamp, readStamp = self.stamp
      return {
        try cancellation.check(); try owner(); try budget.check(); try saved(); try unlocked()
        try AppProcess.requireSame(stamp, restarted, readStamp: readStamp)
      }
    }

    /// Between parts of input already going out: `deliveryCheck`, and what
    /// the person sees for the next part.
    @WorkActor func deliveryStep(
      _ binding: Binding, restarted: String, showing shown: OverlayFeedback
    ) async throws {
      let check = deliveryCheck(binding, restarted: restarted)
      try check()
      guard let feedback, shown == .pulse || binding.onScreen else { return }
      await feedback.show(shown, in: app)
      try check()
    }

    /// One keyboard action's events: everything `deliveryGate` refuses before
    /// the first goes out, then only `deliveryCheck`.
    @WorkActor func keyboardGate(_ binding: Binding, restarted: String)
      -> @Sendable () throws -> Void
    {
      let before = deliveryGate(binding, restarted: restarted, event: true)
      let during = deliveryCheck(binding, restarted: restarted)
      let started = Locked(false)
      return {
        if started.current { return try during() }
        try before()
        started.withLock { $0 = true }
      }
    }

    /// Between the steps of one action: `Stop`, the clocks, and the process.
    ///
    /// Every route calls it immediately before the call that changes the
    /// app — after any Accessibility read, pointer travel or other hop that
    /// could have waited — so a `Stop` or a deadline that lands while the
    /// route was still looking is honoured before anything is changed.
    @WorkActor func checkStep(_ binding: Binding, restarted: String) throws {
      try cancellation.check()
      try ownerCheck()
      try budget.check()
      try savedCheck()
      try requireUnlocked()
      try AppProcess.requireSame(binding.stamp, restarted, readStamp: stamp)
      if let bound = binding.bound {
        _ = try SessionWindows.resolve(app: app, ref: bound.ref, monitor: monitor)
        let current = try WindowGroup.resolve(
          window: bound.element, process: bound.process,
          lifecycleRevision: monitor.observationRevision(
            processIdentifier: binding.processIdentifier), previous: binding.group,
          liveness: bound.liveness,
          check: {
            try cancellation.check(); try budget.check()
          })
        if let blocker = current.blockedBy.first { throw blocker.refusal }
      }
      try deliveryGate(binding, restarted: restarted, markDelivery: false)()
    }

    /// The step check, then what the person sees for the write about to
    /// happen, so a step `Stop` ended shows no ripple for a click that never
    /// came. Showing it hops to the main actor, so the check runs again
    /// after it, immediately before the write. A click or a scroll is drawn
    /// only where the pointer is; a pulse goes wherever there is a pointer.
    @WorkActor func checkStep(_ binding: Binding, restarted: String, showing shown: OverlayFeedback)
      async throws
    {
      try checkStep(binding, restarted: restarted)
      guard let feedback, shown == .pulse || binding.onScreen else { return }
      await feedback.show(shown, in: app)
      try checkStep(binding, restarted: restarted)
    }
  }

  /// Returns what the action did, in the words `performed` carries.
  private static func perform(
    _ action: ActionRequest, _ context: Context,
    savedBatch: PreparedLoginBatch?, index: Int
  ) async throws -> String {
    // The full identity check, once per action; its steps then only confirm
    // they are still talking to this very process.
    let processIdentifier =
      try context.app.currentWindow.map { bound in
        _ = try SessionWindows.resolve(app: context.app, ref: bound.ref, monitor: context.monitor)
        return try AppProcess.verify(context.app)
      } ?? AppProcess.verifyObserved(context.app, readStamp: context.stamp)
    let binding = try binding(
      app: context.app, processIdentifier: processIdentifier, monitor: context.monitor,
      check: {
        try context.cancellation.check(); try context.budget.check()
      }, isHidden: context.isHidden)

    // The app is in the guard's care before anything reaches it, whatever the
    // route: a menu that an AXPress opens takes the keyboard too.
    guard context.app.focus.enforcer(for: processIdentifier) != nil else {
      throw FocusEnforcer.unguarded
    }

    switch action {
    case .click(let target, let button, let count):
      return try await click(
        target: target, button: button, count: count, binding: binding, context)
    case .type(let text, let target):
      return try await type(text: text, target: target, binding: binding, context)
    case .savedText(_, let target):
      guard let savedBatch else { throw LoginEnvelopeCrypto.refusal }
      let value = try savedBatch.open(index: index)
      return try await type(
        text: value.text, target: target, binding: binding, context,
        savedField: value.field, savedCheck: { try savedBatch.check(index: index) })
    case .key(let keys):
      return try await key(keys: keys, binding: binding, context)
    case .setValue(let index, let value):
      return try await setValue(index: index, value: value, binding: binding, context)
    case .scroll(let target, let direction, let amount):
      return try await scroll(
        target: target, direction: direction, amount: amount, binding: binding, context)
    }
  }

  // MARK: - Binding an action to the observed window

  struct Binding {
    let processIdentifier: pid_t
    /// The process the action's identity check verified.
    var stamp: ProcessStamp?
    /// The key window as it is now; the observation's coordinates are
    /// relative to it.
    let keyWindow: ObservedWindow
    /// The app's windows the observation saw, front to back.
    var windows: [ObservedWindow] = []
    /// On the Space being shown, so the drawn pointer can travel to it.
    var onScreen = true
    /// The person hid the app (Command-H). Accessibility still reads and
    /// presses its elements, but posted mouse and keyboard events are dropped
    /// without a trace, so those routes refuse rather than report a success.
    var hidden = false
    var bound: SessionWindow? = nil
    var group: WindowGroup? = nil

    init(
      processIdentifier: pid_t, stamp: ProcessStamp? = nil, windowID: CGWindowID,
      windowFrame: CGRect, windows: [ObservedWindow] = [], onScreen: Bool = true,
      hidden: Bool = false
    ) {
      self.processIdentifier = processIdentifier
      self.stamp = stamp
      keyWindow = ObservedWindow(windowID: windowID, frame: windowFrame)
      self.windows = windows
      self.onScreen = onScreen
      self.hidden = hidden
    }

    var windowFrame: CGRect { keyWindow.frame }
  }

  nonisolated static let hiddenAppRefusal = HelperError(
    .unsupported,
    "The app is hidden, so clicks and typing would not reach it; ask the person to show it."
  )

  /// Checked before any mouse or keyboard event is posted, never after.
  nonisolated static func requireEventDelivery(_ binding: Binding) throws {
    if binding.hidden { throw hiddenAppRefusal }
  }

  /// Invariant 6: the window an action lands in must still be the window that
  /// was observed. A window that changed identity fails `stale-observation`.
  static func binding(
    app: AppSessionState,
    processIdentifier: pid_t,
    monitor: WindowMonitor, check: () throws -> Void = {},
    isHidden: @Sendable (pid_t) -> Bool = {
      NSRunningApplication(processIdentifier: $0)?.isHidden == true
    }
  ) throws -> Binding {
    if let bound = app.currentWindow {
      _ = try SessionWindows.resolve(app: app, ref: bound.ref, monitor: monitor)
      let group = try WindowGroup.resolve(
        window: bound.element, process: bound.process,
        lifecycleRevision: monitor.observationRevision(processIdentifier: processIdentifier),
        previous: bound.group, liveness: bound.liveness, check: check)
      if let blocked = group.blockedBy.first { throw blocked.refusal }
      var result = Binding(
        processIdentifier: processIdentifier, stamp: bound.process,
        windowID: bound.windowID, windowFrame: group.root.frame,
        windows: bound.latest?.windows ?? group.members.map(\.window),
        onScreen: !group.alone, hidden: group.signature.hidden)
      result.bound = bound
      result.group = group
      return result
    }
    guard let latest = app.latest else {
      throw HelperError(.staleObservation, "Observe this window first.")
    }
    guard latest.processIdentifier == processIdentifier else {
      throw HelperError(
        .staleObservation, "This app restarted since it was observed; observe again.")
    }
    if let reason = monitor.staleReason(
      processIdentifier: processIdentifier, windowID: latest.windowID)
    {
      throw HelperError(.staleObservation, reason.message)
    }
    return Binding(
      processIdentifier: processIdentifier, stamp: app.verified,
      windowID: latest.windowID, windowFrame: latest.windowFrame, windows: latest.windows,
      onScreen: KeyWindow.isOnScreen(latest.windowID),
      hidden: isHidden(processIdentifier))
  }

  /// The window a point lands in, and the point inside it. A point over a
  /// popover, a menu, a child window or an open panel belongs to that window,
  /// not the key window, and the event names the window it lands in.
  static func eventTarget(for screenPoint: CGPoint, binding: Binding) throws -> EventTarget {
    let observedWindows = binding.windows.isEmpty ? [binding.keyWindow] : binding.windows
    guard let window = observedWindows.first(where: { $0.frame.contains(screenPoint) }) else {
      throw HelperError(.failed, "That point is outside this window's members.")
    }
    let frame: CGRect
    if let group = binding.group {
      guard group.crop.contains(screenPoint),
        group.members.first(where: { $0.window.frame.contains(screenPoint) })?.window.windowID
          == window.windowID,
        let current = group.members.first(where: { $0.window.windowID == window.windowID }),
        current.window.frame == window.frame,
        KeyWindow.captureState(window.windowID, processIdentifier: binding.processIdentifier)?.frame
          == window.frame
      else {
        throw HelperError(
          .staleObservation,
          "The part of this app at that point changed since it was observed; observe again.")
      }
      frame = current.window.frame
    } else if window.windowID == binding.keyWindow.windowID {
      frame = binding.keyWindow.frame
    } else {
      guard let current = KeyWindow.currentFrame(window.windowID), current == window.frame else {
        throw HelperError(
          .staleObservation,
          "The part of this app at that point changed since it was observed; observe again.")
      }
      frame = current
    }
    return EventTarget(
      processIdentifier: binding.processIdentifier,
      windowID: window.windowID,
      screenPoint: screenPoint,
      windowPoint: CGPoint(x: screenPoint.x - frame.minX, y: screenPoint.y - frame.minY))
  }

  static func keyboardWindow(_ binding: Binding, focused: CGWindowID?) -> CGWindowID {
    guard let group = binding.group else { return focused ?? binding.keyWindow.windowID }
    if let focused, group.members.contains(where: { $0.window.windowID == focused }) { return focused }
    let app = AXUIElementCreateApplication(binding.processIdentifier)
    if let window = AXValueReader.copyElement(app, kAXFocusedWindowAttribute),
      let id = KeyWindow.windowID(of: window), group.members.contains(where: { $0.window.windowID == id }) { return id }
    if let root = binding.bound?.element,
      let sheet = AXElementNode.children(of: root).first(where: { AXValueReader.copyString($0, kAXRoleAttribute) == kAXSheetRole }),
      let id = KeyWindow.windowID(of: sheet), group.members.contains(where: { $0.window.windowID == id }) { return id }
    return binding.keyWindow.windowID
  }

  static func requirePersonWindow(_ binding: Binding) throws {
    guard binding.bound != nil, PrivateAPI.focusPID(front: true) == binding.processIdentifier else {
      return
    }
    let app = AXUIElementCreateApplication(binding.processIdentifier)
    guard let focused = AXValueReader.copyElement(app, kAXFocusedWindowAttribute),
      let id = KeyWindow.windowID(of: focused),
      binding.group?.members.contains(where: { $0.window.windowID == id }) == true
    else {
      throw HelperError(
        .ownerInControl, "The person is using another window of this app; no keys were sent.")
    }
  }

  static func revalidate(_ destination: EventTarget, binding: Binding, context: Context) throws {
    guard let bound = binding.bound else { return }
    let current = try WindowGroup.resolve(
      window: bound.element, process: bound.process,
      lifecycleRevision: context.monitor.observationRevision(
        processIdentifier: binding.processIdentifier), previous: binding.group,
      liveness: bound.liveness,
      check: {
        try context.cancellation.check(); try context.budget.check()
      })
    guard
      let expected = binding.group?.members.first(where: {
        $0.window.windowID == destination.windowID
      }),
      let actual = current.members.first(where: { $0.window.windowID == destination.windowID }),
      expected.window.frame == actual.window.frame,
      current.crop.contains(destination.screenPoint),
      current.members.first(where: { $0.window.frame.contains(destination.screenPoint) })?.window
        .windowID == destination.windowID
    else {
      throw HelperError(
        .staleObservation,
        "The part of this app at that point changed since it was observed; observe again.")
    }
  }

  static func requireElement(
    _ element: AXUIElement, binding: Binding, check: @Sendable () throws -> Void = {}
  ) throws {
    guard binding.bound != nil else { return }
    try check()
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success,
      let bound = binding.bound
    else {
      throw HelperError(.staleObservation, "That element is no longer available; observe again.")
    }
    let current = try WindowGroup.resolve(
      window: bound.element, process: bound.process,
      lifecycleRevision: binding.group?.signature.lifecycle ?? 0, previous: binding.group,
      liveness: bound.liveness, check: check)
    try check()
    if let blocker = current.blockedBy.first { throw blocker.refusal }
    guard let owner = windowID(containing: element),
      current.members.contains(where: { $0.window.windowID == owner }),
      let frame = AXValueReader.copyFrame(element), frame.intersects(current.crop)
    else {
      throw HelperError(.staleObservation, "That element is outside this window's current members.")
    }
    if let latest = bound.latest,
      let observed = latest.elements.first(where: {
        ($0.node as? AXElementNode).map { CFEqual($0.element, element) } == true
      })
    {
      let point = screenPoint(
        for: CGPoint(x: observed.frame.midX, y: observed.frame.midY), in: latest.windowFrame)
      guard current.crop.contains(point), frame.contains(point),
        current.members.first(where: { $0.window.frame.contains(point) })?.window.windowID == owner
      else {
        throw HelperError(
          .staleObservation, "That element moved since it was observed; observe again.")
      }
    }
  }

  // MARK: - Actions

  static func click(
    target: ActionTarget,
    button: MouseButton,
    count: Int,
    binding: Binding,
    _ context: Context
  ) async throws -> String {
    let app = context.app
    let resolved = try resolve(target: target, app: app, binding: binding)
    let description = ActionDescription.click(
      button: button, count: count, element: resolved.named, point: resolved.pixelPoint)
    let restarted = "This app restarted while it was being clicked."

    // The route is decided here, once.
    let route = clickRoute(
      role: resolved.role, button: button, count: count,
      offersPress: resolved.element.map(context.accessibility.offersPress) == true)
    let destination: EventTarget?
    if route == .synthetic {
      try requireEventDelivery(binding)
      destination = try eventTarget(for: resolved.screenPoint, binding: binding)
    } else {
      destination = nil
    }
    await travel(to: resolved.screenPoint, binding: binding, context)

    if route == .press, let element = resolved.element {
      // `Stop` may have come while the pointer was on its way.
      try await context.checkStep(binding, restarted: restarted, showing: .click)
      let press = { (proceed: @Sendable () throws -> Void) in
        try context.validateElement(element, binding, restarted: restarted)
        try proceed()
        try context.deliveryGate(binding, restarted: restarted)()
        context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
        if let error = pressOutcome(
          context.accessibility.press(element),
          whatMayHaveHappened: "the click happened",
          failure: "This element could not be pressed."
        ) {
          throw error
        }
      }
      // A press can bring the app or one of its windows forward — a link that
      // opens a tab, a pop-up button ordering its window in front — so it is
      // watched and sent back. Only a Chromium app is told it is active first;
      // the screen is not held for an ordinary click.
      try await guarded(
        EventTarget(
          processIdentifier: binding.processIdentifier, windowID: binding.keyWindow.windowID),
        prepare: ChromiumDetection.isChromiumLike(
          bundlePath: app.path, bundleId: app.identity.bundleId),
        binding: binding, context, restarted: restarted
      ) { _, proceed in try press(proceed) }
      return description
    }
    guard let destination else { return description }
    try await guarded(
      destination, prepare: needsAttention(resolved, app: app),
      binding: binding, context, restarted: restarted
    ) { _, proceed in
      try await postClick(
        destination, button: button, count: count, binding: binding, context,
        restarted: restarted, proceed: proceed)
    }
    if (try? AppProcess.requireSame(binding.stamp, "", readStamp: context.stamp)) == nil {
      throw HelperError(
        .appNotRunning, "\(app.identity.displayName) quit while it was being clicked.")
    }
    return description
  }

  /// The drawn pointer goes to where the input lands, inside the window it
  /// lands in, and input waits for it to arrive. A window on another Space
  /// gets no pointer: there it would point at nothing the person can see.
  static func travel(to screenPoint: CGPoint, binding: Binding, _ context: Context) async {
    guard binding.onScreen, let overlay = context.overlay else { return }
    let window = AppWindows.window(
      at: screenPoint, among: binding.windows, keyWindow: binding.keyWindow)
    await overlay.movePointer(
      in: context.app, toScreenPoint: screenPoint, window: window.windowID,
      keyWindow: binding.keyWindow.windowID)
  }

  /// Move, then down and up for each click of the count. A mouse-up always
  /// goes to the process that received its mouse-down, even after Stop. The
  /// process stamp still prevents releasing into a reused pid.
  static func postClick(
    _ destination: EventTarget,
    button: MouseButton,
    count: Int,
    binding: Binding,
    _ context: Context,
    restarted: String,
    proceed: @escaping @Sendable () throws -> Void = {}
  ) async throws {
    let gate = context.deliveryGate(binding, restarted: restarted, event: true)
    try context.checkStep(binding, restarted: restarted)
    try revalidate(destination, binding: binding, context: context)
    context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
    try await context.input.mouse(
      .mouseMoved, destination, .left, 0, 0,
      {
        try proceed(); try gate()
      })
    try? await Task.sleep(nanoseconds: moveToDownDelay)

    let types = await SyntheticEvents.mouseTypes(button)
    for click in 1...count {
      try context.checkStep(binding, restarted: restarted)
      try revalidate(destination, binding: binding, context: context)
      try await context.input.mouse(
        types.down, destination, button, click, 1,
        {
          try proceed(); try gate()
        })
      if binding.onScreen { await context.feedback?.show(.click, in: context.app) }
      try? await Task.sleep(nanoseconds: downToUpDelay)
      let stamp = binding.stamp, readStamp = context.stamp
      try await context.input.mouse(
        types.up, destination, button, click, 0,
        { try AppProcess.requireSame(stamp, restarted, readStamp: readStamp) })
    }
  }

  /// Input delivered so the person keeps the front app and the keyboard
  /// (`FocusEnforcer.guarded`). With `prepare`, the app is first told it is
  /// active with the key-capable window that owns `destination` key, and
  /// `deliver` is given that window for keys; `keys` says the input goes to
  /// the app's key window, so that window must be key. `precondition` is
  /// checked with the session, up to the moment the input goes out. An app
  /// sent back after coming forward while the screen was held is not reported
  /// as having come forward: the person never saw it.
  @discardableResult
  static func guarded<Result>(
    _ destination: EventTarget, prepare: Bool, keys: Bool = false,
    binding: Binding, _ context: Context, restarted: String,
    precondition: @escaping @Sendable () throws -> Void = {},
    deliver: (EventTarget, _ proceed: @escaping @Sendable () throws -> Void) async throws -> Result
  ) async throws -> Result {
    let pid = binding.processIdentifier
    let owner = prepare ? try context.keyOwner(pid, destination.windowID) : nil
    guard let enforcer = context.app.focus.enforcer(for: pid) else {
      throw FocusEnforcer.unguarded
    }
    let keyTarget =
      owner.map { EventTarget(processIdentifier: pid, windowID: $0.id) } ?? destination
    context.monitor.noteHelperInput(processIdentifier: pid)
    if let owner { context.monitor.notePrimedWindow(processIdentifier: pid, windowID: owner.id) }
    let finalGate = context.deliveryGate(binding, restarted: restarted, markDelivery: false)
    return try await enforcer.guarded(
      window: owner?.element, prepare: prepare, keys: keys,
      finalCheck: {
        try finalGate(); try precondition()
      },
      deliveryCheck: context.deliveryCheck(binding, restarted: restarted),
      check: {
        try context.checkStep(binding, restarted: restarted)
        try precondition()
      },
      prepared: { unseen in
        // Only preparation's own round trip, before the input can cause one.
        if unseen { context.monitor.forgetActivation(processIdentifier: pid) }
      },
      deliver: { proceed in try await deliver(keyTarget, proceed) })
  }

  /// Codex's rule for which background clicks need the app to believe it is
  /// active first: a click into web content, or into text a click may select.
  /// Any other click lands the same either way.
  static func needsAttention(_ resolved: ResolvedTarget, app: AppSessionState) -> Bool {
    if let role = resolved.role ?? resolved.named?.role, selectingRoles.contains(role) {
      return true
    }
    guard let latest = app.latest else { return false }
    return latest.elements.contains {
      $0.attributes.role == "AXWebArea" && $0.frame.contains(resolved.windowPoint)
    }
  }

  nonisolated static let selectingRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXStaticText", "AXWebArea",
    "AXMenuButton",
  ]

  /// How `type` delivers its text.
  public enum TypeRoute: Equatable, Sendable {
    /// `AXSelectedText` on the focused element: the text replaces the
    /// selection, or is inserted at the caret when nothing is selected —
    /// exactly what typing does — through the app's own text system, with no
    /// keyboard event and no window to route one to.
    case accessibility
    /// Keyboard events posted to the process, stamped with the focused
    /// element's window.
    case keyboard
  }

  /// Decided once, after the target is focused and before any text goes out.
  ///
  /// `AXValue` is never used to type. Writing it replaces the whole content:
  /// in rich text it drops styling and attachments, in a web field it skips
  /// the input events a page listens for, and it can move the caret — so it
  /// is never "the same as typing", and `setValue` is the action for it.
  /// Line breaks and tabs are keys a person presses — Return submits a field,
  /// Tab moves on — so text that holds them goes by keyboard.
  public nonisolated static func typeRoute(text: String, selectedTextSettable: Bool) -> TypeRoute {
    guard selectedTextSettable else { return .keyboard }
    let pressesKeys = text.unicodeScalars.contains {
      $0 == "\n" || $0 == "\r" || $0 == "\t"
    }
    return pressesKeys ? .keyboard : .accessibility
  }

  /// Refused with nothing typed: the named field could not receive the text.
  static let unreceived = HelperError(
    .unsupported, "That field did not take the text, so nothing was typed; click it first.")
  /// After part of the text went in as keys: the field stopped holding the
  /// focus, or changed, so the rest was not sent.
  static let focusLost = HelperError(
    .staleObservation, "That field stopped holding the keyboard focus, so the rest was not typed.")
  /// Refused with nothing typed: the focused field did not say what it is.
  static let unreadableFocus = HelperError(
    .staleObservation,
    "The focused field did not answer, so nothing was typed; observe again and name the field.")

  /// The element's own selection takes the text, or, for a secure field, its
  /// value is set. Otherwise the element takes AX focus and, only once the app
  /// reports that element itself as focused, the text goes as keys, each one
  /// sent only while it still is. Never a click or whatever else has focus.
  static func typeExact(
    _ text: String, into element: AXUIElement?, observed: ElementAttributes?,
    screenPoint: CGPoint?, binding: Binding, _ context: Context, restarted: String,
    savedField: LoginField?
  ) async throws -> String {
    let calls = context.accessibility
    let app = context.app
    guard let element else { throw unreceived }
    let live = calls.attributes(element)
    let secure = observed.map(ActionDescription.isSecure) == true || ActionDescription.isSecure(live)
    // Chromium drops an AXSelectedText write from a background app, and Return,
    // Tab or a newline would need keys that land wherever focus moves.
    let chromium = ChromiumDetection.isChromiumLike(
      bundlePath: app.path, bundleId: app.identity.bundleId)
    guard !chromium, typeRoute(text: text, selectedTextSettable: true) == .accessibility else {
      throw unreceived
    }
    // A native secure field in a background app, such as AppKit's, takes
    // neither AX write; keys are its only route (`nil` here).
    let attribute: String?
    if calls.isSettable(element, kAXSelectedTextAttribute) {
      attribute = kAXSelectedTextAttribute
    } else if secure, calls.isSettable(element, kAXValueAttribute) {
      attribute = kAXValueAttribute
    } else if secure, calls.isSettable(element, kAXFocusedAttribute) {
      try requireEventDelivery(binding)
      attribute = nil
    } else {
      throw unreceived
    }
    // Selected text goes in where the field's own focus puts it; a value
    // replaces the field. Every write follows the gates, which run again after
    // focusing, so a Stop or an expired lease meanwhile still sends nothing.
    let focusFirst = attribute != kAXValueAttribute && calls.isSettable(element, kAXFocusedAttribute)
    let gate = {
      try await context.checkStep(binding, restarted: restarted, showing: .pulse)
      try requirePersonWindow(binding)
      try context.validateElement(element, binding, restarted: restarted)
      try context.deliveryGate(binding, restarted: restarted)()
    }
    if let screenPoint { await travel(to: screenPoint, binding: binding, context) }
    await context.overlay?.typingStarted(in: app)
    do {
      try await gate()
      context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
      if focusFirst {
        if let error = axMutationOutcome(
          calls.setAttribute(element, kAXFocusedAttribute, kCFBooleanTrue),
          whatMayHaveHappened: "the element took the focus",
          failure: "This element did not take the keyboard focus; click it first.")
        {
          throw error
        }
        try await gate()
      }
      if let attribute {
        if let error = axMutationOutcome(
          calls.setAttribute(element, attribute, text as CFTypeRef),
          whatMayHaveHappened: "the text was typed", failure: "This element did not accept the text.")
        {
          throw error
        }
      } else {
        // Focusing a field in a background app can leave the app's focus on
        // another field, which is where keys would go: that refuses here, and
        // `typeByKeyboard` checks again before every key.
        let applicationElement = AXUIElementCreateApplication(binding.processIdentifier)
        guard let focused = calls.focusedElement(applicationElement), CFEqual(focused, element) else {
          throw unreceived
        }
        try await typeByKeyboard(
          text,
          destination: EventTarget(
            processIdentifier: binding.processIdentifier,
            windowID: keyboardWindow(binding, focused: calls.window(element))),
          binding: binding, context, restarted: restarted, saved: savedField != nil,
          exact: element)
      }
    } catch {
      await context.overlay?.typingEnded(in: app)
      throw error
    }
    await context.overlay?.typingEnded(in: app)
    if let savedField { return SavedLoginInput.receipt(savedField) }
    return ActionDescription.type(text: text, field: observed, focused: [live], redact: true)
  }

  static func type(
    text: String,
    target: ActionTarget?,
    binding: Binding,
    _ context: Context,
    savedField: LoginField? = nil,
    savedCheck: @escaping @Sendable () throws -> Void = {}
  ) async throws -> String {
    var context = context
    if savedField != nil {
      try SavedLoginInput.validate(text)
      try savedCheck()
      context.savedCheck = savedCheck
    }
    try requirePersonWindow(binding)
    let app = context.app
    let calls = context.accessibility
    let applicationElement = AXUIElementCreateApplication(binding.processIdentifier)
    AXUIElementSetMessagingTimeout(applicationElement, axMessagingTimeout)

    // Focus first, when the batch names where the text goes. An element is
    // focused through Accessibility, which moves the app's keyboard focus
    // without activating it. Observed controls at a point use the same AX
    // route; a target that cannot take focus that way is clicked.
    let restarted = "This app restarted while text was being typed."
    // A saved value, or text for a secure field, goes only into the element the
    // act names, by Accessibility, or nothing is typed. Focusing a secure field
    // in a background app can leave the app's focus elsewhere; falling back to
    // that element put a saved password into a plain field, where every later
    // observation showed it. Keys or a click could likewise land in another field.
    // Resolved once, so the element that decides the path is the one that
    // receives the text; a failed resolution refuses rather than looking plain.
    let named = try target.map { try resolve(target: $0, app: app, binding: binding) }
    let secureNamed =
      named?.named.map(ActionDescription.isSecure) == true
      || named?.element.map { ActionDescription.isSecure(calls.attributes($0)) } == true
    if savedField != nil || secureNamed {
      return try await typeExact(
        text, into: named?.element, observed: named?.named, screenPoint: named?.screenPoint,
        binding: binding, context, restarted: restarted, savedField: savedField)
    }
    // Text with no target goes where the app's focus is. One read of that focus
    // decides the path and is the element that receives the text, so focus
    // moving to a secure field meanwhile cannot redirect it. A secure field takes
    // it the same exact way, never as keys that a Tab carries elsewhere, and a
    // field whose role does not answer may be secure, so nothing is typed.
    let untargetedFocus = target == nil ? calls.focusedElement(applicationElement) : nil
    if let focused = untargetedFocus {
      let live = calls.attributes(focused)
      if ActionDescription.readable([live]).isEmpty { throw unreadableFocus }
      if ActionDescription.isSecure(live) {
        return try await typeExact(
          text, into: focused, observed: nil, screenPoint: nil, binding: binding, context,
          restarted: restarted, savedField: nil)
      }
    }
    var focusedTarget: AXUIElement?
    var clickedWindow: CGWindowID?
    var clickedPoint: CGPoint?
    var field: ElementAttributes?
    if let target, let resolved = named {
      if case .index = target { field = resolved.named }
      if let element = resolved.element, calls.isSettable(element, kAXFocusedAttribute) {
        await travel(to: resolved.screenPoint, binding: binding, context)
        try context.checkStep(binding, restarted: restarted)
        context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
        try requirePersonWindow(binding)
        try context.validateElement(element, binding, restarted: restarted)
        try context.deliveryGate(binding, restarted: restarted)()
        let status = calls.setAttribute(element, kAXFocusedAttribute, kCFBooleanTrue)
        if let error = axMutationOutcome(
          status, whatMayHaveHappened: "the element took the focus",
          failure: "This element did not take the keyboard focus; click it first.")
        {
          throw error
        }
        focusedTarget = element
      } else {
        try requireEventDelivery(binding)
        let destination = try eventTarget(for: resolved.screenPoint, binding: binding)
        await travel(to: resolved.screenPoint, binding: binding, context)
        try await guarded(
          destination, prepare: needsAttention(resolved, app: app),
          binding: binding, context, restarted: restarted
        ) { _, proceed in
          try await postClick(
            destination, button: .left, count: 1, binding: binding, context,
            restarted: restarted, proceed: proceed)
        }
        clickedWindow = destination.windowID
        clickedPoint = resolved.screenPoint
      }
      try context.checkStep(binding, restarted: restarted)
    }

    // The element the text goes into: the one this action focused, else
    // whatever the app reports as focused after the earlier actions, or, with
    // no target, the focus read above.
    let reportedFocused =
      target == nil ? untargetedFocus : calls.focusedElement(applicationElement)
    let appFocused = reportedFocused.flatMap { element -> AXUIElement? in
      if binding.group == nil { return element }
      guard let id = calls.window(element),
        binding.group?.members.contains(where: { $0.window.windowID == id })
          ?? (id == binding.keyWindow.windowID)
      else { return nil }
      return element
    }
    if case .point = target, let clickedWindow, let clickedPoint {
      // A point names the field at that point, not whichever field happened
      // to have focus beforehand. A non-key child window may accept the click
      // without moving AX focus; sending text to the old field would silently
      // edit the wrong part of the app.
      guard let appFocused,
        calls.window(appFocused) == clickedWindow,
        calls.attributes(appFocused).frame?.contains(clickedPoint) == true
      else {
        throw HelperError(
          .unsupported,
          "That point did not take keyboard focus; target the field by index."
        )
      }
    }
    // Chromium accepts an AXSelectedText write from a background app and then
    // drops it, so its text goes in as keystrokes to the primed key window.
    let chromium = ChromiumDetection.isChromiumLike(
      bundlePath: app.path, bundleId: app.identity.bundleId)
    let receiver =
      chromium
      ? nil
      : [focusedTarget, appFocused].compactMap { $0 }.first {
        calls.isSettable($0, kAXSelectedTextAttribute)
      }
    let route = typeRoute(text: text, selectedTextSettable: receiver != nil)
    let focused = focusedTarget ?? appFocused
    // A point names no field; the element that has the focus does. Both the
    // element this action focused and the one the app now reports as focused
    // are read, because focusing can land somewhere else — a secure field
    // among them keeps the text out of the sentence.
    var focusedAttributes = [focusedTarget, appFocused].compactMap { $0 }.map(calls.attributes)
    var unverifiedReceiver = false
    let keyboardWindow =
      keyboardWindow(binding, focused: focused.flatMap(calls.window) ?? clickedWindow)
    if route == .keyboard { try requireEventDelivery(binding) }

    await context.overlay?.typingStarted(in: app)
    do {
      if route == .accessibility, let receiver {
        try await context.checkStep(binding, restarted: restarted, showing: .pulse)
        try requirePersonWindow(binding)
        if let actual = receiptReceiver(
          receiver, preparedWindow: calls.window(receiver) ?? 0, calls: calls)
        {
          focusedAttributes.append(actual)
        } else {
          unverifiedReceiver = true
        }
        try context.validateElement(receiver, binding, restarted: restarted)
        try context.deliveryGate(binding, restarted: restarted)()
        context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
        if let error = axMutationOutcome(
          calls.setAttribute(receiver, kAXSelectedTextAttribute, text as CFTypeRef),
          whatMayHaveHappened: "the text was typed",
          failure: "This element did not accept the text.")
        {
          throw error
        }
      } else {
        try await typeByKeyboard(
          text,
          destination: EventTarget(
            processIdentifier: binding.processIdentifier, windowID: keyboardWindow),
          binding: binding, context, restarted: restarted, saved: savedField != nil)
      }
    } catch {
      await context.overlay?.typingEnded(in: app)
      throw error
    }
    await context.overlay?.typingEnded(in: app)
    if let savedField { return SavedLoginInput.receipt(savedField) }
    if route == .keyboard {
      // AX focus samples cannot establish a stable receiver between posted
      // keys. Tab/Return and app callbacks can move into a secure field.
      return ActionDescription.type(text: text, field: nil, redact: true)
    }
    return ActionDescription.type(
      text: text, field: field, focused: focusedAttributes, redact: unverifiedReceiver)
  }

  /// Key by key, as the person's layout types it. Before the first key,
  /// everything that refuses with nothing sent; once keys go out they all go
  /// out, wherever the keyboard is, and the person may use the app meanwhile.
  /// `Stop`, the clocks and the process are still checked every few keys: a
  /// long `type` is the thing a person is most likely to want stopped half way.
  static func typeByKeyboard(
    _ text: String,
    destination: EventTarget,
    binding: Binding,
    _ context: Context,
    restarted: String,
    saved: Bool = false,
    exact: AXUIElement? = nil
  ) async throws {
    let unicode = saved || exact != nil
    let presses = unicode ? [] : await VirtualKeys.presses(for: text)
    let pacing = typingPacing(for: context.app.identity.bundleId)
    let calls = context.accessibility
    // Text for one exact element goes only while the app still reports that
    // element as focused, the element still validates and the person's window
    // is unchanged, checked before every chunk. After the first chunk a
    // mismatch is a partial failure, not "nothing was typed".
    let onExact = { (sent: Bool) in
      guard let exact else { return }
      let app = AXUIElementCreateApplication(binding.processIdentifier)
      guard let focused = calls.focusedElement(app), CFEqual(focused, exact) else {
        throw sent ? focusLost : unreceived
      }
      try requirePersonWindow(binding)
      try context.validateElement(exact, binding, restarted: restarted)
    }
    // Long text would hold the person's screen: updates are held only while
    // the app is prepared, and the keys go out with the screen live.
    return try await guarded(
      destination, prepare: true, keys: true, binding: binding, context, restarted: restarted
    ) { destination, proceed in
      let app = AXUIElementCreateApplication(binding.processIdentifier)
      let actual = context.accessibility.focusedElement(app)
      if let actual, let owner = context.accessibility.window(actual), let group = binding.group,
        !group.members.contains(where: { $0.window.windowID == owner })
      {
        throw HelperError(
          .staleObservation, "The prepared keyboard receiver is outside this window's members.")
      }
      try await context.checkStep(binding, restarted: restarted, showing: .pulse)
      try proceed()
      let gate = context.keyboardGate(binding, restarted: restarted)
      // Saved login text, and text for one exact element, goes only as
      // unicode payloads (`TextChunker`).
      if unicode {
        for (index, chunk) in TextChunker.chunks(text).enumerated() {
          if index > 0 {
            try await context.deliveryStep(binding, restarted: restarted, showing: .pulse)
          } else {
            // Last before the first key: the person may have made another
            // window key while the step check waited.
            try requirePersonWindow(binding)
          }
          try onExact(index > 0)
          context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
          try await context.input.unicode(
            chunk, destination, pacing,
            {
              try proceed(); try gate()
            })
        }
        return
      }
      for start in stride(from: 0, to: presses.count, by: keysBetweenChecks) {
        if start > 0 {
          try await context.deliveryStep(binding, restarted: restarted, showing: .pulse)
        }
        context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
        // Last before the first key: the person may have made another window
        // key while the step check waited.
        if start == 0 { try requirePersonWindow(binding) }
        for press in presses[start..<min(start + keysBetweenChecks, presses.count)] {
          try await context.input.press(
            press.virtualKey, press.flags, press.characters,
            destination, pacing,
            {
              try proceed(); try gate()
            })
        }
      }
    }
  }

  static func receiptReceiver(
    _ element: AXUIElement?, preparedWindow: CGWindowID, calls: AccessibilityCalls
  ) -> ElementAttributes? {
    guard let element, calls.window(element) == preparedWindow else {
      return nil
    }
    let attributes = calls.attributes(element)
    guard !attributes.role.isEmpty && attributes.role != "AXUnknown" else {
      return nil
    }
    return attributes
  }

  nonisolated static let keysBetweenChecks = 20
  /// A quarter of a millisecond after each event; iPhone Mirroring relays
  /// keys to the phone and needs five.
  nonisolated static func typingPacing(for bundleId: String) -> UInt64 {
    bundleId.lowercased() == "com.apple.screencontinuity" ? 5_000_000 : 250_000
  }

  nonisolated static let reservedShortcut = HelperError(
    .unsupported,
    "That shortcut belongs to macOS or its Services menu, not to this app, "
      + "so Opensteer does not press it.")

  nonisolated static let unverifiedShortcut = HelperError(
    .unsupported,
    "This app's menus could not be read in time, so Opensteer cannot rule out that this "
      + "shortcut runs a Services menu item and does not press it; observe again, or use "
      + "the app's own controls.")

  /// How a `key` is delivered.
  enum KeyRoute {
    case menuItem(AXUIElement)
    case keystroke
  }

  /// Decided once, from the menu index, before anything is pressed or posted.
  ///
  /// A shortcut the app's menus answer is that menu item pressed through AX: a
  /// background app runs it without coming forward, where a posted keystroke
  /// may not reach its main menu at all. A shortcut the index could not rule
  /// out fails closed when it carries a modifier a menu item or a service
  /// could answer to. A plain key — Return, Tab, an arrow, Escape, a letter,
  /// alone or with Shift — is typing rather than a shortcut, and goes out.
  nonisolated static func keyRoute(_ lookup: MenuShortcutIndex.Lookup, combo: KeyCombo) throws
    -> KeyRoute
  {
    switch lookup {
    case .reserved:
      throw reservedShortcut
    case .item(let item):
      return .menuItem(item)
    case .none:
      return .keystroke
    case .unverified:
      guard combo.modifiers.isDisjoint(with: [.cmd, .ctrl, .alt]) else {
        throw unverifiedShortcut
      }
      return .keystroke
    }
  }

  /// Chromium's commands that open or show a tab or window, which bring the
  /// browser to the front whatever it believes and however they are asked
  /// for: its default shortcuts for New Tab, New Window, New Incognito Window,
  /// Reopen Closed Tab, Settings, History, Downloads, Bookmark Manager and
  /// Clear Browsing Data.
  nonisolated static let browserShortcutsThatActivate: Set<String> = [
    "cmd+t", "cmd+n", "cmd+shift+n", "cmd+shift+t", "cmd+,", "cmd+y", "alt+cmd+l",
    "alt+cmd+b", "cmd+shift+delete",
  ]

  nonisolated static func browserWouldComeForward(_ combo: KeyCombo, appName: String)
    -> HelperError
  {
    HelperError(
      .unsupported,
      "\(appName) brings itself to the front for that, so Opensteer does not press "
        + "\(combo.display) while the person is in another app. Use the current tab instead: "
        + "press ⌘L, type the address, then press Return.")
  }

  static func key(keys: String, binding: Binding, _ context: Context) async throws -> String {
    try requirePersonWindow(binding)
    let combo = try KeyComboParser.parse(keys)
    let calls = context.accessibility
    let applicationElement = AXUIElementCreateApplication(binding.processIdentifier)
    AXUIElementSetMessagingTimeout(applicationElement, axMessagingTimeout)
    let restarted = "This app restarted while a key was being pressed."
    let chromium = ChromiumDetection.isChromiumLike(
      bundlePath: context.app.path, bundleId: context.app.identity.bundleId)
    // Pressed only while the browser is in front, from now until it goes out.
    let activates =
      ChromiumDetection.isChromiumBrowser(bundlePath: context.app.path)
      && browserShortcutsThatActivate.contains(MenuShortcutIndex.key(for: combo))
    let appName = context.app.identity.displayName, pid = binding.processIdentifier
    let inFront: @Sendable () throws -> Void = {
      if activates, PrivateAPI.focusPID(front: true) != pid {
        throw browserWouldComeForward(combo, appName: appName)
      }
    }
    try inFront()

    // The route is chosen here, before anything is pressed or posted, and a
    // failure never becomes a second attempt down the other one (invariant 6):
    // a menu item that reported a failure may still have run.
    let lookup = calls.menuLookup(context.app.menuShortcuts, combo, applicationElement)
    switch try keyRoute(lookup, combo: combo) {
    case .menuItem(let item):
      var path: [String] = []
      try await context.checkStep(binding, restarted: restarted, showing: .pulse)
      let press = {
        path = calls.menuPath(item)
        try requirePersonWindow(binding)
        try context.deliveryGate(binding, restarted: restarted)()
        context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
        if let error = pressOutcome(
          calls.press(item),
          whatMayHaveHappened: "the shortcut ran",
          failure: "This app's menu did not accept that shortcut."
        ) {
          throw error
        }
      }
      // A browser that believes its window is key runs the item for that
      // window; one that does not runs it at application level, which brings
      // the browser forward. Any app's item can bring a window forward, so
      // every press is watched.
      try await guarded(
        EventTarget(
          processIdentifier: binding.processIdentifier, windowID: keyboardWindow(binding, focused: nil)),
        prepare: chromium || binding.bound != nil, keys: chromium || binding.bound != nil,
        binding: binding, context, restarted: restarted, precondition: inFront
      ) { _, proceed in
        try proceed(); try inFront(); try press()
      }
      return ActionDescription.menu(path: path) ?? ActionDescription.keystroke(combo)
    case .keystroke:
      break
    }

    guard let code = await VirtualKeys.code(for: combo) else {
      throw HelperError(.unsupported, "This Mac's keyboard has no key for \(keys).")
    }
    try requireEventDelivery(binding)
    let focused = calls.focusedElement(applicationElement)
    let window = keyboardWindow(binding, focused: focused.flatMap(calls.window))
    try await context.checkStep(binding, restarted: restarted, showing: .pulse)
    try await guarded(
      EventTarget(processIdentifier: binding.processIdentifier, windowID: window),
      prepare: true, keys: true, binding: binding, context,
      restarted: restarted, precondition: inFront
    ) { destination, proceed in
      try context.checkStep(binding, restarted: restarted)
      try requirePersonWindow(binding)
      context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
      let gate = context.keyboardGate(binding, restarted: restarted)
      try await context.input.press(
        code, combo.flags, VirtualKeys.characters(for: combo),
        destination, nil,
        {
          try proceed(); try gate()
        })
    }
    return ActionDescription.keystroke(combo)
  }

  static func setValue(
    index: Int, value: String, binding: Binding, _ context: Context
  ) async throws -> String {
    _ = try resolve(target: .index(index), app: context.app, binding: binding)
    guard let latest = context.app.latest, latest.elements.indices.contains(index),
      let node = latest.elements[index].node as? AXElementNode
    else {
      throw HelperError(
        .staleObservation,
        "There is no element \(index) in the observation this cites."
      )
    }
    let observed = latest.elements[index]
    guard context.accessibility.isSettable(node.element, kAXValueAttribute) else {
      throw HelperError(.unsupported, "This element's value cannot be set directly; type into it.")
    }
    // The pointer goes to the element when it shows in the picture; a value
    // is set wherever the element is.
    let center = CGPoint(x: observed.frame.midX, y: observed.frame.midY)
    if latest.coordinates.contains(latest.coordinates.pixelPoint(from: center)) {
      await travel(
        to: screenPoint(for: center, in: binding.windowFrame), binding: binding, context)
    }
    // Read before the step check, like every read a route makes.
    try await context.checkStep(
      binding, restarted: "This app restarted while a value was being set.", showing: .pulse)
    let current = context.accessibility.attributes(node.element)
    try context.validateElement(
      node.element, binding, restarted: "This app restarted while a value was being set.")
    try context.deliveryGate(
      binding, restarted: "This app restarted while a value was being set.")()
    context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
    if let error = setValueOutcome(
      context.accessibility.setAttribute(node.element, kAXValueAttribute, value as CFTypeRef)
    ) {
      throw error
    }
    return ActionDescription.setValue(
      value: value, field: observed.attributes, current: current)
  }

  /// One tick per unit of `amount`, rather than one large jump: it reads like
  /// a person's scroll wheel in the preview, and it gives `Stop` somewhere to
  /// land inside a long scroll.
  static func scroll(
    target: ActionTarget,
    direction: ScrollDirection,
    amount: Int,
    binding: Binding,
    _ context: Context
  ) async throws -> String {
    let resolved = try resolve(target: target, app: context.app, binding: binding)
    try requireEventDelivery(binding)
    let destination = try eventTarget(for: resolved.screenPoint, binding: binding)
    await travel(to: resolved.screenPoint, binding: binding, context)
    let restarted = "This app restarted while it was being scrolled."
    for tick in 0..<amount {
      try await context.checkStep(binding, restarted: restarted, showing: .scroll(direction))
      try revalidate(destination, binding: binding, context: context)
      context.monitor.noteHelperInput(processIdentifier: binding.processIdentifier)
      try await context.input.scroll(
        direction, 1, destination,
        context.deliveryGate(binding, restarted: restarted, event: true))
      if tick + 1 < amount {
        try? await Task.sleep(nanoseconds: betweenTicksDelay)
      }
    }
    return ActionDescription.scroll(direction: direction, in: resolved.scrolled)
  }

  // MARK: - Routes

  /// How a `click` is delivered.
  public enum ClickRoute: Equatable, Sendable {
    case press
    case synthetic
  }

  /// Decide once before posting: AXPress avoids a synthetic mouse-down's
  /// window raise. Menu tracking can time out; an uncertain answer still
  /// never becomes a second attempt through the pixel route.
  public nonisolated static func clickRoute(
    role: String?, button: MouseButton, count: Int, offersPress: Bool
  ) -> ClickRoute {
    guard button == .left, count == 1, offersPress else { return .synthetic }
    return .press
  }

  /// What an `AXPress` answer means.
  ///
  /// `kAXErrorCannotComplete` is the app not answering in time, which says
  /// nothing about whether it acted — that is `outcome-unknown`, the batch
  /// stops, and nothing is ever retried (§1 invariant 6).
  public nonisolated static func pressOutcome(
    _ status: AXError,
    whatMayHaveHappened: String,
    failure: String
  ) -> HelperError? {
    axMutationOutcome(
      status,
      whatMayHaveHappened: whatMayHaveHappened,
      failure: failure
    )
  }

  /// What an `AXValue` mutation answer means. A timed-out app may have
  /// accepted the value before Accessibility stopped waiting for its reply.
  public nonisolated static func setValueOutcome(_ status: AXError) -> HelperError? {
    axMutationOutcome(
      status,
      whatMayHaveHappened: "the value changed",
      failure: "This element did not accept that value."
    )
  }

  nonisolated static func axMutationOutcome(
    _ status: AXError,
    whatMayHaveHappened: String,
    failure: String
  ) -> HelperError? {
    switch status {
    case .success:
      return nil
    case .cannotComplete:
      return HelperError(
        .outcomeUnknown,
        "This app did not answer in time, so whether \(whatMayHaveHappened) is unknown."
      )
    default:
      return HelperError(.failed, failure)
    }
  }

  // MARK: - Helpers

  struct ResolvedTarget {
    let element: AXUIElement?
    /// The observed role of an indexed target.
    var role: String? = nil
    /// Points relative to the key window.
    let windowPoint: CGPoint
    /// The same point in CoreGraphics screen coordinates.
    let screenPoint: CGPoint
    /// A point target in screenshot pixels, as the model gave it.
    var pixelPoint: CGPoint? = nil
    /// What the action is said to have acted on: the indexed element, or the
    /// element the cited observation shows under a point. It names the
    /// action; the actionable control at a point also supplies its AX route.
    var named: ElementAttributes? = nil
    /// What a scroll there is said to scroll: the indexed element, or the
    /// scrolling container under a point.
    var scrolled: ElementAttributes? = nil
  }

  static func resolve(
    target: ActionTarget,
    app: AppSessionState,
    binding: Binding
  ) throws -> ResolvedTarget {
    let latest: LatestObservation
    let element: AXUIElement?
    var role: String?
    let windowPoint: CGPoint
    let pixelPoint: CGPoint
    var named: ElementAttributes?
    var scrolled: ElementAttributes?
    switch target {
    case .index(let index):
      guard let observation = app.latest, observation.elements.indices.contains(index) else {
        throw HelperError(
          .staleObservation,
          "There is no element \(index) in the observation this cites."
        )
      }
      let observed = observation.elements[index]
      latest = observation
      element = (observed.node as? AXElementNode)?.element
      role = observed.attributes.role
      named = observed.attributes
      scrolled = observed.attributes
      windowPoint = CGPoint(x: observed.frame.midX, y: observed.frame.midY)
      pixelPoint = observation.coordinates.pixelPoint(from: windowPoint)
    case .point(let point):
      guard let observation = app.latest else {
        throw HelperError(.staleObservation, "Observe this app before acting.")
      }
      latest = observation
      windowPoint = observation.coordinates.windowPoint(from: point)
      pixelPoint = point
      // Resolve the actionable control, not a smaller static-text label
      // inside it. Only elements in the cited observation may receive AX.
      let window = AppWindows.window(
        at: screenPoint(for: windowPoint, in: binding.windowFrame),
        among: binding.windows, keyWindow: binding.keyWindow)
      let hit = observation.elements.filter {
        guard ElementTreeWalker.actionableRoles.contains($0.attributes.role),
          $0.frame.contains(windowPoint), let node = $0.node as? AXElementNode
        else { return false }
        // A retained control can be partly behind a sibling window. Its
        // bounding box alone must not route input through that window.
        return windowID(containing: node.element) == window.windowID
      }.min { $0.frame.area < $1.frame.area }
      element = (hit?.node as? AXElementNode)?.element
      role = hit?.attributes.role
      named = ElementHit.innermost(
        at: windowPoint, in: observation.elements.map { ($0.frame, $0.attributes) },
        roles: ElementHit.pointedRoles)
      scrolled = ElementHit.innermost(
        at: windowPoint, in: observation.elements.map { ($0.frame, $0.attributes) },
        roles: ElementHit.scrollingRoles)
    }
    // One bound for both forms. The tree keeps elements that only partly reach
    // into the picture, so an index's center can lie outside the screenshot,
    // and it may not reach anywhere the equivalent point could not.
    guard latest.coordinates.contains(pixelPoint) else {
      throw HelperError(.failed, "That point is outside the observation's screenshot.")
    }
    let screen = screenPoint(for: windowPoint, in: binding.windowFrame)
    if binding.group != nil {
      if case .point = target { _ = try eventTarget(for: screen, binding: binding) }
      if let element {
        var value: CFTypeRef?
        guard
          AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success
        else {
          throw HelperError(
            .staleObservation, "That element is no longer available; observe again.")
        }
        if let id = windowID(containing: element),
          binding.group?.members.contains(where: { $0.window.windowID == id }) != true
        {
          throw HelperError(.staleObservation, "That element is outside this window's members.")
        }
      }
    }
    var resolved = ResolvedTarget(
      element: element,
      role: role,
      windowPoint: windowPoint,
      screenPoint: screenPoint(for: windowPoint, in: binding.windowFrame)
    )
    if case .point(let point) = target { resolved.pixelPoint = point }
    resolved.named = named
    resolved.scrolled = scrolled
    return resolved
  }

  nonisolated static func screenPoint(for windowPoint: CGPoint, in windowFrame: CGRect)
    -> CGPoint
  {
    CGPoint(
      x: windowFrame.origin.x + windowPoint.x,
      y: windowFrame.origin.y + windowPoint.y
    )
  }

  nonisolated static func supportsPress(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
      let actions = names as? [String]
    else { return false }
    return actions.contains(kAXPressAction)
  }

  nonisolated static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
      && settable.boolValue
  }

  /// The window an element is in, for a keystroke meant for it.
  nonisolated static func windowID(containing element: AXUIElement) -> CGWindowID? {
    guard let window = AXValueReader.copyElement(element, kAXWindowAttribute) else { return nil }
    return KeyWindow.windowID(of: window)
  }
}
