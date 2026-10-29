import ApplicationServices
import CoreGraphics
import Foundation

/// The app's own menu bar, indexed by keyboard shortcut.
///
/// `key` presses the menu item whose shortcut matches before it posts anything,
/// because a menu item pressed through Accessibility reaches an app that is not
/// frontmost exactly as reliably as one the person chose, while a key event
/// sometimes does not.
///
/// Not every menu in an app's menu bar is the app's. The Apple menu holds Log
/// Out, Lock Screen, Force Quit and Shut Down, and the Services submenu runs
/// other apps — Terminal among them — on the selection. Neither is indexed,
/// and their shortcuts are **reserved**: `key` refuses them outright, because
/// a keystroke posted to the app reaches those same menu items through the
/// app's own key-equivalent handling.
// Each index belongs to one agent or person lane; its AX reads run on that
// lane's executor and its mutable cache is never shared between them.
final class MenuShortcutIndex {
  struct Built<Node> {
    var shortcuts: [String: Node] = [:]
    var reserved: Set<String> = []
    /// Every menu was read. An index that ran out of time, or met a menu
    /// that did not answer, cannot say a shortcut is absent — only that it
    /// was not found — so it cannot clear a keystroke that might reach a
    /// menu item it never read, a service among them.
    var complete = true
  }

  private var built: Built<AXUIElement>?

  private let buildIndex: @Sendable (AXUIElement) -> Built<AXUIElement>

  nonisolated convenience init() { self.init(build: { Self.build(applicationElement: $0) }) }
  nonisolated init(build: @escaping @Sendable (AXUIElement) -> Built<AXUIElement>) {
    buildIndex = build
  }

  /// The Apple menu's own shortcuts, reserved even when an app's menu bar
  /// cannot be read in time: Force Quit, Log Out (with and without the
  /// confirmation) and Lock Screen.
  nonisolated static let systemReserved: Set<String> = [
    "alt+cmd+escape", "cmd+shift+q", "alt+cmd+shift+q", "cmd+ctrl+q",
  ]

  /// The Services submenu's title in the languages macOS ships, so it is
  /// recognised wherever it appears, not only in the application menu.
  nonisolated static let servicesTitles: Set<String> = [
    "Services", "Dienste", "Servicios", "Servizi", "Serviços", "Diensten", "Tjänster",
    "Tjenester", "Palvelut", "Usługi", "Služby", "Службы", "Служби", "Hizmetler",
    "Szolgáltatások", "Servicii", "Υπηρεσίες", "שירותים", "الخدمات", "サービス", "服务",
    "服務", "서비스", "บริการ", "Dịch vụ", "Layanan", "Perkhidmatan", "Serveis", "Usluge",
    "Tenester",
  ]

  /// `AXMenuItemCmdModifiers` is a bit field where Command is *present* unless
  /// bit 3 is set — the reverse of every other bit.
  nonisolated private static let shiftBit = 1
  nonisolated private static let optionBit = 2
  nonisolated private static let controlBit = 4
  nonisolated private static let noCommandBit = 8

  /// Apps rebuild their menus as windows and modes change — Electron apps
  /// replace the whole menu bar — so the index lives for one observation and
  /// is rebuilt when an element it holds has gone away.
  func invalidate() {
    built = nil
  }

  var isBuilt: Bool { built != nil }

  typealias Lookup = Found<AXUIElement>

  func lookup(_ combo: KeyCombo, applicationElement: AXUIElement) -> Lookup {
    let key = Self.key(for: combo)
    // Checked here, once, before an index is built for a key no app owns.
    if Self.systemReserved.contains(key) { return .reserved }
    if let cached = built?.shortcuts[key], !Self.exists(cached) {
      invalidate()
    }
    let index = built ?? buildIndex(applicationElement)
    built = index
    return Self.lookup(key, in: index)
  }

  /// What an index says of one shortcut the system does not reserve. Only a
  /// complete index can say a shortcut belongs to no menu.
  nonisolated static func lookup<Node>(_ key: String, in index: Built<Node>) -> Found<Node> {
    if index.reserved.contains(key) { return .reserved }
    if let item = index.shortcuts[key] { return .item(item) }
    return index.complete ? .none : .unverified
  }

  enum Found<Node> {
    case item(Node)
    case reserved
    /// Every menu was read and none has this shortcut.
    case none
    /// Not found in an index that is incomplete: it may belong to a menu
    /// item — a service among them — that was never read.
    case unverified
  }

