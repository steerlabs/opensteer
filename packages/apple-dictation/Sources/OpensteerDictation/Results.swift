import AVFoundation
import Foundation

/// A transcript revision and Apple's finalization watermark, in audio time.
struct RecognitionResult: Sendable {
  let start: Double
  let end: Double
  let finalization: Double
  let text: String
}
/// Keeps revisions by range because Apple may finalize without repeating a result.
struct ResultTracker {
  private(set) var kept: [RecognitionResult] = []
  private(set) var finalized: [String] = []
  var dirty = false
  mutating func accept(_ result: RecognitionResult) throws {
    guard result.text.utf16.count <= 50_000 else { throw DictationError.recognitionFailed }
    kept.removeAll { $0.start < result.end && result.start < $0.end }
    kept.append(result)
    kept.sort { $0.start < $1.start }
    finalized += kept.filter { $0.end <= result.finalization }.map(\.text)
    kept.removeAll { $0.end <= result.finalization }
    try checkLimits()
    dirty = true
  }
  mutating func finish() throws {
    finalized += kept.map(\.text)
    kept = []
    try checkLimits()
    dirty = true
  }
  private func checkLimits() throws {
    guard kept.count <= 1_000, finalized.count <= 1_000 else {
      throw DictationError.recognitionFailed
    }
  }
  mutating func take() -> DictationEvent.Payload? {
    guard dirty else { return nil }
    let payload = DictationEvent.Payload.text(finalized: finalized, volatile: kept.map(\.text))
    finalized = []
    dirty = false
    return payload
  }
}

// The tap never schedules a task per buffer. A single feeder drains this bounded
// queue
// The one-element wake stream coalesces notifications, never audio.
/// Copies remain bounded while the analyzer prepares or applies backpressure.
final class AudioQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var buffers: [AVAudioPCMBuffer] = []
  private var seconds = 0.0
  private var closed = false
  private(set) var overflow = false
  private var level = 0.0
  let wakes: AsyncStream<Void>
  private let wake: AsyncStream<Void>.Continuation
  let failures: AsyncStream<Void>
  private let failure: AsyncStream<Void>.Continuation
  init() {
    (wakes, wake) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    (failures, failure) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
  }
  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    let duration = Double(buffer.frameLength) / buffer.format.sampleRate
    if seconds + duration > 10 {
      overflow = true
      closed = true
      failure.yield(())
      failure.finish()
      wake.yield(())
      wake.finish()
      return
    }
    buffers.append(buffer)
    seconds += duration
    level = Self.meter(buffer)
    wake.yield(())
  }
  var latestLevel: Double {
    lock.lock()
    defer { lock.unlock() }
    return level
  }
  func next() -> (buffer: AVAudioPCMBuffer?, level: Double, overflow: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard !buffers.isEmpty else { return (nil, level, overflow) }
    let buffer = buffers.removeFirst()
    seconds -= Double(buffer.frameLength) / buffer.format.sampleRate
    return (buffer, level, overflow)
  }
  func fail() {
    lock.lock()
    defer { lock.unlock() }
    overflow = true
    closed = true
    failure.yield(())
    failure.finish()
    wake.yield(())
    wake.finish()
  }
  func finish() {
    lock.lock()
    defer { lock.unlock() }
    closed = true
    wake.yield(())
    wake.finish()
    failure.finish()
  }
  static func meter(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    var sum = 0.0
    for i in 0..<Int(buffer.frameLength) {
      let x = Double(channels[0][i])
      sum += x * x
    }
    return min(1, max(0, sqrt(sum / Double(buffer.frameLength))))
  }
}

/// Capture owns permission and synchronous microphone shutdown before draining.
protocol AudioCapture: AnyObject, Sendable {
  func permission() -> DictationMicrophone
  func restricted() -> Bool
  func requestPermission() async -> Bool
  func start(queue: AudioQueue, changed: @escaping @Sendable (DictationEndReason) -> Void) throws
  func stop()
}
/// Analyzer seam keeps admission, draining and result completion independently testable.
protocol Recognizer: AnyObject, Sendable {
  func availability(microphone: DictationMicrophone) async -> DictationAvailability
  func download(progress: @escaping @Sendable (Double?) -> Void) async throws
  func admit() async throws
  func prepare() async throws
  func feed(_ buffer: AVAudioPCMBuffer) async throws
  func finishInput() async throws
  func finalize() async throws
  func results(_ receive: @escaping @Sendable (RecognitionResult) async -> Void) async throws
  func cancel() async
}
