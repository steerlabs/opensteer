import AppKit
import CoreGraphics
import Darwin
import Foundation
import Security
import XCTest

@testable import ComputerUseCore

final class NativeSafetyRegressionTests: XCTestCase {

  @MainActor
  func testBackgroundMouseEventCarriesNoCommandModifier() throws {
    guard PrivateAPI.backgroundPointerDeliveryAvailable else {
      throw XCTSkip("This macOS build has no targeted background pointer route.")
    }
    let event = try SyntheticEvents.makeMouseEvent(
      type: .leftMouseDown,
      target: EventTarget(
        processIdentifier: getpid(), windowID: 123, screenPoint: CGPoint(x: 150, y: 200),
        windowPoint: CGPoint(x: 50, y: 60)),
      button: .left,
      clickCount: 1,
      pressure: 1
    )
    XCTAssertFalse(event.flags.contains(.maskCommand))
    XCTAssertEqual(event.getIntegerValueField(.eventTargetUnixProcessID), Int64(getpid()))
    XCTAssertEqual(event.getIntegerValueField(SyntheticEvents.windowNumberField), 123)
  }

  /// A keystroke names its window as a click does: an app that is not
  /// frontmost has no key window to deliver an unnamed one to. Typed text
  /// carries a real key for its first character rather than `A` for all.
  @MainActor
  func testBackgroundKeystrokesNameTheirProcessAndWindow() throws {
    guard PrivateAPI.postToPid != nil else {
      throw XCTSkip("This macOS build has no process-addressed event route.")
    }
    let target = EventTarget(processIdentifier: getpid(), windowID: 321)
    // A shortcut's modifiers ride on the key, between a flags change to them
    // and one back to what is held; there are no modifier key events.
    let shortcut = try SyntheticEvents.keyEvents(
      virtualKey: 17, flags: .maskCommand, characters: "t", target: target)
    XCTAssertEqual(shortcut.map(\.type), [.flagsChanged, .keyDown, .keyUp, .flagsChanged])
    XCTAssertTrue(shortcut[0].flags.contains(.maskCommand))
    XCTAssertFalse(shortcut[3].flags.contains(.maskCommand))
    for event in shortcut {
      XCTAssertEqual(event.getIntegerValueField(.eventTargetUnixProcessID), Int64(getpid()))
      XCTAssertEqual(event.getIntegerValueField(SyntheticEvents.windowNumberField), 321)
    }
    XCTAssertEqual(CGKeyCode(shortcut[1].getIntegerValueField(.keyboardEventKeycode)), 17)

    // A key carries what it types, which an event posted to a process is
    // never given by the window server: Tab is a tab, Shift-S a capital S.
    let tab = try SyntheticEvents.keyEvents(
      virtualKey: 48, flags: [],
      characters: VirtualKeys.characters(for: KeyCombo(modifiers: [], key: "tab")),
      target: target)
    XCTAssertEqual(tab.map(\.type), [.keyDown, .keyUp])
    XCTAssertEqual(Self.characters(of: tab[0]), "\t")
    XCTAssertEqual(VirtualKeys.characters(for: KeyCombo(modifiers: [.cmd, .shift], key: "s")), "S")
    XCTAssertEqual(VirtualKeys.characters(for: KeyCombo(modifiers: [.cmd], key: "s")), "s")
    XCTAssertEqual(VirtualKeys.characters(for: KeyCombo(modifiers: [], key: "f1")), "\u{f704}")

    // Text goes key by key, each key the one the layout types it with.
    let text = try VirtualKeys.presses(for: "hI").map {
      try SyntheticEvents.keyEvents(
        virtualKey: $0.virtualKey, flags: $0.flags, characters: $0.characters, target: target)
    }
    XCTAssertEqual(text.count, 2)
    XCTAssertEqual(Self.characters(of: text[0][0]), "h")
    XCTAssertEqual(
      CGKeyCode(text[0][0].getIntegerValueField(.keyboardEventKeycode)),
      VirtualKeys.code(for: KeyCombo(modifiers: [], key: "h")))
    XCTAssertEqual(text[1].map(\.type), [.flagsChanged, .keyDown, .keyUp, .flagsChanged])
    XCTAssertTrue(text[1][1].flags.contains(.maskShift))
    XCTAssertEqual(Self.characters(of: text[1][1]), "I")

    // Saved login text is a unicode payload alone, with no modifier.
    let saved = try SyntheticEvents.unicodeEvents("Hello", target: target)
    XCTAssertEqual(saved.map(\.type), [.keyDown, .keyUp])
    XCTAssertEqual(Self.characters(of: saved[0]), "Hello")
    XCTAssertTrue(saved[0].flags.isEmpty)
    XCTAssertEqual(saved[0].getIntegerValueField(SyntheticEvents.windowNumberField), 321)
  }

  private static func characters(of event: CGEvent) -> String {
    var length = 0
    var units = [UniChar](repeating: 0, count: 32)
    event.keyboardGetUnicodeString(
      maxStringLength: units.count, actualStringLength: &length, unicodeString: &units)
    return String(utf16CodeUnits: units, count: length)
  }





}
