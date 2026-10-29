import Foundation
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// Every way reading a macOS grant could hold the helper up or ask the person
/// twice, written before the code that reads them.
///
/// macOS answers grant questions synchronously, and while it shows the
/// person a question about Messages it holds every other question about the
/// same pair until the person answers. A helper that asks on its main thread
/// stops answering anything at all for as long as the question is open.
final class GrantReadingTests: XCTestCase {
  // MARK: - Automation of Messages

  func testStatusAnswersAtOnceWhileMacOSIsAskingThePerson() async {
    let messages = FakeMessagesApp(running: true)
    let automation = MessagesAutomation(target: messages)
    let asking = Task { await automation.request() }
    await messages.waitUntilAsking()

    let started = Date()
    let state = await automation.state()
    XCTAssertEqual(state, .requestable)
    XCTAssertLessThan(Date().timeIntervalSince(started), 0.5)
    XCTAssertEqual(messages.checksWhileAsking, 0, "a status read must not wait on the question")

    messages.personAnswers(.granted)
    let answered = await asking.value
    XCTAssertEqual(answered, .granted)
    let after = await automation.state()
    XCTAssertEqual(after, .granted)
  }

  func testTwoRequestsAskMacOSOnce() async {
    let messages = FakeMessagesApp(running: true)
    let automation = MessagesAutomation(target: messages)
    let first = Task { await automation.request() }
    await messages.waitUntilAsking()
    let second = Task { await automation.request() }
    try? await Task.sleep(nanoseconds: 50_000_000)
    messages.personAnswers(.denied)
    let answers = await [first.value, second.value]
    XCTAssertEqual(answers, [.denied, .denied])
    XCTAssertEqual(messages.asks, 1)
  }

  func testARequestForAnAnsweredGrantNeverAsks() async {
    for answer in [DataGrantState.granted, .denied] {
      let messages = FakeMessagesApp(running: true, answer: answer)
      let automation = MessagesAutomation(target: messages)
      let state = await automation.request()
      XCTAssertEqual(state, answer)
      XCTAssertEqual(messages.asks, 0)
    }
  }

  func testARequestWhenMessagesCannotStartAsksNothing() async {
    let messages = FakeMessagesApp(running: false, starts: false)
    let automation = MessagesAutomation(target: messages, settleAttempts: 3, settleInterval: 1_000_000)
    let state = await automation.request()
    XCTAssertEqual(state, .unknown)
    XCTAssertEqual(messages.asks, 0)
  }

  func testASendWhileThePersonIsBeingAskedIsRefusedWithoutAsking() async {
    let messages = FakeMessagesApp(running: true)
    let automation = MessagesAutomation(target: messages)
    let asking = Task { await automation.request() }
    await messages.waitUntilAsking()
    let sending = await automation.stateForSending()
    XCTAssertEqual(sending, .requestable)
    XCTAssertEqual(messages.asks, 1)
    messages.personAnswers(.granted)
    _ = await asking.value
  }

  /// Another process's question about Messages can hold macOS's answer too.
  /// The read gives up in time, and reads meanwhile share the one waiting.
  func testAStatusMacOSHoldsAnswersUnknownInTimeWithoutPilingUp() async {
    let messages = FakeMessagesApp(running: true, stallChecks: true)
    let automation = MessagesAutomation(target: messages, checkTimeout: 0.2)
    let started = Date()
    async let first = automation.state()
    async let second = automation.state()
    let states = await [first, second]
    XCTAssertEqual(states, [.unknown, .unknown])
    XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    // Reads after the timeout share its answer at once, still one call.
    let later = Date()
    for _ in 0..<20 {
      let state = await automation.state()
      XCTAssertEqual(state, .unknown)
    }
    XCTAssertLessThan(Date().timeIntervalSince(later), 0.2)
    XCTAssertEqual(messages.checks, 1)
    messages.releaseChecks()
  }

  /// A read that starts after a check has answered asks macOS again: the
  /// person may have answered or switched it in between. Joining the finished
  /// check read `requestable` after the person allowed it (gate c46, load 100).
  func testAReadAfterACheckHasAnsweredSeesTheNewAnswer() async {
    let messages = FakeMessagesApp(running: true)
    let automation = MessagesAutomation(target: messages)
    for round in 0..<1000 {
      let answer: DataGrantState = round.isMultiple(of: 2) ? .granted : .denied
      messages.personSwitches(to: answer)
      let state = await automation.state()
      guard state == answer else {
        return XCTFail("Round \(round) read \(state) after macOS answered \(answer)")
      }
    }
  }

  func testStatusWhileMessagesIsClosedIsUnknownAndAsksNothing() async {
    let messages = FakeMessagesApp(running: false)
    let automation = MessagesAutomation(target: messages)
    let state = await automation.state()
    XCTAssertEqual(state, .unknown)
    XCTAssertEqual(messages.checks, 0)
  }

  // MARK: - Full Disk Access

  func testFullDiskAccessThisProcessHasNeverStartsAProbe() async {
    let probe = FakeFullDiskAccessProbe(thisProcess: .granted, fresh: .granted)
    let grant = FullDiskAccessGrant(probe: probe)
    let state = await grant.state()
    XCTAssertEqual(state, .granted)
    XCTAssertEqual(probe.freshProbes, 0)
    let waiting = await grant.awaitingRestart
    XCTAssertFalse(waiting)
  }

