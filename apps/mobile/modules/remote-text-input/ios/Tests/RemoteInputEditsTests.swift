import XCTest
@testable import RemoteTextInputCore

/// The places UIKit names for waiting edits, carried over the edits applied before their turn.
/// UIKit names a place in the text as it stands when it calls, while earlier edits still wait for
/// JavaScript's answer: the walk typed 0123456789 fast and the target received 1023456789.
@MainActor final class RemoteInputEditsTests: XCTestCase {
  /// The view as the gate drives it: each keystroke is placed where UIKit names it when typed,
  /// applied only once the answer to the edit before it has arrived, and answered late.
  @MainActor private final class Field {
    let gate = RemoteInputGate()
    var edits = RemoteInputEdits()
    var text: [UInt16] = []
    var caret = 0
    var answers: [[String: Any]] = []
    var string: String { String(decoding: text, as: UTF16.self) }
    init() {
      gate.deliver = { [unowned self] in answers.append(["id": $0["id"]!]) }
      gate.idle = { [unowned self] in edits.settle() }
    }
    /// UIKit replaces `start..<end` of the text as it stands now with `typed`.
    func type(_ typed: String, replacing start: Int? = nil, _ end: Int? = nil) {
      let place = edits.place(start ?? caret, end ?? caret)
      gate.enqueue { [unowned self] in
        gate.event(["type": "beforeinput"]) { [unowned self] in
          let target = edits.current(place, length: text.count)
          let units = Array(typed.utf16)
          text.replaceSubrange(target.start..<target.end, with: units)
          edits.record(start: target.start, removed: target.end - target.start, inserted: units.count)
          caret = target.start + units.count
          gate.notify(["type": "input"])
        }
      }
    }
    /// A backspace as UIKit asks the delegate for it: the character before the caret, named in
    /// the text as it stands now. UIKit asks nothing where it sees nothing to delete.
    func backspace() {
      guard caret > 0 else { return }
      let named = (string as NSString).rangeOfComposedCharacterSequence(at: caret - 1)
      let place = edits.place(named.location, named.location + named.length)
      gate.enqueue { [unowned self] in
        gate.event(["type": "beforeinput"]) { [unowned self] in
          let target = edits.deletion(place, in: string)
          text.removeSubrange(target.location..<(target.location + target.length))
          edits.record(start: target.location, removed: target.length, inserted: 0)
          caret = target.location
          gate.notify(["type": "input"])
        }
      }
    }
    /// deleteBackward(): where the caret was when pressed, carried; one character before it.
    func deleteBackward() {
      let place = edits.place(caret, caret)
      gate.enqueue { [unowned self] in
        gate.event(["type": "beforeinput"]) { [unowned self] in
          let at = edits.current(place, length: text.count).start
          guard at > 0 else { return }
          let target = (string as NSString).rangeOfComposedCharacterSequence(at: at - 1)
          text.removeSubrange(target.location..<(target.location + target.length))
          edits.record(start: target.location, removed: target.length, inserted: 0)
          caret = target.location
          gate.notify(["type": "input"])
        }
      }
    }
    /// JavaScript's answers arrive, one at a time, each after everything typed so far.
    func answerAll() {
      while !answers.isEmpty { gate.respond(answers.removeFirst()) }
    }
  }

  func testABurstTypedBeforeAnyAnswerLandsInTypingOrder() {
    let field = Field()
    for digit in "0123456789" { field.type(String(digit)) }
    field.answerAll()
    XCTAssertEqual(field.string, "0123456789")
    XCTAssertEqual(field.caret, 10)
  }

  func testEachKeystrokeTypedWhileTheOneBeforeWaitsLandsAfterIt() {
    let field = Field()
    for digit in "0123456789" {
      field.type(String(digit))
      // The answer to the keystroke before arrives only after this one was typed.
      if let answer = field.answers.first { field.answers.removeFirst(); field.gate.respond(answer) }
    }
    field.answerAll()
    XCTAssertEqual(field.string, "0123456789")
  }

  func testTypingOverASelectionTwiceLeavesTheSecondAfterTheFirst() {
    let field = Field()
    field.type("hello")
    field.answerAll()
    field.type("a", replacing: 1, 4)
    field.type("b", replacing: 1, 4)
    field.answerAll()
    XCTAssertEqual(field.string, "habo")
  }

