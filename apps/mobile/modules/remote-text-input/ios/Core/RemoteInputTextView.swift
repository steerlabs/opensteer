#if canImport(UIKit)
// tests/remote-input-port.ts ports RemoteInputGate.swift, RemoteInputTextView.swift and
// RemoteInputEdits.swift to TypeScript for the JavaScript adapter's tests: change it with them.
// Tests/Cases/remote-input-edits.json holds RemoteInputEdits' cases, run against both.
import UIKit
import UniformTypeIdentifiers

@MainActor public final class RemoteInputTextView: UITextView, UITextViewDelegate {
  let gate = RemoteInputGate()
  /// Where each waiting edit was typed, carried over the edits applied before its turn.
  private var edits = RemoteInputEdits()
  private var mutating = false
  /// The selection the view itself last left, so a selection callback UIKit sends about it later
  /// (on another run loop turn, after `mutating` is false again) is not taken for a choice.
  private var ownSelection: NSRange?
  /// The selection the person chose after an edit that has since been applied inside a
  /// composition: UIKit's selection is in the composition until it ends, the person's is here,
  /// and what they type meanwhile is named here.
  private var heldChoice: RemoteInputEdits.Place?
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
    gate.idle = { [weak self] in
      self?.edits.settle()
      self?.heldChoice = nil
    }
    installTouch()
  }
  public convenience init() { self.init(frame: .zero, textContainer: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
  public func respond(_ instruction: [String: Any]) { gate.respond(instruction) }
  /// The field's text and caret are invisible, so a touch on it changes nothing a person cannot
  /// see: no selection and no caret move. Only the view's own two recognizers begin, by
  /// allowlist: a tap that focuses the field and a long press that offers Paste. Every
  /// recognizer UIKit installs is refused, whatever its class (its text taps, tap-and-drag and
  /// loupe are not UITapGestureRecognizer subclasses). The person moves the caret on the page or
  /// with the keyboard.
  private lazy var focusTap = UITapGestureRecognizer(target: self, action: #selector(focusTapped))
  private lazy var pasteLongPress = UILongPressGestureRecognizer(target: self, action: #selector(pasteLongPressRecognized(_:)))
  private lazy var pasteMenuDelegate = RemoteInputPasteMenu(view: self)
  private var pasteMenuInteraction: UIInteraction?
  func isOwn(_ recognizer: UIGestureRecognizer) -> Bool { recognizer === focusTap || recognizer === pasteLongPress }
  public override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool { isOwn(recognizer) }
  private func installTouch() {
    addGestureRecognizer(focusTap)
    addGestureRecognizer(pasteLongPress)
    let menu = UIEditMenuInteraction(delegate: pasteMenuDelegate)
    addInteraction(menu)
    pasteMenuInteraction = menu
  }
  /// Focuses the field without placing its caret.
  @objc func focusTapped() {
    onFocusTap?()
    if !isFirstResponder { becomeFirstResponder() }
  }
  /// Told of each focus tap, for tests.
  var onFocusTap: (() -> Void)?
  /// VoiceOver's activation is the focus tap: no recognizer of UIKit's is left to focus the field.
  public override func accessibilityActivate() -> Bool {
    focusTapped()
    return true
  }
  /// gestureRecognizerShouldBegin is asked only about recognizers on the view itself, so no touch
  /// reaches its subviews (the text container view and whatever UIKit adds there): a touch
  /// anywhere in the view is the view's.
  public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let hit = super.hitTest(point, with: event) else { return nil }
    return hit.isDescendant(of: self) ? self : hit
  }
  /// Whether the pasteboard holds something Paste would send. Asking does not bring up the
  /// system's paste prompt; reading the items does.
  var pasteboardHasContent: () -> Bool = { UIPasteboard.general.hasStrings || UIPasteboard.general.hasImages }
  @objc private func pasteLongPressRecognized(_ recognizer: UILongPressGestureRecognizer) {
    if recognizer.state == .began { pasteLongPressed(at: recognizer.location(in: self)) }
  }
  /// Opens the view's own menu, which offers Paste alone and never moves the caret.
  func pasteLongPressed(at point: CGPoint) {
    guard isEditable, window != nil, let menu = pasteMenuInteraction as? UIEditMenuInteraction else { return }
    menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
  }
  /// Paste alone: the system's own Paste command where it suggests one, so it is named as the
  /// system names it.
  /// No menu when nothing can be pasted.
  func pasteMenu(suggested: [UIMenuElement]) -> UIMenu? {
    func find(_ elements: [UIMenuElement]) -> UIMenuElement? {
      for element in elements {
        if let command = element as? UICommand, command.action == #selector(UIResponderStandardEditActions.paste(_:)) { return command }
        if let menu = element as? UIMenu, let found = find(menu.children) { return found }
      }
      return nil
    }
    if let system = find(suggested) { return UIMenu(children: [system]) }
    guard pasteboardHasContent() else { return nil }
    return UIMenu(children: [UIAction(title: NSLocalizedString("Paste", comment: "")) { [weak self] _ in self?.paste(nil) }])
  }
  private func snapshot(selection: NSRange? = nil) -> [String: Any] {
    let selection = selection ?? selectedRange
    var state: [String: Any] = ["value": text ?? "", "selectionStart": selection.location, "selectionEnd": selection.location + selection.length]
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
  /// Applies an edit of `target` and records what it became, for the edits still waiting. The
  /// selection is carried over it: at the caret that is where UIKit leaves it (after typed text,
  /// at a deletion's start, after a selection typed over); a replacement elsewhere (autocorrect,
  /// a mark UIKit names for deletion) leaves the person's caret where it was, where UIKit would
  /// move it into the replacement. Inside a composition the input method's caret stays.
  private func edit(_ target: NSRange, _ action: () -> Void) {
    let kept = place(selectedRange)
    let before = length
    action()
    edits.record(start: target.location, removed: target.length, inserted: length - before + target.length)
    if markedTextRange == nil {
      let carried = range(kept)
      if selectedRange != carried { selectedRange = carried }
    }
  }
  private func apply(_ instruction: [String: Any]) {
    guard markedTextRange == nil, let state = instruction["set"] as? [String: Any],
      let value = state["value"] as? String, let start = state["selectionStart"] as? Int,
      let end = state["selectionEnd"] as? Int, start >= 0, end >= start, end <= value.utf16.count else { return }
    mutating = true
    edit(NSRange(location: 0, length: length)) { text = value }
    selectedRange = NSRange(location: start, length: end - start)
    ownSelection = selectedRange
    heldChoice = nil
    mutating = false
  }
  /// The selection UIKit or the person chose after `typed` was named, carried: applying an edit
  /// named earlier moves the native selection, and this puts it back where they last put it.
  /// Inside a composition UIKit's selection stays in it: the person's choice is held for what they
  /// type meanwhile, and put back once the composition ends.
  private func keepChosen(after typed: RemoteInputEdits.Place?) {
    guard let typed else { return }
    let chosen = edits.chosen(after: typed)
    if markedRange != nil {
      if let chosen { heldChoice = chosen }
      return
    }
    heldChoice = nil
    guard let chosen else { return }
    let target = range(chosen)
    if selectedRange != target { selectedRange = target }
  }
  /// Where the person's selection is: the one held while a composition hides it, or UIKit's.
  private var personSelection: NSRange { heldChoice.map { range($0) } ?? selectedRange }
  /// `inputType` is named when the edit's turn comes, as the field then stands: a keystroke typed
  /// as a composition commits is a plain insertion by the time it is applied.
  private func change(_ namedType: @escaping @autoclosure () -> String, data: String?, typed: RemoteInputEdits.Place? = nil, _ action: @escaping () -> Void) {
    gate.enqueue {
      let inputType = namedType()
      self.gate.event(["type": "beforeinput", "inputType": inputType, "data": data as Any? ?? NSNull()]) {
        let wasComposing = self.markedTextRange != nil
        self.mutating = true
        action()
        // The state right after this edit: its events report its own caret. The selection the
        // person chose later is put back after, for UIKit's next call, and reported in its turn.
        let composing = self.markedTextRange != nil
        let proxy = self.snapshot()
        let markedText = self.marked()
        self.keepChosen(after: typed)
        self.ownSelection = self.selectedRange
        self.mutating = false
        if !wasComposing && composing { self.gate.notify(["type": "compositionstart", "proxy": proxy]) }
        if composing { self.gate.notify(["type": "compositionupdate", "data": markedText, "proxy": proxy]) }
        if wasComposing && !composing { self.gate.notify(["type": "compositionend", "data": data ?? "", "proxy": proxy]) }
        self.gate.notify(["type": "input", "inputType": inputType, "composing": composing, "proxy": proxy])
      }
    }
  }
  public override func insertText(_ text: String) {
    if mutating { super.insertText(text); return }
    let typed = place(personSelection)
    change(self.markedTextRange == nil ? (text == "\n" ? "insertLineBreak" : "insertText") : "insertFromComposition", data: text, typed: typed) {
      self.edit(self.select(typed)) { super.insertText(text) }
    }
  }
  /// Replaces `target` with `text`, recording it for the edits still waiting.
  private func replaceRange(_ target: NSRange, with text: String) {
    guard let a = position(from: beginningOfDocument, offset: target.location), let b = position(from: a, offset: target.length), let current = textRange(from: a, to: b) else { return }
    edit(target) { super.replace(current, withText: text) }
  }
  /// Replaces what UIKit named, wherever the edits applied since have moved it. Named text that is
  /// already gone replaces nothing, never a neighbour; only the deletion of a selection pressed
  /// twice deletes the character before it (RemoteInputEdits.deletion).
  private func replaceTyped(_ typed: RemoteInputEdits.Place, with text: String, selectionAgain: Bool = false) {
    replaceRange(selectionAgain ? edits.deletion(typed, in: self.text ?? "") : range(typed), with: text)
  }
  public override func replace(_ range: UITextRange, withText text: String) {
    if mutating { super.replace(range, withText: text); return }
    let typed = edits.place(offset(from: beginningOfDocument, to: range.start), offset(from: beginningOfDocument, to: range.end))
    change("insertReplacementText", data: text, typed: typed) { self.replaceTyped(typed, with: text) }
  }
  public override func deleteBackward() {
    if mutating { super.deleteBackward(); return }
    let typed = place(personSelection)
    change("deleteContentBackward", data: nil, typed: typed) {
      _ = self.select(typed)
      // Inside a composition the marked text is not what goes: the character before the caret is.
      let selection = self.selectedRange
      let marked = self.markedRange
      let before = self.length
      super.deleteBackward()
      let removed = before - self.length
      self.edits.record(start: RemoteInputEdits.deletedStart(selection: selection, marked: marked, removed: removed), removed: removed, inserted: 0)
    }
  }
  public override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    if mutating { super.setMarkedText(markedText, selectedRange: selectedRange); return }
    let typed = place(personSelection)
    change("insertCompositionText", data: markedText, typed: typed) {
      self.edit(self.select(typed)) { super.setMarkedText(markedText, selectedRange: selectedRange) }
    }
  }
  public override func unmarkText() {
    if mutating { super.unmarkText(); return }
    // A tap during a composition commits it, then moves the caret, both before the commit's turn:
    // once the composition ends, the caret goes back where the person put it.
    let named = place(selectedRange)
    gate.enqueue {
      guard self.markedTextRange != nil else { return }
      let data = self.marked()
      self.mutating = true
      super.unmarkText()
      // Its event reports its own caret; the caret the person chose is reported in its turn.
      let proxy = self.snapshot()
      self.keepChosen(after: named)
      self.ownSelection = self.selectedRange
      self.mutating = false
      self.gate.notify(["type": "compositionend", "data": data, "proxy": proxy])
    }
  }
  public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
    if mutating { return true }
    guard isEditable else { return false }
    // UIKit names what it does at its own selection; while a composition hides the person's,
    // typing over the selection or a Backspace is the person's, at theirs.
    let uikit = selectedRange
    let selection = personSelection
    if replacement.isEmpty && RemoteInputEdits.isBackspace(named: range, selection: uikit, in: text ?? "") {
      // A Backspace: the character before the caret, wherever the caret is by its turn.
      let caret = place(selection)
      change("deleteContentBackward", data: replacement, typed: caret) {
        self.replaceRange(self.edits.backspace(caret, in: self.text ?? ""), with: "")
      }
      return false
    }
    let named = heldChoice != nil && range == uikit ? selection : range
    let again = replacement.isEmpty && RemoteInputEdits.deletesSelection(named: named, selection: selection)
    let typed = place(named)
    change(replacement.isEmpty ? "deleteContentBackward" : "insertReplacementText", data: replacement, typed: typed) {
      self.replaceTyped(typed, with: replacement, selectionAgain: again)
    }
    return false
  }
  /// A selection UIKit or the person moved is reported after the edits typed before it, carried
  /// over them. Reporting never writes the native selection: that stays whatever UIKit last set.
  /// A newer report replaces one still queued, so a drag queues one, not one per frame.
  public func textViewDidChangeSelection(_ textView: UITextView) {
    if mutating || selectedRange == ownSelection { return }
    ownSelection = nil
    heldChoice = nil
    let moved = place(selectedRange)
    edits.choose(moved)
    gate.report {
      self.gate.event(["type": "selection", "proxy": self.snapshot(selection: self.range(moved))])
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
    if action == #selector(paste(_:)) { return isEditable && pasteboardHasContent() }
    // Nothing in the menu selects in the hidden field: what it selected nobody would see. Cmd+A
    // reaches the page as its own selectAll instead.
    if action == #selector(UIResponderStandardEditActions.select(_:)) || action == #selector(UIResponderStandardEditActions.selectAll(_:)) { return false }
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
      ownSelection = selectedRange
      heldChoice = nil
      mutating = false
    }
    let nextTraits = RemoteInputTraits(context, softKeyboard: softKeyboard, keyboardMayReplaceText: keyboardMayReplaceText)
    let changed = traits != nextTraits
    if changed {
      traits = nextTraits
      isEditable = nextTraits.editable
      isSecureTextEntry = nextTraits.sensitive
      autocorrectionType = nextTraits.allowsSuggestions ? .default : .no
      // No spelling marks in a field whose text nobody sees: iOS selects a marked word on a tap.
      spellCheckingType = .no
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

/// The view's own edit menu: Paste alone.
@MainActor final class RemoteInputPasteMenu: NSObject, UIEditMenuInteractionDelegate {
  private weak var view: RemoteInputTextView?
  init(view: RemoteInputTextView) { self.view = view }
  func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
    view?.pasteMenu(suggested: suggestedActions)
  }
}
#endif
