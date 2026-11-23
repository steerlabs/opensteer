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

  /// Commands relative to the caret, matching `caretRelativeEditingCommands` in protocol.
  static let caretRelativeCommands: Set<String> = [
    "deleteBackward",
    "moveBackward",
    "moveForward",
  ]

  /// FIFO bound on earlier contexts kept for the currently focused field.
  static let kept = 64

  /// Maximum wait for an app (such as Electron) to render a prior keystroke before a
  /// text-naming edit is refused as stale.
  static let namedTextWait: TimeInterval = 0.5

  private(set) var current = UUID().uuidString
  private(set) var field: FieldIdentity?
  private var earlier: [String] = []

  /// Observes the live focused field. Rotates only when the field identity changes (clearing
  /// earlier contexts) or when the same field's content/selection changes (keeping previous
  /// contexts in `earlier`). An unchanged observation changes no context and forgets nothing.
  @discardableResult
  mutating func observe(field next: FieldIdentity?, stateChanged: Bool) -> Bool {
    if field != next {
      field = next
      earlier.removeAll()
      current = UUID().uuidString
      return true
    }
    if stateChanged {
      rotate(sameField: true)
      return true
    }
    return false
  }

  /// Rotates `current`. When `sameField` is true and a field is focused, retains `current` in
  /// `earlier` up to `kept`; otherwise clears `earlier`.
  mutating func rotate(sameField: Bool) {
    if sameField, field != nil {
      earlier.append(current)
      if earlier.count > Self.kept { earlier.removeFirst(earlier.count - Self.kept) }
    } else {
      earlier.removeAll()
    }
    current = UUID().uuidString
  }

  /// A text-naming edit mismatched the live field: rotate so the viewer resets its mirror,
  /// without forgetting earlier contexts of this field.
  mutating func mismatch() {
    rotate(sameField: true)
  }

  /// Ends observation of the current field (session end or capture generation change).
  mutating func reset() {
    field = nil
    earlier.removeAll()
    current = UUID().uuidString
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
