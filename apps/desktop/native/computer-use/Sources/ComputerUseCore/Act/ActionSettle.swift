import ApplicationServices
import Foundation

/// Give completed input a bounded chance to appear in the closing observation.
///
/// An app answers input on its own time — Slack takes about a second to switch
/// workspaces — and the closing observation is what the model reads the
/// effect from. So after a batch that sent input, the helper waits until the
/// observed window differs from how it looked before the batch and then holds
/// still for one poll, or until one second has passed. Focus and edited values
/// count as changes, so typing does not spend a second waiting for a title or
/// child-count change that will never happen.
@WorkActor
enum ActionSettle {
  static let timeout: TimeInterval = 1
  static let pollInterval: TimeInterval = 0.1
  /// Settling never eats into the time the closing observation needs.
  static let observationReserve: TimeInterval = ElementTreeWalker.timeBudget

  struct Fingerprint: Equatable {
    let title: String?
    let childCount: Int
    let focusedState: Int?

    init(title: String?, childCount: Int, focusedState: Int? = nil) {
      self.title = title
      self.childCount = childCount
      self.focusedState = focusedState
    }
  }

  /// A batch that sends input and does not end in an explicit `wait`, which is
  /// the model choosing its own pause.
  static func mayApply(to actions: [ActionRequest]) -> Bool {
    !actions.isEmpty
  }

  static func preActionDeadline(budget: WorkBudget, now: Date = Date()) -> Date {
    min(
      now.addingTimeInterval(timeout),
      (budget.end ?? .distantFuture).addingTimeInterval(-observationReserve))
  }

  /// The window's shallow shape and focused element's changing value, read
  /// within `deadline`; nil when it cannot be read in time.
  static func fingerprint(
    of window: AXUIElement, until deadline: Date, cancellation: SessionCancellation
  ) -> Fingerprint? {
    func prepare(_ element: AXUIElement) -> Bool {
      let remaining = deadline.timeIntervalSinceNow
      guard remaining > 0, !cancellation.isCancelled else { return false }
      AXUIElementSetMessagingTimeout(element, Float(min(remaining, Double(axMessagingTimeout))))
      return true
    }
    guard prepare(window) else { return nil }
    let title = AXValueReader.copyString(window, kAXTitleAttribute)
    let count = ManualAccessibility.shallowCount(of: window, beforeRead: prepare)
    var processIdentifier: pid_t = 0
    var focusedState: Int?
    if AXUIElementGetPid(window, &processIdentifier) == .success {
      let application = AXUIElementCreateApplication(processIdentifier)
      if prepare(application),
        let focused = AXValueReader.copyElement(application, kAXFocusedUIElementAttribute),
        prepare(focused)
      {
        var hash = Hasher()
        hash.combine(CFHash(focused))
        let role = AXValueReader.copyString(focused, kAXRoleAttribute)
        let subrole = AXValueReader.copyString(focused, kAXSubroleAttribute)
        if !ActionReceipt.isSecure(role: role, subrole: subrole) {
          let value = AXValueReader.displayString(
            AXValueReader.copy(focused, kAXValueAttribute) as AnyObject?)
          hash.combine(value?.prefix(128))
          hash.combine(value?.suffix(128))
          guard prepare(focused) else { return nil }
          let selectedText = AXValueReader.copyString(focused, kAXSelectedTextAttribute)
          hash.combine(selectedText?.prefix(128))
          hash.combine(selectedText?.suffix(128))
        }
        focusedState = hash.finalize()
      }
    }
    guard Date() < deadline, !cancellation.isCancelled else { return nil }
    return Fingerprint(title: title, childCount: count, focusedState: focusedState)
  }

  /// Settling is a bounded pause, not an action: it ends on its own clock, at
  /// the batch's or request's deadline less the closing observation's time, or
  /// on Stop, and never fails a batch whose actions all completed. A Stop is
  /// reported by the session's cancellation, which the closing step reads.
  static func wait(
    window: AXUIElement, before: Fingerprint?, budget: WorkBudget,
    cancellation: SessionCancellation
  ) async {
    await settle(
      fingerprint: { deadline in
        fingerprint(of: window, until: deadline, cancellation: cancellation)
      },
      before: before, budget: budget, cancellation: cancellation)
  }

  @discardableResult
  static func settle(
    fingerprint: (Date) -> Fingerprint?,
    before: Fingerprint?,
    budget: WorkBudget,
    cancellation: SessionCancellation,
    now: () -> Date = Date.init,
    sleep: (TimeInterval) async -> Void = { interval in
      try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
    }
  ) async -> Int {
    let deadline = min(
      now().addingTimeInterval(timeout),
      (budget.end ?? .distantFuture).addingTimeInterval(-observationReserve))
    var previous: Fingerprint?
    var polls = 0
    while now() < deadline, !cancellation.isCancelled {
      await sleep(min(pollInterval, max(0, deadline.timeIntervalSince(now()))))
      guard now() < deadline, !cancellation.isCancelled else { break }
      let current = fingerprint(deadline)
      polls += 1
      if let current, current != before, current == previous { break }
      previous = current
    }
    return polls
  }
}
