import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Virtual key codes for the `key` action.
///
/// Named keys come from the fixed table — their codes are positions on the
/// keyboard and do not move with the layout. Letters, digits and punctuation
/// are resolved through the *current* layout with `UCKeyTranslate`, so `cmd+z`
/// on a French keyboard presses the key that actually types `z`; the US table
/// is the backstop when the layout cannot be read.
@MainActor
public enum VirtualKeys {
  nonisolated static let named: [String: CGKeyCode] = [
    "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  nonisolated static let usLayout: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
  ]

  private static var cachedLayout: [Character: CGKeyCode] = [:]
  private static var cachedLayoutSource: String?

  /// What a key types, as AppKit spells it in `NSEvent.characters`.
  ///
  /// An event posted to a process never passes through the window server's
  /// keyboard translation, so a key event carries only the characters it is
  /// given. Without them a text field ignores Tab and Return, and a menu's
  /// key equivalent — matched on the characters — never fires. Shift is the
  /// one modifier AppKit keeps in `charactersIgnoringModifiers`, so it
  /// capitalises a letter here too.
  public nonisolated static func characters(for combo: KeyCombo) -> String? {
    if let named = namedCharacters[combo.key] { return named }
    guard combo.key.count == 1 else { return nil }
    return combo.modifiers.contains(.shift) ? combo.key.uppercased() : combo.key
  }

  nonisolated static let namedCharacters: [String: String] = {
    var characters: [String: String] = [
      "enter": "\r", "tab": "\t", "space": " ", "delete": "\u{7f}", "escape": "\u{1b}",
      "forwarddelete": "\u{f728}", "home": "\u{f729}", "end": "\u{f72b}",
      "pageup": "\u{f72c}", "pagedown": "\u{f72d}", "up": "\u{f700}", "down": "\u{f701}",
      "left": "\u{f702}", "right": "\u{f703}",
    ]
    for number in 1...12 {
      characters["f\(number)"] = String(UnicodeScalar(0xF703 + UInt32(number))!)
    }
    return characters
  }()

  public static func code(for combo: KeyCombo) -> CGKeyCode? {
    if let code = named[combo.key] { return code }
    guard let character = combo.key.first, combo.key.count == 1 else { return nil }
    if let code = currentLayout()[character] { return code }
    return usLayout[character]
  }

  /// One key that types part of a text.
  struct Press: Equatable, Sendable {
    let virtualKey: CGKeyCode
    let flags: CGEventFlags
    let characters: String
  }

  /// The keys that type `text` in the person's layout, one per character, the
  /// way Codex's helper types: a line break is Return and a tab is Tab, as
  /// when a person types them. A character no key types is sent as itself.
  static func presses(for text: String) -> [Press] {
    let layout = typingLayout()
    return text.map { character in
      // Return and Tab are the same keys in every layout, read or not.
      switch character {
      case "\r\n", "\n", "\r": return Press(virtualKey: 36, flags: [], characters: "\r")
      case "\t": return Press(virtualKey: 48, flags: [], characters: "\t")
      default: break
      }
      let units = Array(String(character).utf16)
      if units.count == 1, let press = layout[units[0]] { return press }
      return Press(virtualKey: 0, flags: [], characters: String(character))
    }
  }

  private static var cachedTyping: [UniChar: Press] = [:]
  private static var cachedTypingSource: String?

  /// Each character the layout types, with the first key and modifiers that
  /// type it — no modifier, then Shift, Option, Shift-Option, then the same
  /// with Control — keyed by its UTF-16 unit.
  static func typingLayout() -> [UniChar: Press] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return [:] }
    let identifier =
      (TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
        .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String }) ?? ""
    if identifier == cachedTypingSource, !cachedTyping.isEmpty { return cachedTyping }
    let layoutData = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    let candidates: [(carbon: UInt32, flags: CGEventFlags)] = [
      (0, []), (0x200, .maskShift), (0x800, .maskAlternate),
      (0xA00, [.maskShift, .maskAlternate]), (0x1000, .maskControl),
      (0x1200, [.maskControl, .maskShift]), (0x1800, [.maskControl, .maskAlternate]),
      (0x1A00, [.maskControl, .maskShift, .maskAlternate]),
    ]
    var map: [UniChar: Press] = [:]
    layoutData.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      let keyboardLayout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
      var characters = [UniChar](repeating: 0, count: 4)
      for candidate in candidates {
        for keyCode in CGKeyCode(0)..<CGKeyCode(128) {
          var deadKeyState: UInt32 = 0
          var length = 0
          let status = UCKeyTranslate(
            keyboardLayout, UInt16(keyCode), UInt16(kUCKeyActionDisplay),
            (candidate.carbon >> 8) & 0xFF, UInt32(LMGetKbdType()), 0, &deadKeyState,
            characters.count, &length, &characters)
          guard status == noErr, length > 0, map[characters[0]] == nil else { continue }
          map[characters[0]] = Press(
            virtualKey: keyCode, flags: candidate.flags,
            characters: String(utf16CodeUnits: characters, count: length))
        }
      }
    }
    cachedTyping = map
    cachedTypingSource = identifier
    return map
  }

  /// A character-to-keycode map for the layout the person is typing in.
  static func currentLayout() -> [Character: CGKeyCode] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else {
      return usLayout
    }
    let identifier =
      (TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
        .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String }) ?? ""
    if identifier == cachedLayoutSource, !cachedLayout.isEmpty { return cachedLayout }

    guard let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
      return usLayout
    }
    let layoutData = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    var map: [Character: CGKeyCode] = [:]
    layoutData.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      let keyboardLayout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
      var deadKeyState: UInt32 = 0
      var characters = [UniChar](repeating: 0, count: 8)
      var length = 0
      for keyCode in CGKeyCode(0)...CGKeyCode(127) {
        deadKeyState = 0
        let status = UCKeyTranslate(
          keyboardLayout,
          UInt16(keyCode),
          UInt16(kUCKeyActionDisplay),
          0,
          UInt32(LMGetKbdType()),
          UInt32(kUCKeyTranslateNoDeadKeysBit),
          &deadKeyState,
          characters.count,
          &length,
          &characters
        )
        guard status == noErr, length == 1 else { continue }
        let scalarValue = characters[0]
        guard let scalar = Unicode.Scalar(scalarValue),
          !CharacterSet.controlCharacters.contains(scalar)
        else { continue }
        let character = Character(scalar)
        // The first key that types a character wins, which is the one a person
        // would reach for.
        if map[character] == nil { map[character] = keyCode }
      }
    }
    guard !map.isEmpty else { return usLayout }
    cachedLayout = map
    cachedLayoutSource = identifier
    return map
  }
}
