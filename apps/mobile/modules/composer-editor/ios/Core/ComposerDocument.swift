// Source/display mapping ported from T3 Code's T3ComposerEditorView.swift
// (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
import Foundation

/// A Markdown reference shown as one chip, at UTF-16 offsets into the source.
public struct ComposerAtom: Equatable {
  public let start: Int
  public let end: Int
  public let source: String

  public init(start: Int, end: Int, source: String) {
    self.start = start
    self.end = end
    self.source = source
  }
}

/// What the editor displays: plain runs, and atoms that each occupy one character.
public enum ComposerSegment: Equatable {
  case text(String)
  case atom(String)

  var displayLength: Int {
    switch self {
    case .text(let text): return (text as NSString).length
    case .atom: return 1
    }
  }

  var sourceLength: Int {
    switch self {
    case .text(let text), .atom(let text): return (text as NSString).length
    }
  }
}

/// The plain-Markdown source behind an editor that collapses references to chips.
public enum ComposerDocument {
  /// The atoms that still match the source, in order and without overlap.
  public static func validAtoms(_ atoms: [ComposerAtom], in source: String) -> [ComposerAtom] {
    let text = source as NSString
    var cursor = 0
    return atoms.filter { atom in
      guard atom.start >= cursor, atom.end > atom.start, atom.end <= text.length,
            text.substring(with: NSRange(location: atom.start, length: atom.end - atom.start))
              .utf16.elementsEqual(atom.source.utf16) else { return false }
      cursor = atom.end
      return true
    }
  }

  public static func segments(source: String, atoms: [ComposerAtom]) -> [ComposerSegment] {
    let text = source as NSString
    var result: [ComposerSegment] = []
    var cursor = 0
    for atom in validAtoms(atoms, in: source) {
      if atom.start > cursor {
        result.append(.text(text.substring(with: NSRange(location: cursor, length: atom.start - cursor))))
      }
      result.append(.atom(atom.source))
      cursor = atom.end
    }
    if cursor < text.length {
      result.append(.text(text.substring(from: cursor)))
    }
    return result
  }

  public static func sourceOffset(displayOffset: Int, segments: [ComposerSegment]) -> Int {
    var remaining = max(0, displayOffset)
    var offset = 0
    for segment in segments where remaining > 0 {
      if case .text(let text) = segment {
        let taken = min(remaining, (text as NSString).length)
        offset += taken
        remaining -= taken
      } else {
        offset += segment.sourceLength
        remaining -= 1
      }
    }
    return offset
  }

  /// A source offset inside an atom maps to just after it, so a caret never splits one.
  public static func displayOffset(sourceOffset: Int, segments: [ComposerSegment]) -> Int {
    var remaining = max(0, sourceOffset)
    var offset = 0
    for segment in segments where remaining > 0 {
      if case .text(let text) = segment {
        let taken = min(remaining, (text as NSString).length)
        offset += taken
        remaining -= taken
      } else {
        offset += 1
        remaining = max(0, remaining - segment.sourceLength)
      }
    }
    return offset
  }

  /// The source for a display range; a chip copies or cuts as its whole Markdown link.
  public static func source(segments: [ComposerSegment], displayRange: NSRange) -> String {
    var result = ""
    var position = 0
    let end = displayRange.location + displayRange.length
    for segment in segments {
      let next = position + segment.displayLength
      defer { position = next }
      let from = max(position, displayRange.location)
      let to = min(next, end)
      guard from < to else { continue }
      switch segment {
      case .atom(let source):
        result += source
      case .text(let text):
        result += (text as NSString).substring(with: NSRange(location: from - position, length: to - from))
      }
    }
    return result
  }
}