  /// The person switched it on after this process started: macOS applies it
  /// to a process only from its next launch. The helper asks once to be
  /// restarted, and until it has, the grant reads as this process has it, so
  /// nothing reports success before a read can succeed — however many reads
  /// race to find it.
  func testFullDiskAccessGivenAfterLaunchAsksOnceForARestartAndReadsDeniedUntilThen() async {
    let probe = FakeFullDiskAccessProbe(thisProcess: .denied, fresh: .granted)
    let grant = FullDiskAccessGrant(probe: probe)
    let restarts = Counter()
    await grant.whenGrantedAfterLaunch { restarts.increment() }
    async let first = grant.state()
    async let second = grant.state()
    let states = await [first, second]
    let third = await grant.state()
    XCTAssertEqual(states, [.denied, .denied])
    XCTAssertEqual(third, .denied)
    let waiting = await grant.awaitingRestart
    XCTAssertTrue(waiting)
    XCTAssertEqual(restarts.value, 1)
    XCTAssertEqual(probe.freshProbes, 1)
  }

  func testFullDiskAccessStillOffIsDeniedAndProbedAtMostOncePerInterval() async {
    let probe = FakeFullDiskAccessProbe(thisProcess: .denied, fresh: .denied)
    let clock = TestClock()
    let grant = FullDiskAccessGrant(probe: probe, freshInterval: 1, now: { clock.now })
    for _ in 0..<5 {
      let state = await grant.state()
      XCTAssertEqual(state, .denied)
    }
    XCTAssertEqual(probe.freshProbes, 1)
    clock.advance(1.1)
    _ = await grant.state()
    XCTAssertEqual(probe.freshProbes, 2)
  }

  func testAnOpenFailureThatIsNotTheGrantIsUnknownWithoutAProbe() async {
    let probe = FakeFullDiskAccessProbe(thisProcess: .unknown, fresh: .granted)
    let grant = FullDiskAccessGrant(probe: probe)
    let state = await grant.state()
    XCTAssertEqual(state, .unknown)
    XCTAssertEqual(probe.freshProbes, 0)
  }
}

// MARK: - Fakes

/// Messages as macOS reports it: `determine(ask: true)` blocks, as the real
/// call does, until the test answers for the person.
final class FakeMessagesApp: AutomationTarget, @unchecked Sendable {
  private let lock = NSLock()
  private var running: Bool
  private let starts: Bool
  private var answer: DataGrantState
  private var personAnswer: DataGrantState = .granted
  private var asking = false
  private var askCount = 0
  private var checkCount = 0
  private var checksDuringAsk = 0
  private let stallChecks: Bool
  private let askGate = DispatchSemaphore(value: 0)
  private let askEntered = DispatchSemaphore(value: 0)
  private let checkGate = DispatchSemaphore(value: 0)

  init(
    running: Bool, starts: Bool = true, answer: DataGrantState = .requestable,
    stallChecks: Bool = false
  ) {
    self.running = running
    self.starts = starts
    self.answer = answer
    self.stallChecks = stallChecks
  }

  var asks: Int { lock.withLock { askCount } }
  var checks: Int { lock.withLock { checkCount } }
  var checksWhileAsking: Int { lock.withLock { checksDuringAsk } }

  func isRunning() -> Bool { lock.withLock { running } }

  func launch(activating: Bool) async {
    lock.withLock { if starts { running = true } }
  }

  func determine(ask: Bool) -> DataGrantState {
    if ask {
      let current = lock.withLock { () -> DataGrantState in
        askCount += 1
        return answer
      }
      guard current == .requestable else { return current }
      lock.withLock { asking = true }
      askEntered.signal()
      askGate.wait()
      return lock.withLock {
        asking = false
        answer = personAnswer
        return answer
      }
    }
    lock.withLock {
      checkCount += 1
      if asking { checksDuringAsk += 1 }
    }
    if stallChecks { checkGate.wait() }
    return lock.withLock { answer }
  }

  func waitUntilAsking() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      DispatchQueue.global().async {
        self.askEntered.wait()
        continuation.resume()
      }
    }
  }

  func personAnswers(_ state: DataGrantState) {
    lock.withLock { personAnswer = state }
    askGate.signal()
  }

  /// The person flips the helper's switch for Messages in System Settings.
  func personSwitches(to state: DataGrantState) {
    lock.withLock { answer = state }
  }

  func releaseChecks() {
    for _ in 0..<8 { checkGate.signal() }
  }
}

final class FakeFullDiskAccessProbe: FullDiskAccessProbing, @unchecked Sendable {
  private let lock = NSLock()
  private let inProcess: DataGrantState
  private let fresh: DataGrantState
  private var freshCount = 0

  init(thisProcess: DataGrantState, fresh: DataGrantState) {
    inProcess = thisProcess
    self.fresh = fresh
  }

  var freshProbes: Int { lock.withLock { freshCount } }

  func thisProcess() -> DataGrantState { inProcess }

  func freshProcess() async -> DataGrantState {
    lock.withLock {
      freshCount += 1
      return fresh
    }
  }
}

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.withLock { count } }
  func increment() { lock.withLock { count += 1 } }
}

final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current = Date(timeIntervalSince1970: 1_000_000)
  var now: Date { lock.withLock { current } }
  func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}
