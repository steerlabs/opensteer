import CoreGraphics
import XCTest

@testable import ComputerUseCore

final class ActionReceiptTests: XCTestCase {
  func testEveryActionUsesTheObservedLabel() throws {
    let elements = [ElementAttributes(role: "AXTextField", title: "Title")]
    let cases: [(ActionRequest, String)] = [
      (.click(target: .index(0), button: .left, count: 1), "Clicked \"Title\""),
      (.click(target: .index(0), button: .left, count: 2), "Double-clicked \"Title\""),
      (.click(target: .index(0), button: .left, count: 3), "Triple-clicked \"Title\""),
      (.click(target: .index(0), button: .right, count: 1), "Right-clicked \"Title\""),
      (.click(target: .index(0), button: .middle, count: 1), "Middle-clicked \"Title\""),
      (
        .click(target: .point(CGPoint(x: 412, y: 88)), button: .left, count: 1),
        "Clicked at 412, 88"
      ),
      (
        .type(text: "Venue shortlist", target: .index(0)),
        "Typed \"Venue shortlist\" into \"Title\""
      ),
      (.type(text: "Venue shortlist"), "Typed \"Venue shortlist\""),
      (.type(text: "Notes", target: .point(.zero)), "Typed \"Notes\""),
      (.key(keys: "cmd+s"), "Pressed ⌘S"),
      (.key(keys: "ctrl+alt+shift+cmd+return"), "Pressed ⌃⌥⇧⌘↩"),
      (.setValue(index: 0, value: "Offsite"), "Set \"Title\" to \"Offsite\""),
      (.scroll(target: .index(0), direction: .down, amount: 3), "Scrolled down in \"Title\""),
      (.scroll(target: .point(.zero), direction: .up, amount: 1), "Scrolled up"),
      (.key(keys: "Escape"), "Pressed ⎋"),
    ]
    for (action, expected) in cases {
      XCTAssertEqual(try ActionReceipt.format(action, elements: elements), expected)
    }
  }

  func testNamelessElementsUseNaturalRolesAndLabelsMatchTheTree() throws {
    XCTAssertEqual(
      try ActionReceipt.format(
        .click(target: .index(0), button: .left, count: 1),
        elements: [ElementAttributes(role: "AXRadioButton")]), "Clicked the radio button")
    XCTAssertEqual(
      try ActionReceipt.format(
        .type(text: "A\n\"B\"", target: .index(0)),
        elements: [ElementAttributes(role: "AXTextField", subrole: "AXSearchField")]),
      #"Typed "A \"B\"" into the search field"#)
    let attributes = ElementAttributes(role: "AXStaticText", value: "Report.pdf")
    XCTAssertEqual(
      try ActionReceipt.format(
        .click(target: .index(0), button: .left, count: 2), elements: [attributes]),
      "Double-clicked \"Report.pdf\"")
  }

  func testSecureFieldsNeverRepeatTypedTextOrTheirValue() throws {
    XCTAssertTrue(ActionReceipt.isSecure(role: "AXSecureTextField", subrole: nil))
    XCTAssertTrue(ActionReceipt.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
    XCTAssertTrue(ActionReceipt.isSecure(role: nil, subrole: nil))
    XCTAssertFalse(ActionReceipt.isSecure(role: "AXTextField", subrole: nil))
    for attributes in [
      ElementAttributes(role: "AXSecureTextField", title: "Password", value: "old secret"),
      ElementAttributes(role: "AXTextField", subrole: "AXSecureTextField", title: "Password"),
    ] {
      XCTAssertEqual(
        try ActionReceipt.format(
          .type(text: "secretsecret", target: .index(0)), elements: [attributes]),
        "Typed 12 characters into \"Secure text field\"")
      XCTAssertEqual(
        try ActionReceipt.format(
          .setValue(index: 0, value: "secretsecret"), elements: [attributes]),
        "Set \"Secure text field\" to 12 characters")
    }
    XCTAssertEqual(
      try ActionReceipt.format(
        .type(text: "secret", target: .index(0)),
        elements: [ElementAttributes(role: "AXSecureTextField", value: "old secret")]),
      "Typed 6 characters into \"Secure text field\"")
    XCTAssertEqual(
      try ActionReceipt.format(
        .type(text: "secret"),
        elements: [ElementAttributes(role: "AXSecureTextField", focused: true)]),
      "Typed 6 characters")
    for target: ActionTarget? in [nil, .point(.zero), .index(0)] {
      let receipt = try ActionReceipt.format(
        .type(text: "secret", target: target),
        elements: [ElementAttributes(role: "AXTextField", title: "Password")], secureReceiver: true)
      XCTAssertFalse(receipt.contains("secret"))
      XCTAssertTrue(receipt.hasPrefix("Typed 6 characters"))
    }
    XCTAssertEqual(
      try ActionReceipt.format(
        .setValue(index: 0, value: "secret"),
        elements: [ElementAttributes(role: "AXUnknown", title: "Password")],
        secureReceiver: true),
      "Set \"Password\" to 6 characters")
  }

  func testClippingPreservesQuotesAndFitsTheWireLimitIncludingEmoji() throws {
    for value in [
      String(repeating: "a", count: 300), String(repeating: "😀", count: 300),
      String(repeating: "\\\"", count: 300),
    ] {
      for action: ActionRequest in [
        .type(text: value, target: .index(0)),
        .setValue(index: 0, value: value), .click(target: .index(0), button: .left, count: 1),
      ] {
        let receipt = try ActionReceipt.format(
          action,
          elements: [ElementAttributes(role: "AXTextField", title: value)])
        XCTAssertLessThanOrEqual(receipt.utf16.count, 160)
        XCTAssertTrue(receipt.hasSuffix("…\""))
        XCTAssertFalse(receipt.contains("\n"))
      }
    }
  }
}
