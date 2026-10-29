import XCTest

@testable import ComputerUseCore

final class TextChunkerTests: XCTestCase {
  func testEmptyTextIsNoEvents() {
    XCTAssertTrue(TextChunker.chunks("").isEmpty)
  }

  func testShortTextIsOneChunk() {
    XCTAssertEqual(TextChunker.chunks("hello"), ["hello"])
  }

  func testChunksAreAtMostTwentyUTF16Units() {
    let text = String(repeating: "a", count: 55)
    let chunks = TextChunker.chunks(text)
    XCTAssertEqual(chunks.count, 3)
    XCTAssertEqual(chunks.map(\.utf16.count), [20, 20, 15])
    XCTAssertEqual(chunks.joined(), text)
  }

  /// An emoji is two UTF-16 units; it must never be cut between them.
  func testASurrogatePairIsNeverSplit() {
    let text = String(repeating: "a", count: 19) + "😀" + "b"
    let chunks = TextChunker.chunks(text)
    XCTAssertEqual(chunks.joined(), text)
    for chunk in chunks {
      XCTAssertLessThanOrEqual(chunk.utf16.count, TextChunker.maxUTF16UnitsPerChunk)
      XCTAssertEqual(String(chunk.unicodeScalars.map(Character.init)).isEmpty, chunk.isEmpty)
    }
    XCTAssertTrue(chunks.contains { $0.contains("😀") })
  }

  func testACombiningSequenceStaysWhole() {
    // A family emoji is one Character made of eleven UTF-16 units.
    let family = "👨‍👩‍👧‍👦"
    XCTAssertGreaterThan(family.utf16.count, 1)
    let chunks = TextChunker.chunks("hi " + family + " there")
    XCTAssertEqual(chunks.joined(), "hi " + family + " there")
    XCTAssertTrue(chunks.contains { $0.contains(family) })
  }

  /// One character too long for a whole chunk still goes in an event of its
  /// own rather than being cut in half.
  func testACharacterLongerThanTheLimitIsNotSplit() {
    let family = "👨‍👩‍👧‍👦"
    let chunks = TextChunker.chunks("ab" + family + "cd", limit: 4)
    XCTAssertEqual(chunks, ["ab", family, "cd"])
  }

  func testNewlinesAreCarriedThroughUnchanged() {
    XCTAssertEqual(TextChunker.chunks("a\nb"), ["a\nb"])
  }
}
