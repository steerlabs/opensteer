import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

/// `performed`: what each completed action did, in the words a person reading
/// the transcript and the model reading the result both use (§2 "Actions").
final class ActionDescriptionTests: XCTestCase {
  private func element(
    _ role: String, title: String? = nil, value: String? = nil, help: String? = nil,
    subrole: String? = nil
  ) -> ElementAttributes {
    ElementAttributes(role: role, subrole: subrole, title: title, value: value, help: help)
  }

  func testClicksNameTheElementTheButtonAndTheCount() {
    let save = element("AXButton", title: "Save")
    XCTAssertEqual(
      ActionDescription.click(button: .left, count: 1, element: save, point: nil),
      #"Clicked "Save""#)
    XCTAssertEqual(
      ActionDescription.click(
        button: .left, count: 2, element: element("AXStaticText", value: "Budget.xlsx"),
        point: nil),
      #"Double-clicked "Budget.xlsx""#)
    XCTAssertEqual(
      ActionDescription.click(
        button: .right, count: 1, element: element("AXRow", help: "Inbox"), point: nil),
      #"Right-clicked "Inbox""#)
    XCTAssertEqual(
      ActionDescription.click(button: .left, count: 3, element: save, point: nil),
      #"Triple-clicked "Save""#)
    XCTAssertEqual(
      ActionDescription.click(button: .right, count: 2, element: save, point: nil),
      #"Right-clicked "Save" twice"#)
  }

  func testAnUntitledElementIsNamedByItsRoleAndABarePointByItsCoordinates() {
    XCTAssertEqual(
      ActionDescription.click(button: .left, count: 1, element: element("AXButton"), point: nil),
      "Clicked the button")
    XCTAssertEqual(
      ActionDescription.click(
        button: .left, count: 1, element: element("AXCheckBox"), point: nil),
      "Clicked the checkbox")
    XCTAssertEqual(
      ActionDescription.click(
        button: .left, count: 1,
        element: element("AXRadioButton", subrole: "AXTabButton"), point: nil),
      "Clicked the tab")
    XCTAssertEqual(
      ActionDescription.click(
        button: .left, count: 1, element: element("AXLevelIndicator"), point: nil),
      "Clicked the level indicator")
    XCTAssertEqual(
      ActionDescription.click(
        button: .left, count: 1, element: nil, point: CGPoint(x: 412.4, y: 88)),
      "Clicked at (412, 88)")
  }

  func testAFieldIsNeverNamedByItsContents() {
    // A text field's value is what is in it, not what it is called.
    let field = element("AXTextField", value: "draft text")
    XCTAssertEqual(
      ActionDescription.click(button: .left, count: 1, element: field, point: nil),
      "Clicked the text field")
    XCTAssertEqual(
      ActionDescription.type(text: "Venue shortlist", field: element("AXTextField", help: "Title")),
      #"Typed "Venue shortlist" into "Title""#)
  }

  func testTypingQuotesClipsAndKeepsOneLine() {
    let field = element("AXTextField")
    XCTAssertEqual(
      ActionDescription.type(text: "Venue shortlist", field: nil, focused: [field]),
      #"Typed "Venue shortlist" into the text field"#)
    XCTAssertEqual(
      ActionDescription.type(text: " and more", field: field),
      #"Typed " and more" into the text field"#, "The spaces a person typed are kept.")
    let long = String(repeating: "abcdefghij", count: 10)
    let clipped = ActionDescription.type(text: long, field: field)
    XCTAssertEqual(clipped, "Typed \"\(String(long.prefix(39)))…\" into the text field")
    XCTAssertEqual(
      ActionDescription.type(text: "Line one\nLine two\tend", field: field),
      #"Typed "Line one↵Line two⇥end" into the text field"#)
  }

  /// The protocol counts a description's length in UTF-16 code units, and a
  /// flag or a family emoji is one character but several of them. Every cut
  /// falls between characters.
  func testDescriptionsFitTheProtocolsLengthAndNeverSplitACharacter() {
    let field = element("AXTextField")
    let samples = [
      "🇯🇵🇫🇷🇺🇸", "👨‍👩‍👧‍👦", "e\u{301}", "Z\u{324}\u{354}\u{367}\u{311}\u{313}", "a🏳️‍🌈b",
      "日本語テキスト", "x",
    ]
    for sample in samples {
      for count in 1...90 {
        let text = String(repeating: sample, count: count)
        for description in [
          ActionDescription.type(text: text, field: field),
          ActionDescription.setValue(value: text, field: field),
          ActionDescription.click(
            button: .left, count: 1, element: element("AXButton", title: text), point: nil),
          ActionDescription.menu(path: [text, text, text]) ?? "",
        ] {
          XCTAssertLessThanOrEqual(
            description.utf16.count, ActionDescription.maxLength, description)
          XCTAssertFalse(description.isEmpty)
        }
        let quoted = ActionDescription.quoted(text)
        XCTAssertLessThanOrEqual(quoted.utf16.count, ActionDescription.quotedLimit + 2)
        let body = String(quoted.dropFirst().dropLast())
        let kept = body.hasSuffix("…") ? String(body.dropLast()) : body
        XCTAssertEqual(
          Array(text.prefix(kept.count)), Array(kept),
          "The cut keeps whole characters: \(sample) × \(count)")
      }
    }
    // Eleven code units each: 160 would hold fourteen, and the ellipsis
    // takes one of the last eleven.
    let families = String(repeating: "👨‍👩‍👧‍👦", count: 30)
    XCTAssertEqual(ActionDescription.clip(families, to: 160), String(families.prefix(14)) + "…")
    XCTAssertEqual(ActionDescription.clip("🇯🇵🇯🇵", to: 8), "🇯🇵🇯🇵", "Fits exactly.")
    XCTAssertEqual(ActionDescription.clip("🇯🇵🇯🇵", to: 7), "🇯🇵…")
    XCTAssertEqual(ActionDescription.clip("🇯🇵🇯🇵", to: 4), "…", "No half flag.")
  }

  /// Text is counted, never quoted, when the field it went into could be a
  /// password field: the one named, or one that had the focus, reports
  /// itself secure, or none of them could be read.
  func testTextIsCountedWhenTheFieldMayBeSecure() {
    let title = element("AXTextField", title: "Title")
    let secure = element("AXTextField", subrole: "AXSecureTextField")
    let unreadable = element("AXUnknown")
    XCTAssertEqual(
      ActionDescription.type(text: "hunter22", field: title, focused: [secure]),
      #"Typed 8 characters into "Title""#)
    XCTAssertEqual(
      ActionDescription.type(text: "hunter22", field: nil, focused: [secure]),
      "Typed 8 characters into the password field")
    XCTAssertEqual(ActionDescription.type(text: "hunter22", field: nil), "Typed 8 characters")
    XCTAssertEqual(
      ActionDescription.type(text: "hunter22", field: nil, focused: [unreadable]),
      "Typed 8 characters")
    XCTAssertEqual(
      ActionDescription.type(text: "hunter22", field: unreadable), "Typed 8 characters")
    XCTAssertEqual(
      ActionDescription.type(text: "Q4", field: nil, focused: [unreadable, title]),
      #"Typed "Q4" into "Title""#, "One readable, plain field is enough to quote.")
    XCTAssertEqual(
      ActionDescription.setValue(value: "s3cret", field: title, current: secure),
      #"Set "Title" to 6 characters"#)
    XCTAssertEqual(
      ActionDescription.setValue(value: "s3cret", field: nil, current: unreadable),
      "Set the value to 6 characters")
    XCTAssertEqual(
      ActionDescription.setValue(value: "s3cret", field: unreadable),
      "Set the value to 6 characters")
  }

  func testSecureTextIsCountedAndNeverRepeated() {
    let password = element("AXTextField", title: "Password", subrole: "AXSecureTextField")
    XCTAssertEqual(
      ActionDescription.type(text: "hunter22", field: password),
      #"Typed 8 characters into "Password""#)
    XCTAssertEqual(
      ActionDescription.type(text: "x", field: element("AXSecureTextField")),
      "Typed 1 character into the password field")
    XCTAssertEqual(
      ActionDescription.setValue(value: "s3cret", field: password),
      #"Set "Password" to 6 characters"#)
    for description in [
      ActionDescription.type(text: "hunter22", field: password),
      ActionDescription.setValue(value: "hunter22", field: password),
    ] {
      XCTAssertFalse(description.contains("hunter22"))
    }
  }

  func testKeysUseTheMenuPathOrMacGlyphs() {
    XCTAssertEqual(ActionDescription.menu(path: ["File", "Save"]), "Chose File › Save")
    XCTAssertEqual(
      ActionDescription.menu(path: ["Format", "Font", "Bold"]), "Chose Format › Font › Bold")
    XCTAssertNil(ActionDescription.menu(path: ["", "  "]))
    func pressed(_ keys: String) throws -> String {
      ActionDescription.keystroke(try KeyComboParser.parse(keys))
    }
    XCTAssertEqual(try pressed("cmd+s"), "Pressed ⌘S")
    XCTAssertEqual(try pressed("shift+cmd+z"), "Pressed ⇧⌘Z")
    XCTAssertEqual(try pressed("ctrl+alt+shift+cmd+k"), "Pressed ⌃⌥⇧⌘K")
    XCTAssertEqual(try pressed("return"), "Pressed Return")
    XCTAssertEqual(try pressed("esc"), "Pressed Esc")
    XCTAssertEqual(try pressed("ctrl+tab"), "Pressed ⌃Tab")
    XCTAssertEqual(try pressed("left"), "Pressed ←")
    XCTAssertEqual(try pressed("f5"), "Pressed F5")
    XCTAssertEqual(try pressed("pgdn"), "Pressed Page Down")
  }

  func testValuesScrollsAndWaits() {
    XCTAssertEqual(
      ActionDescription.setValue(value: "Q4", field: element("AXTextField", title: "Title")),
      #"Set "Title" to "Q4""#)
    XCTAssertEqual(
      ActionDescription.setValue(value: "50", field: element("AXSlider")),
      #"Set the slider to "50""#)
    XCTAssertEqual(
      ActionDescription.scroll(direction: .down, in: element("AXTable", help: "Inbox")),
      #"Scrolled down in "Inbox""#)
    XCTAssertEqual(ActionDescription.scroll(direction: .up, in: nil), "Scrolled up")
    XCTAssertEqual(ActionDescription.wait(milliseconds: 1_500), "Waited 1.5 s")
    XCTAssertEqual(ActionDescription.wait(milliseconds: 2_000), "Waited 2 s")
    XCTAssertEqual(ActionDescription.wait(milliseconds: 100), "Waited 0.1 s")
    XCTAssertEqual(ActionDescription.wait(milliseconds: 0), "Waited 0 s")
  }

  func testEveryDescriptionIsOneBoundedLine() {
    let huge = String(repeating: "word ", count: 200)
    let named = element("AXButton", title: "Title\nwith a break " + huge)
    for description in [
      ActionDescription.click(button: .left, count: 1, element: named, point: nil),
      ActionDescription.type(text: huge, field: named),
      ActionDescription.setValue(value: huge, field: named),
      ActionDescription.menu(path: Array(repeating: huge, count: 5)) ?? "",
      ActionDescription.scroll(direction: .left, in: named),
    ] {
      XCTAssertLessThanOrEqual(
        description.utf16.count, ActionDescription.maxLength, description)
      XCTAssertFalse(description.contains("\n"), description)
      XCTAssertFalse(description.isEmpty)
    }
    XCTAssertTrue(
      ActionDescription.menu(path: Array(repeating: huge, count: 5))?.hasSuffix("…") == true)
  }

  /// A point target is named by what the cited observation shows under it:
  /// the smallest element of a role a person would name.
  func testAPointIsNamedByTheInnermostElementUnderIt() {
    let window = (CGRect(x: 0, y: 0, width: 800, height: 600), element("AXWindow", title: "Doc"))
    let toolbar = (CGRect(x: 0, y: 0, width: 800, height: 50), element("AXToolbar"))
    let save = (CGRect(x: 10, y: 10, width: 60, height: 30), element("AXButton", title: "Save"))
    let list = (CGRect(x: 0, y: 60, width: 300, height: 540), element("AXList", help: "Notes"))
    let elements = [window, toolbar, save, list]
    XCTAssertEqual(
      ElementHit.innermost(
        at: CGPoint(x: 20, y: 20), in: elements, roles: ElementHit.pointedRoles)?.title, "Save")
    XCTAssertNil(
      ElementHit.innermost(
        at: CGPoint(x: 500, y: 300), in: elements, roles: ElementHit.pointedRoles))
    XCTAssertEqual(
      ElementHit.innermost(
        at: CGPoint(x: 100, y: 300), in: elements, roles: ElementHit.scrollingRoles)?.help,
      "Notes")
  }
}
