import Foundation
import AVFoundation

public actor DictationService {
  private final class Session {
    let id: String
    let capture: AudioCapture
    let recognizer: Recognizer
    let queue = AudioQueue()
    var seq = 0
    var tracker = ResultTracker()
    var listening = false
    var downloading = false
    var stopping = false
    var lastLevel = ContinuousClock.now
    var work: Task<Void, Never>?
    var feeder: Task<Void, Error>?
    var consumer: Task<Void, Error>?
    var ticker: Task<Void, Never>?
    var deadline: Task<Void, Never>?
    var monitor: Task<Void, Never>?
    var overrun: Task<Void, Never>?
    var finisher: Task<Void, Never>?
    init(_ id: String, _ capture: AudioCapture, _ recognizer: Recognizer) {
      self.id = id; self.capture = capture; self.recognizer = recognizer
    }
  }
  private let emit: @Sendable (DictationEvent) -> Void
  private let makeCapture: @Sendable () -> AudioCapture
  private let makeRecognizer: @Sendable () -> Recognizer
  private let finalizationTimeout: Duration
  private var active: Session?
  private var usedSessions = Set<String>()
  public init(emit: @escaping @Sendable (DictationEvent) -> Void) {
    self.emit = emit; makeCapture = { MicrophoneCapture() }
    makeRecognizer = { if #available(iOS 26, macOS 26, *) { return AppleRecognizer() }; return UnsupportedRecognizer() }
    finalizationTimeout = .seconds(5)
  }
  init(emit: @escaping @Sendable (DictationEvent) -> Void,
       capture: @escaping @Sendable () -> AudioCapture,
       recognizer: @escaping @Sendable () -> Recognizer, timeout: Duration = .seconds(5)) {
    self.emit = emit; makeCapture = capture; makeRecognizer = recognizer; finalizationTimeout = timeout
  }
  public func availability() async -> DictationAvailability {
    guard #available(iOS 26, macOS 26, *) else { return .unavailable(.os) }
    let capture = makeCapture()
    if capture.restricted() { return .unavailable(.restricted) }
    return await makeRecognizer().availability(microphone: capture.permission())
  }
  private func admit(_ id: String) throws -> Session? {
    try validateSession(id)
    guard usedSessions.insert(id).inserted else { return nil }
    if active != nil {
      emit(DictationEvent(session: id, seq: 1, payload: .ended(.failed, .busy)))
      return nil
    }
    let s = Session(id, makeCapture(), makeRecognizer()); active = s; return s
  }
  public func start(session: String) throws {
    guard let s = try admit(session) else { return }
    s.work = Task { await self.begin(s) }
  }
  private func current(_ s: Session) -> Bool { active === s }
  private func begin(_ s: Session) async {
    guard current(s), !s.stopping else { return }
    do {
      let granted = s.capture.permission() == .granted ? true : await s.capture.requestPermission()
      guard current(s), !s.stopping else { return }
      guard granted else { throw DictationError.permissionDenied }
      try await s.recognizer.admit()
      guard current(s), !s.stopping else { await s.recognizer.cancel(); return }
      do { try s.capture.start(queue: s.queue) { reason in Task { await self.scheduleFinish(s, reason: reason) } } }
      catch { throw DictationError.microphoneUnavailable }
      s.listening = true; deliver(s, .listening)
      s.overrun = Task {
        for await _ in s.queue.failures { await self.fail(s, .recognitionFailed) }
      }
      s.consumer = Task {
        try await s.recognizer.results { result in await self.receive(s, result) }
      }
      s.feeder = Task {
        try await s.recognizer.prepare()
        for await _ in s.queue.wakes {
          try Task.checkCancellation()
          while true {
            let next = s.queue.next()
            if next.overflow { throw DictationError.recognitionFailed }
            guard let buffer = next.buffer else { break }
            try await s.recognizer.feed(buffer)
            self.level(s, next.level)
          }
        }
        try await s.recognizer.finishInput()
      }
      s.ticker = Task {
        while !Task.isCancelled {
          do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
          self.flush(s)
        }
      }
      // Observe feeder and consumer failures during listening, not just on stop.
      s.work = Task {
        do { try await s.feeder?.value; try await s.consumer?.value }
        catch { await self.fail(s, error as? DictationError ?? .recognitionFailed) }
      }
      s.monitor = Task {
        do { try await s.consumer?.value }
        catch { await self.fail(s, .recognitionFailed) }
      }
    } catch { await fail(s, error as? DictationError ?? .recognitionFailed) }
  }
  public func download(session: String) throws {
    guard let s = try admit(session) else { return }
    s.downloading = true
    s.work = Task {
      do {
        try await s.recognizer.download { progress in Task { await self.progress(s, progress) } }
        guard self.current(s), !s.stopping else { return }
        await self.terminate(s, .completed, nil)
      } catch { await self.fail(s, .downloadFailed) }
    }
  }
  private func progress(_ s: Session, _ progress: Double?) {
    guard current(s) else { return }
    let now = ContinuousClock.now
    if s.seq == 0 || s.lastLevel.duration(to: now) >= .milliseconds(250) {
      s.lastLevel = now; deliver(s, .downloading(progress))
    }
  }
  public func stop(session: String) {
    if let s = active, s.id == session { scheduleFinish(s, reason: .completed) }
  }
  public func interrupt() { if let s = active { scheduleFinish(s, reason: .interrupted) } }
  private func scheduleFinish(_ s: Session, reason: DictationEndReason) {
    guard current(s), !s.stopping else { return }
    // Fence admission at command acceptance, before the finalizer task runs.
    s.stopping = true; s.capture.stop(); s.queue.finish()
    let reason: DictationEndReason = s.downloading && reason == .completed ? .cancelled : reason
    s.finisher = Task { await self.finish(s, reason: reason) }
  }
  public func cancel(session: String) async {
    if let s = active, s.id == session { await terminate(s, .cancelled, nil) }
  }
  private func finish(_ s: Session, reason: DictationEndReason) async {
    guard current(s) else { return }
    guard s.listening else { await terminate(s, reason, nil); return }
    // Preparation and backpressured draining can stall before finalization starts.
    s.deadline = Task {
      do { try await Task.sleep(for: finalizationTimeout) } catch { return }
      await self.fail(s, .recognitionFailed)
    }
    do {
      try await s.feeder?.value
      guard current(s) else { return }
      s.deadline?.cancel()
      s.deadline = Task {
        do { try await Task.sleep(for: finalizationTimeout) } catch { return }
        await self.fail(s, .recognitionFailed)
      }
      try await s.recognizer.finalize()
      try await s.consumer?.value
      guard current(s) else { return }
      try s.tracker.finish(); flush(s)
      await terminate(s, reason, nil)
    } catch { await fail(s, .recognitionFailed) }
  }
  private func receive(_ s: Session, _ result: RecognitionResult) async {
    guard current(s) else { return }
    do { try s.tracker.accept(result) } catch { await fail(s, .recognitionFailed) }
  }
  private func flush(_ s: Session) {
    guard current(s), let payload = s.tracker.take() else { return }; deliver(s, payload)
  }
  private func level(_ s: Session, _ value: Double) {
    let now = ContinuousClock.now
    guard current(s), s.lastLevel.duration(to: now) >= .milliseconds(100) else { return }
    s.lastLevel = now; deliver(s, .level(value))
  }
  private func deliver(_ s: Session, _ payload: DictationEvent.Payload) {
    guard current(s) else { return }
    s.seq += 1; emit(DictationEvent(session: s.id, seq: s.seq, payload: payload))
  }
  private func fail(_ s: Session, _ error: DictationError) async { await terminate(s, .failed, error) }
  private func terminate(_ s: Session, _ reason: DictationEndReason, _ error: DictationError?) async {
    guard current(s) else { return }
    s.capture.stop(); s.queue.finish()
    s.work?.cancel(); s.feeder?.cancel(); s.consumer?.cancel(); s.ticker?.cancel(); s.deadline?.cancel(); s.monitor?.cancel(); s.finisher?.cancel(); s.overrun?.cancel()
    deliver(s, .ended(reason, error)); active = nil
    await s.recognizer.cancel()
  }
}

final class UnsupportedRecognizer: Recognizer {
  func availability(microphone: DictationMicrophone) async -> DictationAvailability { .unavailable(.os) }
  func download(progress: @escaping @Sendable (Double?) -> Void) async throws { throw DictationError.modelUnavailable }
  func admit() async throws { throw DictationError.modelUnavailable }
  func prepare() async throws { throw DictationError.modelUnavailable }
  func feed(_ buffer: AVAudioPCMBuffer) async throws {}
  func finishInput() async throws {}
  func finalize() async throws {}
  func results(_ receive: @escaping @Sendable (RecognitionResult) async -> Void) async throws {}
  func cancel() async {}
}
