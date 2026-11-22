import Foundation

// tests/typing-order.interaction.test.tsx ports RemoteInputGate.swift, RemoteInputTextView.swift
// and RemoteInputEdits.swift to TypeScript to test the JavaScript adapter: change it with them.

/// Where UIKit placed a native edit, carried over the edits applied after it placed it.
///
/// The gate holds every native edit until JavaScript has answered the one before it, but UIKit
/// names an edit's place (the selection it types over, or the range it replaces) in the text as it
/// stands when UIKit calls: without the edits still waiting their turn. Typed fast, "1" was placed
/// at the start of an empty text while "0" waited, and went in before it once "0" was applied.
///
/// So each place keeps the number of edits applied when it was named, and is moved over every edit
/// applied since: a keystroke lands where it was typed, after everything typed before it, however
/// late its turn comes. An edit that replaced the text around a place leaves it just after the
/// replacement, as typing over a selection twice leaves the second character after the first. A
/// caret moves past text inserted where it stands; a range keeps an edit that begins at its end
/// outside it, whatever that edit removed, so a word named for autocorrect is still that word after
/// the space beside it was typed over.
struct RemoteInputEdits {
  /// A place named in the text as it stood after `revision` edits, in UTF-16 offsets.
  struct Place: Equatable {
    let revision: Int
    let start: Int
    let end: Int
  }
  private struct Edit {
    let start: Int
    let removed: Int
    let inserted: Int
  }
  private var edits: [Edit] = []
  /// How many edits were applied before `edits[0]`.
  private var base = 0
  /// How many edits have been applied.
  var revision: Int { base + edits.count }

  /// A place in the text as it stands now.
  func place(_ start: Int, _ end: Int) -> Place {
    Place(revision: revision, start: start, end: end)
  }

  /// The `removed` code units from `start` became `inserted` code units.
  mutating func record(start: Int, removed: Int, inserted: Int) {
    edits.append(Edit(start: max(0, start), removed: max(0, removed), inserted: max(0, inserted)))
  }

  /// Where `place` is now, inside a text `length` code units long.
  func current(_ place: Place, length: Int) -> (start: Int, end: Int) {
    var start = place.start
    var end = place.end
    let caret = start == end
    if place.revision >= base {
      for edit in edits.dropFirst(place.revision - base) {
        start = Self.move(start, over: edit, before: false)
        end = Self.move(end, over: edit, before: !caret)
      }
    }
    start = min(max(0, start), length)
    end = min(max(start, end), length)
    return (start, end)
  }

  /// Where a deletion UIKit named is now, in `text`. A backspace pressed while the one before it
  /// waits names the same character before the caret; once the earlier one has deleted it, the
  /// place is empty and this one deletes the character before where it now stands. Five presses
  /// are five deletions.
  func deletion(_ place: Place, in text: String) -> NSRange {
    let current = current(place, length: text.utf16.count)
    if current.end > current.start || place.end == place.start { return NSRange(location: current.start, length: current.end - current.start) }
    guard current.start > 0 else { return NSRange(location: 0, length: 0) }
    return (text as NSString).rangeOfComposedCharacterSequence(at: current.start - 1)
  }

  /// Nothing placed before now is still waiting for its turn: the edits so far move nothing.
  mutating func settle() {
    base = revision
    edits.removeAll()
  }

  /// `before`: an edit that begins exactly at `offset` lies after it (the end of a range).
  private static func move(_ offset: Int, over edit: Edit, before: Bool) -> Int {
    if offset < edit.start || (before && offset == edit.start) { return offset }
    if offset >= edit.start + edit.removed { return offset - edit.removed + edit.inserted }
    return edit.start + edit.inserted
  }
}
