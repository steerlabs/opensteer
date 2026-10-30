import XCTest

@testable import OpensteerDictation

final class WireTests: XCTestCase {
  struct Fixture: Codable {
    let events: [DictationEvent]
    let availability: [DictationAvailability]
  }
  func testWireFixture() throws {
    var payloads: [DictationEvent.Payload] = [
      .downloading(nil), .downloading(0.5), .listening,
      .text(finalized: ["Hello", "😀"], volatile: [" world"]), .level(0.7),
      .ended(.completed, nil), .ended(.failed, .recognitionFailed),
    ]
    payloads += DictationEndReason.allCases.filter { $0 != .failed }.map { .ended($0, nil) }
    payloads += DictationError.allCases.map { .ended(.failed, $0) }
    let availability =
      DictationUnavailableReason.allCases.map { DictationAvailability.unavailable($0) }
      + DictationModel.allCases.flatMap { model in
        DictationMicrophone.allCases.map { microphone in
          DictationAvailability.available(
            locale: "en-US", languageName: "English", model: model, microphone: microphone)
        }
      }
    let fixture = Fixture(
      events: payloads.enumerated().map {
        DictationEvent(
          session: "00000000-0000-4000-8000-000000000001", seq: $0.offset + 1, payload: $0.element)
      }, availability: availability)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(fixture) + Data([10])
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Fixtures/dictation-wire.json")
    if ProcessInfo.processInfo.environment["UPDATE_DICTATION_FIXTURE"] == "1" {
      try data.write(to: path)
    }
    XCTAssertEqual(try Data(contentsOf: path), data)
    XCTAssertEqual(try JSONDecoder().decode(Fixture.self, from: data).events, fixture.events)
  }
}
