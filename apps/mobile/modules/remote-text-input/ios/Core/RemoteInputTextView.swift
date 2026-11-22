// tests/typing-order.interaction.test.tsx ports RemoteInputGate.swift, RemoteInputTextView.swift
// and RemoteInputEdits.swift to TypeScript to test the JavaScript adapter: change it with them.
import UIKit
import UniformTypeIdentifiers

@MainActor public final class RemoteInputTextView: UITextView, UITextViewDelegate {
  private let gate = RemoteInputGate()
  /// Where each waiting edit was typed, carried over the edits applied before its turn.
  private var edits = RemoteInputEdits()
  private var mutating = false
  private var held = Set<Int>()
  private var contextId: String?
  private var traits: RemoteInputTraits?
  private let noKeyboard = UIView(frame: .zero)
  public override var canBecomeFirstResponder: Bool { true }
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
    gate.idle = { [weak self] in self?.edits.settle() }
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
  private var length: Int { (text ?? "").utf16.count }
  private var markedRange: NSRange? {
    markedTextRange.map { NSRange(location: offset(from: beginningOfDocument, to: $0.start), length: offset(from: $0.start, to: $0.end)) }
  }
  /// A place in the text as UIKit names it now, while earlier edits may still wait their turn.
  private func place(_ range: NSRange) -> RemoteInputEdits.Place { edits.place(range.location, range.location + range.length) }
  /// Where a place named earlier is now, after the edits applied since.
  private func range(_ place: RemoteInputEdits.Place) -> NSRange {
    let current = edits.current(place, length: length)
    return NSRange(location: current.start, length: current.end - current.start)
  }
  /// Puts the selection where a waiting edit was typed and returns where the edit goes: the
  /// marked text, while there is some, is where UIKit puts it.
  private func select(_ place: RemoteInputEdits.Place) -> NSRange {
    if let marked = markedRange { return marked }
    let target = range(place)
    if selectedRange != target { selectedRange = target }
    return target
  }
  /// Applies an edit of `target` and records what it became, for the edits still waiting.
  private func edit(_ target: NSRange, _ action: () -> Void) {
    let before = length
    action()
    edits.record(start: target.location, removed: target.length, inserted: length - before + target.length)
  }
  private func apply(_ instruction: [String: Any]) {
    guard markedTextRange == nil, let state = instruction["set"] as? [String: Any],
      let value = state["value"] as? String, let start = state["selectionStart"] as? Int,
      let end = state["selectionEnd"] as? Int, start >= 0, end >= start, end <= value.utf16.count else { return }
    mutating = true
    edit(NSRange(location: 0, length: length)) { text = value }
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
    let typed = place(selectedRange)
    change(markedTextRange == nil ? (text == "\n" ? "insertLineBreak" : "insertText") : "insertFromComposition", data: text) {
      self.edit(self.select(typed)) { super.insertText(text) }
    }
  }
  /// Replaces what UIKit named, wherever the edits applied since have moved it.
  private func replaceTyped(_ typed: RemoteInputEdits.Place, with text: String) {
    let target = range(typed)
    guard let a = position(from: beginningOfDocument, offset: target.location), let b = position(from: a, offset: target.length), let current = textRange(from: a, to: b) else { return }
    edit(target) { super.replace(current, withText: text) }
  }
  public override func replace(_ range: UITextRange, withText text: String) {
    if mutating { super.replace(range, withText: text); return }
    let typed = edits.place(offset(from: beginningOfDocument, to: range.start), offset(from: beginningOfDocument, to: range.end))
    change("insertReplacementText", data: text) { self.replaceTyped(typed, with: text) }
  }
  public override func deleteBackward() {
    if mutating { super.deleteBackward(); return }
    let typed = place(selectedRange)
    change("deleteContentBackward", data: nil) {
      let target = self.select(typed)
      let before = self.length
      super.deleteBackward()
      let removed = before - self.length
      // What went is the selection, or as much just before the caret.
      self.edits.record(start: target.length > 0 ? target.location : target.location - removed, removed: removed, inserted: 0)
    }
  }
  public override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    if mutating { super.setMarkedText(markedText, selectedRange: selectedRange); return }
    let typed = place(self.selectedRange)
    change("insertCompositionText", data: markedText) {
      self.edit(self.select(typed)) { super.setMarkedText(markedText, selectedRange: selectedRange) }
    }
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
    let typed = place(range)
    change(replacement.isEmpty ? "deleteContentBackward" : "insertReplacementText", data: replacement) { self.replaceTyped(typed, with: replacement) }
    return false
  }
  /// A selection UIKit or the person moved takes its turn after the edits typed before it, at the
  /// place it was moved to, carried over them; JavaScript reads it as it is then.
  public func textViewDidChangeSelection(_ textView: UITextView) {
    if mutating { return }
    let moved = place(selectedRange)
    gate.enqueue {
      self.mutating = true
      _ = self.select(moved)
      self.mutating = false
      self.gate.event(["type": "selection", "proxy": self.snapshot()])
    }
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
    // Leave system/app Command shortcuts in the responder chain outside text editing.
    if !isEditable && key.modifierFlags.contains(.command) && (down || !held.contains(usage)) { action(); return }
    let named: [Int: String] = [40: "Enter", 41: "Escape", 42: "Backspace", 43: "Tab", 44: " ", 73: "Insert", 74: "Home", 75: "PageUp", 76: "Delete", 77: "End", 78: "PageDown", 79: "ArrowRight", 80: "ArrowLeft", 81: "ArrowDown", 82: "ArrowUp", 101: "ContextMenu", 224: "Control", 225: "Shift", 226: "Alt", 227: "Meta", 228: "Control", 229: "Shift", 230: "Alt", 231: "Meta"]
    let name = (58...69).contains(usage) ? "F\(usage - 57)" : named[usage]
    let code: String
    if usage >= 4 && usage <= 29 { code = "Key" + String(UnicodeScalar(65 + usage - 4)!) }
    else if usage >= 30 && usage <= 39 { code = "Digit\((usage - 29) % 10)" }
    else if usage >= 224 && usage <= 231 { code = (named[usage] ?? "Unidentified") + (usage < 228 ? "Left" : "Right") }
    else { code = [44: "Space", 45: "Minus", 46: "Equal", 47: "BracketLeft", 48: "BracketRight", 49: "Backslash", 51: "Semicolon", 52: "Quote", 53: "Backquote", 54: "Comma", 55: "Period", 56: "Slash"][usage] ?? name ?? "Unidentified" }
    let flags = key.modifierFlags
    let repeated = down && held.contains(usage)
    if down { held.insert(usage) } else { held.remove(usage) }
    let event: [String: Any] = ["type": down ? "keydown" : "keyup", "key": name ?? key.characters, "code": code, "alt": flags.contains(.alternate), "control": flags.contains(.control), "meta": flags.contains(.command), "shift": flags.contains(.shift), "altGraph": false, "location": usage >= 224 && usage <= 231 ? (usage < 228 ? 1 : 2) : (usage >= 84 && usage <= 99 ? 3 : 0), "repeat": repeated]
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
  public func configure(_ context: [String: Any]?, focused: Bool, softKeyboard: Bool = true, keyboardMayReplaceText: Bool = true) {
    gate.enqueue {
      if context?["contextId"] as? String != self.contextId {
        self.unmarkText()
        // The ending's acknowledgement precedes the reset and new-context input.
        self.gate.enqueue { self.applyConfiguration(context, focused: focused, softKeyboard: softKeyboard, keyboardMayReplaceText: keyboardMayReplaceText) }
      } else {
        self.applyConfiguration(context, focused: focused, softKeyboard: softKeyboard, keyboardMayReplaceText: keyboardMayReplaceText)
      }
    }
  }
  private func applyConfiguration(_ context: [String: Any]?, focused: Bool, softKeyboard: Bool, keyboardMayReplaceText: Bool) {
    let nextContext = context?["contextId"] as? String
    if nextContext != contextId {
      contextId = nextContext
      gate.contextId = nextContext
      mutating = true
      edit(NSRange(location: 0, length: length)) { text = "" }
      selectedRange = NSRange(location: 0, length: 0)
      mutating = false
    }
    let nextTraits = RemoteInputTraits(context, softKeyboard: softKeyboard, keyboardMayReplaceText: keyboardMayReplaceText)
    let changed = traits != nextTraits
    if changed {
      traits = nextTraits
      isEditable = nextTraits.editable
      isSecureTextEntry = nextTraits.sensitive
      autocorrectionType = nextTraits.allowsSuggestions ? .default : .no
      spellCheckingType = nextTraits.allowsSuggestions ? .default : .no
      if #available(iOS 17.0, *) {
        inlinePredictionType = nextTraits.keyboardMayReplaceText ? .default : .no
      }
      smartInsertDeleteType = nextTraits.keyboardMayReplaceText ? .default : .no
      keyboardType = ["numeric": .numberPad, "decimal": .decimalPad, "tel": .phonePad, "email": .emailAddress, "url": .URL, "search": .webSearch][nextTraits.inputMode] ?? .default
      returnKeyType = ["done": .done, "go": .go, "next": .next, "search": .search, "send": .send][nextTraits.enterKeyHint] ?? .default
      autocapitalizationType = ["sentences": .sentences, "words": .words, "characters": .allCharacters][nextTraits.autocapitalize] ?? .none
      inputView = nextTraits.showsKeyboard ? nil : noKeyboard
    }
    if focused {
      if !isFirstResponder { becomeFirstResponder() }
      else if changed { reloadInputViews() }
    } else if isFirstResponder { resignFirstResponder() }
  }
}
