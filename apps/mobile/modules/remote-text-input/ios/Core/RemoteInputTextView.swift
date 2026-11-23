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
  /// The selection a move is measured from: as the last callback saw it, or as the view last set
  /// it (CW5: UIKit may defer or coalesce the callback for a selection the view sets).
  private var lastSelection = NSRange(location: 0, length: 0)
  /// The view owns the selection as it now stands (after its own edit, an answer, a configure):
  /// a callback UIKit sends about it later is not a choice, and a move is measured from it even
  /// when UIKit sends none (CW5). Every selection the view leaves goes through here.
  private func recordOwn(_ range: NSRange? = nil) {
    if let range, selectedRange != range { selectedRange = range }
    ownSelection = selectedRange
    lastSelection = selectedRange
  }
  /// The caret's moves since the last report ran, in composed characters; nil once a range is
  /// chosen.
  private var distance: [Int]? = []
  /// Where the caret moves since the last report started.
  private var from: RemoteInputEdits.Place?
  /// The caret move whose turn has not come yet.
  private var pendingMove: RemoteInputEdits.CaretMove?
  /// Where the last applied edit or answer left the caret, before a later choice is put back.
  private var turnCaret = NSRange(location: 0, length: 0)
  /// The selection the person chose after an edit that has since been applied inside a
  /// composition: UIKit's selection is in the composition until it ends, the person's is here,
  /// and what they type meanwhile is named here.
  private var heldChoice: RemoteInputEdits.Place?
  private var held = Set<Int>()
  private var contextId: String?
  /// The context the last configure call asked for, ahead of its turn.
  private var pendingContext: String?
  private var traits: RemoteInputTraits?
  private let noKeyboard = UIView(frame: .zero)
  public override var canBecomeFirstResponder: Bool { true }
  /// Undo and redo are the far page's (RemoteInputUndo).
  private lazy var remoteUndo = RemoteInputUndo(enabled: { [weak self] in self?.isEditable == true }) { [weak self] redo in
    self?.forwardUndo(redo: redo)
  }
  public override var undoManager: UndoManager? { remoteUndo }
  /// The far page's own undo or redo chord, through the gate like a key: the reducer sends the
  /// page's command and resets the mirror from what comes back.
  private func forwardUndo(redo: Bool) {
    for type in ["keydown", "keyup"] {
      gate.enqueue {
        self.gate.event(["type": type, "key": redo ? "Z" : "z", "code": "KeyZ", "alt": false, "control": false, "meta": true, "shift": redo, "altGraph": false, "location": 0, "repeat": false, "composing": self.markedTextRange != nil])
      }
    }
  }
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
    // CW7: no Writing Tools for text nobody sees, and nothing in the keyboard's assistant bar.
    if #available(iOS 18.0, *) { writingToolsBehavior = .none }
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
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
  /// The pasteboard's items, as Paste reads them (a test gives its own).
  var pasteboardItems: () -> [[String: Any]] = { UIPasteboard.general.items }
  /// Whether the pasteboard holds something Paste would send. Asking does not bring up the
  /// system's paste prompt; reading the items does.
  var pasteboardHasContent: () -> Bool = { UIPasteboard.general.hasStrings || UIPasteboard.general.hasImages }
  @objc private func pasteLongPressRecognized(_ recognizer: UILongPressGestureRecognizer) {
    if recognizer.state == .began { pasteLongPressed(at: recognizer.location(in: self)) }
  }
  /// Opens the view's own menu, which offers Paste alone and never moves the caret; nothing when
  /// nothing can be pasted.
  func pasteLongPressed(at point: CGPoint) {
    guard isEditable, window != nil, pasteboardHasContent(), let menu = pasteMenuInteraction as? UIEditMenuInteraction else { return }
    menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
  }
  /// Every edit menu the field shows: Paste alone, the system's own Paste command where it
  /// suggests one, so it is named as the system names it. Empty when nothing can be pasted, never
  /// nil: to UIKit nil is the default system menu (Cut, Copy, Paste, AutoFill).
  ///
  /// It is asked by the view's own long press (RemoteInputPasteMenu) and by UIKit's text
  /// interaction: that menu is built by UITextInput's editMenu(for:suggestedActions:), which
  /// UITextView answers from its delegate's textView(_:editMenuForTextIn(Ranges):suggestedActions:).
  func pasteMenu(suggested: [UIMenuElement]) -> UIMenu {
    func find(_ elements: [UIMenuElement]) -> UIMenuElement? {
      for element in elements {
        if let command = element as? UICommand, command.action == #selector(UIResponderStandardEditActions.paste(_:)) { return command }
        if let menu = element as? UIMenu, let found = find(menu.children) { return found }
      }
      return nil
    }
    if let system = find(suggested) { return UIMenu(children: [system]) }
    guard isEditable, pasteboardHasContent() else { return UIMenu(children: []) }
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
  private func place(_ range: NSRange) -> RemoteInputEdits.Place {
    var named = edits.place(range.location, range.location + range.length)
    named.context = pendingContext
    return named
  }
  /// Where a place named earlier is now, after the edits applied since. A caret move is the
  /// distance moved, from where the caret it started at is now, until its turn resolves it.
  private func range(_ place: RemoteInputEdits.Place) -> NSRange {
    if let move = place.move {
      if let resolved = move.resolved { return range(resolved) }
      let text = self.text ?? ""
      let at = move.distances.reduce(NSMaxRange(range(move.from))) { RemoteInputEdits.advance(text, from: $0, by: $1) }
      return NSRange(location: at, length: 0)
    }
    let current = edits.current(place, length: length)
    return NSRange(location: current.start, length: current.end - current.start)
  }
  /// The caret as it stands at an action's turn: where the last applied edit or answer left it,
  /// when the person chose another after the action was named (a later choice is not this one's).
  private func caretAtTurn(_ place: RemoteInputEdits.Place) -> NSRange {
    edits.chosen(after: place) != nil ? turnCaret : selectedRange
  }
  /// Puts the selection where a waiting edit was typed and returns where the edit goes: the
  /// marked text, while there is some, is where UIKit puts it.
  private func select(_ place: RemoteInputEdits.Place) -> NSRange {
    // Inside a composition the caret is the composition's, at its end, whatever was chosen since:
    // the edit's events report its own caret, and the person's choice is put back after it.
    if let marked = markedRange {
      let end = NSRange(location: NSMaxRange(marked), length: 0)
      if selectedRange != end { selectedRange = end }
      return marked
    }
    // Typing and deleting backward are relative to the caret: named in an older mirror, they go
    // where the caret stands at their turn.
    let target = edits.stale(place) ? caretAtTurn(place) : range(place)
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
    defer {
      selectedRange = NSRange(location: start, length: end - start)
      recordOwn()
      turnCaret = selectedRange
      heldChoice = nil
      mutating = false
    }
    let old = (text ?? "") as NSString, new = value as NSString
    // An answer that says which edit it is is applied as exactly that edit.
    if let exact = instruction["edit"] as? [String: Any], let from = exact["start"] as? Int,
      let to = exact["end"] as? Int, let inserted = exact["text"] as? String, from >= 0, to >= from, to <= old.length,
      old.replacingCharacters(in: NSRange(location: from, length: to - from), with: inserted) == value {
      let target = NSRange(location: from, length: to - from)
      edit(target) { textStorage.replaceCharacters(in: target, with: inserted) }
      return
    }
    // The answer applied as the edit it is: a paste is the pasted text where it went, so the
    // places still waiting are carried over it. Its text went in ending at its caret, so the
    // common prefix stops there and a repeated character is not taken for the inserted one. An
    // empty answer clears the mirror: a new generation, in which no place named before names
    // anything.
    let cap = max(0, start - max(0, new.length - old.length))
    var prefix = 0
    while prefix < cap && prefix < old.length && prefix < new.length && old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
    var suffix = 0
    while suffix < old.length - prefix && suffix < new.length - prefix && old.character(at: old.length - 1 - suffix) == new.character(at: new.length - 1 - suffix) { suffix += 1 }
    let target = NSRange(location: prefix, length: old.length - prefix - suffix)
    let inserted = new.substring(with: NSRange(location: prefix, length: new.length - prefix - suffix))
    edit(target) { textStorage.replaceCharacters(in: target, with: inserted) }
    if value.isEmpty { edits.clear() }
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
  private var personSelection: NSRange {
    guard let heldChoice, !edits.stale(heldChoice) else { return selectedRange }
    return range(heldChoice)
  }
  /// Where what the person types now is named: at a caret move still waiting its turn, or at the
  /// person's selection. A move held while a composition hides it, or still waiting its turn, is
  /// resolved at its turn: what is typed now is named at it.
  private func namedHere() -> RemoteInputEdits.Place {
    let move = heldChoice.flatMap { edits.stale($0) ? nil : $0 }.map { $0.move } ?? pendingMove
    guard let move else { return place(personSelection) }
    var named = place(selectedRange)
    named.move = move
    return named
  }
  /// Nothing is applied across a reset. A place named in an older mirror is never applied to a
  /// newer one: a positional place (a range replaced, a mark deleted) is dropped; typing and
  /// deleting backward go where the caret is now, unless a new context fenced them out.
  private func dropped(_ place: RemoteInputEdits.Place, positional: Bool) -> Bool {
    // Fenced out only once the field has moved to another context: named before the configure
    // call, its turn may still come in the context it was named in, where it goes (CV1).
    (edits.fenced(place) && place.context != contextId) || (positional && edits.stale(place))
  }
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
        self.turnCaret = self.selectedRange
        let proxy = self.snapshot()
        let markedText = self.marked()
        self.keepChosen(after: typed)
        self.recordOwn()
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
    let typed = namedHere()
    change(self.markedTextRange == nil ? (text == "\n" ? "insertLineBreak" : "insertText") : "insertFromComposition", data: text, typed: typed) {
      if self.dropped(typed, positional: false) { return }
      self.edit(self.select(typed)) { super.insertText(text) }
    }
  }
  /// The composed character just before `caret` (up to it), or nothing at the start.
  private func before(_ caret: Int) -> NSRange {
    guard caret > 0 else { return NSRange(location: 0, length: 0) }
    let start = ((text ?? "") as NSString).rangeOfComposedCharacterSequence(at: caret - 1).location
    return NSRange(location: start, length: caret - start)
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
    let typed = place(NSRange(location: offset(from: beginningOfDocument, to: range.start), length: offset(from: range.start, to: range.end)))
    change("insertReplacementText", data: text, typed: typed) {
      if self.dropped(typed, positional: true) { return }
      // A replacement elsewhere: its events report the caret as it stands at its turn.
      if self.markedTextRange == nil { self.selectedRange = self.caretAtTurn(typed) }
      self.replaceTyped(typed, with: text)
    }
  }
  public override func deleteBackward() {
    if mutating { super.deleteBackward(); return }
    let typed = namedHere()
    change("deleteContentBackward", data: nil, typed: typed) {
      if self.dropped(typed, positional: false) { return }
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
    let typed = namedHere()
    change("insertCompositionText", data: markedText, typed: typed) {
      if self.dropped(typed, positional: false) { return }
      self.edit(self.select(typed)) { super.setMarkedText(markedText, selectedRange: selectedRange) }
    }
  }
  public override func unmarkText() {
    if mutating { super.unmarkText(); return }
    // A tap during a composition commits it, then moves the caret, both before the commit's turn:
    // once the composition ends, the caret goes back where the person put it.
    let named = place(selectedRange)
    gate.enqueue {
      guard let marked = self.markedRange else { return }
      let data = self.marked()
      self.mutating = true
      super.unmarkText()
      // Its event reports the composition's own caret, at its end; a later choice is put back after.
      self.selectedRange = NSRange(location: NSMaxRange(marked), length: 0)
      // Its event reports its own caret; the caret the person chose is reported in its turn.
      let proxy = self.snapshot()
      self.keepChosen(after: named)
      self.recordOwn()
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
      let caret = namedHere()
      change("deleteContentBackward", data: replacement, typed: caret) {
        if self.dropped(caret, positional: false) { return }
        let at = self.edits.stale(caret) ? self.place(self.caretAtTurn(caret)) : caret
        // Its events report its own caret: the deletion's, where the caret was by its turn.
        let caretNow = self.range(at).location
        if self.markedTextRange == nil { self.selectedRange = NSRange(location: caretNow, length: 0) }
        self.replaceRange(self.before(caretNow), with: "")
      }
      return false
    }
    let named = heldChoice != nil && range == uikit ? selection : range
    // Typing over the selection, or deleting it, is relative; any other range UIKit names is a
    // place in the text.
    let relative = named == selection
    let again = replacement.isEmpty && RemoteInputEdits.deletesSelection(named: named, selection: selection)
    let typed = relative && named.length == 0 ? namedHere() : place(named)
    change(replacement.isEmpty ? "deleteContentBackward" : "insertReplacementText", data: replacement, typed: typed) {
      if self.dropped(typed, positional: !relative) { return }
      if self.edits.stale(typed) {
        let current = self.caretAtTurn(typed)
        let target = !replacement.isEmpty || current.length > 0 ? current : self.before(current.location)
        // Its events report its own caret, at the place it went.
        if self.markedTextRange == nil { self.selectedRange = NSRange(location: NSMaxRange(target), length: 0) }
        self.replaceRange(target, with: replacement)
        return
      }
      let target = again ? self.edits.deletion(typed, in: self.text ?? "") : self.range(typed)
      // Typing over the selection: its events report its own caret, after what it typed; a range
      // named elsewhere, the caret as it stands at its turn.
      if self.markedTextRange == nil { self.selectedRange = relative ? target : self.caretAtTurn(typed) }
      self.replaceRange(target, with: replacement)
    }
    return false
  }
  /// A selection UIKit or the person moved is reported after the edits typed before it, carried
  /// over them. Reporting never writes the native selection: that stays whatever UIKit last set.
  /// A newer report replaces one still queued, so a drag queues one, not one per frame.
  public func textViewDidChangeSelection(_ textView: UITextView) {
    let previous = lastSelection
    lastSelection = selectedRange
    if mutating || selectedRange == ownSelection { return }
    ownSelection = nil
    heldChoice = nil
    // A caret move is the distance the person moved the caret, from the caret it started at
    // (each move one report stands for, in order). It is resolved at its turn, when everything
    // typed before it has been applied; what is typed after it is named there. After a reset it
    // is sent as the distances, never dropped. A range is the place UIKit named; one selected in
    // text that is gone selects nothing.
    let caret = previous.length == 0 && selectedRange.length == 0
    // A move that gets a report of its own starts its own distance.
    if !gate.coalesces {
      distance = []
      from = nil
    }
    // From the person's caret: an earlier move still waiting its turn is where they were.
    if caret, distance != nil, from == nil {
      var start = place(previous)
      start.move = pendingMove
      from = start
    }
    if let sum = distance, caret {
      let text = self.text ?? ""
      let span = NSRange(location: min(previous.location, selectedRange.location), length: abs(selectedRange.location - previous.location))
      let count = RemoteInputEdits.composedCount(in: text, range: span)
      distance = sum + [selectedRange.location < previous.location ? -count : count]
    } else { distance = nil }
    var moved = place(selectedRange)
    let move = distance.flatMap { distances in from.map { RemoteInputEdits.CaretMove(from: $0, distances: distances) } }
    pendingMove = move
    moved.move = move
    edits.choose(moved)
    gate.report {
      self.distance = []
      self.from = nil
      if self.pendingMove === move { self.pendingMove = nil }
      if let move, self.edits.stale(move.from) {
        move.resolved = self.place(self.selectedRange)
        self.gate.event(["type": "selection", "proxy": self.snapshot(), "moves": move.distances])
        return
      }
      if move == nil, self.edits.stale(moved) { return }
      let at = self.range(moved)
      if let move {
        move.resolved = self.place(at)
        // The native caret is the person's from here on, unless they have moved it since.
        if self.edits.chosen(after: moved) == nil, self.selectedRange != at {
          // Owned before it is set, so UIKit's callback for it is not taken for a move.
          self.ownSelection = at
          self.recordOwn(at)
        }
      }
      self.gate.event(["type": "selection", "proxy": self.snapshot(selection: at)])
    }
  }
  public func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    pasteMenu(suggested: suggestedActions)
  }
  @available(iOS 26.0, *)
  public func textView(_ textView: UITextView, editMenuForTextInRanges ranges: [NSValue], suggestedActions: [UIMenuElement]) -> UIMenu? {
    pasteMenu(suggested: suggestedActions)
  }
  public func textViewDidEndEditing(_ textView: UITextView) {
    held.removeAll()
    gate.notify(["type": "blur"])
  }
  public override func copy(_ sender: Any?) { gate.notify(["type": "copy"]) }
  public override func cut(_ sender: Any?) { gate.notify(["type": "cut"]) }
  /// Pastes what the pasteboard held when the person pressed Paste: it is read now, not at the
  /// paste's turn, when it may hold what they copied after.
  public override func paste(_ sender: Any?) {
    var items: [[String: Any]] = []
    var bytes = 0
    func append(_ type: String, _ data: Data) {
      bytes += data.count
      if bytes <= 16 * 1024 * 1024 && items.count < 16 { items.append(["type": type, "data": data.base64EncodedString()]) }
    }
    for item in pasteboardItems() {
      for (key, mime) in [(UTType.utf8PlainText.identifier, "text/plain"), (UTType.html.identifier, "text/html"), (UTType.png.identifier, "image/png"), (UTType.jpeg.identifier, "image/jpeg")] {
        if let data = item[key] as? Data { append(mime, data) }
        else if let value = item[key] as? String, let data = value.data(using: .utf8) { append(mime, data) }
        else if let image = item[key] as? UIImage, let data = mime == "image/jpeg" ? image.jpegData(compressionQuality: 1) : image.pngData() { append(mime, data) }
      }
    }
    let pasted = bytes > 16 * 1024 * 1024 ? [] : items
    gate.notify(["type": "paste", "items": pasted])
  }
  /// CW7: nothing of the system's acts on the hidden text, which nobody sees: the view's own Paste
  /// alone, and the page's undo and redo (RemoteInputUndo). Copy, Cut and Select All reach the
  /// page from their keys as its own (the reducer's bindings), never as UIKit's actions.
  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) { return isEditable && pasteboardHasContent() }
    if action == NSSelectorFromString("undo:") || action == NSSelectorFromString("redo:") { return isEditable }
    return false
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
    // A new context fences out what was named before this call, from now: no edit typed for the
    // old context is applied to the new one.
    if context?["contextId"] as? String != pendingContext { edits.fenceNow() }
    pendingContext = context?["contextId"] as? String
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
      edits.clear()
      selectedRange = NSRange(location: 0, length: 0)
      recordOwn()
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
