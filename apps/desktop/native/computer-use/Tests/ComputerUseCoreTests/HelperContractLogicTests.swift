import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

final class HelperContractLogicTests: XCTestCase {
  /// An available AX route prevents the window raise caused by synthetic
  /// mouse-down. A menu's uncertain AX answer must never fall back to pixels.
  @MainActor
  func testSingleLeftClicksPreferAXIncludingMenuOpeningRoles() {
    for role in ["AXPopUpButton", "AXMenuButton", "AXComboBox", "AXMenuBarItem"] {
      XCTAssertEqual(
        ActionRunner.clickRoute(role: role, button: .left, count: 1, offersPress: true),
        .press, role)
    }
    XCTAssertEqual(
      ActionRunner.clickRoute(role: "AXButton", button: .left, count: 1, offersPress: true), .press)
    XCTAssertEqual(
      ActionRunner.clickRoute(role: "AXMenuItem", button: .left, count: 1, offersPress: true),
      .press)
    XCTAssertEqual(
      ActionRunner.clickRoute(role: "AXButton", button: .left, count: 2, offersPress: true),
      .synthetic)
    XCTAssertEqual(
      ActionRunner.clickRoute(role: "AXButton", button: .right, count: 1, offersPress: true),
      .synthetic)
    XCTAssertEqual(
      ActionRunner.clickRoute(role: "AXButton", button: .left, count: 1, offersPress: false),
      .synthetic)
    XCTAssertEqual(
      ActionRunner.clickRoute(role: nil, button: .left, count: 1, offersPress: false), .synthetic)
  }

  /// Menu key equivalents that are control characters are read by the name
  /// `key` spells them with.
  func testControlCharacterShortcutsAreReadByName() {
    XCTAssertEqual(
      MenuShortcutIndex.shortcut(rawModifiers: 2, commandCharacter: "\u{1b}", virtualKey: nil),
      KeyCombo(modifiers: [.cmd, .alt], key: "escape"))
    XCTAssertEqual(
      MenuShortcutIndex.shortcut(rawModifiers: 0, commandCharacter: "\u{f704}", virtualKey: nil),
      KeyCombo(modifiers: [.cmd], key: "f1"))
    XCTAssertEqual(
      MenuShortcutIndex.shortcut(rawModifiers: 8, commandCharacter: "S", virtualKey: nil),
      KeyCombo(modifiers: [], key: "s"))
  }

  func testPixelTargetsRejectNegativeAndFractionalCoordinates() throws {
    for input in [#"{"x":-1,"y":0}"#, #"{"x":1.5,"y":0}"#] {
      XCTAssertThrowsError(try JSONCoding.decoder.decode(ActionTarget.self, from: Data(input.utf8)))
    }
    _ = try JSONCoding.decoder.decode(ActionTarget.self, from: Data(#"{"x":0,"y":0}"#.utf8))
  }

  func testThreadTitleIsRequiredNullableAndBounded() throws {
    for title in ["null", "\"Shopping list\""] {
      let data = Data("{\"sessionId\":\"s\",\"apps\":[],\"threadTitle\":\(title)}".utf8)
      _ = try JSONCoding.decoder.decode(Wire.SessionOpenParams.self, from: data)
    }
    for input in [
      #"{"sessionId":"s","apps":[]}"#,
      "{\"sessionId\":\"s\",\"apps\":[],\"threadTitle\":\"\(String(repeating: "a", count: 241))\"}",
    ] {
      XCTAssertThrowsError(
        try JSONCoding.decoder.decode(
          Wire.SessionOpenParams.self,
          from: Data(input.utf8)))
    }
  }

  func testInstalledDefaultsAndBounds() throws {
    let params = try JSONCoding.decoder.decode(Wire.InstalledAppsParams.self, from: Data("{}".utf8))
    XCTAssertEqual(params.query, "")
    XCTAssertEqual(params.limit, 50)
    XCTAssertEqual(params.offset, 0)
    XCTAssertFalse(params.icons)
    for input in [#"{"limit":0}"#, #"{"limit":101}"#, #"{"offset":-1}"#] {
      XCTAssertThrowsError(
        try JSONCoding.decoder.decode(
          Wire.InstalledAppsParams.self,
          from: Data(input.utf8)))
    }
  }
}
