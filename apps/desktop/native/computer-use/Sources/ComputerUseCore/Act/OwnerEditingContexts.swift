import Foundation

/// CY13: the editing contexts of the Mac app field a person types into from another device, kept
/// by the page's own rule (ruling (a)). The helper gives the field a new context after every edit
/// of the person's and whenever it sees the field change; the device sends its next edit under
/// whatever context it last heard, which an app that applies input late (Electron) has moved on
/// from by then. So the contexts the same field has had stay valid for what is relative to its
/// caret: an insertion goes in at the caret as it now is. A replacement names text around the
/// caret and needs the current context. Another field, or none, leaves no earlier context.
struct OwnerEditingContexts {
  private(set) var current = UUID().uuidString
  private var earlier: [String] = []
  /// How many earlier contexts are kept: a device is never more than a few edits behind.
  static let kept = 16

  /// A new context. `sameField`: the same element, its text or selection moved.
  mutating func rotate(sameField: Bool) {
    if sameField {
      earlier.append(current)
      if earlier.count > Self.kept { earlier.removeFirst(earlier.count - Self.kept) }
    } else {
      earlier.removeAll()
    }
    current = UUID().uuidString
  }

  /// Whether an edit made under `contextId` may be applied now: any under the current context,
  /// only an insertion at the caret under an earlier one of the same field.
  func admits(_ contextId: String, insertion: Bool) -> Bool {
    contextId == current || (insertion && earlier.contains(contextId))
  }

  /// What the field showed, for telling when a person's edit has taken effect.
  struct FieldState: Equatable {
    let value: String?
    let selectionLocation: Int?
    let selectionLength: Int?
  }

  /// How long the helper waits for an app to show an edit before it publishes anyway.
  static let effectWait: TimeInterval = 0.5

  /// CY13: a context read after a person's edit describes the field only once the field shows
  /// the edit's effect (its text or its selection moved from what it held before the edit), or
  /// once the app has had `effectWait` to show it. Before that, publishing it would name the
  /// field as it was before the edit, and an edit sent against it would be stale.
  static func effectShown(before: FieldState, now: FieldState, waited: TimeInterval) -> Bool {
    now != before || waited >= effectWait
  }
}
