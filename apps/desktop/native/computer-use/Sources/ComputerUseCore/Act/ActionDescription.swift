import CoreGraphics
import Foundation

/// What one completed action did, in the words a person reading the
/// transcript and the model reading its result both use (§2 "Actions"):
/// a past-tense verb and the element as the person sees it —
/// `Clicked "Save"`, `Typed "Venue shortlist" into "Title"`, `Pressed ⌘S`.
///
/// Text typed into a secure field is never repeated, only counted. Every
/// description is one line of at most `maxLength` UTF-16 code units.
public enum ActionDescription {
  /// `computerUsePerformedMaxLength` in the protocol package, counted as it
  /// counts: in UTF-16 code units.
  public static let maxLength = 160
  /// Typed text, values and element names are cut here (in UTF-16 code
  /// units, like `maxLength`), so one long string
  /// cannot crowd out the rest of the sentence.
  static let quotedLimit = 40

  // MARK: - Actions

  /// `element` is the element clicked when the action named one, or the
  /// element the cited observation shows under the point; `point` is the
  /// target in screenshot pixels, used only when there is no element.
  public static func click(
    button: MouseButton, count: Int, element: ElementAttributes?, point: CGPoint?
  ) -> String {
    let verb: String
    switch button {
    case .left:
      verb = count >= 3 ? "Triple-clicked" : count == 2 ? "Double-clicked" : "Clicked"
    case .right:
      verb = "Right-clicked"
    case .middle:
      verb = "Middle-clicked"
    }
    let repeats = button != .left && count > 1 ? (count == 2 ? " twice" : " \(count) times") : ""
    if let element, let object = object(element) {
      return finish("\(verb) \(object)\(repeats)")
    }
    if let point {
      return finish("\(verb) at (\(Int(point.x.rounded())), \(Int(point.y.rounded())))\(repeats)")
    }
    return finish("\(verb)\(repeats)")
  }

  /// `field` is the element the action named, as observed; `focused` is
  /// what the app reported as focused when the text went in — the element
  /// this action focused, and whatever the app says has the focus. The field
  /// is named by the first of them that can be read.
  ///
  /// Text is counted when a receiver is secure or unreadable, or the caller
  /// cannot verify the receiver throughout delivery. Redaction uncertainty
  /// does not invent element attributes for the description.
  public static func type(
    text: String, field: ElementAttributes?, focused: [ElementAttributes] = [], redact: Bool = false
  ) -> String {
    let known = readable([field] + focused)
    let into = known.lazy.compactMap(object).first.map { " into \($0)" } ?? ""
    if redact || mayBeSecure(known) {
      return finish("Typed \(characters(text.count))\(into)")
    }
    return finish("Typed \(quoted(text))\(into)")
  }

  /// A shortcut the app's own menu answered: the menu path, `File › Save`.
  public static func menu(path: [String]) -> String? {
    let titles = path.map(clean).filter { !$0.isEmpty }
    guard !titles.isEmpty else { return nil }
    return finish("Chose \(titles.joined(separator: " › "))")
  }

  public static func keystroke(_ combo: KeyCombo) -> String {
    finish("Pressed \(keys(combo))")
  }

  /// `field` is the element as observed and `current` what it reports now;
  /// the value is counted by the same rule as typed text.
  public static func setValue(
    value: String, field: ElementAttributes?, current: ElementAttributes? = nil
  ) -> String {
    let known = readable([field, current])
    let target = known.lazy.compactMap(object).first ?? "the value"
    if mayBeSecure(known) {
      return finish("Set \(target) to \(characters(value.count))")
    }
    return finish("Set \(target) to \(quoted(value))")
  }

  public static func scroll(direction: ScrollDirection, in element: ElementAttributes?) -> String {
    let place = element.flatMap(object).map { " in \($0)" } ?? ""
    return finish("Scrolled \(direction.rawValue)\(place)")
  }

  public static func wait(milliseconds: Int) -> String {
    let seconds = Double(milliseconds) / 1_000
    var number = String(format: "%.2f", seconds)
    while number.hasSuffix("0") { number.removeLast() }
    if number.hasSuffix(".") { number.removeLast() }
    return finish("Waited \(number) s")
  }

  // MARK: - Keys

  /// `⌘S`, `⇧⌘Z`, `⌃Tab`, `Return` — macOS's modifier glyphs, in its order.
  public static func keys(_ combo: KeyCombo) -> String {
    let glyphs: [(KeyModifier, String)] = [
      (.fn, "fn "), (.ctrl, "⌃"), (.alt, "⌥"), (.shift, "⇧"), (.cmd, "⌘"),
    ]
    let prefix = glyphs.filter { combo.modifiers.contains($0.0) }.map(\.1).joined()
    return prefix + keyName(combo.key)
  }

  static let keyNames: [String: String] = [
    "enter": "Return", "tab": "Tab", "escape": "Esc", "space": "Space", "delete": "Delete",
    "forwarddelete": "Forward Delete", "up": "↑", "down": "↓", "left": "←", "right": "→",
    "home": "Home", "end": "End", "pageup": "Page Up", "pagedown": "Page Down",
  ]

  static func keyName(_ key: String) -> String {
    keyNames[key] ?? key.uppercased()
  }

  // MARK: - Elements

