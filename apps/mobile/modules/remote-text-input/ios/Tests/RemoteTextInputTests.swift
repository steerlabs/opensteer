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
  func testTypingAfterATapWhileAnEarlierKeystrokeWaitsLandsAtTheTap() {
    let field = Field(settled: "hello")
    field.view.insertText("a")
    field.select(NSRange(location: 0, length: 0))
    field.answerOne()
    field.view.insertText("X")
    field.answerAll()
    XCTAssertEqual(field.view.text, "Xhelloa")
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

  // T1: each edit's event reports the state right after that edit, never a caret chosen later.
  func testEachEditReportsItsOwnCaretWhenATapCameAfterIt() {
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
    XCTAssertEqual(selections.map { $0["selectionEnd"] as? Int }, [0])
    XCTAssertEqual(field.view.text, "helloab")
    XCTAssertEqual(field.view.selectedRange, NSRange(location: 0, length: 0))
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
    XCTAssertFalse(RemoteInputTextView.letsTouchBegin(UITapGestureRecognizer(), editing: true))
    XCTAssertTrue(RemoteInputTextView.letsTouchBegin(UITapGestureRecognizer(), editing: false))
    XCTAssertTrue(RemoteInputTextView.letsTouchBegin(UILongPressGestureRecognizer(), editing: true))
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
}
#endif
