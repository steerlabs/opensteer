import AVFoundation
import Foundation

/// Owns session admission and fences callbacks before asynchronous cleanup.
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
    var overrun: Task<Void, Never>?
    var finisher: Task<Void, Never>?
    init(_ id: String, _ capture: AudioCapture, _ recognizer: Recognizer) {
      self.id = id
      self.capture = capture
      self.recognizer = recognizer
    }
  }
  private let emit: @Sendable (DictationEvent) -> Void
  private let makeCapture: @Sendable () -> AudioCapture
  private let makeRecognizer: @Sendable () -> Recognizer
  private let finalizationTimeout: Duration
  private let beforeFinish: @Sendable () async -> Void
  private let onCleanupWait: @Sendable () -> Void
  private let onCleanupReady: @Sendable () -> Void
  private var active: Session?
  /// Terminal events are prompt
  /// Subsequent work waits for native cleanup.
  private var cleanup: Task<Void, Never>?
  private var usedSessions = Set<String>()
  public init(emit: @escaping @Sendable (DictationEvent) -> Void) {
    self.emit = emit
    makeCapture = { MicrophoneCapture() }
    let reservations = ReservationCoordinator()
    makeRecognizer = {
      if #available(iOS 26, macOS 26, *) { return AppleRecognizer(reservations: reservations) }
      return UnsupportedRecognizer()
    }
    finalizationTimeout = .seconds(5)
    beforeFinish = {}
    onCleanupWait = {}
    onCleanupReady = {}
  }
  init(
    emit: @escaping @Sendable (DictationEvent) -> Void,
    capture: @escaping @Sendable () -> AudioCapture,
    recognizer: @escaping @Sendable () -> Recognizer, timeout: Duration = .seconds(5),
    beforeFinish: @escaping @Sendable () async -> Void = {},
    onCleanupWait: @escaping @Sendable () -> Void = {},
    onCleanupReady: @escaping @Sendable () -> Void = {}
  ) {
    self.emit = emit
    makeCapture = capture
    makeRecognizer = recognizer
    finalizationTimeout = timeout
    self.beforeFinish = beforeFinish
    self.onCleanupWait = onCleanupWait
    self.onCleanupReady = onCleanupReady
  }
  public func availability() async -> DictationAvailability {
    guard #available(iOS 26, macOS 26, *) else { return .unavailable(.os) }
    await cleanup?.value
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
    let s = Session(id, makeCapture(), makeRecognizer())
    active = s
    return s
  }
  public func start(session: String) throws {
    guard let s = try admit(session) else { return }
    s.work = Task { await self.begin(s) }
  }
  private func current(_ s: Session) -> Bool { active === s }
  func admissionTask() -> Task<Void, Never>? { active?.work }
  private func begin(_ s: Session) async {
    onCleanupWait()
    await cleanup?.value
    onCleanupReady()
    guard current(s), !s.stopping else { return }
    do {
      let granted = s.capture.permission() == .granted ? true : await s.capture.requestPermission()
      guard current(s), !s.stopping else { return }
      guard granted else { throw DictationError.permissionDenied }
      do {
        try s.capture.start(queue: s.queue) { reason in
          Task { await self.scheduleFinish(s, reason: reason) }
        }
      } catch { throw DictationError.microphoneUnavailable }
      s.listening = true
      deliver(s, .listening)
      s.overrun = Task {
        for await _ in s.queue.failures { await self.fail(s, .recognitionFailed) }
      }
      s.ticker = Task {
        while !Task.isCancelled {
          do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
          self.flush(s)
          self.level(s, s.queue.latestLevel)
        }
      }
      try await s.recognizer.admit()
      // Stop closes capture but still drains audio recorded during admission.
      guard current(s) else { return }
      s.consumer = Task {
        do { try await s.recognizer.results { result in await self.receive(s, result) } } catch {
          await self.fail(s, .recognitionFailed)
          throw error
        }
      }
      s.feeder = Task {
        do {
          try await s.recognizer.prepare()
          guard self.current(s) else { return }
          for await _ in s.queue.wakes {
            try Task.checkCancellation()
            while true {
              let next = s.queue.next()
              if next.overflow { throw DictationError.recognitionFailed }
              guard let buffer = next.buffer else { break }
              try await s.recognizer.feed(buffer)
            }
          }
          try await s.recognizer.finishInput()
        } catch {
          await self.fail(s, .recognitionFailed)
          throw error
        }
      }
    } catch {
      guard current(s), !s.stopping else { return }
      await fail(s, error as? DictationError ?? .recognitionFailed)
    }
  }

  public func download(session: String) throws {
    guard let s = try admit(session) else { return }
    s.downloading = true
    s.work = Task {
      await self.cleanup?.value
      guard self.current(s), !s.stopping else { return }
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
      s.lastLevel = now
      deliver(s, .downloading(progress))
    }
  }
  public func stop(session: String) {
    if let s = active, s.id == session { scheduleFinish(s, reason: .completed) }
  }
  public func interrupt() { if let s = active { scheduleFinish(s, reason: .interrupted) } }
  private func scheduleFinish(_ s: Session, reason: DictationEndReason) {
    guard current(s), !s.stopping else { return }
    // Fence capture startup at command acceptance, before the finalizer task runs.
    let deadline = ContinuousClock.now + finalizationTimeout
    s.stopping = true
    s.capture.stop()
    s.queue.finish()
    let reason: DictationEndReason = s.downloading && reason == .completed ? .cancelled : reason
    if s.listening {
      s.deadline = Task {
        do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
        guard self.current(s) else { return }
        // Promote what Apple left tentative when the bounds allow; termination
        // flushes either way, so a refused promotion still delivers every word.
        try? s.tracker.finish()
        await self.fail(s, .recognitionFailed)
      }
    }
    s.finisher = Task {
      await self.beforeFinish()
      await self.finish(s, reason: reason)
    }
  }
  public func cancel(session: String) async {
    if let s = active, s.id == session { await terminate(s, .cancelled, nil) }
  }
  private func finish(_ s: Session, reason: DictationEndReason) async {
    guard current(s) else { return }
    guard s.listening else {
      await terminate(s, reason, nil)
      return
    }
    // Admission may still be resolving while capture is already closed.
    await s.work?.value
    guard current(s) else { return }
    guard s.consumer != nil else {
      await terminate(s, reason, nil)
      return
    }
    do {
      try await s.feeder?.value
      guard current(s) else { return }
      try await s.recognizer.finalize()
      guard current(s) else { return }
      try await s.consumer?.value
      guard current(s) else { return }
      try s.tracker.finish()
      flush(s)
      await terminate(s, reason, nil)
    } catch { await fail(s, .recognitionFailed) }
  }
  private func receive(_ s: Session, _ result: RecognitionResult) async {
    guard current(s) else { return }
    do { try s.tracker.accept(result) } catch { await fail(s, .recognitionFailed) }
  }
  private func flush(_ s: Session) {
    guard current(s), let payload = s.tracker.take() else { return }
    deliver(s, payload)
  }
  private func level(_ s: Session, _ value: Double) {
    let now = ContinuousClock.now
    guard current(s), s.lastLevel.duration(to: now) >= .milliseconds(100) else { return }
    s.lastLevel = now
    deliver(s, .level(value))
  }
  private func deliver(_ s: Session, _ payload: DictationEvent.Payload) {
    guard current(s) else { return }
    s.seq += 1
    emit(DictationEvent(session: s.id, seq: s.seq, payload: payload))
  }
  private func fail(_ s: Session, _ error: DictationError) async {
    await terminate(s, .failed, error)
  }
  private func terminate(_ s: Session, _ reason: DictationEndReason, _ error: DictationError?) async
  {
    guard current(s) else { return }
    // Words recognized since the last 100 ms tick must not be lost to a failure,
    // an interruption or a device change; only cancel discards them.
    if reason != .cancelled { flush(s) }
    s.capture.stop()
    s.queue.finish()
    s.work?.cancel()
    s.feeder?.cancel()
    s.consumer?.cancel()
    s.ticker?.cancel()
    s.deadline?.cancel()
    s.finisher?.cancel()
    s.overrun?.cancel()
    deliver(s, .ended(reason, error))
    active = nil
    let previous = cleanup
    cleanup = Task {
      await previous?.value
      await s.recognizer.cancel()
    }
  }
}

/// Older runtimes retain the service API without opening a microphone.
final class UnsupportedRecognizer: Recognizer {
  func availability(microphone: DictationMicrophone) async -> DictationAvailability {
    .unavailable(.os)
  }
  func download(progress: @escaping @Sendable (Double?) -> Void) async throws {
    throw DictationError.modelUnavailable
  }
  func admit() async throws { throw DictationError.modelUnavailable }
  func prepare() async throws { throw DictationError.modelUnavailable }
  func feed(_ buffer: AVAudioPCMBuffer) async throws {}
  func finishInput() async throws {}
  func finalize() async throws {}
  func results(_ receive: @escaping @Sendable (RecognitionResult) async -> Void) async throws {}
  func cancel() async {}
}
