@preconcurrency import AppKit
import CoreServices
import Foundation

/// How macOS answers about the helper's Automation of Messages. `MessagesApp`
/// is the real one; tests drive their own.
protocol AutomationTarget: Sendable {
  func isRunning() -> Bool
  func launch(activating: Bool) async
  /// macOS answers synchronously. Asked with `ask`, the call waits for as long
  /// as the person takes over macOS's question, and while that question is on
  /// screen macOS holds every other answer about the same pair too.
  func determine(ask: Bool) -> DataGrantState
}

/// The helper's Automation permission for Messages, which macOS keeps per
/// app it sends Apple events to and reports only while that app runs.
///
/// One per process, because the question macOS shows is one per process:
/// while it is on screen the answer is plainly not given yet, so nothing here
/// asks macOS anything until the person has answered, and a second request
/// waits for the same answer rather than asking again. Every call into macOS
/// leaves the caller's thread (`Blocking`), so the main actor never waits on
/// the person.
actor MessagesAutomation {
  static let shared = MessagesAutomation(target: MessagesApp())

  private let target: any AutomationTarget
  private let checkTimeout: TimeInterval
  private let settleAttempts: Int
  private let settleInterval: UInt64
  /// macOS's question, while the person has it on screen.
  private var question: Task<DataGrantState, Never>?
  /// A request under way, which another request joins.
  private var requesting: Task<DataGrantState, Never>?
  /// The one check under way that does not ask, and its answer bounded by
  /// `checkTimeout`, which every read meanwhile shares: a check macOS holds
  /// never collects a waiter per read.
  private var checking: (id: UInt64, answer: Task<DataGrantState, Never>)?
  private var checks: UInt64 = 0

  /// `checkTimeout` bounds a check macOS is holding for a question this
  /// helper did not put up: the answer is `unknown`, and the check goes on
  /// for whoever reads next.
  init(
    target: any AutomationTarget,
    checkTimeout: TimeInterval = 2,
    settleAttempts: Int = 50,
    settleInterval: UInt64 = 100_000_000
  ) {
    self.target = target
    self.checkTimeout = checkTimeout
    self.settleAttempts = settleAttempts
    self.settleInterval = settleInterval
  }

  /// Never prompts and never starts Messages: `unknown` while it is not
  /// running, since macOS answers only for an app that is, and `requestable`
  /// while the person is being asked.
  func state() async -> DataGrantState {
    if question != nil { return .requestable }
    guard target.isRunning() else { return .unknown }
    return await check()
  }

  /// The definite answer a send needs, without asking the person: Messages
  /// is started out of sight when it is not running, as sending would start
  /// it anyway, until macOS can answer.
  func stateForSending() async -> DataGrantState {
    let current = await state()
    guard current == .unknown else { return current }
    await target.launch(activating: false)
    return await settled()
  }

  /// The person at this Mac asked: Messages comes forward, so macOS's
  /// question names an app they can see, and macOS asks if it has not.
  func request() async -> DataGrantState {
    if let requesting { return await requesting.value }
    let task = Task { await self.ask() }
    requesting = task
    let answer = await task.value
    requesting = nil
    return answer
  }

  private func ask() async -> DataGrantState {
    await target.launch(activating: true)
    let before = await settled()
    // Asked before, or Messages never came up: there is nothing to ask.
    guard before == .requestable else { return before }
    let target = self.target
    let question = Task { await Blocking.run { target.determine(ask: true) } }
    self.question = question
    let answer = await question.value
    self.question = nil
    return answer
  }

  /// A just-started Messages takes a moment to answer Apple events.
  private func settled() async -> DataGrantState {
    for _ in 0..<settleAttempts {
      let current = await state()
      if current != .unknown { return current }
      try? await Task.sleep(nanoseconds: settleInterval)
    }
    return .unknown
  }

  private func check() async -> DataGrantState {
    if let checking { return await checking.answer.value }
    checks += 1
    let id = checks
    let target = self.target
    let timeout = checkTimeout
    // The check ends before its answer is given, so a read that starts after
    // an answer asks macOS again: the person may have answered or switched it
    // since. Ended separately, a read could still join the finished check.
    let call = Task { [weak self] in
      let state = await Blocking.run { target.determine(ask: false) }
      await self?.finishCheck(id)
      return state
    }
    let answer = Task { await Blocking.first(call, orAfter: timeout, otherwise: .unknown) }
    checking = (id, answer)
    return await answer.value
  }

  private func finishCheck(_ id: UInt64) {
    if checking?.id == id { checking = nil }
  }
}

/// Messages, as macOS reports it.
struct MessagesApp: AutomationTarget {
  static let bundleIdentifier = "com.apple.MobileSMS"

  func isRunning() -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleIdentifier).isEmpty
  }

  func launch(activating: Bool) async {
    await Self.open(activating: activating)
  }

  @MainActor
  private static func open(activating: Bool) async {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
    else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = activating
    configuration.hides = !activating
    configuration.addsToRecentItems = false
    _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
  }

  func determine(ask: Bool) -> DataGrantState {
    let target = NSAppleEventDescriptor(bundleIdentifier: Self.bundleIdentifier)
    guard let descriptor = target.aeDesc else { return .unknown }
    let wildcard = AEEventClass(0x2a2a_2a2a)
    switch AEDeterminePermissionToAutomateTarget(descriptor, wildcard, wildcard, ask) {
    case noErr: return .granted
    case OSStatus(errAEEventWouldRequireUserConsent): return .requestable
    case OSStatus(errAEEventNotPermitted): return .denied
    default: return .unknown
    }
  }
}

