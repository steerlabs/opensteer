import CoreGraphics
import Foundation

/// What one accessibility element looks like once it has been read.
///
/// The walker and the formatter work on this and never on `AXUIElement`, which
/// is what makes the tree text testable without the Accessibility grant.
public struct ElementAttributes: Sendable, Equatable {
  /// The raw role, e.g. `AXButton`.
  public var role: String
  public var subrole: String?
  public var title: String?
  public var value: String?
  public var roleDescription: String?
  public var help: String?
  /// Screen points, top-left origin, as Accessibility reports them. `nil` when
  /// the element does not have a position and size.
  public var frame: CGRect?
  public var enabled: Bool
  public var focused: Bool

  public init(
    role: String,
    subrole: String? = nil,
    title: String? = nil,
    value: String? = nil,
    roleDescription: String? = nil,
    help: String? = nil,
    frame: CGRect? = nil,
    enabled: Bool = true,
    focused: Bool = false
  ) {
    self.role = role
    self.subrole = subrole
    self.title = title
    self.value = value
    self.roleDescription = roleDescription
    self.help = help
    self.frame = frame
    self.enabled = enabled
    self.focused = focused
  }
}

/// A node of the tree being walked. The AX implementation reads lazily; the
/// tests hand the walker a plain in-memory tree.
public protocol ElementNode: AnyObject {
  func readAttributes() -> ElementAttributes
  func readChildren() -> [any ElementNode]
  /// The element this node reads, compared by identity, so a subtree already
  /// walked as its own root is not walked again inside its parent.
  var elementIdentity: AnyHashable { get }
  /// Bounds the next read to what is left of the walk's time.
  func limitWait(to seconds: TimeInterval)
}

extension ElementNode {
  public var elementIdentity: AnyHashable { ObjectIdentifier(self) }
  public func limitWait(to seconds: TimeInterval) {}
}

/// One element that made it into the observation.
public struct ObservedElement {
  public let node: any ElementNode
  public let attributes: ElementAttributes
  /// Points relative to the key window's top-left (§2 "Observation").
  public let frame: CGRect
  /// Indentation depth in emitted elements, so a skipped wrapper does not
  /// indent what is inside it.
  public let depth: Int
}

public struct WalkResult {
  public let elements: [ObservedElement]
  /// How many elements the cap left out.
  public let omitted: Int
  /// The app answered too slowly for the walk's time budget, or the work was
  /// stopped, so part of the app was never read.
  public let incomplete: Bool
}

/// One subtree the walk starts from, in the order that matters to the agent.
public struct WalkRoot {
  public let node: any ElementNode
  /// Screen rectangles of the app's windows in front of this one. An element
  /// entirely inside one of them is hidden in the screenshot, so it is left
  /// out with its subtree.
  public var occluders: [CGRect]

  public init(_ node: any ElementNode, occluders: [CGRect] = []) {
    self.node = node
    self.occluders = occluders
  }
}

/// Depth-first walk of the app as the screenshot shows it.
///
/// The roots come in the order that matters: open menus, then sheets,
/// dialogs, popovers and the app's other windows in front of the key window,
/// then the key window, then what shows of the windows behind it. The tree
/// budget cuts from the end, so what is cut is what matters least.
public enum ElementTreeWalker {
  public static let elementLimit = 1_500
  /// A cheap guard against a pathological tree; a window with this many nodes
  /// is already far past the element cap.
  static let visitLimit = 40_000
  static let depthLimit = 64
  /// Each Accessibility read of an app that stops answering costs up to its
  /// messaging timeout. The walk's whole budget is enforced before every read
  /// — each read may only wait for what is left of it — so an unresponsive app
  /// holds an observation for at most this long.
  public static let timeBudget: TimeInterval = 3
  /// Below this, a read is not worth starting.
  static let minimumRead: TimeInterval = 0.05

  /// Roles that are always a line, labeled or not: the containers a person
  /// would name when saying where something is, and the ones a scroll aims at.
  static let structuralRoles: Set<String> = [
    "AXWindow", "AXSheet", "AXDrawer", "AXPopover", "AXMenu", "AXDialog", "AXToolbar",
    "AXTabGroup", "AXTable", "AXOutline", "AXList", "AXWebArea",
  ]

