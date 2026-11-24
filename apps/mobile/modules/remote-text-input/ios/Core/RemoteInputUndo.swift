#if canImport(UIKit)
import Foundation

/// The hidden field's undo manager: undo and redo are the far page's. UITextView's own manager
/// would change the hidden text outside the gate (Cmd+Z through the responder chain, the
/// three-finger gestures and shake all ask it). This one records nothing and forwards each undo
/// or redo to `forward`, which sends the far page's own chord through the gate.
final class RemoteInputUndo: UndoManager {
  private let forward: (_ redo: Bool) -> Void
  private let enabled: () -> Bool
  init(enabled: @escaping () -> Bool, forward: @escaping (_ redo: Bool) -> Void) {
    self.enabled = enabled
    self.forward = forward
    super.init()
    // UITextView registers its edits here; none are kept.
    disableUndoRegistration()
  }
  override var canUndo: Bool { enabled() }
  override var canRedo: Bool { enabled() }
  override func undo() { if enabled() { forward(false) } }
  override func redo() { if enabled() { forward(true) } }
}
#endif
