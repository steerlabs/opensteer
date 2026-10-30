import AVFoundation
import XCTest

@testable import OpensteerDictation

private let id = "00000000-0000-4000-8000-000000000001"
private let other = "00000000-0000-4000-8000-000000000002"
final class Events: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [DictationEvent] = []
  func append(_ event: DictationEvent) {
    lock.lock()
    defer { lock.unlock() }
    values.append(event)
  }
  var all: [DictationEvent] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
  var ended: [DictationEvent] {
    all.filter {
      if case .ended = $0.payload { return true }
      return false
    }
  }
}
/// One synchronized trace makes cross-task lifecycle order observable.
final class Trace: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String] = []
  func append(_ value: String) {
    lock.lock()
    defer { lock.unlock() }
    values.append(value)
  }
  var all: [String] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
}

/// A reusable, cancellation-independent gate for forcing late callbacks.
actor Gate {
  private var continuation: CheckedContinuation<Void, Never>?
  private(set) var entered = false
  private var opened = false
  func wait() async {
    entered = true
    if opened { return }
    await withCheckedContinuation { continuation = $0 }
  }
  func open() {
    opened = true
    continuation?.resume()
    continuation = nil
  }
}

final class Capture: AudioCapture, @unchecked Sendable {
  let permissionGate = Gate()
  let operations: Trace
  var granted = true
  private let lock = NSLock()
  private var startCount = 0
  var starts: Int {
    lock.lock()
    defer { lock.unlock() }
    return startCount
  }
  var burst = 1
  init(trace: Trace = Trace()) { operations = trace }
  func permission() -> DictationMicrophone { granted ? .granted : .undetermined }
  func restricted() -> Bool { false }
  func requestPermission() async -> Bool {
    await permissionGate.wait()
    return true
  }
  func start(queue: AudioQueue, changed: @escaping @Sendable (DictationEndReason) -> Void) throws {
    lock.lock()
    startCount += 1
    lock.unlock()
    operations.append("captureStart")
    for _ in 0..<burst { queue.append(buffer()) }
  }
  func stop() { operations.append("captureStop") }
}

