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

}
