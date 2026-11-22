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