func buffer(seconds: Double = 0.1) -> AVAudioPCMBuffer {
  let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
  let buffer = AVAudioPCMBuffer(
    pcmFormat: format, frameCapacity: AVAudioFrameCount(16000 * seconds))!
  buffer.frameLength = buffer.frameCapacity
  if let channel = buffer.floatChannelData {
    channel[0].initialize(repeating: 0, count: Int(buffer.frameLength))
  }
  return buffer
}
actor FakeRecognizer: Recognizer {
  let stream: AsyncStream<RecognitionResult>
  let output: AsyncStream<RecognitionResult>.Continuation
  let operations: Trace
  var trace: [String] { operations.all }
  var admissionGate: Gate?
  var cleanupGate: Gate?
  var preparationGate: Gate?
  func gates(admission: Gate? = nil, cleanup: Gate? = nil, preparation: Gate? = nil) {
    admissionGate = admission
    cleanupGate = cleanup
    preparationGate = preparation
  }
  var hanging = false
  var longText = false
  var delayedPreparation = false
  var delayedFeed = false
  var delayedDownload = false
  init(trace: Trace = Trace()) {
    operations = trace
    (stream, output) = AsyncStream.makeStream()
  }
  func configure(
    hanging: Bool = false, longText: Bool = false, delayedPreparation: Bool = false,
    delayedFeed: Bool = false, delayedDownload: Bool = false
  ) {
    self.hanging = hanging
    self.longText = longText
    self.delayedPreparation = delayedPreparation
    self.delayedFeed = delayedFeed
    self.delayedDownload = delayedDownload
  }
  func availability(microphone: DictationMicrophone) async -> DictationAvailability {
    .available(locale: "en-US", languageName: "English", model: .installed, microphone: microphone)
  }
  func download(progress: @escaping @Sendable (Double?) -> Void) async throws {
    progress(0.5)
    if delayedDownload { try await Task.sleep(for: .seconds(60)) }
  }
  func admit() async throws {
    operations.append("admit")
    if let admissionGate {
      await admissionGate.wait()
      throw DictationError.modelUnavailable
    }
  }
  func prepare() async throws {
    operations.append("prepare")
    await preparationGate?.wait()
    if delayedPreparation { try await Task.sleep(for: .seconds(60)) }
  }
  func feed(_ buffer: AVAudioPCMBuffer) async throws {
    operations.append("feed")
    if delayedFeed { try await Task.sleep(for: .seconds(60)) }
    output.yield(
      .init(
        start: 0, end: 1, finalization: 0,
        text: longText ? String(repeating: "😀", count: 25_001) : "last words"))
  }
  func finishInput() async throws { operations.append("finishInput") }
  func finalize() async throws {
    operations.append("finalize")
    if hanging { try await Task.sleep(for: .seconds(60)) }
    output.finish()
  }
  func results(_ receive: @escaping @Sendable (RecognitionResult) async -> Void) async throws {
    for await result in stream { await receive(result) }
    operations.append("consumed")
  }
  func push(_ result: RecognitionResult) { output.yield(result) }
  func cancel() async {
    operations.append("cancel")
    await cleanupGate?.wait()
    output.finish()
    operations.append("cleaned")
  }
}
final class EngineTests: XCTestCase {
  func wait(_ predicate: () async -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(3)
    while !(await predicate()) {
      guard ContinuousClock.now < deadline else {
        XCTFail("Condition timed out")
        return
      }
      try await Task.sleep(for: .milliseconds(5))
    }
  }
  func testLateAdmissionErrorCannotOverrideStop() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    let gate = Gate()
    await recognizer.gates(admission: gate)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait { await gate.entered }
    await service.stop(session: id)
    await gate.open()
    try await wait { !events.ended.isEmpty }
    XCTAssertEqual(events.ended.map(\.payload), [.ended(.completed, nil)])
    XCTAssertEqual(capture.starts, 0)
  }

  func testNextSessionWaitsForCleanupAndLateResultsAreFenced() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    let gate = Gate()
    await recognizer.gates(cleanup: gate)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait { capture.starts == 1 }
    await service.cancel(session: id)
    try await wait { await gate.entered }
    let count = events.all.count
    await recognizer.push(.init(start: 0, end: 1, finalization: 1, text: "late"))
    try await service.start(session: other)
    XCTAssertEqual(capture.starts, 1)
    XCTAssertEqual(events.all.count, count)
    await gate.open()
    try await wait { capture.starts == 2 }
    let trace = await recognizer.trace
    XCTAssertLessThan(trace.firstIndex(of: "cleaned")!, trace.lastIndex(of: "admit")!)
    XCTAssertEqual(events.all.filter { $0.session == id }.count, count)
    await service.cancel(session: other)
  }

  func testLevelsContinueDuringPreparation() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    let gate = Gate()
    await recognizer.gates(preparation: gate)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait {
      events.all.filter {
        if case .level = $0.payload { return true }
        return false
      }.count >= 2
    }
    let trace = await recognizer.trace
    XCTAssertFalse(trace.contains("feed"))
    await service.cancel(session: id)
    await gate.open()
  }

  func testCaptureConfigurationIgnoresOutputAndCategoryChanges() {
    let center = NotificationCenter()
    let source = NSObject()
    let route = Route()
    let trace = Trace()
    let monitor = InputChanges(center: center, object: source, read: { route.input }) {
      trace.append("changed")
    }
    withExtendedLifetime(monitor) {
      // Output override and category notifications preserve the input snapshot.
      center.post(name: .AVAudioEngineConfigurationChange, object: source)
      center.post(name: .AVAudioEngineConfigurationChange, object: source)
      XCTAssertEqual(trace.all, [])
      route.replace(AudioInputIdentity(devices: ["headset"], sampleRate: 48000, channels: 1))
      center.post(name: .AVAudioEngineConfigurationChange, object: source)
      XCTAssertEqual(trace.all, ["changed"])
    }
  }

  func testEquivalentLocaleAndInputIdentities() {
    XCTAssertEqual(
      localeIdentity(Locale(identifier: "en-US")), localeIdentity(Locale(identifier: "en_US")))
    let input = AudioInputIdentity(devices: ["mic"], sampleRate: 48000, channels: 1)
    XCTAssertEqual(input, AudioInputIdentity(devices: ["mic"], sampleRate: 48000, channels: 1))
    XCTAssertNotEqual(
      input, AudioInputIdentity(devices: ["headset"], sampleRate: 48000, channels: 1))
    XCTAssertNotEqual(input, AudioInputIdentity(devices: ["mic"], sampleRate: 16000, channels: 1))
  }

  func testRealConverterFlushPreservesQueuedAudio() async throws {
    let input = buffer(seconds: 0.1)
    input.floatChannelData![0].update(repeating: 0.5, count: Int(input.frameLength))
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    let converter = AVAudioConverter(from: input.format, to: format)!
    var before = 0
    var flushed = 0
    try await convertAudio(converter, buffer: input) { before += Int($0.frameLength) }
    try await convertAudio(converter, buffer: nil) { flushed += Int($0.frameLength) }
    XCTAssertGreaterThan(before, 0)
    XCTAssertGreaterThan(flushed, 0)
    XCTAssertEqual(before + flushed, 4800)
  }

  func testRangeRevisionAndFinalizationWatermark() throws {
    var tracker = ResultTracker()
    try tracker.accept(.init(start: 0, end: 1, finalization: 0, text: "old"))
    try tracker.accept(.init(start: 1, end: 2, finalization: 0, text: "tail"))
    try tracker.accept(.init(start: 0, end: 1, finalization: 0, text: "revised"))
    XCTAssertEqual(tracker.take(), .text(finalized: [], volatile: ["revised", "tail"]))
    try tracker.accept(.init(start: 2, end: 3, finalization: 2, text: "next"))
    XCTAssertEqual(tracker.take(), .text(finalized: ["revised", "tail"], volatile: ["next"]))
    try tracker.finish()
    XCTAssertEqual(tracker.take(), .text(finalized: ["next"], volatile: []))
  }
  func testStopDrainsAndKeepsLastWords() async throws {
    let operations = Trace()
    let events = Events()
    let capture = Capture(trace: operations)
    let recognizer = FakeRecognizer(trace: operations)
    let preparation = Gate()
    await recognizer.gates(preparation: preparation)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait { events.all.contains { $0.payload == .listening } }
    await service.stop(session: id)
    await preparation.open()
    try await wait { !events.ended.isEmpty }
    XCTAssertEqual(events.ended.map(\.payload), [.ended(.completed, nil)])
    XCTAssertTrue(
      events.all.contains { $0.payload == .text(finalized: ["last words"], volatile: []) })
    let trace = await recognizer.trace
    XCTAssertLessThan(trace.firstIndex(of: "captureStop")!, trace.firstIndex(of: "feed")!)
    XCTAssertLessThan(trace.firstIndex(of: "feed")!, trace.firstIndex(of: "finishInput")!)
    XCTAssertLessThan(trace.firstIndex(of: "finishInput")!, trace.firstIndex(of: "finalize")!)
    XCTAssertLessThan(trace.firstIndex(of: "finalize")!, trace.firstIndex(of: "consumed")!)
    XCTAssertEqual(events.all.map(\.seq), Array(1...events.all.count))
  }
  func testStopAndCancelDuringPermissionNeverOpenCapture() async throws {
    for cancel in [false, true] {
      let events = Events()
      let capture = Capture()
      let recognizer = FakeRecognizer()
      capture.granted = false
      let service = DictationService(
        emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
      try await service.start(session: id)
      try await wait { await capture.permissionGate.entered }
      if cancel { await service.cancel(session: id) } else { await service.stop(session: id) }
      try await wait { !events.ended.isEmpty }
      await capture.permissionGate.open()
      try await Task.sleep(for: .milliseconds(20))
      XCTAssertEqual(capture.starts, 0)
      XCTAssertEqual(events.ended.map(\.payload), [.ended(cancel ? .cancelled : .completed, nil)])
    }
  }
  func testBusyAndCancelSupersedesStop() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    await recognizer.configure(hanging: true)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait { events.all.contains { $0.payload == .listening } }
    try await service.start(session: other)
    let stop = Task { await service.stop(session: id) }
    try await wait { await recognizer.trace.contains("finalize") }
    await service.cancel(session: id)
    // Cancel the caller's suspended fake finalize as well
    // Production cancel closes the analyzer.
    stop.cancel()
    await stop.value
    XCTAssertEqual(events.ended.map(\.payload), [.ended(.failed, .busy), .ended(.cancelled, nil)])
  }
  func testOverflowDeadlineAndUTF16LimitsFailExplicitly() async throws {
    for scenario in 0..<5 {
      let events = Events()
      let capture = Capture()
      let recognizer = FakeRecognizer()
      capture.burst = scenario == 0 ? 101 : 1
      await recognizer.configure(
        hanging: scenario == 1, longText: scenario == 2,
        delayedPreparation: scenario == 0 || scenario == 3, delayedFeed: scenario == 4)
      let service = DictationService(
        emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer },
        timeout: .milliseconds(25))
      try await service.start(session: id)
      try await wait { events.all.contains { $0.payload == .listening } }
      if scenario == 1 || scenario >= 3 {
        let stop = Task { await service.stop(session: id) }
        try await wait { !events.ended.isEmpty }
        stop.cancel()
        await stop.value
      } else {
        try await wait { !events.ended.isEmpty }
      }
      XCTAssertEqual(events.ended.map(\.payload), [.ended(.failed, .recognitionFailed)])
    }
  }
  func testStoppedDownloadIsCancelledRatherThanInstalled() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    await recognizer.configure(delayedDownload: true)
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.download(session: id)
    try await wait { !events.all.isEmpty }
    await service.stop(session: id)
    try await wait { !events.ended.isEmpty }
    XCTAssertEqual(events.ended.map(\.payload), [.ended(.cancelled, nil)])
    XCTAssertEqual(capture.starts, 0)
  }
  func testTextTicksAndMeterStayBounded() async throws {
    let events = Events()
    let capture = Capture()
    let recognizer = FakeRecognizer()
    capture.burst = 50
    let service = DictationService(
      emit: { events.append($0) }, capture: { capture }, recognizer: { recognizer })
    try await service.start(session: id)
    try await wait {
      events.all.contains {
        if case .text = $0.payload { return true }
        return false
      }
    }
    try await Task.sleep(for: .milliseconds(220))
    let textEvents = events.all.filter {
      if case .text = $0.payload { return true }
      return false
    }
    XCTAssertEqual(textEvents.count, 1)
    XCTAssertEqual(textEvents.first?.payload, .text(finalized: [], volatile: ["last words"]))
    await recognizer.push(.init(start: 1, end: 2, finalization: 1, text: "next"))
    try await wait {
      events.all.contains { $0.payload == .text(finalized: ["last words"], volatile: ["next"]) }
    }
    await service.interrupt()
    try await wait { !events.ended.isEmpty }
    XCTAssertEqual(events.ended.last?.payload, .ended(.interrupted, nil))
    // Replays and stale commands cannot add events after termination.
    let count = events.all.count
    try await service.start(session: id)
    await service.stop(session: id)
    await service.cancel(session: id)
    XCTAssertEqual(events.all.count, count)
    let audio = buffer()
    XCTAssertEqual(AudioQueue.meter(audio), 0)
    audio.floatChannelData![0].update(repeating: 2, count: Int(audio.frameLength))
    XCTAssertEqual(AudioQueue.meter(audio), 1)
  }
  func testCoalescingPreservesFinalizedAndLimitsArrays() throws {
    var tracker = ResultTracker()
    for i in 0..<1000 {
      try tracker.accept(
        .init(start: Double(i), end: Double(i + 1), finalization: Double(i + 1), text: "word"))
    }
    XCTAssertEqual(tracker.finalized.count, 1000)
    XCTAssertThrowsError(
      try tracker.accept(.init(start: 1000, end: 1001, finalization: 1001, text: "overflow")))
    XCTAssertThrowsError(
      try validateSession(id.uppercased().replacingOccurrences(of: "00000000", with: "AAAAAAAA")))
    XCTAssertNoThrow(try validateSession(id))
  }
}

/// Input snapshots can change from notification-producing threads.
private final class Route: @unchecked Sendable {
  private let lock = NSLock()
  private var value = AudioInputIdentity(devices: ["mic"], sampleRate: 48000, channels: 1)
  var input: AudioInputIdentity {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func replace(_ input: AudioInputIdentity) {
    lock.lock()
    defer { lock.unlock() }
    value = input
  }
}
