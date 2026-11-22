import Foundation

// tests/remote-input-port.ts ports RemoteInputGate.swift, RemoteInputTextView.swift and
// RemoteInputEdits.swift to TypeScript for the JavaScript adapter's tests: change it with them.
// Tests/Cases/remote-input-edits.json holds RemoteInputEdits' cases, run against both.

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
  /// A place named in the text as it stood after `revision` edits, in UTF-16 offsets; `order`
  /// counts the places named, so a later one can tell it was named after an earlier one.
  /// A caret move: the distance the person moved the caret, from the caret it started at, each
  /// move a report stands for in order. It is resolved once, at its turn (when everything typed
  /// before it has been applied), into a place in the text as it then stands; until then it
  /// resolves provisionally the same way.
  final class CaretMove {
    let from: Place
    var distances: [Int]
    var resolved: Place?
    init(from: Place, distances: [Int]) {
      self.from = from
      self.distances = distances
    }
  }
  struct Place: Equatable {
    let revision: Int
    let order: Int
    let start: Int
    let end: Int
    /// The mirror it was named in (`generation`).
    var generation = 0
    /// A caret move: where it resolves (the view's moves), not this place's offsets.
    var move: CaretMove?
    static func == (a: Place, b: Place) -> Bool {
      a.revision == b.revision && a.order == b.order && a.start == b.start && a.end == b.end
        && a.generation == b.generation && a.move === b.move
    }
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
  private var named = 0
  /// The selection UIKit or the person last chose, as named.
  private var chosen: Place?
  /// The mirror's generation: every clear of the field begins a new one.
  private var generation = 0
  /// The places a new context fenced out: every one named before the call that changed it.
  private var fence = 0
  /// How many places have been named: a fence is drawn at the call that changes the context.
  var order: Int { named }

  /// A place in the text as it stands now.
  mutating func place(_ start: Int, _ end: Int) -> Place {
    named += 1
    return Place(revision: revision, order: named, start: start, end: end, generation: generation)
  }
  /// The field was cleared: a new mirror.
  mutating func clear() { generation += 1 }
  /// A new context: every place named so far is fenced out, from this call on.
  mutating func fenceNow() { fence = named }
  /// Named in an older mirror: it names nothing in this one.
  func stale(_ place: Place) -> Bool { place.generation < generation }
  /// Named under an older context: dropped with it, whatever it is.
  func fenced(_ place: Place) -> Bool { place.order <= fence }

  /// UIKit or the person chose this selection. The native selection is whatever they last chose:
  /// an edit named before the choice and applied after it must not leave the caret where the edit
  /// put it.
  mutating func choose(_ selection: Place) { chosen = selection }
  /// The selection chosen after `place` was named, if there is one.
  func chosen(after place: Place) -> Place? {
    guard let chosen, chosen.order > place.order, !stale(chosen) else { return nil }
    return chosen
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
        // A caret stays on the side where the person put it: at the start of a range then
        // replaced, before the replacement.
        if caret {
          if !(edit.removed > 0 && start == edit.start) { start = Self.move(start, over: edit, before: false) }
          end = start
          continue
        }
        start = Self.move(start, over: edit, before: false)
        end = Self.move(end, over: edit, before: true)
      }
    }
    start = min(max(0, start), length)
    end = min(max(start, end), length)
    return (start, end)
  }

  /// Whether an empty replacement UIKit asked the delegate for is a Backspace: the selection is a
  /// caret and the range named is exactly the one composed character before it. A Backspace
  /// deletes the character before the caret, wherever the caret has moved by its turn; it never
  /// deletes the text it named, which may by then be a character typed before the typo the person
  /// meant to erase. A longer deletion (a word) is the text it named, carried: the count UIKit
  /// named belongs to the text it named.
  static func isBackspace(named range: NSRange, selection: NSRange, in text: String) -> Bool {
    selection.length == 0 && range.length > 0 && range.location + range.length == selection.location
      && composedCount(in: text, range: range) == 1
      && (text as NSString).rangeOfComposedCharacterSequences(for: range) == range
  }
  /// Whether an empty replacement deletes the selection itself.
  static func deletesSelection(named range: NSRange, selection: NSRange) -> Bool {
    selection.length > 0 && range == selection
  }
  /// How many composed characters `range` of `text` holds; none for a range outside the text.
  static func composedCount(in text: String, range: NSRange) -> Int {
    let string = text as NSString
    // Compared without adding, so a huge location cannot overflow.
    guard range.location >= 0, range.length >= 0, range.location <= string.length, range.length <= string.length - range.location else { return 0 }
    var count = 0
    string.enumerateSubstrings(in: range, options: [.byComposedCharacterSequences, .substringNotRequired]) { _, _, _, _ in count += 1 }
    return count
  }
  /// The offset `distance` composed characters from `from` in `text`, held inside it: a move that
  /// would pass either end stops there.
  static func advance(_ text: String, from: Int, by distance: Int) -> Int {
    let string = text as NSString
    var boundaries = [0]
    string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: [.byComposedCharacterSequences, .substringNotRequired]) { _, range, _, _ in
      boundaries.append(NSMaxRange(range))
    }
    let index = boundaries.firstIndex { $0 >= from } ?? boundaries.count - 1
    return boundaries[min(max(0, index + distance), boundaries.count - 1)]
  }
  /// What a Backspace pressed at `caret` deletes: the composed character before where the caret
  /// now stands, or nothing at the start of the text.
  func backspace(_ caret: Place, in text: String) -> NSRange {
    let at = current(caret, length: text.utf16.count).start
    guard at > 0 else { return NSRange(location: at, length: 0) }
    return (text as NSString).rangeOfComposedCharacterSequence(at: at - 1)
  }
  /// Where deleteBackward's deletion began: the selection it deleted, or as much just before the
  /// caret (inside a composition too, where the marked text is not what went).
  /// With marked text the deletion is before a caret inside it, or at its end wherever else the
  /// caret was moved while it waited: the person's caret is not where an input method's Backspace
  /// deletes. What a real input method does with a caret inside its marked text is a walk item.
  static func deletedStart(selection: NSRange, marked: NSRange? = nil, removed: Int) -> Int {
    if let marked {
      // A caret inside the marked text deletes before itself; anywhere else (moved away while
      // the deletion waited) the deletion is at the marked text's end.
      let inside = selection.length == 0 && selection.location > marked.location && selection.location <= marked.location + marked.length
      return max(marked.location, (inside ? selection.location : marked.location + marked.length) - removed)
    }
    return selection.length > 0 ? selection.location : max(0, selection.location - removed)
  }

  /// Where the deletion of a selection UIKit named is now, in `text`. Pressed twice while the
  /// first waits, both name the selection; once the first has deleted it, the place is empty and
  /// the second deletes the character before where it now stands, as a second press would.
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
    chosen = nil
  }

  /// `before`: an edit that begins exactly at `offset` lies after it (the end of a range).
  private static func move(_ offset: Int, over edit: Edit, before: Bool) -> Int {
    if offset < edit.start || (before && offset == edit.start) { return offset }
    if offset >= edit.start + edit.removed { return offset - edit.removed + edit.inserted }
    return edit.start + edit.inserted
  }
}
