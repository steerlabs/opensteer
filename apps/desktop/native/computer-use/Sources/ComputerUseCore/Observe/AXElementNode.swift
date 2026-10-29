import ApplicationServices
import CoreGraphics
import Foundation

/// Every Accessibility call runs under a two-second messaging timeout, and on
/// the work executor rather than the main thread, so an unresponsive app can
/// never hold `Stop` (§2 "Observation").
public let axMessagingTimeout: Float = 2.0

/// An `AXUIElement` behind the walker's `ElementNode`.
///
/// The read is one `AXUIElementCopyMultipleAttributeValues` round trip per
/// element, which is what keeps a window of a thousand elements to a fraction
/// of a second instead of ten thousand IPC calls.
final class AXElementNode: ElementNode {
  let element: AXUIElement
  private let allowedWindows: Set<CGWindowID>?

  private static let attributeNames: [String] = [
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXRoleDescriptionAttribute,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXEnabledAttribute,
    kAXFocusedAttribute,
  ]

  init(_ element: AXUIElement, allowedWindows: Set<CGWindowID>? = nil) {
    self.allowedWindows = allowedWindows
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    self.element = element
  }

  var elementIdentity: AnyHashable { AnyHashable(element) }

  /// Setting the timeout is local to this process and costs no message, so it
  /// is set before every read of a walk to what is left of the walk's budget.
  func limitWait(to seconds: TimeInterval) {
    AXUIElementSetMessagingTimeout(
      element, Float(min(Double(axMessagingTimeout), max(seconds, 0.01))))
  }

  func readAttributes() -> ElementAttributes {
    // Determine security before requesting content. Even an AXValue fetched
    // and then discarded would have collected the saved password.
    var identityValues: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element,
        [kAXRoleAttribute, kAXSubroleAttribute] as CFArray,
        AXCopyMultipleAttributeOptions(rawValue: 0), &identityValues) == .success,
      let identity = identityValues as? [AnyObject], identity.count == 2,
      let role = AXValueReader.string(identity[0])
    else {
      return ElementAttributes(role: "AXUnknown")
    }
    let subrole = AXValueReader.string(identity[1])
    let secure = ActionReceipt.isSecure(role: role, subrole: subrole)
    let names =
      secure
      ? [kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute]
      : Self.attributeNames
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
      element, names as CFArray,
      AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard status == .success, let list = values as? [AnyObject], list.count == names.count else {
      return ElementAttributes(role: role, subrole: subrole)
    }
    let offset = secure ? 0 : 4
    return ElementAttributes(
      role: role, subrole: subrole,
      title: secure ? nil : AXValueReader.string(list[0]),
      value: secure ? nil : AXValueReader.displayString(list[1]),
      roleDescription: secure ? nil : AXValueReader.string(list[3]),
      help: secure ? nil : AXValueReader.string(list[2]),
      frame: AXValueReader.frame(position: list[offset], size: list[offset + 1]),
      enabled: AXValueReader.bool(list[offset + 2]) ?? true,
      focused: AXValueReader.bool(list[offset + 3]) ?? false)
  }

  func readChildren() -> [any ElementNode] {
    AXElementNode.children(of: element).compactMap { child in
      if let allowedWindows {
        let role = AXValueReader.copyString(child, kAXRoleAttribute)
        if role == kAXWindowRole || role == kAXSheetRole || role == "AXPopover"
          || role == kAXMenuRole
        {
          guard let id = KeyWindow.windowID(of: child) ?? ActionRunner.windowID(containing: child),
            allowedWindows.contains(id)
          else { return nil }
        }
      }
      return AXElementNode(child, allowedWindows: allowedWindows)
    }
  }

  static func children(of element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        == .success,
      let children = value as? [AXUIElement]
    else { return [] }
    return children
  }
}

/// Turning `AXUIElement` attribute values into plain Swift.
enum AXValueReader {
  static func string(_ value: AnyObject?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }

  /// `AXValue` carries numbers, booleans and strings; a value an agent cannot
  /// read is not put in the tree at all.
  static func displayString(_ value: AnyObject?) -> String? {
    if let text = value as? String { return text.isEmpty ? nil : text }
    if let number = value as? NSNumber {
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return number.boolValue ? "true" : "false"
      }
      return number.stringValue
    }
    return nil
  }

  static func bool(_ value: AnyObject?) -> Bool? {
    (value as? NSNumber)?.boolValue
  }

  /// The type id is checked first, so the reinterpretation below is exactly the
  /// bridge Swift would do for `as!` — without the trap when a future macOS
  /// hands back something else.
  private static func axValue(_ value: AnyObject?) -> AXValue? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXValue.self)
  }

  static func point(_ value: AnyObject?) -> CGPoint? {
    guard let axValue = axValue(value), AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
    return point
  }

  static func size(_ value: AnyObject?) -> CGSize? {
    guard let axValue = axValue(value), AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
    return size
  }

  static func frame(position: AnyObject?, size sizeValue: AnyObject?) -> CGRect? {
    guard let origin = point(position), let size = size(sizeValue) else { return nil }
    return CGRect(origin: origin, size: size)
  }

  static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
      return nil
    }
    return value
  }

  static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = copy(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
  }

  static func copyElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    guard let value = copy(element, attribute), let list = value as? [AXUIElement] else {
      return []
    }
    return list
  }

  static func copyBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    bool(copy(element, attribute) as AnyObject?)
  }

  static func copyString(_ element: AXUIElement, _ attribute: String) -> String? {
    copy(element, attribute) as? String
  }

  static func copyFrame(_ element: AXUIElement) -> CGRect? {
    frame(
      position: copy(element, kAXPositionAttribute) as AnyObject?,
      size: copy(element, kAXSizeAttribute) as AnyObject?
    )
  }
}
