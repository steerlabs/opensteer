#if canImport(UIKit)
import XCTest
import UIKit
@testable import RemoteTextInputCore

@MainActor final class RemoteTextInputTests: XCTestCase {
  func testHardwareFocusAndStableKeyboardTraits() {
    let view = RemoteInputTextView()
    view.configure(nil, focused: false, softKeyboard: false)
    XCTAssertTrue(view.canBecomeFirstResponder)
    XCTAssertFalse(view.isEditable)
    let hidden = view.inputView
    XCTAssertNotNil(hidden)
    view.configure(["contextId": "page", "field": NSNull(), "caret": NSNull()], focused: false, softKeyboard: false)
    XCTAssertTrue(view.inputView === hidden)
    let field: [String: Any] = ["kind": "text", "sensitive": true, "inputMode": "numeric", "enterKeyHint": "done"]
    view.configure(["contextId": "secret", "field": field], focused: false)
    XCTAssertTrue(view.isSecureTextEntry)
    XCTAssertEqual(view.autocorrectionType, .no)
    XCTAssertEqual(view.spellCheckingType, .no)
    XCTAssertEqual(view.keyboardType, .numberPad)
    XCTAssertEqual(view.returnKeyType, .done)
    XCTAssertNil(view.inputView)
    view.configure(["contextId": "secret", "field": field, "caret": ["x": 0.5]], focused: false)
    XCTAssertTrue(view.isSecureTextEntry)
    XCTAssertEqual(view.keyboardType, .numberPad)
    view.configure(["contextId": "secret", "field": field], focused: false, softKeyboard: false)
    XCTAssertTrue(view.inputView === hidden)
    XCTAssertTrue(view.isSecureTextEntry)
  }

