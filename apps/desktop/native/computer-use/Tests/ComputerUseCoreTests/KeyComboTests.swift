import XCTest

@testable import ComputerUseCore

final class KeyComboTests: XCTestCase {
  func testParsesASimpleShortcut() throws {
    let combo = try KeyComboParser.parse("cmd+s")
    XCTAssertEqual(combo.modifiers, [.cmd])
    XCTAssertEqual(combo.key, "s")
  }

  func testParsesEveryModifier() throws {
    let combo = try KeyComboParser.parse("cmd+ctrl+alt+shift+fn+f5")
    XCTAssertEqual(combo.modifiers, [.cmd, .ctrl, .alt, .shift, .fn])
    XCTAssertEqual(combo.key, "f5")
  }

  func testAcceptsModifierAliases() throws {
    XCTAssertEqual(try KeyComboParser.parse("command+a").modifiers, [.cmd])
    XCTAssertEqual(try KeyComboParser.parse("control+a").modifiers, [.ctrl])
    XCTAssertEqual(try KeyComboParser.parse("option+a").modifiers, [.alt])
    XCTAssertEqual(try KeyComboParser.parse("opt+a").modifiers, [.alt])
  }

  func testNormalisesKeyAliases() throws {
    XCTAssertEqual(try KeyComboParser.parse("return").key, "enter")
    XCTAssertEqual(try KeyComboParser.parse("esc").key, "escape")
    XCTAssertEqual(try KeyComboParser.parse("backspace").key, "delete")
    XCTAssertEqual(try KeyComboParser.parse("arrowleft").key, "left")
    XCTAssertEqual(try KeyComboParser.parse("pgdn").key, "pagedown")
  }

  func testIsCaseInsensitive() throws {
    XCTAssertEqual(try KeyComboParser.parse("CMD+Shift+S").modifiers, [.cmd, .shift])
    XCTAssertEqual(try KeyComboParser.parse("CMD+Shift+S").key, "s")
  }

  func testAcceptsEveryNamedKey() throws {
    for name in KeyComboParser.namedKeys {
      XCTAssertEqual(try KeyComboParser.parse(name).key, name)
    }
  }

  func testTheTrailingPlusIsTheKeyItself() throws {
    let combo = try KeyComboParser.parse("cmd++")
    XCTAssertEqual(combo.modifiers, [.cmd])
    XCTAssertEqual(combo.key, "+")
  }

  func testRefusesAnUnknownModifier() {
    XCTAssertThrowsError(try KeyComboParser.parse("hyper+s")) { error in
      XCTAssertEqual((error as? HelperError)?.code, .unsupported)
    }
  }

  func testRefusesAnUnknownKey() {
    XCTAssertThrowsError(try KeyComboParser.parse("cmd+wibble"))
    XCTAssertThrowsError(try KeyComboParser.parse(""))
  }

  @MainActor
  func testTheMenuIndexKeyIsStableRegardlessOfModifierOrder() throws {
    let one = try KeyComboParser.parse("shift+cmd+s")
    let other = try KeyComboParser.parse("cmd+shift+s")
    XCTAssertEqual(MenuShortcutIndex.key(for: one), MenuShortcutIndex.key(for: other))
  }

  @MainActor
  func testAMenuItemVirtualKeyMapsBackToItsName() {
    XCTAssertEqual(MenuShortcutIndex.namedKey(forVirtualKey: 36), "enter")
    XCTAssertEqual(MenuShortcutIndex.namedKey(forVirtualKey: 53), "escape")
    XCTAssertNil(MenuShortcutIndex.namedKey(forVirtualKey: 200))
  }
}