  /// Pressing a menu item the app has since destroyed fails, so a vanished
  /// element sends the lookup back to the live menu bar before anything is
  /// pressed; the route is still chosen once.
  private static func exists(_ element: AXUIElement) -> Bool {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value)
      != .invalidUIElement
  }

  nonisolated static func key(for combo: KeyCombo) -> String {
    (combo.sortedModifiers.map(\.rawValue) + [combo.key]).joined(separator: "+")
  }

  private static func build(applicationElement: AXUIElement) -> Built<AXUIElement> {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(
      applicationElement, kAXMenuBarAttribute as CFString, &value)
    guard status == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
      return Self.withoutMenuBar(status)
    }
    let menuBar = unsafeBitCast(value, to: AXUIElement.self)
    let deadline = Date().addingTimeInterval(ElementTreeWalker.timeBudget)
    // A read skipped for want of time, or one the app did not answer, leaves
    // the index incomplete.
    var missed = false
    // Each read waits at most for what is left of the budget.
    func bounded(_ element: AXUIElement) -> Bool {
      let remaining = deadline.timeIntervalSinceNow
      guard remaining >= ElementTreeWalker.minimumRead else {
        missed = true
        return false
      }
      AXUIElementSetMessagingTimeout(
        element, Float(min(Double(axMessagingTimeout), remaining)))
      return true
    }
    var built = Self.collect(
      menuBar: menuBar,
      children: { element in
        guard bounded(element) else { return [] }
        let (children, answered) = Self.children(of: element)
        if !answered { missed = true }
        return children
      },
      read: { element in
        guard bounded(element) else { return nil }
        guard let info = Self.read(element) else {
          missed = true
          return nil
        }
        return info
      },
      deadline: deadline
    )
    if missed { built.complete = false }
    return built
  }

  /// The index of an app whose menu bar could not be read. One that has no
  /// menu bar has no shortcut to find; one that did not answer may have any.
  nonisolated static func withoutMenuBar(_ status: AXError) -> Built<AXUIElement> {
    var built = Built<AXUIElement>()
    built.complete = [.noValue, .attributeUnsupported].contains(status)
    return built
  }

  /// A menu's items, and whether the app answered. An element with no
  /// children says so; one that timed out or went away does not.
  nonisolated static func children(of element: AXUIElement) -> ([AXUIElement], Bool) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    switch status {
    case .success:
      return ((value as? [AXUIElement]) ?? [], true)
    case .noValue, .attributeUnsupported:
      return ([], true)
    default:
      return ([], false)
    }
  }

  /// What the index needs of one menu item.
  struct ItemInfo: Equatable {
    var combo: KeyCombo?
    var enabled: Bool = true
    var title: String?
  }

  /// The Apple menu and the Services submenu first — their shortcuts are the
  /// ones that must be known before any keystroke goes out — then the app's
  /// menus: two levels eagerly, deeper only where an item has a submenu.
  ///
  /// It runs under the same budget as the window read. What was read by then
  /// is the index; a shortcut it does not hold goes out as a keystroke, the
  /// route `key` already has for keys no menu names. A disabled item is not
  /// indexed, so its shortcut goes out as the keystroke a person would press,
  /// which the app answers as it would for them.
  nonisolated static func collect<Node>(
    menuBar: Node,
    children: (Node) -> [Node],
    read: (Node) -> ItemInfo?,
    deadline: Date,
    now: () -> Date = Date.init
  ) -> Built<Node> {
    var built = Built<Node>()
    var expired = false

    func inTime() -> Bool {
      if !expired, now() >= deadline { expired = true }
      return !expired
    }

    /// Every shortcut under `element`, recorded as reserved.
    func reserve(_ element: Node, depth: Int) {
      guard depth < 4, inTime() else { return }
      for item in children(element) {
        guard inTime() else { return }
        if let combo = read(item)?.combo { built.reserved.insert(key(for: combo)) }
        for submenu in children(item) { reserve(submenu, depth: depth + 1) }
      }
    }

    func index(_ element: Node, depth: Int, inApplicationMenu: Bool) {
      guard depth < 4, inTime() else { return }
      for item in children(element) {
        guard inTime() else { return }
        let info = read(item)
        let submenus = children(item)
        let isServices =
          (inApplicationMenu && depth == 0 && !submenus.isEmpty)
          || info?.title.map(servicesTitles.contains) == true
        if isServices {
          for submenu in submenus { reserve(submenu, depth: depth + 1) }
          continue
        }
        if let info, info.enabled, let combo = info.combo {
          let key = key(for: combo)
          if built.shortcuts[key] == nil, !built.reserved.contains(key) {
            built.shortcuts[key] = item
          }
        }
        for submenu in submenus {
          index(submenu, depth: depth + 1, inApplicationMenu: inApplicationMenu)
        }
      }
    }

    let items = children(menuBar)
    guard inTime() else {
      built.complete = false
      return built
    }
    // The Apple menu is the menu bar's first item. The application menu is
    // the second; the only submenu macOS puts in it is Services.
    let apple = items.first
    let application = items.dropFirst().first
    if let apple {
      for menu in children(apple) { reserve(menu, depth: 0) }
    }
    if let application {
      for menu in children(application) { index(menu, depth: 0, inApplicationMenu: true) }
    }
    for menu in items.dropFirst(2) {
      guard inTime() else { break }
      for container in children(menu) { index(container, depth: 0, inApplicationMenu: false) }
    }
    for key in built.reserved { built.shortcuts[key] = nil }
    if expired { built.complete = false }
    return built
  }

  /// `File › Save`: the titles from the menu bar down to the item, read
  /// before the item is pressed, since pressing it may take it away. One
  /// round trip per level, and never longer than `menuPathBudget` in all:
  /// the path only names the action, so a slow app gets a shorter name.
  nonisolated static func menuPath(of item: AXUIElement) -> [String] {
    let names = [kAXRoleAttribute, kAXTitleAttribute, kAXParentAttribute] as CFArray
    let deadline = Date().addingTimeInterval(menuPathBudget)
    var titles: [String] = []
    var element: AXUIElement? = item
    for _ in 0..<6 {
      let remaining = deadline.timeIntervalSinceNow
      guard let current = element, remaining > 0.01 else { break }
      AXUIElementSetMessagingTimeout(current, Float(remaining))
      var values: CFArray?
      guard
        AXUIElementCopyMultipleAttributeValues(
          current, names, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
        let list = values as? [AnyObject], list.count == 3
      else { break }
      let role = AXValueReader.string(list[0])
      if role == kAXMenuBarRole as String { break }
      if role == kAXMenuItemRole as String || role == kAXMenuBarItemRole as String,
        let title = AXValueReader.string(list[1])
      {
        titles.insert(title, at: 0)
      }
      let parent = list[2]
      element =
        CFGetTypeID(parent) == AXUIElementGetTypeID()
        ? unsafeBitCast(parent, to: AXUIElement.self) : nil
    }
    return titles
  }

  nonisolated static let menuPathBudget: TimeInterval = 0.5

  nonisolated static func read(_ item: AXUIElement) -> ItemInfo? {
    let names =
      [
        "AXMenuItemCmdModifiers", "AXMenuItemCmdChar", "AXMenuItemCmdVirtualKey",
        kAXEnabledAttribute, kAXTitleAttribute,
      ] as CFArray
    var values: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        item, names, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
      let list = values as? [AnyObject], list.count == 5
    else { return nil }
    let rawModifiers = (list[0] as? NSNumber)?.intValue
    let commandCharacter = list[1] as? String
    let virtualKey = (list[2] as? NSNumber)?.intValue
    return ItemInfo(
      combo: shortcut(
        rawModifiers: rawModifiers, commandCharacter: commandCharacter, virtualKey: virtualKey),
      enabled: (list[3] as? NSNumber)?.boolValue ?? true,
      title: list[4] as? String)
  }

  nonisolated static func shortcut(rawModifiers: Int?, commandCharacter: String?, virtualKey: Int?)
    -> KeyCombo?
  {
    guard rawModifiers != nil || commandCharacter != nil || virtualKey != nil else { return nil }

    let bits = rawModifiers ?? 0
    var modifiers: Set<KeyModifier> = []
    if bits & noCommandBit == 0 { modifiers.insert(.cmd) }
    if bits & shiftBit != 0 { modifiers.insert(.shift) }
    if bits & optionBit != 0 { modifiers.insert(.alt) }
    if bits & controlBit != 0 { modifiers.insert(.ctrl) }

    if let commandCharacter, commandCharacter.unicodeScalars.count == 1,
      let scalar = commandCharacter.unicodeScalars.first
    {
      if let name = namedCharacters[scalar.value] {
        return KeyCombo(modifiers: modifiers, key: name)
      }
      if let character = commandCharacter.lowercased().first,
        !character.isWhitespace, !CharacterSet.controlCharacters.contains(scalar),
        !(0xF700...0xF8FF).contains(scalar.value)
      {
        return KeyCombo(modifiers: modifiers, key: String(character))
      }
    }
    if let virtualKey, let name = namedKey(forVirtualKey: CGKeyCode(virtualKey)) {
      return KeyCombo(modifiers: modifiers, key: name)
    }
    return nil
  }

  /// Menu key equivalents that are control characters or AppKit's function
  /// key characters, by the name `key` spells them — so Force Quit's
  /// Option-Command-Escape is `alt+cmd+escape`, not an invisible character.
  nonisolated static let namedCharacters: [UInt32: String] = {
    var names: [UInt32: String] = [
      0x1B: "escape", 0x0D: "enter", 0x03: "enter", 0x09: "tab", 0x08: "delete",
      0x7F: "delete", 0x20: "space", 0xF700: "up", 0xF701: "down", 0xF702: "left",
      0xF703: "right", 0xF728: "forwarddelete", 0xF729: "home", 0xF72B: "end",
      0xF72C: "pageup", 0xF72D: "pagedown",
    ]
    for number in 1...12 { names[0xF703 + UInt32(number)] = "f\(number)" }
    return names
  }()

  /// The reverse of the named-key table, so a menu item that names a virtual
  /// key (Return, the arrows, the function keys) can be matched by name.
  nonisolated static func namedKey(forVirtualKey code: CGKeyCode) -> String? {
    VirtualKeys.named.first(where: { $0.value == code })?.key
  }
}
