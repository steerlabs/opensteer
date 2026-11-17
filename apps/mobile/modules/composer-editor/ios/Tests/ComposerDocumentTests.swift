import Foundation
import XCTest
@testable import ComposerEditorCore

final class ComposerDocumentTests: XCTestCase {
  private let link = "[Fix login](opensteer:thr_12345678-1234-4234-8234-123456789abc)"

  private func document(_ prefix: String, _ suffix: String) -> (String, [ComposerSegment]) {
    let source = prefix + link + suffix
    let start = (prefix as NSString).length
    let atom = ComposerAtom(start: start, end: start + (link as NSString).length, source: link)
    return (source, ComposerDocument.segments(source: source, atoms: [atom]))
  }

  func testAtomCollapsesToOneCharacterAroundEmoji() {
    let (_, segments) = document("🦊 see ", " now")
    XCTAssertEqual(segments, [.text("🦊 see "), .atom(link), .text(" now")])
    // "🦊 see " is 7 UTF-16 units; the chip is display offset 7, one character wide.
    XCTAssertEqual(ComposerDocument.sourceOffset(displayOffset: 7, segments: segments), 7)
    XCTAssertEqual(
      ComposerDocument.sourceOffset(displayOffset: 8, segments: segments),
      7 + (link as NSString).length
    )
    XCTAssertEqual(
      ComposerDocument.displayOffset(sourceOffset: 7 + (link as NSString).length + 2, segments: segments),
      10
    )
  }

  func testSourceOffsetInsideAtomLandsAfterIt() {
    let (_, segments) = document("a ", "")
    XCTAssertEqual(ComposerDocument.displayOffset(sourceOffset: 5, segments: segments), 3)
    XCTAssertEqual(ComposerDocument.displayOffset(sourceOffset: 2, segments: segments), 2)
  }

  func testCopyingAChipYieldsItsWholeMarkdownSource() {
    let (source, segments) = document("x ", " y")
    XCTAssertEqual(ComposerDocument.source(segments: segments, displayRange: NSRange(location: 2, length: 1)), link)
    XCTAssertEqual(
      ComposerDocument.source(segments: segments, displayRange: NSRange(location: 0, length: 5)),
      source
    )
    XCTAssertEqual(ComposerDocument.source(segments: segments, displayRange: NSRange(location: 3, length: 2)), " y")
  }

  func testStaleOrOverlappingAtomsStayText() {
    let source = "a " + link
    let stale = ComposerAtom(start: 1, end: 1 + (link as NSString).length, source: link)
    XCTAssertEqual(ComposerDocument.segments(source: source, atoms: [stale]), [.text(source)])
    let real = ComposerAtom(start: 2, end: 2 + (link as NSString).length, source: link)
    XCTAssertEqual(ComposerDocument.validAtoms([real, real], in: source), [real])
  }

  func testCanonicallyEquivalentSourceIsNotTheSameAtom() {
    // "é" precomposed and decomposed compare equal as Strings but differ in UTF-16 length.
    let composed = "[caf\u{e9}](opensteer:thr_12345678-1234-4234-8234-123456789abc)"
    let decomposed = "[cafe\u{301}](opensteer:thr_12345678-1234-4234-8234-123456789abc)"
    let atom = ComposerAtom(start: 0, end: (decomposed as NSString).length, source: decomposed)
    XCTAssertEqual(ComposerDocument.validAtoms([atom], in: composed), [])
  }
}
