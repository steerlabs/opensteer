import Foundation

/// Shared editing-admission state machine (see `docs/editing-admission.md` and
/// `packages/protocol/fixtures/editing-admission.json`, run identically in TypeScript
/// `EditingContexts` and here in Swift `OwnerEditingContexts`).
struct OwnerEditingContexts: Sendable {
  struct FieldIdentity: Equatable, Sendable {
    let id: String
    let kind: String
    let sensitive: Bool
    let editable: Bool
  }

  /// Snapshot of the focused field's selection and optional trailing text before the caret,
  /// used to distinguish the phone's own edit effects from external changes (P4(b)).
  struct ObservedState: Equatable, Sendable {
    let location: Int
    let length: Int
    let text: String?

    init(location: Int, length: Int, text: String? = nil) {
      self.location = location
      self.length = length
      self.text = text
    }

    func matchesExpected(_ expected: ObservedState) -> Bool {
      // Q2: an expected (or observed) state whose text could not be predicted is NOT a match: rotate.
      guard location == expected.location, length == expected.length,
            let expectedText = expected.text, let actualText = text
      else { return false }
      return actualText == expectedText
    }
  }

  enum AdmissionKind: String, Sendable {
    case relative
    case named
    case exact
  }

  enum NamedTextWaitDecision: String, Sendable {
    case apply
    case wait
    case refuseMismatch = "refuse-mismatch"
    case refuseField = "refuse-field"
  }

  /// Commands relative to the caret, matching `caretRelativeCommands` in the shared fixture.
  static let caretRelativeCommands: Set<String> = [
    "deleteBackward",
    "moveBackward",
    "moveForward",
  ]

  /// FIFO bound on earlier published contexts kept for the currently focused field.
  static let kept = 64

  /// Maximum wait for an app (such as Electron) to render a prior keystroke before a
  /// text-naming edit is refused as stale.
  static let namedTextWait: TimeInterval = 0.5

  private(set) var current = UUID().uuidString
  private(set) var field: FieldIdentity?
  private var earlier: [String] = []
  private var currentPublished = false
  private var baseline: ObservedState?
  private var expected: [ObservedState] = []

  /// The state predicted after all currently unanswered own edits (or the baseline if none).
  var predictedState: ObservedState? {
    expected.last ?? baseline
  }

  /// Marks `current` as published to the viewer. Only published contexts enter `earlier` on
  /// same-field rotation (P4(c)), so unpublished rotations while batches are pending never evict
  /// the viewer's published context.
  mutating func markPublished() {
    currentPublished = true
  }

  /// Records the state expected after dispatching one of the viewer's own edits (P4(b)).
  mutating func expectOwnEffect(_ state: ObservedState) {
    guard field != nil else { return }
    expected.append(state)
    if expected.count > Self.kept {
      expected.removeFirst(expected.count - Self.kept)
    }
  }

  /// Observes the live focused field. Rotates only when the field identity changes (clearing
  /// earlier contexts) or when the same field's content/selection changes (keeping previous
  /// published contexts in `earlier`). An unchanged observation changes no context and forgets nothing.
  @discardableResult
  mutating func observe(field next: FieldIdentity?, stateChanged: Bool) -> Bool {
    if field != next {
      field = next
      earlier.removeAll()
      expected.removeAll()
      baseline = nil
      current = UUID().uuidString
      currentPublished = false
      return true
    }
    if stateChanged {
      rotate(sameField: true)
      return true
    }
    return false
  }

  /// Observes the live focused field together with its live selection/text state (P4(b)).
  /// - Equal to `baseline` (unchanged or app has not caught up yet): rotates nothing.
  /// - Equal to any expected prefix in `expected`: consumes that prefix, advances `baseline`,
  ///   rotates nothing.
  /// - Anything else (or `forceChanged`, e.g. agent mutation): rotates, clears `expected`,
  ///   and updates `baseline`.
  @discardableResult
  mutating func observeState(
    field next: FieldIdentity?,
    state: ObservedState?,
    forceChanged: Bool = false
  ) -> Bool {
    if field != next {
      field = next
      earlier.removeAll()
      expected.removeAll()
      baseline = state
      current = UUID().uuidString
      currentPublished = false
      return true
    }
    if forceChanged {
      expected.removeAll()
      baseline = state
      rotate(sameField: field != nil)
      return true
    }
    guard let state else {
      if baseline == nil { return false }
      expected.removeAll()
      baseline = nil
      rotate(sameField: field != nil)
      return true
    }
    guard let base = baseline else {
      baseline = state
      return false
    }
    if state == base {
      return false
    }
    if let matchIndex = expected.firstIndex(where: { state.matchesExpected($0) }) {
      baseline = state
      expected.removeFirst(matchIndex + 1)
      return false
    }
    expected.removeAll()
    baseline = state
    rotate(sameField: field != nil)
    return true
  }

  /// Rotates `current`. When `sameField` is true and a field is focused, retains `current` in
  /// `earlier` (up to `kept`) ONLY if `current` was published; otherwise clears `earlier`.
  mutating func rotate(sameField: Bool) {
    if sameField, field != nil {
      if currentPublished, !earlier.contains(current) {
        earlier.append(current)
        if earlier.count > Self.kept { earlier.removeFirst(earlier.count - Self.kept) }
      }
    } else {
      earlier.removeAll()
    }
    expected.removeAll()
    current = UUID().uuidString
    currentPublished = false
  }

  /// A text-naming edit mismatched the live field: rotate while a field is focused so the viewer
  /// resets its mirror, without forgetting earlier contexts. With no focused field, rotates nothing (S6).
  mutating func mismatch() {
    guard field != nil else { return }
    rotate(sameField: true)
  }

  /// Ends observation of the current field (session end or capture generation change).
  mutating func reset() {
    field = nil
    baseline = nil
    expected.removeAll()
    earlier.removeAll()
    current = UUID().uuidString
    currentPublished = false
  }

  /// Whether an operation stamped with `contextId` is admitted against the live field.
  /// Under an earlier context of the same field, a relative edit requires a collapsed live
  /// selection (`collapsed == true`); under the current context, any selection is admitted.
  func admits(
    _ contextId: String,
    kind: AdmissionKind,
    namedMatches: Bool = true,
    exactNamed: Bool = false,
    collapsed: Bool = true
  ) -> Bool {
    let isCurrent = contextId == current
    let sameFieldContext = isCurrent || (field != nil && earlier.contains(contextId))
    guard sameFieldContext else { return false }
    switch kind {
    case .relative:
      return isCurrent || collapsed
    case .named:
      return namedMatches && (exactNamed ? isCurrent : true)
    case .exact:
      return isCurrent
    }
  }

  /// Bounded-wait decision for a text-naming edit on the Mac helper.
  static func namedTextWaitDecision(
    sameField: Bool,
    matches: Bool,
    waited: TimeInterval
  ) -> NamedTextWaitDecision {
    guard sameField else { return .refuseField }
    if matches { return .apply }
    return waited >= namedTextWait ? .refuseMismatch : .wait
  }
}
