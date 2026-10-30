import XCTest
@testable import OpensteerDictation

final class WireTests: XCTestCase {
  struct Fixture: Codable { let events: [DictationEvent]; let availability: [DictationAvailability] }
  func testWireFixture() throws {
    let payloads: [DictationEvent.Payload] = [.downloading(nil), .downloading(0.5), .listening,
      .text(finalized: ["Hello", "😀"], volatile: [" world"]), .level(0.7),
      .ended(.completed, nil), .ended(.failed, .recognitionFailed)]
    let fixture = Fixture(events: payloads.enumerated().map {
      DictationEvent(session: "00000000-0000-4000-8000-000000000001", seq: $0.offset + 1, payload: $0.element)
    }, availability: [.unavailable(.os), .available(locale: "en-US", languageName: "English", model: .installed, microphone: .granted)])
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(fixture) + Data([10])
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/dictation-wire.json")
    if ProcessInfo.processInfo.environment["UPDATE_DICTATION_FIXTURE"] == "1" { try data.write(to: path) }
    XCTAssertEqual(try Data(contentsOf: path), data)
    XCTAssertEqual(try JSONDecoder().decode(Fixture.self, from: data).events, fixture.events)
  }
}
