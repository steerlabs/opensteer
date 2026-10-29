import Foundation

/// Receipts describe completed input using the same labels as the cited tree.
enum ActionReceipt {
  static let maxLength = 160

  static func format(
    _ action: ActionRequest, elements: [ElementAttributes], secureReceiver: Bool = false
  ) throws -> String {
    func element(_ target: ActionTarget?) -> ElementAttributes? {
      guard case .index(let index) = target, elements.indices.contains(index) else { return nil }
      return elements[index]
    }
    func name(_ attributes: ElementAttributes) -> Part {
      var safe = attributes
      if isSecure(safe) { safe.value = nil }
      if let label = TreeFormatter.label(safe) { return .quoted(label) }
      let role = TreeFormatter.role(safe)
      let phrases = [
        "radiobutton": "radio button", "textfield": "text field",
        "securetextfield": "secure text field", "searchfield": "search field",
        "textarea": "text area", "scrollarea": "scroll area", "checkbox": "checkbox",
        "popupbutton": "pop-up button", "menubutton": "menu button",
        "menuitem": "menu item", "menubaritem": "menu bar item", "combobox": "combo box",
        "statictext": "text", "tabgroup": "tab group",
      ]
      return .literal("the \(phrases[role] ?? role)")
    }
    func text(_ value: String) -> Part { .quoted(TreeFormatter.sanitize(value)) }

    switch action {
    case .click(let target, let button, let count):
      let verb: String
      switch button {
      case .right: verb = count == 1 ? "Right-clicked" : "Right-clicked \(count) times"
      case .middle: verb = count == 1 ? "Middle-clicked" : "Middle-clicked \(count) times"
      case .left: verb = count == 3 ? "Triple-clicked" : count == 2 ? "Double-clicked" : "Clicked"
      }
      if let attributes = element(target) {
        return render([.literal(verb + " "), name(attributes)])
      }
      if case .point(let point) = target {
        return "\(verb) at \(TreeFormatter.number(point.x)), \(TreeFormatter.number(point.y))"
      }
      return "\(verb) the element"
    case .type(let value, let target):
      let attributes = element(target)
      let secure =
        secureReceiver || attributes.map(isSecure) == true
        || (target == nil && elements.contains { $0.focused && isSecure($0) })
      var parts: [Part] = [.literal("Typed ")]
      parts.append(secure ? .literal("\(value.count) characters") : text(value))
      if let attributes { parts += [.literal(" into "), name(attributes)] }
      return render(parts)
    case .savedText(let envelope, _): return SavedLoginInput.receipt(envelope.binding.field)
    case .key(let keys):
      // Only a successfully parsed and completed key action receives a receipt.
      return clipped("Pressed \(try KeyComboParser.parse(keys).display)", limit: maxLength)
    case .setValue(let index, let value):
      let attributes = element(.index(index))
      return render([
        .literal("Set "), attributes.map(name) ?? .literal("the element"), .literal(" to "),
        secureReceiver || attributes.map(isSecure) == true
          ? .literal("\(value.count) characters") : text(value),
      ])
    case .scroll(let target, let direction, _):
      var parts: [Part] = [.literal("Scrolled \(direction.rawValue)")]
      if let attributes = element(target) { parts += [.literal(" in "), name(attributes)] }
      return render(parts)

    }
  }

  static func isSecure(_ attributes: ElementAttributes) -> Bool {
    isSecure(role: attributes.role, subrole: attributes.subrole)
  }

  static func isSecure(role: String?, subrole: String?) -> Bool {
    role == nil || role == "AXSecureTextField" || subrole == "AXSecureTextField"
  }

  private enum Part {
    case literal(String)
    case quoted(String)

    var value: String {
      switch self {
      case .literal(let value): return value
      case .quoted(let value): return "\"\(value)\""
      }
    }
  }

  private static func clipped(_ text: String, limit: Int) -> String {
    guard text.utf16.count > limit else { return text }
    var result = ""
    for character in text {
      guard result.utf16.count + String(character).utf16.count < limit else { break }
      result.append(character)
    }
    return result + "…"
  }

  private static func render(_ parts: [Part]) -> String {
    var parts = parts
    // Zod's string limit counts UTF-16 units, including both halves of emoji.
    while parts.reduce(0, { $0 + $1.value.utf16.count }) > maxLength {
      guard
        let index = parts.indices.filter({
          if case .quoted(let value) = parts[$0] { return value != "…" }
          return false
        }).max(by: { parts[$0].value.utf16.count < parts[$1].value.utf16.count }),
        case .quoted(var value) = parts[index]
      else { break }
      if value.hasSuffix("…") { value.removeLast() }
      if !value.isEmpty { value.removeLast() }
      // Do not leave a dangling escape before the closing quote.
      while value.hasSuffix("\\") { value.removeLast() }
      parts[index] = .quoted(value + "…")
    }
    return clipped(parts.map(\.value).joined(), limit: maxLength)
  }
}
