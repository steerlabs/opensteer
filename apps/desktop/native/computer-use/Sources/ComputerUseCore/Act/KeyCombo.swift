import CoreGraphics
import Foundation

public enum KeyModifier: String, Sendable, CaseIterable, Comparable {
  case cmd
  case ctrl
  case alt
  case shift
  case fn

  public static func < (left: KeyModifier, right: KeyModifier) -> Bool {
    left.rawValue < right.rawValue
  }
}

/// `cmd+s`, `ctrl+shift+tab`, `f5` — what the `key` action accepts (§2).
public struct KeyCombo: Sendable, Equatable {
  public let modifiers: Set<KeyModifier>
  /// The normalised key name: a single lowercase letter or digit, or one of
  /// the named keys below.
  public let key: String

  public init(modifiers: Set<KeyModifier>, key: String) {
    self.modifiers = modifiers
    self.key = key
  }

  public var display: String {
    let glyphs: [(KeyModifier, String)] = [
      (.fn, "fn"), (.ctrl, "⌃"), (.alt, "⌥"), (.shift, "⇧"), (.cmd, "⌘"),
    ]
    let keys = [
      "enter": "↩", "tab": "⇥", "escape": "⎋", "space": "Space", "delete": "⌫",
      "forwarddelete": "⌦", "up": "↑", "down": "↓", "left": "←", "right": "→",
      "home": "↖", "end": "↘", "pageup": "⇞", "pagedown": "⇟",
    ]
    return glyphs.filter { modifiers.contains($0.0) }.map(\.1).joined()
      + (keys[key] ?? key.uppercased())
  }

  public var sortedModifiers: [KeyModifier] { modifiers.sorted() }
}

public enum KeyComboParser {
  private static let modifierAliases: [String: KeyModifier] = [
    "cmd": .cmd, "command": .cmd, "meta": .cmd, "super": .cmd,
    "ctrl": .ctrl, "control": .ctrl,
    "alt": .alt, "opt": .alt, "option": .alt,
    "shift": .shift,
    "fn": .fn, "function": .fn,
  ]

  /// Aliases collapse to one spelling so the virtual-key table and the menu
  /// matcher only ever see one name for a key.
  private static let keyAliases: [String: String] = [
    "return": "enter", "esc": "escape", "backspace": "delete", "del": "delete",
    "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
    "pgup": "pageup", "pgdn": "pagedown", "pagedn": "pagedown",
    "spacebar": "space",
  ]

  public static let namedKeys: Set<String> = {
    var names: Set<String> = [
      "enter", "tab", "escape", "space", "delete", "forwarddelete",
      "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
    ]
    for number in 1...12 { names.insert("f\(number)") }
    return names
  }()

  public static func parse(_ raw: String) throws -> KeyCombo {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else {
      throw HelperError(.unsupported, "Name a key to press, such as cmd+s.")
    }

    var components = trimmed.components(separatedBy: "+")
    // `cmd++` means the plus key with a Command modifier; the split leaves an
    // empty tail for it.
    if components.count > 1, components.last == "" {
      components.removeLast()
      components[components.count - 1] = "+"
    }
    guard let last = components.popLast(), !last.isEmpty else {
      throw HelperError(.unsupported, "\(quoted(raw)) does not name a key to press.")
    }

    var modifiers: Set<KeyModifier> = []
    for component in components {
      guard let modifier = modifierAliases[component] else {
        throw HelperError(
          .unsupported,
          "\(quoted(component)) is not a modifier; use cmd, ctrl, alt, shift or fn."
        )
      }
      modifiers.insert(modifier)
    }

    let key = keyAliases[last] ?? last
    if namedKeys.contains(key) { return KeyCombo(modifiers: modifiers, key: key) }
    if key.count == 1, let character = key.first,
      character.isLetter || character.isNumber || character.isPunctuation
        || character.isSymbol
    {
      return KeyCombo(modifiers: modifiers, key: key)
    }
    throw HelperError(.unsupported, "\(quoted(last)) is not a key this Mac can press.")
  }

  private static func quoted(_ value: String) -> String { "\u{201C}\(value)\u{201D}" }
}

extension KeyCombo {
  /// The event flags the combo's modifiers hold down.
  var flags: CGEventFlags {
    var flags: CGEventFlags = []
    if modifiers.contains(.cmd) { flags.insert(.maskCommand) }
    if modifiers.contains(.ctrl) { flags.insert(.maskControl) }
    if modifiers.contains(.alt) { flags.insert(.maskAlternate) }
    if modifiers.contains(.shift) { flags.insert(.maskShift) }
    if modifiers.contains(.fn) { flags.insert(.maskSecondaryFn) }
    return flags
  }
}
