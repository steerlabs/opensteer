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
  func testReplacementPermissionOnlyChangesReplacementTraits() {
    for sensitive in [false, true] {
      for mode in ["text", "email", "url", "numeric", "decimal", "tel", "search", "none"] {
        let context: [String: Any] = ["field": ["sensitive": sensitive, "inputMode": mode, "enterKeyHint": "send", "autocapitalize": "words"]]
        let full = RemoteInputTraits(context, softKeyboard: true)
        let basic = RemoteInputTraits(context, softKeyboard: true, keyboardMayReplaceText: false)
        XCTAssertTrue(full.keyboardMayReplaceText)
        XCTAssertEqual(full.allowsSuggestions, !sensitive)
        XCTAssertFalse(basic.keyboardMayReplaceText)
        XCTAssertFalse(basic.allowsSuggestions)
        XCTAssertNotEqual(full, basic)
        XCTAssertEqual(full.editable, basic.editable)
        XCTAssertEqual(full.sensitive, basic.sensitive)
        XCTAssertEqual(full.inputMode, basic.inputMode)
        XCTAssertEqual(full.enterKeyHint, basic.enterKeyHint)
        XCTAssertEqual(full.autocapitalize, basic.autocapitalize)
        XCTAssertEqual(full.showsKeyboard, basic.showsKeyboard)
      }
    }
  }
}