  func testPreventionIsBeforeMutation() {
    let view = RemoteInputTextView()
    var events: [[String: Any]] = []
    view.deliver = { events.append($0) }
    view.insertText("a")
    XCTAssertEqual(view.text, "")
    XCTAssertEqual(events.count, 1)
    view.respond(["id": 1, "preventDefault": true])
    XCTAssertEqual(view.text, "")
  }
  func testCompositionCannotBeResetAndCommitsOnce() {
    let view = RemoteInputTextView()
    var events: [[String: Any]] = []
    view.deliver = { packet in
      events.append(packet)
      DispatchQueue.main.async { view.respond(["id": packet["id"]!]) }
    }
    view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    let finished = expectation(description: "FIFO")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      XCTAssertNotNil(view.markedTextRange)
      view.respond(["id": 0, "set": ["value": "", "selectionStart": 0, "selectionEnd": 0]])
      XCTAssertEqual(view.text, "に")
      view.insertText("日")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        XCTAssertEqual(view.text, "日")
        let types = events.compactMap { ($0["event"] as? [String: Any])?["type"] as? String }
        XCTAssertEqual(types.filter { $0 == "compositionend" }.count, 1)
        finished.fulfill()
      }
    }
    wait(for: [finished], timeout: 3)
  }
  func testQueuedEditsAndUTF16Selection() {
    let view = RemoteInputTextView()
    var events: [[String: Any]] = []
    view.deliver = { packet in events.append(packet) }
    view.insertText("👩‍💻")
    view.insertText("a")
    var index = 0
    while index < events.count {
      view.respond(["id": events[index]["id"]!])
      index += 1
    }
    XCTAssertEqual(view.text, "👩‍💻a")
    XCTAssertEqual(view.selectedRange.location, 6)
  }
  // The walk typed 0123456789 fast and the target received 1023456789: UIKit named each
  // keystroke's place in the text before the keystrokes still waiting were applied.
  func testKeystrokesPlacedBeforeEarlierOnesWereAppliedLandInTypingOrder() throws {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    view.deliver = { packets.append($0) }
    for (index, digit) in "0123456789".enumerated() {
      let typed = String(digit)
      if index % 2 == 0 {
        XCTAssertFalse(view.textView(view, shouldChangeTextIn: view.selectedRange, replacementText: typed))
      } else {
        // The caret as a range; a view outside a window may have none until it has text.
        let caret = try XCTUnwrap(view.textRange(from: view.endOfDocument, to: view.endOfDocument))
        view.replace(caret, withText: typed)
      }
    }
    var next = 0
    while next < packets.count {
      view.respond(["id": packets[next]["id"]!])
      next += 1
    }
    XCTAssertEqual(view.text, "0123456789")
    XCTAssertEqual(view.selectedRange, NSRange(location: 10, length: 0))
  }
  // The walk: 0123456789, then five backspaces in one burst, and 0123456 arrived. Each press
  // named the character before the caret while the press before it still waited.
  func testFiveBackspacesNamedBeforeAnyAnswerDeleteFive() {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    var next = 0
    view.deliver = { packets.append($0) }
    func answerAll() { while next < packets.count { view.respond(["id": packets[next]["id"]!]); next += 1 } }
    for digit in "0123456789" { view.insertText(String(digit)) }
    answerAll()
    for _ in 0..<5 {
      let caret = view.selectedRange.location
      XCTAssertFalse(view.textView(view, shouldChangeTextIn: NSRange(location: caret - 1, length: 1), replacementText: ""))
    }
    for _ in 0..<5 { view.deleteBackward() }
    answerAll()
    XCTAssertEqual(view.text, "")
    XCTAssertEqual(view.selectedRange, NSRange(location: 0, length: 0))
  }
  func testAnAnswerArrivingAfterNewerTypingNeverMovesTheCaretBackOverIt() {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    view.deliver = { packets.append($0) }
    view.insertText("a")
    view.respond(["id": packets[0]["id"]!])
    // "b" is typed while the answer to "a"'s input is still on its way.
    _ = view.textView(view, shouldChangeTextIn: view.selectedRange, replacementText: "b")
    var next = 1
    while next < packets.count {
      view.respond(["id": packets[next]["id"]!])
      next += 1
    }
    XCTAssertEqual(view.text, "ab")
    XCTAssertEqual(view.selectedRange, NSRange(location: 2, length: 0))
  }
  func testContextReplacementEndsTheNativeComposition() {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    var next = 0
    view.deliver = { packets.append($0) }
    func drain() {
      while next < packets.count {
        let packet = packets[next]; next += 1
        view.respond(["id": packet["id"]!])
      }
    }
    let field: [String: Any] = ["kind": "text", "multiline": true, "sensitive": false]
    view.configure(["contextId": "first", "field": field], focused: false)
    view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    drain()
    XCTAssertNotNil(view.markedTextRange)
    view.configure(["contextId": "second", "field": field], focused: false)
    let ending = packets.last!
    XCTAssertEqual((ending["event"] as? [String: Any])?["type"] as? String, "compositionend")
    XCTAssertEqual(ending["contextId"] as? String, "first")
    XCTAssertEqual(view.text, "に", "Reset waits for the old ending acknowledgement")
    view.insertText("a")
    drain()
    XCTAssertNil(view.markedTextRange)
    XCTAssertEqual(view.text, "a", "New-context typing queued behind the ending is preserved")
    let ends = packets.filter { ($0["event"] as? [String: Any])?["type"] as? String == "compositionend" }
    XCTAssertEqual(ends.count, 1, "The reducer needs the actual native ending after it commits an interrupted composition")
    view.unmarkText()
    drain()
    XCTAssertEqual(view.text, "a")
    XCTAssertEqual(packets.last?["contextId"] as? String, "second")
    view.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0))
    drain()
    view.unmarkText()
    drain()
    XCTAssertEqual(packets.filter { ($0["event"] as? [String: Any])?["type"] as? String == "compositionend" }.count, 2)
  }

  func testContextReplacementPreservesAnEndingAlreadyAwaitingAcknowledgement() {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    var next = 0
    view.deliver = { packets.append($0) }
    func drain() { while next < packets.count { let packet = packets[next]; next += 1; view.respond(["id": packet["id"]!]) } }
    let field: [String: Any] = ["kind": "text", "multiline": true, "sensitive": false]
    view.configure(["contextId": "first", "field": field], focused: false)
    view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    drain()
    view.unmarkText()
    view.configure(["contextId": "second", "field": field], focused: false)
    XCTAssertEqual(view.text, "に")
    drain()
    XCTAssertEqual(view.text, "")
    XCTAssertEqual(packets.filter { ($0["event"] as? [String: Any])?["type"] as? String == "compositionend" }.count, 1)
    view.insertText("b")
    drain()
    XCTAssertEqual(view.text, "b")
  }


  // MARK: The review's faults, on the real view: typed fast, answers late.

  /// The view with its answers held until the test lets them through, oldest first.
  @MainActor final class Field {
    let view = RemoteInputTextView()
    var packets: [[String: Any]] = []
    var next = 0
    init(settled text: String = "") {
      view.deliver = { [unowned self] in packets.append($0) }
      if !text.isEmpty { view.insertText(text); answerAll() }
    }
    func answerOne() { if next < packets.count { view.respond(["id": packets[next]["id"]!]); next += 1 } }
    func answerAll() { while next < packets.count { answerOne() } }
    /// A Backspace as UIKit asks the delegate: the composed character before the caret, named in
    /// the text as it stands now.
    func backspace() {
      let caret = view.selectedRange
      let named = caret.length > 0 ? caret : ((view.text ?? "") as NSString).rangeOfComposedCharacterSequence(at: caret.location - 1)
      XCTAssertFalse(view.textView(view, shouldChangeTextIn: named, replacementText: ""))
    }
    /// The person or UIKit moves the selection; UIKit tells the delegate itself.
    func select(_ range: NSRange) { view.selectedRange = range }
    var selections: Int { packets.filter { ($0["event"] as? [String: Any])?["type"] as? String == "selection" }.count }
  }

  // CW5: a move is measured from the selection the view last set, whether or not UIKit told the
  // delegate of that set (it may defer or coalesce the callback). Here UIKit's callback is withheld
  // while the view applies typing; the person then moves back two characters.
  func testAMoveIsMeasuredFromTheSelectionTheViewSetWithoutACallback() {
    let field = Field(settled: "hello")
    field.view.delegate = nil
    field.view.insertText("a")
    field.view.insertText("b")
    field.answerAll()
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 7, length: 0))
    field.view.delegate = field.view
    // "c" waits while the person moves back two characters from after "b": the move is two
    // back from after "c", where "x" then goes.
    field.view.insertText("c")
    field.select(NSRange(location: 5, length: 0))
    field.answerAll()
    field.view.insertText("x")
    field.answerAll()
    XCTAssertEqual(field.view.text, "helloaxbc")
  }

  // CV3: the field resigning (UIKit's textViewDidEndEditing) while an edit waits. The edit keeps
  // its turn and goes as typed; the blur is told after it, in order, and changes nothing else.
  // (What UIKit itself does to marked text when the field resigns needs a window: not recorded
  // here, so the typing test blurs only while nothing is marked.)
  func testABlurWhileAnEditWaitsComesAfterItAndKeepsIt() {
    let field = Field(settled: "a")
    let settled = field.packets.count
    field.view.insertText("b")
    field.view.textViewDidEndEditing(field.view)
    field.answerAll()
    let types = field.packets[settled...].compactMap { ($0["event"] as? [String: Any])?["type"] as? String }
    XCTAssertEqual(types, ["beforeinput", "input", "blur"])
    XCTAssertEqual(field.view.text, "ab")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 2, length: 0))
  }

  // P1: a typo then Backspace erases the typo, not the character before it.
  func testATypoThenBackspaceErasesTheTypo() {
    let field = Field(settled: "a")
    field.view.insertText("b")
    field.backspace()
    field.answerAll()
    XCTAssertEqual(field.view.text, "a")
  }
  func testBackspaceWhileNineWaitErasesTheLastOfThem() {
    let field = Field(settled: "0")
    for digit in "123456789" { field.view.insertText(String(digit)) }
    field.backspace()
    field.answerAll()
    XCTAssertEqual(field.view.text, "012345678")
  }
  func testBackspaceAfterAJoinedEmojiErasesWhatWasTypedAfterIt() {
    let field = Field(settled: "a👩‍💻")
    field.view.insertText("b")
    field.backspace()
    field.backspace()
    field.answerAll()
    XCTAssertEqual(field.view.text, "a")
  }
  func testASelectionDeletedTwiceDeletesTheCharacterBeforeIt() {
    let field = Field(settled: "hello")
    field.select(NSRange(location: 1, length: 3))
    field.answerAll()
    XCTAssertFalse(field.view.textView(field.view, shouldChangeTextIn: NSRange(location: 1, length: 3), replacementText: ""))
    XCTAssertFalse(field.view.textView(field.view, shouldChangeTextIn: NSRange(location: 1, length: 3), replacementText: ""))
    field.answerAll()
    XCTAssertEqual(field.view.text, "o")
  }
  // Finding 4: a replacement naming text already gone replaces nothing; its neighbour stays.
  func testAReplacementOfTextAlreadyGoneDeletesNothingElse() {
    let field = Field(settled: "xyab")
    let named = { () -> UITextRange in
      let start = field.view.position(from: field.view.beginningOfDocument, offset: 2)!
      return field.view.textRange(from: start, to: field.view.endOfDocument)!
    }
    field.view.replace(named(), withText: "")
    field.view.replace(named(), withText: "")
    field.answerAll()
    XCTAssertEqual(field.view.text, "xy")
  }

  // P2: a queued selection report never moves the text view's selection back.
  func testTypingAfterDraggingTheCaretLandsWhereTheDragEnded() {
    let field = Field(settled: "hello")
    field.select(NSRange(location: 0, length: 0))
    field.answerAll()
    for offset in 1...5 { field.select(NSRange(location: offset, length: 0)) }
    field.answerOne()
    field.view.insertText("!")
    field.answerAll()
    XCTAssertEqual(field.view.text, "hello!")
  }
  // A caret move is the distance moved, from the person's caret: five back from after "a".
  func testTypingAfterACaretMoveWhileAnEarlierKeystrokeWaitsLandsTheDistanceMoved() {
    let field = Field(settled: "hello")
    field.view.insertText("a")
    field.select(NSRange(location: 0, length: 0))
    field.answerOne()
    field.view.insertText("X")
    field.answerAll()
    XCTAssertEqual(field.view.text, "hXelloa")
  }
  func testADragOfSixtyCallbacksQueuesOneReport() {
    let field = Field(settled: "hello")
    field.view.insertText("a")
    for frame in 0..<60 { field.select(NSRange(location: frame % 6, length: 0)) }
    XCTAssertEqual(field.view.gate.queued, 1)
    field.answerAll()
    XCTAssertEqual(field.selections, 1)
  }

  // A guard, not P3's test: without an input method UIKit deletes the whole marked text, so this
  // passes with or without P3's fix, here and on a simulator. The real test of P3 is the shared
  // case "deleteBackward records where the characters actually went" (deletedStart), since no
  // IME that deletes one marked character runs in a test.
  func testDeletingAWholeCompositionWithoutAnIMECarriesLaterPlaces() {
    let field = Field()
    field.view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0))
    field.answerAll()
    field.view.deleteBackward()
    field.view.unmarkText()
    XCTAssertFalse(field.view.textView(field.view, shouldChangeTextIn: NSRange(location: 1, length: 0), replacementText: "X"))
    field.answerAll()
    XCTAssertEqual(field.view.text, "X")
  }

  // T1: each edit's event reports the state right after that edit, never a caret chosen later. The
  // move is five back from the person's caret after "b".
  func testEachEditReportsItsOwnCaretWhenAMoveCameAfterIt() {
    let field = Field(settled: "hello")
    let settled = field.packets.count
    field.view.insertText("a")
    field.view.insertText("b")
    field.select(NSRange(location: 0, length: 0))
    field.answerAll()
    let events = field.packets[settled...].compactMap { $0["event"] as? [String: Any] }
    let inputs = events.filter { $0["type"] as? String == "input" }.compactMap { $0["proxy"] as? [String: Any] }
    XCTAssertEqual(inputs.map { $0["selectionEnd"] as? Int }, [6, 7])
    let selections = events.filter { $0["type"] as? String == "selection" }.compactMap { $0["proxy"] as? [String: Any] }
    XCTAssertEqual(selections.map { $0["selectionEnd"] as? Int }, [2])
    XCTAssertEqual(field.view.text, "helloab")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 2, length: 0))
  }

  // T2: a deletion of more than one composed character deletes the text it named.
  func testAWordDeletionWhileTypingWaitsDeletesTheWordItNamed() {
    let field = Field(settled: "hello")
    field.view.insertText(" ")
    field.view.insertText("a")
    XCTAssertFalse(field.view.textView(field.view, shouldChangeTextIn: NSRange(location: 0, length: 5), replacementText: ""))
    field.answerAll()
    XCTAssertEqual(field.view.text, " a")
  }
  func testTwoWordDeletionsNamingOneWordDeleteOneWord() {
    let field = Field(settled: "one two three")
    for _ in 0..<2 {
      XCTAssertFalse(field.view.textView(field.view, shouldChangeTextIn: NSRange(location: 8, length: 5), replacementText: ""))
    }
    field.answerAll()
    XCTAssertEqual(field.view.text, "one two ")
  }

  // A selection callback UIKit sends on its own after the view moved the selection (on a later
  // run loop turn, when `mutating` is already false) is not a choice the person made.
  func testTheViewsOwnSelectionIsNotTakenForAChoice() {
    let field = Field(settled: "hello")
    let settled = field.packets.count
    field.view.textViewDidChangeSelection(field.view)
    field.answerAll()
    let types = field.packets[settled...].compactMap { ($0["event"] as? [String: Any])?["type"] as? String }
    XCTAssertEqual(types, [])
  }

  // The walk's caret variant (b): a tap on the misspelled "helloab" in the typing field selected
  // it, and "!" replaced it on both sides (the field's accessibility value was "!"). The field's
  // text and caret are invisible: no underline marks a word, and a tap while editing changes no
  // selection; a long press still opens the edit menu, for Paste.
  func testTheHiddenFieldMarksNoWordAndATapWhileEditingSelectsNothing() {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    XCTAssertEqual(view.spellCheckingType, .no)
    XCTAssertNotEqual(view.autocorrectionType, .no)
  }

  // The walk's variant (b) as the native field took it: the selected word, then "!" typed over it.
  // The selection is reported, with the text it was made in, before the keystroke that replaces
  // it, so the far side can restate exactly the text it passes over.
  func testASelectionIsReportedBeforeTheKeystrokeTypedOverIt() {
    let field = Field(settled: "helloab")
    let settled = field.packets.count
    field.select(NSRange(location: 0, length: 7))
    field.view.insertText("!")
    field.answerAll()
    let events = field.packets[settled...].compactMap { $0["event"] as? [String: Any] }
    XCTAssertEqual(events.compactMap { $0["type"] as? String }, ["selection", "beforeinput", "input"])
    let selection = events[0]["proxy"] as? [String: Any]
    XCTAssertEqual(selection?["value"] as? String, "helloab")
    XCTAssertEqual([selection?["selectionStart"] as? Int, selection?["selectionEnd"] as? Int], [0, 7])
    XCTAssertEqual(field.view.text, "!")
  }

  // The long-press menu kept for Paste offers nothing that selects in the hidden field: Select
  // and Select All would select text nobody sees (Cmd+A goes to the page as selectAll instead).
  // Not a failing-first test: outside a window the view is not first responder, and UITextView
  // then refuses Select by itself; the explicit refusal is for the editing field on a device.
  func testTheEditMenuOffersPasteButNoSelection() {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    view.pasteboardHasContent = { true }
    view.insertText("hello")
    view.respond(["id": 1])
    XCTAssertTrue(view.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
    XCTAssertFalse(view.canPerformAction(#selector(UIResponderStandardEditActions.select(_:)), withSender: nil))
    XCTAssertFalse(view.canPerformAction(#selector(UIResponderStandardEditActions.selectAll(_:)), withSender: nil))
  }

  // C1: while the field is shown, a touch changes nothing a person cannot see. Every recognizer
  // UIKit installs on the view is refused, whatever its class (its text taps are not
  // UITapGestureRecognizer subclasses on current iOS); only the view's own focus tap and Paste
  // long press begin, and neither moves the caret.
  func testOnlyTheViewsOwnRecognizersBegin() {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    let recognizers = view.gestureRecognizers ?? []
    let own = recognizers.filter { view.isOwn($0) }
    XCTAssertEqual(own.count, 2, "the focus tap and the Paste long press")
    for recognizer in recognizers where !view.isOwn(recognizer) {
      XCTAssertFalse(view.gestureRecognizerShouldBegin(recognizer), "\(type(of: recognizer)) began")
    }
    for recognizer in own { XCTAssertTrue(view.gestureRecognizerShouldBegin(recognizer)) }
  }
  func testThePasteMenuOffersOnlyPaste() {
    let view = RemoteInputTextView()
    view.pasteboardHasContent = { true }
    let menu = view.pasteMenu(suggested: [])
    XCTAssertEqual(menu.children.count, 1)
  }

  // CR7: nothing to paste offers no Paste (tapping it reset the mirror for nothing), from the menu
  // or from Cmd+V.
  func testNothingToPasteOffersNoPaste() {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    view.pasteboardHasContent = { false }
    // An empty menu: nil is "the default system menu" to UIKit, with Cut, Copy and AutoFill.
    XCTAssertEqual(view.pasteMenu(suggested: []).children.count, 0)
    XCTAssertFalse(view.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
  }
  /// What UIKit suggests for a text view's edit menu, as the build 9 walk saw it on a device.
  private func systemSuggestions() -> (all: [UIMenuElement], paste: UICommand) {
    let paste = UICommand(title: "Paste", action: #selector(UIResponderStandardEditActions.paste(_:)))
    let edit = UIMenu(options: .displayInline, children: [
      UICommand(title: "Cut", action: #selector(UIResponderStandardEditActions.cut(_:))),
      UICommand(title: "Copy", action: #selector(UIResponderStandardEditActions.copy(_:))),
      paste,
    ])
    let autoFill = UIMenu(title: "AutoFill", children: [UIAction(title: "Passwords") { _ in }])
    return ([edit, autoFill], paste)
  }
  private func leaves(_ elements: [UIMenuElement]) -> [UIMenuElement] {
    elements.flatMap { ($0 as? UIMenu).map { leaves($0.children) } ?? [$0] }
  }
  // DW2: UIKit's own text-interaction menu (the one a long press showed on the device: Cut, Copy,
  // Paste, AutoFill) is built by UITextInput's editMenu(for:suggestedActions:), which UITextView
  // answers from its delegate; nil there is the default system menu. The view answers it with
  // its own menu: Paste alone.
  func testUIKitsOwnTextMenuIsPasteAlone() throws {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    view.pasteboardHasContent = { true }
    view.insertText("hello")
    view.respond(["id": 1])
    let range = try XCTUnwrap(view.textRange(from: view.beginningOfDocument, to: view.endOfDocument))
    let suggested = systemSuggestions()
    let menu = try XCTUnwrap((view as UITextInput).editMenu?(for: range, suggestedActions: suggested.all), "the system's menu")
    let shown = leaves(menu.children)
    XCTAssertEqual(shown.count, 1, shown.map { ($0 as? UICommand)?.title ?? "\($0)" }.joined(separator: ", "))
    XCTAssertTrue(shown.first === suggested.paste)
  }
  // DW2: with nothing to paste, both menus are empty, never the system's.
  func testNothingToPasteShowsNoMenuOfUIKits() throws {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    view.pasteboardHasContent = { false }
    let range = try XCTUnwrap(view.textRange(from: view.beginningOfDocument, to: view.endOfDocument))
    let cutCopy: [UIMenuElement] = [UIMenu(options: .displayInline, children: [
      UICommand(title: "Cut", action: #selector(UIResponderStandardEditActions.cut(_:))),
      UICommand(title: "Copy", action: #selector(UIResponderStandardEditActions.copy(_:))),
    ]), UIMenu(title: "AutoFill", children: [UIAction(title: "Passwords") { _ in }])]
    let menu = try XCTUnwrap((view as UITextInput).editMenu?(for: range, suggestedActions: cutCopy), "the system's menu")
    XCTAssertEqual(leaves(menu.children).count, 0)
  }
  // CW7: nothing of the system's acts on the hidden text. The field answers yes for its own
  // Paste (with something to paste) and the page's undo and redo, no for every other standard
  // action; Writing Tools are off for it and the assistant bar holds nothing.
  func testNothingOfTheSystemsActsOnTheHiddenText() {
    let view = RemoteInputTextView()
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: false)
    view.pasteboardHasContent = { true }
    view.insertText("hello")
    view.respond(["id": 1])
    view.selectedRange = NSRange(location: 0, length: 5)
    var refused: [Selector] = [
      #selector(UIResponderStandardEditActions.cut(_:)),
      #selector(UIResponderStandardEditActions.copy(_:)),
      #selector(UIResponderStandardEditActions.select(_:)),
      #selector(UIResponderStandardEditActions.selectAll(_:)),
      #selector(UIResponderStandardEditActions.delete(_:)),
      #selector(UIResponderStandardEditActions.makeTextWritingDirectionLeftToRight(_:)),
      #selector(UIResponderStandardEditActions.makeTextWritingDirectionRightToLeft(_:)),
      #selector(UIResponderStandardEditActions.toggleBoldface(_:)),
      #selector(UIResponderStandardEditActions.toggleItalics(_:)),
      #selector(UIResponderStandardEditActions.toggleUnderline(_:)),
      #selector(UIResponderStandardEditActions.increaseSize(_:)),
      #selector(UIResponderStandardEditActions.decreaseSize(_:)),
      #selector(UIResponderStandardEditActions.pasteAndMatchStyle(_:)),
      #selector(UIResponder.captureTextFromCamera(_:)),
      NSSelectorFromString("_lookup:"),
      NSSelectorFromString("_translate:"),
      NSSelectorFromString("_share:"),
      NSSelectorFromString("_define:"),
      NSSelectorFromString("showWritingTools:"),
      NSSelectorFromString("replace:"),
    ]
    if #available(iOS 16.0, *) {
      refused += [
        #selector(UIResponderStandardEditActions.find(_:)),
        #selector(UIResponderStandardEditActions.findAndReplace(_:)),
        #selector(UIResponderStandardEditActions.useSelectionForFind(_:)),
        #selector(UIResponderStandardEditActions.rename(_:)),
        #selector(UIResponderStandardEditActions.duplicate(_:)),
      ]
    }
    let answered = refused.filter { view.canPerformAction($0, withSender: nil) }
    XCTAssertEqual(answered.map { NSStringFromSelector($0) }, [])
    XCTAssertTrue(view.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
    if #available(iOS 18.0, *) { XCTAssertEqual(view.writingToolsBehavior, .none) }
    XCTAssertEqual(view.inputAssistantItem.leadingBarButtonGroups.count, 0)
    XCTAssertEqual(view.inputAssistantItem.trailingBarButtonGroups.count, 0)
  }
  // CR7: the system's own Paste command is kept whenever UIKit suggests one: it pastes without the
  // prompt a programmatic read of the pasteboard brings up.
  func testTheSystemsOwnPasteCommandIsKept() {
    let view = RemoteInputTextView()
    view.pasteboardHasContent = { false }
    let system = UICommand(title: "Paste", action: #selector(UIResponderStandardEditActions.paste(_:)))
    let suggested: [UIMenuElement] = [UICommand(title: "Select", action: #selector(UIResponderStandardEditActions.select(_:))), UIMenu(children: [system])]
    let menu = view.pasteMenu(suggested: suggested)
    XCTAssertEqual(menu.children.count, 1)
    XCTAssertTrue(menu.children.first === system)
  }
  // CR7: VoiceOver's activation focuses the field, as the focus tap does: no recognizer of UIKit's
  // is left to do it. Outside a window the view cannot become first responder; the windowed test
  // checks the focus itself.
  func testVoiceOverActivationIsTheFocusTap() {
    let view = RemoteInputTextView()
    var focused = 0
    view.onFocusTap = { focused += 1 }
    XCTAssertTrue(view.accessibilityActivate())
    XCTAssertEqual(focused, 1)
  }
  // CR7: gestureRecognizerShouldBegin is asked only about the view's own recognizers, so a touch
  // must never reach the text view's subviews (its text container view, and whatever UIKit adds
  // there): hit testing anywhere in the view returns the view.
  func testTouchesNeverReachTheTextViewsSubviews() {
    let view = RemoteInputTextView(frame: CGRect(x: 0, y: 0, width: 390, height: 44), textContainer: nil)
    view.insertText("hello")
    view.respond(["id": 1])
    view.layoutIfNeeded()
    XCTAssertFalse(view.subviews.isEmpty, "UITextView keeps its text in a subview")
    for x in stride(from: 1.0, to: 390.0, by: 13.0) {
      for y in stride(from: 1.0, to: 44.0, by: 7.0) {
        let hit = view.hitTest(CGPoint(x: x, y: y), with: nil)
        XCTAssertTrue(hit === view, "a touch at (\(x), \(y)) reached \(hit.map { String(describing: type(of: $0)) } ?? "nothing")")
      }
    }
    XCTAssertNil(view.hitTest(CGPoint(x: 500, y: 10), with: nil))
  }
  func testTheFocusTapAndThePasteLongPressLeaveTheCaretWhereItWas() {
    let field = Field(settled: "helloab")
    let before = field.packets.count
    field.view.focusTapped()
    field.view.pasteLongPressed(at: .zero)
    field.answerAll()
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 7, length: 0))
    XCTAssertEqual(field.packets.count, before)
  }

  // DW1: at the largest text size a tap on "helloab" selected the word on build 9 (8f34d1ce5), and
  // "!" replaced it: a touch reached UIKit's own views inside the field (its selection range
  // adjustment container, the size of the whole field, and its grabbers), whose recognizers the
  // view is never asked about. Here at that size, with the walk's frame, the word selected so
  // UIKit lays those views out, and the walk's touch points: every one reaches the view, and the
  // view's own tap leaves the selection where it was. Runs on the iOS Simulator only (it needs a
  // window); on 8f34d1ce5, with no hitTest of the view's, the subviews took these touches.
  func testAtTheLargestTextSizeNoTouchReachesUIKitsSelectionViews() throws {
    #if targetEnvironment(macCatalyst)
    throw XCTSkip("Needs a window: run on the iOS Simulator")
    #else
    // The package supports iOS 16; trait overrides came in iOS 17.
    guard #available(iOS 17.0, *) else { throw XCTSkip("Needs iOS 17's trait overrides") }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 466, height: 678))
    window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    let view = RemoteInputTextView(frame: CGRect(x: 46, y: 262, width: 356, height: 44), textContainer: nil)
    view.adjustsFontForContentSizeCategory = true
    view.font = UIFont.preferredFont(forTextStyle: .body)
    window.addSubview(view)
    window.makeKeyAndVisible()
    var packets: [[String: Any]] = []
    view.deliver = { packets.append($0) }
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: true)
    XCTAssertTrue(view.isFirstResponder)
    view.insertText("helloab")
    view.respond(["id": packets.last!["id"]!])
    view.selectedRange = NSRange(location: 0, length: 7)
    view.layoutIfNeeded()
    view.selectedRange = NSRange(location: 7, length: 0)
    view.layoutIfNeeded()
    func walk(_ parent: UIView) -> [UIView] { parent.subviews + parent.subviews.flatMap(walk) }
    for subview in walk(view) {
      let frame = subview.convert(subview.bounds, to: view).intersection(view.bounds)
      if frame.isNull || frame.isEmpty { continue }
      for point in [CGPoint(x: frame.midX, y: frame.midY), CGPoint(x: frame.minX + 1, y: frame.minY + 1), CGPoint(x: frame.maxX - 1, y: frame.maxY - 1)] {
        XCTAssertTrue(view.hitTest(point, with: nil) === view, "a touch reached \(type(of: subview))")
      }
    }
    // The walk tapped the field's centre and along the word.
    for x in stride(from: 4, through: 352, by: 16) {
      let point = window.convert(CGPoint(x: 46 + CGFloat(x), y: 284), to: view)
      XCTAssertTrue(view.hitTest(point, with: nil) === view, "a touch at \(x) reached UIKit")
    }
    let before = packets.count
    view.focusTapped()
    view.focusTapped()
    XCTAssertEqual(view.selectedRange, NSRange(location: 7, length: 0))
    XCTAssertEqual(packets.count, before, "a tap sent something")
    window.isHidden = true
    #endif
  }

  // C1 in a window, editing, as on a phone: the recognizers UIKit adds once the field is first
  // responder are refused too. Runs on the iOS Simulator; on Mac Catalyst it would put a window
  // on the Mac's screen, so it is skipped there.
  func testInAWindowAndEditingOnlyTheViewsOwnRecognizersBegin() throws {
    #if targetEnvironment(macCatalyst)
    throw XCTSkip("Needs a window: run on the iOS Simulator")
    #else
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 120))
    let view = RemoteInputTextView(frame: CGRect(x: 0, y: 0, width: 390, height: 44), textContainer: nil)
    window.addSubview(view)
    window.makeKeyAndVisible()
    var packets: [[String: Any]] = []
    view.deliver = { packets.append($0) }
    view.configure(["contextId": "page", "field": ["kind": "text", "sensitive": false]], focused: true)
    XCTAssertTrue(view.isFirstResponder)
    var recognizers = view.gestureRecognizers ?? []
    for interaction in view.interactions {
      if let text = interaction as? UITextInteraction { recognizers += text.gesturesForFailureRequirements }
    }
    XCTAssertEqual(recognizers.filter { view.isOwn($0) }.count, 2)
    for recognizer in recognizers where !view.isOwn(recognizer) {
      XCTAssertFalse(view.gestureRecognizerShouldBegin(recognizer), "\(type(of: recognizer)) began")
    }
    // Recognizers on the text view's subviews are never asked through the view: no touch may
    // reach them. Every point of every subview that carries one hit-tests to the view.
    view.insertText("hello")
    view.respond(["id": packets.last!["id"]!])
    view.layoutIfNeeded()
    func walk(_ parent: UIView) -> [UIView] { parent.subviews + parent.subviews.flatMap(walk) }
    for subview in walk(view) where !(subview.gestureRecognizers ?? []).isEmpty || !subview.interactions.isEmpty {
      let frame = subview.convert(subview.bounds, to: view).intersection(view.bounds)
      if frame.isNull || frame.isEmpty { continue }
      for point in [CGPoint(x: frame.midX, y: frame.midY), CGPoint(x: frame.minX + 1, y: frame.minY + 1), CGPoint(x: frame.maxX - 1, y: frame.maxY - 1)] {
        XCTAssertTrue(view.hitTest(point, with: nil) === view, "a touch reached \(type(of: subview))")
      }
    }
    // VoiceOver's activation focuses the field.
    view.resignFirstResponder()
    XCTAssertFalse(view.isFirstResponder)
    XCTAssertTrue(view.accessibilityActivate())
    XCTAssertTrue(view.isFirstResponder)
    window.isHidden = true
    #endif
  }

  // Found by the random sequences (second generator, seed 81): a space typed as the input method
  // commits, before the commit's turn, was named insertFromComposition when it was typed and
  // taken for the composition's own tail; the far side never got it. A keystroke is named when its
  // turn comes, as the field then stands.
  func testAKeystrokeTypedAsTheCompositionCommitsIsNamedForItsTurn() {
    let field = Field()
    field.view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    field.answerAll()
    let before = field.packets.count
    // The input method updates the composition, commits it and types a space, all before any
    // answer: the commit and the space wait behind the update.
    field.view.setMarkedText("日", selectedRange: NSRange(location: 1, length: 0))
    field.view.unmarkText()
    field.view.insertText(" ")
    field.answerAll()
    let inputs = field.packets[before...].compactMap { $0["event"] as? [String: Any] }.filter { $0["type"] as? String == "beforeinput" }
    XCTAssertEqual(inputs.compactMap { $0["inputType"] as? String }, ["insertCompositionText", "insertText"])
    XCTAssertEqual(field.view.text, "日 ")
  }

  // Found by the random sequences (second generator, seed 2195): the caret moved while a
  // Backspace inside a composition waited; the deletion was recorded at the moved caret instead
  // of the marked text it deleted, and the next keystroke landed inside an emoji. The move is one
  // character back from the person's caret, after the second emoji.
  func testACompositionDeletionIsRecordedWhereItsCharactersWentWhateverTheCaret() {
    let field = Field(settled: "👩‍💻")
    field.view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    field.answerAll()
    field.view.deleteBackward()
    field.view.insertText("👩‍💻")
    field.select(NSRange(location: 5, length: 0))
    field.view.insertText("א")
    field.answerAll()
    let text = field.view.text ?? ""
    XCTAssertEqual(text, "👩‍💻א👩‍💻")
    XCTAssertEqual(text.utf16.count, (text as NSString).length)
  }

  // W1: the bridge hands JavaScript's numbers over as Double. A paste's answer, read with them,
  // puts the pasted text in the native field, so the next Backspace deletes one character of it,
  // not the whole paste and the character before it.
  func testAnAnswerWithTheBridgesNumbersIsApplied() {
    let field = Field(settled: "hello")
    let pasted = "hellofixture clipboard 👩‍💻"
    let at = Double(pasted.utf16.count)
    field.view.respond(["id": 0, "set": ["value": pasted, "selectionStart": at, "selectionEnd": at] as [String: Any],
      "edit": ["start": 5.0, "end": 5.0, "text": "fixture clipboard 👩‍💻"] as [String: Any]])
    XCTAssertEqual(field.view.text, pasted)
    XCTAssertEqual(field.view.selectedRange, NSRange(location: pasted.utf16.count, length: 0))
  }
  func testAnAnswerWithBooleanOffsetsIsIgnored() {
    XCTAssertNil(RemoteInputTextView.integer(true))
    XCTAssertNil(RemoteInputTextView.integer(false))
    let field = Field(settled: "hello")
    field.view.respond(["id": 0, "set": ["value": "bad", "selectionStart": false, "selectionEnd": true] as [String: Any]])
    XCTAssertEqual(field.view.text, "hello")
  }
  // CS2: an answer is applied as the edit it is. A paste's answer inserts the pasted text where it
  // went, so a keystroke and a caret move still waiting are carried over it, not over a cleared
  // field. The move is two back from the person's caret, which ends after "Py".
  func testAPastesAnswerCarriesWhatStillWaits() {
    let field = Field(settled: "abc")
    field.view.insertText("y")
    field.select(NSRange(location: 1, length: 0))
    field.view.respond(["id": 0, "set": ["value": "abcP", "selectionStart": 4, "selectionEnd": 4]])
    field.answerAll()
    field.view.insertText("x")
    field.answerAll()
    XCTAssertEqual(field.view.text, "abcxPy")
  }
  // CS2 and CT1: a caret move named in a mirror cleared before its turn is sent as the distance
  // the person moved it, never as a place in the new mirror.
  func testACaretMoveNamedBeforeAResetIsSentAsItsDistance() {
    let field = Field()
    field.view.insertText("a")
    field.answerOne()
    field.select(NSRange(location: 0, length: 0))
    field.view.respond(["id": 0, "set": ["value": "", "selectionStart": 0, "selectionEnd": 0]])
    field.answerAll()
    let selection = field.packets.compactMap { $0["event"] as? [String: Any] }.last { $0["type"] as? String == "selection" }
    XCTAssertEqual(selection?["moves"] as? [Int], [-1])
  }
  // CS2: a replacement named in a mirror that no longer exists is dropped: it names nothing.
  func testAReplacementNamedInAClearedMirrorIsDropped() {
    let field = Field(settled: "teh")
    let start = field.view.beginningOfDocument
    field.view.replace(field.view.textRange(from: start, to: field.view.position(from: start, offset: 3)!)!, withText: "the")
    field.view.respond(["id": 0, "set": ["value": "", "selectionStart": 0, "selectionEnd": 0]])
    field.answerAll()
    XCTAssertEqual(field.view.text, "")
  }

  // CS4: undo and redo are the far page's. Whatever asks the hidden field's undo manager (Cmd+Z
  // through the responder chain, the three-finger gestures, shake) sends the far page's own undo
  // or redo chord through the gate; the hidden text never changes outside it.
  func testUndoAndRedoAreTheFarPagesAndChangeNothingHere() {
    let field = Field(settled: "hello")
    let before = field.packets.count
    XCTAssertEqual(field.view.undoManager?.canUndo, true)
    XCTAssertEqual(field.view.undoManager?.canRedo, true)
    field.view.undoManager?.undo()
    field.view.undoManager?.redo()
    field.answerAll()
    XCTAssertEqual(field.view.text, "hello")
    let keys = field.packets[before...].compactMap { $0["event"] as? [String: Any] }.filter { $0["type"] as? String == "keydown" }
    XCTAssertEqual(keys.map { "\($0["key"]!) meta \($0["meta"]!) shift \($0["shift"]!)" }, ["z meta true shift false", "Z meta true shift true"])
  }

  // Found by the person oracle (third generator, seed 750 and others): a replacement UIKit names
  // elsewhere (autocorrect) moved the caret to the replaced word, so the person's next keystroke
  // went in there. The person's caret is carried over it instead.
  func testAnAutocorrectElsewhereLeavesTheCaretWhereThePersonLeftIt() {
    let field = Field(settled: "teh cat")
    let start = field.view.beginningOfDocument
    let range = field.view.textRange(from: start, to: field.view.position(from: start, offset: 3)!)!
    field.view.replace(range, withText: "the")
    field.answerAll()
    XCTAssertEqual(field.view.text, "the cat")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 7, length: 0))
    field.view.insertText("s")
    field.answerAll()
    XCTAssertEqual(field.view.text, "the cats")
  }

  // Found by the person oracle (third generator, seed 988): the person moved the caret after a
  // composition's commit was typed; when the composition was applied, UIKit's selection went into
  // it, and a keystroke typed then was named there instead of at the caret the person chose: one
  // back from after "b".
  func testAKeystrokeTypedWhileAnAppliedCompositionHidesThePersonsCaretGoesThere() {
    let field = Field(settled: "a")
    field.view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    field.view.insertText("b")
    field.select(NSRange(location: 0, length: 0))
    // The composition's turn comes: UIKit's selection is in it, the commit still waits.
    field.answerOne()
    XCTAssertNotNil(field.view.markedTextRange)
    field.view.insertText("x")
    field.answerAll()
    XCTAssertEqual(field.view.text, "axb")
  }

  // Found by the random sequences (second generator, seeds 4021, 15915 and 16868): a tap during a
  // composition commits it (unmarkText) and moves the caret, both before the composition's turn.
  // The commit left the native caret at the end of the composition while the selection reported
  // the caret the person chose, so the far caret went there and the next keystroke did not. The
  // move is one back from the person's caret after the committed 日本.
  func testACaretMovedWhileTheCompositionsCommitWaitsIsWhereTheNextKeystrokeGoes() {
    let field = Field(settled: "ab")
    field.view.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
    field.view.unmarkText()
    field.select(NSRange(location: 1, length: 0))
    field.answerAll()
    let reported = field.packets.compactMap { $0["event"] as? [String: Any] }.last { $0["type"] as? String == "selection" }
    let proxy = reported?["proxy"] as? [String: Any]
    XCTAssertEqual(proxy?["selectionStart"] as? Int, 3)
    XCTAssertEqual(proxy?["selectionEnd"] as? Int, 3)
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 3, length: 0))
    field.view.insertText("x")
    field.answerAll()
    XCTAssertEqual(field.view.text, "ab日x本")
    let input = field.packets.compactMap { $0["event"] as? [String: Any] }.last { $0["type"] as? String == "input" }
    XCTAssertEqual((input?["proxy"] as? [String: Any])?["selectionStart"] as? Int, 4)
  }

  // W4: tapping from one remote field to another keeps the hidden UITextView first responder
  // with the software keyboard up, even when traits change or a transient no-field update arrives
  // while focused stays true, without emitting a spurious blur back to JavaScript.
  func testSwitchingFieldsKeepsFirstResponderAndSoftKeyboard() throws {
    #if targetEnvironment(macCatalyst)
    throw XCTSkip("Needs a window: run on the iOS Simulator")
    #else
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 120))
    let view = RemoteInputTextView(frame: CGRect(x: 0, y: 0, width: 390, height: 44), textContainer: nil)
    window.addSubview(view)
    window.makeKeyAndVisible()
    var packets: [[String: Any]] = []
    view.deliver = { packets.append($0) }
    let textField: [String: Any] = ["kind": "text", "sensitive": false]
    let numericPassword: [String: Any] = ["kind": "text", "sensitive": true, "inputMode": "numeric"]
    view.configure(["contextId": "first", "field": textField], focused: true, softKeyboard: true)
    XCTAssertTrue(view.isFirstResponder)
    XCTAssertNil(view.inputView)
    view.configure(["contextId": "second", "field": textField], focused: true, softKeyboard: true)
    XCTAssertTrue(view.isFirstResponder)
    XCTAssertNil(view.inputView)
    view.configure(["contextId": "third", "field": numericPassword], focused: true, softKeyboard: true)
    XCTAssertTrue(view.isFirstResponder)
    XCTAssertNil(view.inputView)
    // A transient no-field update while focused stays true must not emit a spurious blur.
    view.configure(["contextId": "gap", "field": NSNull()], focused: true, softKeyboard: false)
    view.configure(["contextId": "fourth", "field": textField], focused: true, softKeyboard: true)
    XCTAssertTrue(view.isFirstResponder)
    XCTAssertNil(view.inputView)
    let blurs = packets.compactMap { ($0["event"] as? [String: Any])?["type"] as? String }.filter { $0 == "blur" }
    XCTAssertEqual(blurs, [], "Programmatic field transitions must not emit a spurious blur")
    window.isHidden = true
    #endif
  }

  // P4(a) / S4: evidence test before changing Mac helper rotation.
  // Insert "t", deliver a same-field context with a new contextId as the Mac helper currently
  // publishes after a keystroke, insert "e", deliver another contextId, insert "h". Because
  // RemoteInputTextView.applyConfiguration clears `text = ""` whenever nextContext != contextId,
  // the native text view holds only "h" before the caret (not "teh"), so iOS autocorrect never
  // sees the word being typed when the Mac helper's round-trip arrives between keystrokes.
  func testMacPerKeystrokeContextClearsNativeTextBeforeCaret() {
    let field = Field()
    let textField: [String: Any] = ["kind": "text", "sensitive": false]
    field.view.configure(["contextId": "mac-0", "field": textField], focused: false)
    field.view.insertText("t")
    field.answerAll()
    XCTAssertEqual(field.view.text, "t")
    field.view.configure(["contextId": "mac-1", "field": textField], focused: false)
    field.view.insertText("e")
    field.answerAll()
    XCTAssertEqual(field.view.text, "e")
    field.view.configure(["contextId": "mac-2", "field": textField], focused: false)
    field.view.insertText("h")
    field.answerAll()
    let text = field.view.text ?? ""
    let beforeCaret = (text as NSString).substring(to: field.view.selectedRange.location)
    XCTAssertEqual(beforeCaret, "h")
    XCTAssertEqual(field.view.text, "h")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 1, length: 0))
  }

  // P4(b): positive case beside the per-keystroke rotation test above. When the Mac helper skips
  // rotating for its own edit effects (same contextId across the person's typing, or no new
  // context between keystrokes), the native text view keeps "teh" before the caret so iOS
  // autocorrect sees the whole word.
  func testSameContextAcrossThreeKeystrokesKeepsNativeTextBeforeCaret() {
    let field = Field()
    let textField: [String: Any] = ["kind": "text", "sensitive": false]
    field.view.configure(["contextId": "mac-0", "field": textField], focused: false)
    field.view.insertText("t")
    field.answerAll()
    field.view.configure(["contextId": "mac-0", "field": textField], focused: false)
    field.view.insertText("e")
    field.answerAll()
    field.view.insertText("h")
    field.answerAll()
    let text = field.view.text ?? ""
    let beforeCaret = (text as NSString).substring(to: field.view.selectedRange.location)
    XCTAssertEqual(beforeCaret, "teh")
    XCTAssertEqual(field.view.text, "teh")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 3, length: 0))
  }
}
#endif