/// How the helper finds out about its own Full Disk Access, which macOS gives
/// no way to ask for or read: a gated open is the only honest probe.
/// `~/.Trash` exists for every account and only this grant gates it; a refused
/// probe is also what lists this helper in the Full Disk Access pane for the
/// person to switch on.
protocol FullDiskAccessProbing: Sendable {
  /// This process's answer, which macOS settles for the life of the process.
  func thisProcess() -> DataGrantState
  /// A new process's answer: a child of this helper is the same app to macOS,
  /// and sees a switch the person turned on after this process started.
  func freshProcess() async -> DataGrantState
}

public struct FullDiskAccessProbes: FullDiskAccessProbing {
  /// The argument that makes the helper print this answer and quit.
  public static let argument = "--probe-full-disk-access"

  public init() {}

  public func thisProcess() -> DataGrantState {
    let trash = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".Trash").path
    let descriptor = open(trash, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    if descriptor >= 0 {
      close(descriptor)
      return .granted
    }
    return errno == EPERM ? .denied : .unknown
  }

  func freshProcess() async -> DataGrantState {
    // Only the helper app is the same app to macOS as its child; any other
    // process (a test runner) would ask about something else entirely.
    guard Bundle.main.bundleIdentifier == Log.subsystem,
      let executable = Bundle.main.executableURL
    else { return .unknown }
    return await Blocking.run {
      let process = Process()
      process.executableURL = executable
      process.arguments = [Self.argument]
      let output = Pipe()
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      let exited = DispatchSemaphore(value: 0)
      process.terminationHandler = { _ in exited.signal() }
      do { try process.run() } catch { return .unknown }
      guard exited.wait(timeout: .now() + 2) == .success else {
        process.terminate()
        return .unknown
      }
      let said = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      return DataGrantState(rawValue: said.trimmingCharacters(in: .whitespacesAndNewlines))
        ?? .unknown
    }
  }
}

/// The helper's Full Disk Access, including a switch turned on after launch.
///
/// macOS applies Full Disk Access to a process from its next launch: until
/// then this process's own probe stays refused however long the person has
/// had the switch on. A refused probe therefore asks a fresh child once a
/// second at most; a child that is allowed means the grant is there and this
/// process is the only thing still without it, so the helper restarts as soon
/// as nothing is under way. Until it has, the grant reads as this process has
/// it — denied — so nothing reports success before a read can succeed.
actor FullDiskAccessGrant {
  static let shared = FullDiskAccessGrant(probe: FullDiskAccessProbes())

  private let probe: any FullDiskAccessProbing
  private let freshInterval: TimeInterval
  private let now: @Sendable () -> Date
  private var lastFresh: (at: Date, state: DataGrantState)?
  private var probing: Task<DataGrantState, Never>?
  private var grantedAfterLaunch: (@Sendable () -> Void)?
  /// The grant is there and this process cannot use it until it restarts.
  private(set) var awaitingRestart = false

  init(
    probe: any FullDiskAccessProbing,
    freshInterval: TimeInterval = 1,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.probe = probe
    self.freshInterval = freshInterval
    self.now = now
  }

  /// Called once, the first time the grant is found to have arrived after
  /// launch.
  func whenGrantedAfterLaunch(_ handler: @escaping @Sendable () -> Void) {
    grantedAfterLaunch = handler
  }

  func state() async -> DataGrantState {
    let own = probe.thisProcess()
    guard own == .denied, !awaitingRestart else { return own }
    let fresh = await fresh()
    // Another read may have found it while this one waited on the child.
    guard fresh == .granted, !awaitingRestart else { return own }
    awaitingRestart = true
    grantedAfterLaunch?()
    return own
  }

  private func fresh() async -> DataGrantState {
    if let probing { return await probing.value }
    if let lastFresh, now().timeIntervalSince(lastFresh.at) < freshInterval {
      return lastFresh.state
    }
    let probe = self.probe
    let task = Task { await probe.freshProcess() }
    probing = task
    let state = await task.value
    probing = nil
    lastFresh = (now(), state)
    return state
  }
}

/// Calls macOS may hold for as long as a person takes, run where waiting
/// costs nothing else: never on the main actor, never on Swift's cooperative
/// pool, whose few threads every other task in the helper shares.
enum Blocking {
  private static let queue = DispatchQueue(
    label: "com.opensteer.computer-use.blocking", qos: .userInitiated, attributes: .concurrent)

  static func run<Value: Sendable>(_ work: @escaping @Sendable () -> Value) async -> Value {
    await withCheckedContinuation { continuation in
      queue.async { continuation.resume(returning: work()) }
    }
  }

  /// The task's answer, or `fallback` once `seconds` pass, whichever comes
  /// first. The task itself carries on.
  static func first<Value: Sendable>(
    _ task: Task<Value, Never>, orAfter seconds: TimeInterval, otherwise fallback: Value
  ) async -> Value {
    await withCheckedContinuation { continuation in
      let once = ResumeOnce(continuation)
      Task { once.resume(await task.value) }
      Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        once.resume(fallback)
      }
    }
  }
}

private final class ResumeOnce<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Never>?

  init(_ continuation: CheckedContinuation<Value, Never>) {
    self.continuation = continuation
  }

  func resume(_ value: Value) {
    let waiting = lock.withLock { () -> CheckedContinuation<Value, Never>? in
      defer { continuation = nil }
      return continuation
    }
    waiting?.resume(returning: value)
  }
}
