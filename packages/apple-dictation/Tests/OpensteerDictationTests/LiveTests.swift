import XCTest
import AVFoundation
@testable import OpensteerDictation

private final class FileCapture: AudioCapture, @unchecked Sendable {
  let url: URL
  init(_ url: URL) { self.url = url }
  func permission() -> DictationMicrophone { .granted }
  func restricted() -> Bool { false }
  func requestPermission() async -> Bool { true }
  func start(queue: AudioQueue, changed: @escaping @Sendable (DictationEndReason) -> Void) throws {
    let file = try AVAudioFile(forReading: url)
    while file.framePosition < file.length {
      let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1024)!
      try file.read(into: buffer); queue.append(buffer)
    }
  }
  func stop() {}
}
final class LiveTests: XCTestCase {
  func testGeneratedSpeechThroughRealAnalyzer() async throws {
    guard ProcessInfo.processInfo.environment["OPENSTEER_DICTATION_LIVE_TESTS"] == "1" else { throw XCTSkip("Opt in with OPENSTEER_DICTATION_LIVE_TESTS=1; never uses a microphone") }
    guard #available(macOS 26, iOS 26, *) else { throw XCTSkip("SpeechAnalyzer requires OS 26") }
    #if os(macOS)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".aiff")
    defer { try? FileManager.default.removeItem(at: url) }
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    process.arguments = ["-o", url.path, "The bright orange bicycle waits beside the garden."]
    try process.run(); process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
    let events = Events()
    let service = DictationService(emit: { events.append($0) }, capture: { FileCapture(url) }, recognizer: { AppleRecognizer() })
    let availability = await service.availability()
    guard case let .available(_, _, model, _) = availability else { XCTFail("Unavailable: \(availability)"); return }
    let downloadID = "00000000-0000-4000-8000-000000000003"
    if model == .download {
      try await service.download(session: downloadID)
      let deadline = ContinuousClock.now + .seconds(180)
      while !events.ended.contains(where: { $0.session == downloadID }) {
        guard ContinuousClock.now < deadline else { await service.cancel(session: downloadID); XCTFail("Model installation timed out"); return }
        try await Task.sleep(for: .milliseconds(100))
      }
      guard events.ended.last?.payload == .ended(.completed, nil) else { XCTFail("Model installation failed: \(events.ended)"); return }
    }
    let session = "00000000-0000-4000-8000-000000000004"
    try await service.start(session: session)
    let deadline = ContinuousClock.now + .seconds(30)
    while !events.all.contains(where: { $0.session == session && $0.payload == .listening }) {
      guard ContinuousClock.now < deadline, !events.ended.contains(where: { $0.session == session }) else { await service.cancel(session: session); XCTFail("Capture did not start: \(events.all)"); return }
      try await Task.sleep(for: .milliseconds(10))
    }
    await service.stop(session: session)
    let finishDeadline = ContinuousClock.now + .seconds(10)
    while !events.ended.contains(where: { $0.session == session }) {
      guard ContinuousClock.now < finishDeadline else { await service.cancel(session: session); XCTFail("Finalization timed out"); return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(events.ended.last?.payload, .ended(.completed, nil))
    let text = events.all.flatMap { event -> [String] in
      if case .text(let finalized, _) = event.payload { return finalized }; return []
    }.joined(separator: " ").lowercased()
    for word in ["orange", "bicycle", "garden"] { XCTAssertTrue(text.contains(word), "Missing \(word): \(text)") }
    #endif
  }
}
