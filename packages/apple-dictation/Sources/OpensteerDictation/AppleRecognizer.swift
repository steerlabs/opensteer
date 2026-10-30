import AVFoundation
import Speech
import Foundation

@available(iOS 26, macOS 26, *)
actor AppleRecognizer: Recognizer {
  private var transcriber: SpeechTranscriber?
  private var analyzer: SpeechAnalyzer?
  private var format: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var inputs: AnalyzerInputs?
  private var cancelled = false
  private var reservation: Locale?
  private var installation: AssetInstallationRequest?

  private func resolve() async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    for language in Locale.preferredLanguages {
      if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) { return locale }
    }
    return nil
  }
  private func module(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  }
  private func reconcile(_ locale: Locale?) async {
    for reserved in await AssetInventory.reservedLocales where reserved != locale {
      await AssetInventory.release(reservedLocale: reserved)
    }
  }
  func availability(microphone: DictationMicrophone) async -> DictationAvailability {
    guard SpeechTranscriber.isAvailable else { return .unavailable(.hardware) }
    let resolved = await resolve(); await reconcile(resolved)
    guard let locale = resolved else { return .unavailable(.language) }
    let status = await AssetInventory.status(forModules: [module(locale)])
    guard status != .unsupported else { return .unavailable(.language) }
    let identifier = locale.identifier(.bcp47)
    let name = Locale.current.localizedString(forLanguageCode: locale.language.languageCode?.identifier ?? identifier) ?? identifier
    return .available(locale: identifier, languageName: name, model: status == .installed ? .installed : .download, microphone: microphone)
  }
  func download(progress: @escaping @Sendable (Double?) -> Void) async throws {
    let resolved = await resolve(); await reconcile(resolved)
    guard !cancelled, let locale = resolved else { throw DictationError.downloadFailed }
    let existed = await AssetInventory.reservedLocales.contains(locale)
    try await AssetInventory.reserve(locale: locale)
    if !existed { reservation = locale }
    guard !cancelled else { await releaseUninstalled(); throw CancellationError() }
    let modules = [module(locale)]
    do {
      installation = try await AssetInventory.assetInstallationRequest(supporting: modules)
      guard !cancelled else { throw CancellationError() }
      if let installation {
        progress(nil)
        let ticker = Task {
          while !Task.isCancelled {
            progress(installation.progress.fractionCompleted)
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
          }
        }
        defer { ticker.cancel() }
        try await installation.downloadAndInstall()
      }
      guard !cancelled else { throw CancellationError() }
      reservation = nil; installation = nil
    } catch { await releaseUninstalled(); throw error }
  }
  private func releaseUninstalled() async {
    if let locale = reservation {
      reservation = nil
      if await AssetInventory.status(forModules: [module(locale)]) != .installed { await AssetInventory.release(reservedLocale: locale) }
    }
  }
  func admit() async throws {
    guard let locale = await resolve(), !cancelled else { throw DictationError.modelUnavailable }
    let transcriber = module(locale)
    guard await AssetInventory.status(forModules: [transcriber]) == .installed, !cancelled,
          let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]), !cancelled else { throw DictationError.modelUnavailable }
    self.transcriber = transcriber; self.format = format
    analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .lingering))
  }
  func prepare() async throws {
    guard !cancelled, let analyzer, let format else { throw DictationError.recognitionFailed }
    try await analyzer.prepareToAnalyze(in: format)
    guard !cancelled else { throw CancellationError() }
    let inputs = AnalyzerInputs()
    self.inputs = inputs
    try await analyzer.start(inputSequence: inputs)
  }
  func feed(_ buffer: AVAudioPCMBuffer) async throws {
    guard !cancelled, let format else { throw CancellationError() }
    if converter == nil { converter = AVAudioConverter(from: buffer.format, to: format) }
    guard let converter else { throw DictationError.recognitionFailed }
    try await convert(converter, buffer: buffer)
  }
  private func convert(_ converter: AVAudioConverter, buffer: AVAudioPCMBuffer?) async throws {
    var supplied = false
    while true {
      guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 4096) else { throw DictationError.recognitionFailed }
      var error: NSError?
      let status = converter.convert(to: output, error: &error) { _, state in
        if let buffer, !supplied { supplied = true; state.pointee = .haveData; return buffer }
        state.pointee = buffer == nil ? .endOfStream : .noDataNow; return nil
      }
      if error != nil || status == .error { throw DictationError.recognitionFailed }
      if output.frameLength > 0 {
        guard let inputs else { throw DictationError.recognitionFailed }
        await inputs.send(AnalyzerInput(buffer: output))
        guard !cancelled else { throw CancellationError() }
      }
      if status == .endOfStream || status == .inputRanDry { return }
    }
  }
  func finishInput() async throws {
    if let converter { try await convert(converter, buffer: nil) }
    inputs?.finish()
  }
  func finalize() async throws { try await analyzer?.finalizeAndFinishThroughEndOfInput() }
  func results(_ receive: @escaping @Sendable (RecognitionResult) async -> Void) async throws {
    guard let transcriber else { throw DictationError.recognitionFailed }
    for try await result in transcriber.results {
      try Task.checkCancellation()
      await receive(RecognitionResult(start: result.range.start.seconds, end: result.range.end.seconds, finalization: result.resultsFinalizationTime.seconds, text: String(result.text.characters)))
    }
  }
  func cancel() async {
    cancelled = true; installation?.progress.cancel(); inputs?.finish()
    await analyzer?.cancelAndFinishNow(); await releaseUninstalled()
    installation = nil; converter = nil; analyzer = nil; transcriber = nil
  }
}

// Backpressure reaches the capture queue: conversion waits until the analyzer
// accepts each buffer instead of accumulating an unbounded second audio stream.
@available(iOS 26, macOS 26, *)
private final class AnalyzerInputs: AsyncSequence, @unchecked Sendable {
  typealias Element = AnalyzerInput
  private let stream: AsyncStream<AnalyzerInput>
  private let continuation: AsyncStream<AnalyzerInput>.Continuation
  private let lock = NSLock()
  private var pending: CheckedContinuation<Void, Never>?
  private var closed = false
  init() { (stream, continuation) = AsyncStream.makeStream() }
  func send(_ input: AnalyzerInput) async {
    await withCheckedContinuation { ack in
      lock.lock(); defer { lock.unlock() }
      guard !closed else { ack.resume(); return }
      pending = ack; continuation.yield(input)
    }
  }
  func acknowledge() {
    lock.lock(); let ack = pending; pending = nil; lock.unlock(); ack?.resume()
  }
  func finish() {
    lock.lock(); closed = true; let ack = pending; pending = nil; lock.unlock()
    continuation.finish(); ack?.resume()
  }
  struct AsyncIterator: AsyncIteratorProtocol {
    var base: AsyncStream<AnalyzerInput>.Iterator
    let owner: AnalyzerInputs
    mutating func next() async -> AnalyzerInput? {
      let input = await base.next(); owner.acknowledge(); return input
    }
  }
  func makeAsyncIterator() -> AsyncIterator { AsyncIterator(base: stream.makeAsyncIterator(), owner: self) }
}
