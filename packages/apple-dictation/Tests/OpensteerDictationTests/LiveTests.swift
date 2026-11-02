import AVFoundation
import XCTest

@testable import OpensteerDictation

#if os(macOS)
  import Darwin
  import Speech
#endif

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
      try file.read(into: buffer)
      queue.append(buffer)
    }
  }
  func stop() {}
}
final class LiveTests: XCTestCase {
  func testGeneratedSpeechThroughRealAnalyzer() async throws {
    try await generatedSpeech(restartSpeechService: false)
  }

  func testInstalledModelSurvivesSpeechServiceExit() async throws {
    try await generatedSpeech(restartSpeechService: true)
  }

  private func generatedSpeech(restartSpeechService: Bool) async throws {
    guard ProcessInfo.processInfo.environment["OPENSTEER_DICTATION_LIVE_TESTS"] == "1" else {
      throw XCTSkip("Opt in with OPENSTEER_DICTATION_LIVE_TESTS=1; never uses a microphone")
    }
    guard #available(macOS 26, iOS 26, *) else { throw XCTSkip("SpeechAnalyzer requires OS 26") }
    #if os(macOS)
      let reserved = await AssetInventory.reservedLocales
      do {
        try await recognizeGeneratedSpeech(restartSpeechService: restartSpeechService)
      } catch {
        await releaseTestReservations(excluding: reserved)
        throw error
      }
      await releaseTestReservations(excluding: reserved)
    #endif
  }

  #if os(macOS)
    @available(macOS 26, *)
    private func releaseTestReservations(excluding original: [Locale]) async {
      for locale in await AssetInventory.reservedLocales
      where !original.contains(where: { localeIdentity($0) == localeIdentity(locale) }) {
        await AssetInventory.release(reservedLocale: locale)
      }
    }

    private func run(_ executable: String, _ arguments: [String], output: Pipe? = nil) async throws
    {
      let exited = expectation(description: "\(executable) exited")
      let process = Process()
      process.executableURL = URL(fileURLWithPath: executable)
      process.arguments = arguments
      process.standardOutput = output
      process.terminationHandler = { _ in exited.fulfill() }
      try process.run()
      await fulfillment(of: [exited], timeout: 10)
      if process.isRunning {
        kill(process.processIdentifier, SIGKILL)
        await fulfillment(of: [exited], timeout: 2)
        throw NSError(domain: "LiveTests.processTimeout", code: 1)
      }
      XCTAssertEqual(process.terminationStatus, 0, executable)
    }

    private func exitOwnedSpeechService() async throws {
      let output = Pipe()
      try await run("/bin/launchctl", ["print", "pid/\(getpid())"], output: output)
      let listing = String(
        decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      XCTAssertTrue(
        listing.contains("services = {"), "Missing process services in launchctl output")
      var inServices = false
      for line in listing.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed == "services = {" {
          inServices = true
          continue
        }
        guard inServices else { continue }
        if trimmed == "}" { break }
        let fields = trimmed.split(whereSeparator: { $0.isWhitespace })
        guard fields.count == 3, fields[1] == "-",
          fields[2] == "com.apple.speech.localspeechrecognition",
          let pid = Int32(fields[0]), pid > 0
        else { continue }
        // This is this test process's own service instance, never a PID matched by name.
        let result = kill(pid, SIGKILL)
        XCTAssertTrue(
          result == 0 || errno == ESRCH, "Could not exit owned speech service: \(errno)")
        return
      }
      // The owned instance may already have idle-exited.
    }

    @available(macOS 26, *)
    private func recognizeGeneratedSpeech(restartSpeechService: Bool) async throws {
      let url = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString + ".aiff")
      defer { try? FileManager.default.removeItem(at: url) }
      try await run(
        "/usr/bin/say",
        [
          "-v", "Samantha", "-o", url.path, "The bright orange bicycle waits beside the garden.",
        ])
      let downloadID = "00000000-0000-4000-8000-000000000003"
      let session = "00000000-0000-4000-8000-000000000004"
      let downloaded = XCTestExpectation(description: "Model installation ended")
      let listening = XCTestExpectation(description: "Capture started")
      let ended = XCTestExpectation(description: "Recognition finalized")
      let events = Events { event in
        if event.session == downloadID, case .ended = event.payload { downloaded.fulfill() }
        if event.session == session {
          if event.payload == .listening { listening.fulfill() }
          if case .ended = event.payload { ended.fulfill() }
        }
      }
      let service = DictationService(
        emit: { events.append($0) }, capture: { FileCapture(url) },
        recognizer: { AppleRecognizer(languages: ["en-US"]) })
      do {
        if restartSpeechService {
          _ = await AssetInventory.status(forModules: [
            SpeechTranscriber(
              locale: Locale(identifier: "en-US"), transcriptionOptions: [],
              reportingOptions: [.volatileResults], attributeOptions: [])
          ])
          try await exitOwnedSpeechService()
        }
        // Follow the controller: availability decides whether the press downloads.
        let availability = await service.availability()
        guard case .available(_, _, let model, _) = availability else {
          XCTFail("Unavailable: \(availability)")
          return
        }
        if model == .download {
          try await service.download(session: downloadID)
          await fulfillment(of: [downloaded], timeout: 180)
          guard events.ended.last?.payload == .ended(.completed, nil) else {
            await service.cancel(session: downloadID)
            XCTFail("Model installation failed or timed out: \(events.ended)")
            return
          }
        }
        let ready = await service.availability()
        guard case .available(_, _, .installed, _) = ready else {
          XCTFail("Installed model not ready: \(ready)")
          return
        }
        try await service.start(session: session)
        await fulfillment(of: [listening], timeout: 30)
        guard events.all.contains(where: { $0.session == session && $0.payload == .listening })
        else {
          await service.cancel(session: session)
          XCTFail("Capture did not start: \(events.all)")
          return
        }
        await service.stop(session: session)
        await fulfillment(of: [ended], timeout: 10)
        await service.cancel(session: session)
        XCTAssertEqual(events.ended.last?.payload, .ended(.completed, nil))
        let text = events.all.flatMap { event -> [String] in
          if case .text(let finalized, _) = event.payload { return finalized }
          return []
        }.joined(separator: " ").lowercased()
        for word in ["orange", "bicycle", "garden"] {
          XCTAssertTrue(text.contains(word), "Missing \(word): \(text)")
        }
      } catch {
        await service.cancel(session: downloadID)
        await service.cancel(session: session)
        throw error
      }
    }
  #endif
}