  func testAReplacementNamedBeforeEarlierTypingStillReplacesItsWord() {
    let field = Field()
    field.type("teh")
    field.answerAll()
    field.type(" ")
    field.type("the", replacing: 0, 3)  // autocorrect, named before the space went in
    field.type("x")
    field.answerAll()
    XCTAssertEqual(field.string, "the x")
  }

  func testAReplacementOfTheWholeTextMovesWaitingPlacesToItsEnd() {
    var edits = RemoteInputEdits()
    let waiting = edits.place(5, 5)
    edits.record(start: 0, removed: 5, inserted: 0)
    XCTAssertEqual(edits.current(waiting, length: 0).start, 0)
    edits.record(start: 0, removed: 0, inserted: 2)
    XCTAssertEqual(edits.current(waiting, length: 2).start, 2)
  }

  // An edit that begins where a range ends is outside the range, whatever it removed: the word
  // named for autocorrect is still that word after the space beside it became two line breaks.
  func testARangeEndingWhereAnEarlierReplacementBeginsKeepsItOutside() {
    let field = Field()
    field.type("ab cd")
    field.answerAll()
    field.type("\n\n", replacing: 2, 3)
    field.type("AB", replacing: 0, 2)
    field.answerAll()
    XCTAssertEqual(field.string, "AB\n\ncd")
  }

  // The mirror cases, read as the lead asked: a range starting where an earlier edit's removed
  // text ended, and a range strictly containing a replaced region.
  func testARangeStartingWhereAnEarlierRemovalEndedFollowsIt() {
    var edits = RemoteInputEdits()
    let word = edits.place(3, 5)
    edits.record(start: 1, removed: 2, inserted: 1)
    XCTAssertTrue(edits.current(word, length: 10) == (2, 4))
  }
  func testARangeContainingAReplacedRegionGrowsAndShrinksWithIt() {
    var edits = RemoteInputEdits()
    let range = edits.place(0, 5)
    edits.record(start: 1, removed: 2, inserted: 4)
    XCTAssertTrue(edits.current(range, length: 10) == (0, 7))
  }

  // The walk: 0123456789, then five backspaces in one burst, and 0123456 arrived.
  func testFiveBackspacesNamedBeforeAnyAnswerDeleteFive() {
    let field = Field()
    for digit in "0123456789" { field.type(String(digit)) }
    field.answerAll()
    for _ in 0..<5 { field.backspace() }
    field.answerAll()
    XCTAssertEqual(field.string, "01234")
  }
  func testFiveBackspacesTypedWhileTheTenStillWaitDeleteFive() {
    let field = Field()
    for digit in "0123456789" { field.type(String(digit)) }
    for _ in 0..<5 { field.deleteBackward() }
    field.answerAll()
    XCTAssertEqual(field.string, "01234")
  }
  func testABackspaceOverAnEmojiAlreadyDeletedDeletesTheCharacterBeforeIt() {
    let field = Field()
    field.type("a👩‍💻")
    field.answerAll()
    field.backspace()
    field.backspace()
    field.answerAll()
    XCTAssertEqual(field.string, "")
  }

  func testAnEditAfterAPlaceDoesNotMoveIt() {
    var edits = RemoteInputEdits()
    let waiting = edits.place(1, 2)
    edits.record(start: 3, removed: 1, inserted: 4)
    XCTAssertEqual(edits.current(waiting, length: 10).start, 1)
    XCTAssertEqual(edits.current(waiting, length: 10).end, 2)
  }

  func testTheGateForgetsEditsOnlyWhenNothingWaits() {
    let field = Field()
    field.type("a")
    field.type("b")
    XCTAssertEqual(field.edits.revision, 0)
    field.gate.respond(field.answers.removeFirst())
    // "a" is applied; "b" still waits for its turn, so the edit that moves it is kept.
    XCTAssertEqual(field.edits.revision, 1)
    field.answerAll()
    XCTAssertEqual(field.string, "ab")
    field.type("c")
    XCTAssertEqual(field.edits.current(field.edits.place(2, 2), length: 2).start, 2)
    field.answerAll()
    XCTAssertEqual(field.string, "abc")
  }
}
