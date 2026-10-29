import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The window a key goes to: the key-capable window that owns the element the
/// keyboard is for.
@WorkActor
enum WindowKey {
  nonisolated static let unconfirmed = HelperError(
    .unsupported,
    "The target window's keyboard routing could not be confirmed, so no keys were sent.")

  /// Keyboard routing uses a key-capable owner, not an event's pointer window.
  /// An auxiliary surface must identify that owner through AX; ambiguity refuses.
  static func owner(pid: pid_t, destination: CGWindowID) throws -> (
    id: CGWindowID, element: AXUIElement
  ) {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    let roots = AXValueReader.copyElements(app, kAXWindowsAttribute)
    let windows = roots + roots.flatMap { AXElementNode.children(of: $0) }
    guard
      var candidate = windows.first(where: { KeyWindow.windowID(of: $0) == destination })
        ?? AXValueReader.copyElement(app, kAXFocusedUIElementAttribute).flatMap({
          ActionRunner.windowID(containing: $0) == destination
            ? AXValueReader.copyElement($0, kAXWindowAttribute) : nil
        })
    else { throw unconfirmed }
    for _ in 0..<8 {
      let role = AXValueReader.copyString(candidate, kAXRoleAttribute)
      let subrole = AXValueReader.copyString(candidate, kAXSubroleAttribute)
      if role == kAXWindowRole || role == kAXSheetRole,
        subrole != "AXPopover", subrole != "AXFloatingWindow",
        let id = KeyWindow.windowID(of: candidate),
        KeyWindow.captureState(id, processIdentifier: pid) != nil
      {
        return (id, candidate)
      }
      guard let parent = AXValueReader.copyElement(candidate, kAXParentAttribute),
        !CFEqual(parent, candidate)
      else { break }
      candidate = parent
    }
    throw unconfirmed
  }
}