  /// Roles an agent can act on by index, labeled or not.
  static let actionableRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
    "AXComboBox", "AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField",
    "AXSlider", "AXIncrementor", "AXLink", "AXMenuItem", "AXMenuBarItem",
    "AXDisclosureTriangle", "AXColorWell", "AXDateField", "AXTimeField", "AXSwitch",
    "AXSegmentedControl", "AXTab", "AXToggle", "AXStepper",
  ]

  public static func walk(
    roots: [WalkRoot],
    bounds: CGRect,
    origin: CGPoint,
    limit: Int = elementLimit,
    budget: TimeInterval = timeBudget,
    now: () -> Date = Date.init,
    isCancelled: () -> Bool = { false }
  ) -> WalkResult {
    var elements: [ObservedElement] = []
    var omitted = 0
    var visits = 0
    var incomplete = false
    let deadline = now().addingTimeInterval(budget)
    let rootIdentities = Set(roots.map(\.node.elementIdentity))

    /// Whether another read may start, and how long it may wait.
    func mayRead(_ node: any ElementNode) -> Bool {
      guard !incomplete else { return false }
      let remaining = deadline.timeIntervalSince(now())
      guard remaining >= minimumRead, !isCancelled() else {
        incomplete = true
        return false
      }
      node.limitWait(to: remaining)
      return true
    }

    func visit(
      _ node: any ElementNode, root: WalkRoot, depth: Int, treeDepth: Int, parentLabel: String?
    ) {
      guard treeDepth < depthLimit, visits < visitLimit, mayRead(node) else { return }
      visits += 1
      let attributes = node.readAttributes()

      if let frame = attributes.frame, frame.width > 0, frame.height > 0 {
        // Outside the screenshot, or behind another of the app's windows:
        // nothing here can be seen, and neither can anything under it.
        guard frame.intersects(bounds) else { return }
        if root.occluders.contains(where: { $0.contains(frame) }) { return }
      }

      let label = TreeFormatter.label(attributes)
      var emitted = false
      if shouldEmit(attributes, label: label, parentLabel: parentLabel) {
        if elements.count < limit {
          elements.append(
            ObservedElement(
              node: node,
              attributes: attributes,
              frame: relative(attributes.frame ?? .zero, to: origin),
              depth: depth
            )
          )
          emitted = true
        } else {
          omitted += 1
        }
      }

      guard mayRead(node) else { return }
      for child in node.readChildren() {
        if rootIdentities.contains(child.elementIdentity) { continue }
        visit(
          child, root: root, depth: emitted ? depth + 1 : depth, treeDepth: treeDepth + 1,
          parentLabel: emitted ? label : parentLabel)
        if incomplete { return }
      }
    }

    for root in roots {
      visit(root.node, root: root, depth: 0, treeDepth: 0, parentLabel: nil)
      if incomplete { break }
    }
    return WalkResult(elements: elements, omitted: omitted, incomplete: incomplete)
  }

  /// The walk of one window and the app's open menus, in that window's frame.
  public static func walk(
    root: any ElementNode,
    menus: [any ElementNode] = [],
    windowFrame: CGRect,
    limit: Int = elementLimit,
    budget: TimeInterval = timeBudget,
    now: () -> Date = Date.init
  ) -> WalkResult {
    walk(
      roots: menus.map { WalkRoot($0) } + [WalkRoot(root)],
      bounds: windowFrame,
      origin: windowFrame.origin,
      limit: limit,
      budget: budget,
      now: now
    )
  }

  /// A line has to earn its bytes. An element with no size cannot be aimed
  /// at; one with nothing to read and nothing to do — an unlabeled group, a
  /// scroll area, a row, an empty text — is layout. Both are left out and
  /// their children take their place. Containers and controls are kept even
  /// unlabeled, and text that only repeats the element it sits in is dropped.
  static func shouldEmit(
    _ attributes: ElementAttributes, label: String?, parentLabel: String?
  ) -> Bool {
    guard let frame = attributes.frame, frame.width > 0, frame.height > 0 else { return false }
    if attributes.role == "AXUnknown" { return false }
    if structuralRoles.contains(attributes.role) { return true }
    if let subrole = attributes.subrole, structuralRoles.contains(subrole) { return true }
    if actionableRoles.contains(attributes.role) { return true }
    if let subrole = attributes.subrole, actionableRoles.contains(subrole) { return true }
    if attributes.focused { return true }
    guard let label else { return false }
    if attributes.role == "AXStaticText", label == parentLabel { return false }
    return attributes.role != "AXGroup" || label != parentLabel
  }

  static func relative(_ frame: CGRect, to origin: CGPoint) -> CGRect {
    CGRect(
      x: frame.origin.x - origin.x,
      y: frame.origin.y - origin.y,
      width: frame.width,
      height: frame.height
    )
  }
}
