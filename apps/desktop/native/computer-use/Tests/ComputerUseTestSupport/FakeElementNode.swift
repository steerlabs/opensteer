import CoreGraphics
import Foundation

@testable import ComputerUseCore

/// An in-memory tree, so the walker and the formatter can be tested without the
/// Accessibility grant or a running app.
final class FakeElementNode: ElementNode {
  var attributes: ElementAttributes
  var children: [FakeElementNode]

  init(_ attributes: ElementAttributes, children: [FakeElementNode] = []) {
    self.attributes = attributes
    self.children = children
  }

  func readAttributes() -> ElementAttributes { attributes }
  func readChildren() -> [any ElementNode] { children }
}

extension FakeElementNode {
  static func node(
    _ role: String,
    title: String? = nil,
    value: String? = nil,
    frame: CGRect?,
    enabled: Bool = true,
    focused: Bool = false,
    children: [FakeElementNode] = []
  ) -> FakeElementNode {
    FakeElementNode(
      ElementAttributes(
        role: role,
        title: title,
        value: value,
        frame: frame,
        enabled: enabled,
        focused: focused
      ),
      children: children
    )
  }
}
