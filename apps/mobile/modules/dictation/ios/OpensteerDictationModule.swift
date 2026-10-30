import ExpoModulesCore
import OpensteerDictation
import UIKit

public final class OpensteerDictationModule: Module {
  private var runtime: DictationRuntime?
  @MainActor private func getRuntime() -> DictationRuntime {
    if let runtime { return runtime }
    let created = DictationRuntime { [weak self] json in self?.sendEvent("onDictation", ["json": json]) }
    runtime = created
    return created
  }
  public func definition() -> ModuleDefinition {
    Name("OpensteerDictation")
    Events("onDictation")
    OnDestroy { [weak self] in
      let runtime = self?.runtime
      Task { @MainActor in await runtime?.destroy() }
    }
    AsyncFunction("availability") { () async throws -> String in
      let runtime = await self.getRuntime()
      let availability = await runtime.service.availability()
      return try dictationJSON(availability)
    }
    AsyncFunction("start") { (session: String) async throws in
      let runtime = await self.getRuntime()
      await runtime.begin(session)
      try await runtime.service.start(session: session)
    }
    AsyncFunction("download") { (session: String) async throws in
      let runtime = await self.getRuntime()
      await runtime.begin(session)
      try await runtime.service.download(session: session)
    }
    AsyncFunction("stop") { (session: String) async in
      let runtime = await MainActor.run { self.runtime }
      await runtime?.stop(session)
    }
    AsyncFunction("cancel") { (session: String) async in
      let runtime = await MainActor.run { self.runtime }
      await runtime?.service.cancel(session: session)
    }
    AsyncFunction("openMicrophoneSettings") { () async in
      await MainActor.run { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
    }
  }
}

@MainActor private final class DictationRuntime {
  private var state = DictationLifecycle()
  private var observer: NSObjectProtocol?
  private var background: UIBackgroundTaskIdentifier = .invalid
  private let emit: (String) -> Void
  private let events = AsyncStream<DictationEvent>.makeStream()
  private var delivery: Task<Void, Never>?
  lazy var service = DictationService { [continuation = events.continuation] event in continuation.yield(event) }
  init(emit: @escaping (String) -> Void) {
    self.emit = emit
    delivery = Task { [weak self, stream = events.stream] in
      for await event in stream { self?.receive(event) }
    }
    observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor [weak self] in self?.interrupt() }
    }
  }
  func begin(_ session: String) { state.begin(session) }
  func stop(_ session: String) async {
    if state.session == session { restoreIdleTimer() }
    await service.stop(session: session)
  }
  private func restoreIdleTimer() {
    if let previous = state.stopListening() { UIApplication.shared.isIdleTimerDisabled = previous }
  }
  private func interrupt() {
    guard state.session != nil, background == .invalid else { return }
    restoreIdleTimer()
    background = UIApplication.shared.beginBackgroundTask { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, let session = self.state.expire() else { return }
        await self.service.cancel(session: session)
      }
    }
    Task { await service.interrupt() }
  }
  private func receive(_ event: DictationEvent) {
    var forwarded = event
    switch event.payload {
    case .listening:
      if state.listening(event.session, previous: UIApplication.shared.isIdleTimerDisabled) { UIApplication.shared.isIdleTimerDisabled = true }
    case .ended:
      if state.expiring == event.session { forwarded = DictationEvent(session: event.session, seq: event.seq, payload: .ended(.interrupted, nil)) }
      let owns = state.session == event.session
      if let previous = state.ended(event.session) { UIApplication.shared.isIdleTimerDisabled = previous }
      if owns { endBackground() }
    default: break
    }
    if let json = try? dictationJSON(forwarded) { emit(json) }
  }
  private func endBackground() {
    if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
  }
  func destroy() async {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    if let session = state.session {
      if let previous = state.ended(session) { UIApplication.shared.isIdleTimerDisabled = previous }
      await service.cancel(session: session)
    }
    endBackground()
    events.continuation.finish(); delivery?.cancel()
  }
}
