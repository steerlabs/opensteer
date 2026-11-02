import XCTest
@testable import RemoteTextInputCore

final class RemoteInputTraitsTests: XCTestCase {
  private let field: [String: Any] = ["sensitive": false, "inputMode": "text", "autocapitalize": "none"]
  func testCaretAndContextChangesDoNotChangeInputTraits() {
    let first = RemoteInputTraits(["contextId": "first", "field": field], softKeyboard: true)
    let moved = RemoteInputTraits(["contextId": "second", "field": field, "caret": ["x": 0.5]], softKeyboard: true)
    XCTAssertEqual(first, moved)
    XCTAssertEqual(first, RemoteInputTraits(["field": ["sensitive": false, "inputMode": "unknown"]], softKeyboard: true))
  }
  func testEveryKeyboardTraitAndSensitiveTransitionChangesConfiguration() {
    let first = RemoteInputTraits(["field": field], softKeyboard: true)
    for (key, value) in [("sensitive", true as Any), ("inputMode", "numeric"), ("enterKeyHint", "send"), ("autocapitalize", "words")] {
      var next = field
      next[key] = value
      XCTAssertNotEqual(first, RemoteInputTraits(["field": next], softKeyboard: true), key)
    }
    XCTAssertNotEqual(first, RemoteInputTraits(["field": field], softKeyboard: false))
    XCTAssertFalse(RemoteInputTraits(nil, softKeyboard: true).showsKeyboard)
    XCTAssertFalse(RemoteInputTraits(["field": ["inputMode": "none"]], softKeyboard: true).showsKeyboard)
  }
}
