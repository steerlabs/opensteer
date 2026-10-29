import ApplicationServices
import CoreGraphics
import Foundation

/// The Accessibility reads and writes an action's routes make.
///
/// The live set talks to the app. A test swaps in its own to land a `Stop`
/// part way through a read and see that nothing is written after it — which
/// is the rule every route keeps: the step check runs after the last read and
/// immediately before the write.
struct AccessibilityCalls {
  var menuLookup: @WorkActor (MenuShortcutIndex, KeyCombo, AXUIElement) -> MenuShortcutIndex.Lookup
  var menuPath: (AXUIElement) -> [String]
  var isSettable: (AXUIElement, String) -> Bool
  var focusedElement: (AXUIElement) -> AXUIElement?
  /// The window an element is in, for a keystroke meant for it.
  var window: (AXUIElement) -> CGWindowID?
  /// What an element is called, for the sentence that names the action.
  var attributes: (AXUIElement) -> ElementAttributes
  var press: (AXUIElement) -> AXError
  var setAttribute: (AXUIElement, String, CFTypeRef) -> AXError
  /// Whether an element offers `AXPress`, which decides a click's route.
  var offersPress: (AXUIElement) -> Bool = ActionRunner.supportsPress

  static var live: AccessibilityCalls {
    AccessibilityCalls(
      menuLookup: { index, combo, application in
        index.lookup(combo, applicationElement: application)
      },
      menuPath: MenuShortcutIndex.menuPath(of:),
      isSettable: ActionRunner.isSettable,
      focusedElement: { AXValueReader.copyElement($0, kAXFocusedUIElementAttribute) },
      window: ActionRunner.windowID(containing:),
      attributes: { AXElementNode($0).readAttributes() },
      press: { AXUIElementPerformAction($0, kAXPressAction as CFString) },
      setAttribute: { AXUIElementSetAttributeValue($0, $1 as CFString, $2) }
    )
  }
}

/// The element the cited observation shows under a point: the smallest one
/// of the given roles whose frame holds it. This supplies the description;
/// ActionRunner separately resolves the actionable AX control at the point.
enum ElementHit {
  /// What a click or a typed point is said to have landed on.
  static let pointedRoles: Set<String> = ElementTreeWalker.actionableRoles.union([
    "AXRow", "AXCell", "AXStaticText", "AXImage",
  ])

  /// What a scroll is said to have scrolled.
  static let scrollingRoles: Set<String> = [
    "AXTable", "AXOutline", "AXList", "AXWebArea", "AXScrollArea", "AXTextArea", "AXBrowser",
    "AXCollection",
  ]

  static func innermost(
    at point: CGPoint, in elements: [(frame: CGRect, attributes: ElementAttributes)],
    roles: Set<String>
  ) -> ElementAttributes? {
    elements
      .filter { roles.contains($0.attributes.role) && $0.frame.contains(point) }
      .min { $0.frame.area < $1.frame.area }?
      .attributes
  }
}