  /// `"Save"`, or `the button` when the element has no name a person sees.
  static func object(_ element: ElementAttributes) -> String? {
    if let name = name(element) { return quoted(name) }
    return friendlyRole(element).map { "the \($0)" }
  }

  /// What a person calls the element: its title, else its description. A
  /// value names an element only where the value is its visible label — the
  /// text of a static text or a cell — never a field's contents, which is
  /// what was typed, not what the field is called.
  static func name(_ element: ElementAttributes) -> String? {
    var candidates = [element.title, element.help]
    if labelValueRoles.contains(element.role) { candidates.insert(element.value, at: 1) }
    for candidate in candidates {
      guard let candidate else { continue }
      let value = clean(candidate)
      if !value.isEmpty { return value }
    }
    return nil
  }

  static let labelValueRoles: Set<String> = ["AXStaticText", "AXCell", "AXLink"]

  static func isSecure(_ element: ElementAttributes) -> Bool {
    element.role == "AXSecureTextField" || element.subrole == "AXSecureTextField"
  }

  /// The elements whose attributes were actually read: one that did not
  /// answer reports the role `AXUnknown`.
  static func readable(_ elements: [ElementAttributes?]) -> [ElementAttributes] {
    elements.compactMap { $0 }.filter { !$0.role.isEmpty && $0.role != "AXUnknown" }
  }

  static func mayBeSecure(_ readable: [ElementAttributes]) -> Bool {
    readable.isEmpty || readable.contains(where: isSecure)
  }

  static let roleNames: [String: String] = [
    "AXButton": "button", "AXTextField": "text field", "AXTextArea": "text area",
    "AXSecureTextField": "password field", "AXSearchField": "search field",
    "AXCheckBox": "checkbox", "AXRadioButton": "radio button", "AXPopUpButton": "pop-up button",
    "AXMenuButton": "menu button", "AXComboBox": "combo box", "AXRow": "row", "AXCell": "cell",
    "AXLink": "link", "AXMenuItem": "menu item", "AXMenuBarItem": "menu", "AXTab": "tab",
    "AXTabButton": "tab", "AXSlider": "slider", "AXImage": "image", "AXStaticText": "text",
    "AXDisclosureTriangle": "disclosure triangle", "AXSwitch": "switch", "AXToggle": "switch",
    "AXIncrementor": "stepper", "AXStepper": "stepper", "AXColorWell": "color well",
    "AXDateField": "date field", "AXTimeField": "time field", "AXOutline": "outline",
    "AXTable": "table", "AXList": "list", "AXWebArea": "web page", "AXScrollArea": "scroll area",
    "AXToolbar": "toolbar", "AXWindow": "window", "AXSheet": "sheet", "AXDialog": "dialog",
    "AXGroup": "group", "AXSegmentedControl": "segmented control", "AXMenu": "menu",
    "AXPopover": "popover",
  ]

  /// `AXCheckBox` → `checkbox`; a subrole that says what the element really
  /// is — a search field, a switch, a tab — wins over its generic role.
  static func friendlyRole(_ element: ElementAttributes) -> String? {
    if let subrole = element.subrole, let name = roleNames[subrole] { return name }
    if let name = roleNames[element.role] { return name }
    guard element.role.hasPrefix("AX"), element.role.count > 2,
      element.role != "AXUnknown"
    else { return nil }
    // `AXLevelIndicator` → `level indicator`.
    var words = ""
    for character in element.role.dropFirst(2) {
      if character.isUppercase, !words.isEmpty { words.append(" ") }
      words.append(Character(character.lowercased()))
    }
    return words
  }

  // MARK: - Text

  /// `"Venue shortlist"`, one line, cut at `quotedLimit` code units. A line
  /// break or tab in typed text is a key the person would press, so it shows
  /// as that key's glyph rather than breaking the line.
  static func quoted(_ text: String) -> String {
    let visible = text.replacingOccurrences(of: "\r\n", with: "↵")
      .replacingOccurrences(of: "\n", with: "↵")
      .replacingOccurrences(of: "\r", with: "↵")
      .replacingOccurrences(of: "\t", with: "⇥")
    return "\"\(clip(oneLine(visible), to: quotedLimit))\""
  }

  static func characters(_ count: Int) -> String {
    count == 1 ? "1 character" : "\(count) characters"
  }

  /// One line with single spaces.
  static func clean(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
      .joined(separator: " ")
  }

  /// Line breaks and other control whitespace become spaces; the spaces a
  /// person typed are kept.
  static func oneLine(_ text: String) -> String {
    String(text.map { $0.isNewline || $0 == "\t" ? " " : $0 })
  }

  /// Cuts to at most `limit` UTF-16 code units, ellipsis included, because
  /// that is what the protocol's string length counts; a flag or a family
  /// emoji is one character but up to eleven code units. The cut falls only
  /// between characters, so no emoji or combining mark is split.
  static func clip(_ text: String, to limit: Int) -> String {
    guard text.utf16.count > limit else { return text }
    let budget = limit - "…".utf16.count
    var used = 0
    var end = text.startIndex
    while end < text.endIndex {
      let next = text.index(after: end)
      let size = text[end..<next].utf16.count
      if used + size > budget { break }
      used += size
      end = next
    }
    return String(text[..<end]) + "…"
  }

  static func finish(_ text: String) -> String {
    clip(oneLine(text), to: maxLength)
  }
}
