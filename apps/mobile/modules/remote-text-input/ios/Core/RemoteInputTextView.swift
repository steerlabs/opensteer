import UIKit
import UniformTypeIdentifiers

@MainActor public final class RemoteInputTextView: UITextView, UITextViewDelegate {
  private let gate = RemoteInputGate()
  private var mutating = false
  private var held = Set<Int>()
  private var contextId: String?
  public var deliver: (([String: Any]) -> Void)? { didSet { gate.deliver = deliver } }
  public override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    delegate = self
    backgroundColor = .clear
    textColor = .clear
    tintColor = .clear
    accessibilityLabel = "Type into the remote field"
    smartQuotesType = .no
    smartDashesType = .no
    gate.apply = { [weak self] in self?.apply($0) }
  }
  public convenience init() { self.init(frame: .zero, textContainer: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
  public func respond(_ instruction: [String: Any]) { gate.respond(instruction) }
  private func snapshot() -> [String: Any] {
    var state: [String: Any] = ["value": text ?? "", "selectionStart": selectedRange.location, "selectionEnd": selectedRange.location + selectedRange.length]
    if let range = markedTextRange { state["markedRange"] = ["start": offset(from: beginningOfDocument, to: range.start), "end": offset(from: beginningOfDocument, to: range.end)] }
    return state
  }
  private func marked() -> String { markedTextRange.flatMap { self.text(in: $0) } ?? "" }
  private func apply(_ instruction: [String: Any]) {
    guard markedTextRange == nil, let state = instruction["set"] as? [String: Any],
      let value = state["value"] as? String, let start = state["selectionStart"] as? Int,
      let end = state["selectionEnd"] as? Int, start >= 0, end >= start, end <= value.utf16.count else { return }
    mutating = true
    text = value
    selectedRange = NSRange(location: start, length: end - start)
    mutating = false
  }
  private func change(_ inputType: String, data: String?, _ action: @escaping () -> Void) {
    gate.enqueue {
      self.gate.event(["type": "beforeinput", "inputType": inputType, "data": data as Any? ?? NSNull()]) {
        let wasComposing = self.markedTextRange != nil
        self.mutating = true
        action()
        self.mutating = false
        let composing = self.markedTextRange != nil
        if !wasComposing && composing { self.gate.notify(["type": "compositionstart", "proxy": self.snapshot()]) }
        if composing { self.gate.notify(["type": "compositionupdate", "data": self.marked(), "proxy": self.snapshot()]) }
        if wasComposing && !composing { self.gate.notify(["type": "compositionend", "data": data ?? "", "proxy": self.snapshot()]) }
        self.gate.notify(["type": "input", "inputType": inputType, "composing": composing, "proxy": self.snapshot()])
      }
    }
  }
  public override func insertText(_ text: String) {
    if mutating { super.insertText(text); return }
    change(markedTextRange == nil ? (text == "\n" ? "insertLineBreak" : "insertText") : "insertFromComposition", data: text) { super.insertText(text) }
  }
  public override func replace(_ range: UITextRange, withText text: String) {
    if mutating { super.replace(range, withText: text); return }
    let start = offset(from: beginningOfDocument, to: range.start)
    let end = offset(from: beginningOfDocument, to: range.end)
    change("insertReplacementText", data: text) {
      guard let a = self.position(from: self.beginningOfDocument, offset: start), let b = self.position(from: self.beginningOfDocument, offset: end), let current = self.textRange(from: a, to: b) else { return }
      super.replace(current, withText: text)
    }
  }
  public override func deleteBackward() {
    if mutating { super.deleteBackward(); return }
    change("deleteContentBackward", data: nil) { super.deleteBackward() }
  }
  public override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    if mutating { super.setMarkedText(markedText, selectedRange: selectedRange); return }
    change("insertCompositionText", data: markedText) { super.setMarkedText(markedText, selectedRange: selectedRange) }
  }
  public override func unmarkText() {
    if mutating { super.unmarkText(); return }
    gate.enqueue {
      guard self.markedTextRange != nil else { return }
      let data = self.marked()
      self.mutating = true
      super.unmarkText()
      self.mutating = false
      self.gate.notify(["type": "compositionend", "data": data, "proxy": self.snapshot()])
    }
  }
  public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
    if mutating { return true }
    guard isEditable else { return false }
    change(replacement.isEmpty ? "deleteContentBackward" : "insertReplacementText", data: replacement) {
      guard let start = self.position(from: self.beginningOfDocument, offset: range.location), let end = self.position(from: start, offset: range.length), let current = self.textRange(from: start, to: end) else { return }
      super.replace(current, withText: replacement)
    }
    return false
  }
  public func textViewDidChangeSelection(_ textView: UITextView) {
    if !mutating { gate.notify(["type": "selection", "proxy": snapshot()]) }
  }
  public func textViewDidEndEditing(_ textView: UITextView) {
    held.removeAll()
    gate.notify(["type": "blur"])
  }
  public override func copy(_ sender: Any?) { gate.notify(["type": "copy"]) }
  public override func cut(_ sender: Any?) { gate.notify(["type": "cut"]) }
  public override func paste(_ sender: Any?) {
    gate.enqueue {
      var items: [[String: Any]] = []
      var bytes = 0
      func append(_ type: String, _ data: Data) {
        bytes += data.count
        if bytes <= 16 * 1024 * 1024 && items.count < 16 { items.append(["type": type, "data": data.base64EncodedString()]) }
      }
      for item in UIPasteboard.general.items {
        for (key, mime) in [(UTType.utf8PlainText.identifier, "text/plain"), (UTType.html.identifier, "text/html"), (UTType.png.identifier, "image/png"), (UTType.jpeg.identifier, "image/jpeg")] {
          if let data = item[key] as? Data { append(mime, data) }
          else if let value = item[key] as? String, let data = value.data(using: .utf8) { append(mime, data) }
          else if let image = item[key] as? UIImage, let data = mime == "image/jpeg" ? image.jpegData(compressionQuality: 1) : image.pngData() { append(mime, data) }
        }
      }
      if bytes > 16 * 1024 * 1024 { self.gate.notify(["type": "paste", "items": []]); return }
      self.gate.notify(["type": "paste", "items": items])
    }
  }
  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(copy(_:)) || action == #selector(cut(_:)) { return isEditable && !isSecureTextEntry }
    if action == #selector(paste(_:)) { return isEditable }
    return super.canPerformAction(action, withSender: sender)
  }
  private func hardware(_ press: UIPress, down: Bool, action: @escaping () -> Void) {
    guard let key = press.key else { action(); return }
    let usage = Int(key.keyCode.rawValue)
    let named: [Int: String] = [40: "Enter", 41: "Escape", 42: "Backspace", 43: "Tab", 44: " ", 73: "Insert", 74: "Home", 75: "PageUp", 76: "Delete", 77: "End", 78: "PageDown", 79: "ArrowRight", 80: "ArrowLeft", 81: "ArrowDown", 82: "ArrowUp", 224: "Control", 225: "Shift", 226: "Alt", 227: "Meta", 228: "Control", 229: "Shift", 230: "Alt", 231: "Meta"]
    let code: String
    if usage >= 4 && usage <= 29 { code = "Key" + String(UnicodeScalar(65 + usage - 4)!) }
    else if usage >= 30 && usage <= 39 { code = "Digit\((usage - 29) % 10)" }
    else if usage >= 224 && usage <= 231 { code = (named[usage] ?? "Unidentified") + (usage < 228 ? "Left" : "Right") }
    else { code = [44: "Space", 45: "Minus", 46: "Equal", 47: "BracketLeft", 48: "BracketRight", 49: "Backslash", 51: "Semicolon", 52: "Quote", 53: "Backquote", 54: "Comma", 55: "Period", 56: "Slash"][usage] ?? named[usage] ?? "Unidentified" }
    let flags = key.modifierFlags
    let repeated = down && held.contains(usage)
    if down { held.insert(usage) } else { held.remove(usage) }
    let event: [String: Any] = ["type": down ? "keydown" : "keyup", "key": named[usage] ?? key.characters, "code": code, "alt": flags.contains(.alternate), "control": flags.contains(.control), "meta": flags.contains(.command), "shift": flags.contains(.shift), "altGraph": false, "location": usage >= 224 && usage <= 231 ? (usage < 228 ? 1 : 2) : (usage >= 84 && usage <= 99 ? 3 : 0), "repeat": repeated]
    gate.enqueue {
      var current = event
      current["composing"] = self.markedTextRange != nil
      self.gate.event(current, default: action)
    }
  }
  public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses { hardware(press, down: true) { super.pressesBegan([press], with: event) } }
  }
  public override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses { hardware(press, down: false) { super.pressesEnded([press], with: event) } }
  }
  public override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses { hardware(press, down: false) { super.pressesCancelled([press], with: event) } }
  }
  public func configure(_ context: [String: Any]?, focused: Bool) {
    gate.enqueue {
      if context?["contextId"] as? String != self.contextId {
        self.unmarkText()
        // The ending's acknowledgement precedes the reset and new-context input.
        self.gate.enqueue { self.applyConfiguration(context, focused: focused) }
      } else {
        self.applyConfiguration(context, focused: focused)
      }
    }
  }
  private func applyConfiguration(_ context: [String: Any]?, focused: Bool) {
    let nextContext = context?["contextId"] as? String
    if nextContext != contextId {
      contextId = nextContext
      gate.contextId = nextContext
      mutating = true
      text = ""
      selectedRange = NSRange(location: 0, length: 0)
      mutating = false
    }
    let field = context?["field"] as? [String: Any]
    let editable = field != nil
    isEditable = editable
    let sensitive = field?["sensitive"] as? Bool == true
    isSecureTextEntry = sensitive
    autocorrectionType = sensitive ? .no : .default
    spellCheckingType = sensitive ? .no : .default
    keyboardType = ["numeric": .numberPad, "decimal": .decimalPad, "tel": .phonePad, "email": .emailAddress, "url": .URL, "search": .webSearch][field?["inputMode"] as? String ?? ""] ?? .default
    returnKeyType = ["done": .done, "go": .go, "next": .next, "search": .search, "send": .send][field?["enterKeyHint"] as? String ?? ""] ?? .default
    autocapitalizationType = ["off": .none, "none": .none, "on": .sentences, "sentences": .sentences, "words": .words, "characters": .allCharacters][field?["autocapitalize"] as? String ?? "none"] ?? .none
    inputView = field?["inputMode"] as? String == "none" ? UIView(frame: .zero) : nil
    if editable && focused { if !isFirstResponder { becomeFirstResponder() }; reloadInputViews() }
    else { resignFirstResponder() }
  }
}
