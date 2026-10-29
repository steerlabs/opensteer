import XCTest

@testable import ComputerUseCore

/// Every way reading a Messages `attributedBody` can go wrong, from the
/// archives macOS itself wrote: a body it cannot read costs that body, never
/// the row, and no bytes make it throw or read past the end.
final class TypedStreamTests: XCTestCase {
  func testReadsTheArchivesMacOSItselfProduced() {
    XCTAssertEqual(TypedStream.text(MessagesFixture.appleArchive("ascii")), "Lunch at one?")
    XCTAssertEqual(TypedStream.text(MessagesFixture.appleArchive("emoji")), "Café ☕️ — 😀 ok")
    XCTAssertEqual(
      TypedStream.text(MessagesFixture.appleArchive("long")),
      String(repeating: "vacation photos ", count: 12))
    XCTAssertEqual(TypedStream.text(MessagesFixture.appleArchive("mutable")), "Edited reply")
  }

  /// The fixture builder is held to Apple's own bytes, so a fixture is a
  /// real archive rather than a shape two halves of this code agreed on.
  func testTheFixtureBuilderAgreesWithNSArchiverByteForByte() {
    XCTAssertEqual(MessagesFixture.attributedBody("Lunch at one?"), MessagesFixture.appleArchive("ascii"))
    XCTAssertEqual(MessagesFixture.attributedBody("Café ☕️ — 😀 ok"), MessagesFixture.appleArchive("emoji"))
    XCTAssertEqual(
      MessagesFixture.attributedBody(String(repeating: "vacation photos ", count: 12)),
      MessagesFixture.appleArchive("long"))
    XCTAssertEqual(
      MessagesFixture.attributedBody("Edited reply", mutable: true),
      MessagesFixture.appleArchive("mutable"))
  }

  func testReadsTheFourByteLengthAndTheEmptyString() {
    let long = String(repeating: "a", count: 70_000)
    XCTAssertEqual(TypedStream.text(MessagesFixture.attributedBody(long)), long)
    XCTAssertEqual(TypedStream.text(MessagesFixture.attributedBody("")), "")
  }

  func testRefusesEverythingThatIsNotThePayloadItKnows() {
    let ascii = MessagesFixture.appleArchive("ascii")
    XCTAssertNil(TypedStream.text([]))
    XCTAssertNil(TypedStream.text(Array("not an archive at all".utf8)))
    XCTAssertNil(TypedStream.text([0x05] + ascii.dropFirst()))
    XCTAssertNil(TypedStream.text(MessagesFixture.undecodableBody))
    // A 64-bit length, which no message body has.
    let marker = MessagesFixture.attributedBody("x")
    let at = marker.indices.first { marker[$0] == 0x84 && marker[$0 + 1] == 0x01 && marker[$0 + 2] == 0x2b }!
    var wide = marker
    wide[at + 3] = 0x83
    XCTAssertNil(TypedStream.text(wide))
  }

  func testStopsAtTheEndOfTheBufferWhenTheLengthOverrunsIt() {
    let whole = MessagesFixture.attributedBody("Lunch at one?")
    let at = whole.indices.first { whole[$0] == 0x84 && whole[$0 + 1] == 0x01 && whole[$0 + 2] == 0x2b }!
    XCTAssertNil(TypedStream.text(Array(whole[..<(at + 8)])))
  }

  func testNeverThrowsAndNeverReadsPastTheEndWhateverTheBytesAre() {
    var generator = SystemRandomNumberGenerator()
    let seeds = [MessagesFixture.appleArchive("ascii"), MessagesFixture.appleArchive("long")]
    for _ in 0..<2_000 {
      var bytes = seeds[Int.random(in: 0..<2, using: &generator)]
      for _ in 0..<Int.random(in: 1...6, using: &generator) {
        bytes[Int.random(in: 0..<bytes.count, using: &generator)] = UInt8.random(
          in: 0...255, using: &generator)
      }
      bytes = Array(bytes.prefix(Int.random(in: 0...bytes.count, using: &generator)))
      _ = TypedStream.text(bytes)
    }
  }
}
