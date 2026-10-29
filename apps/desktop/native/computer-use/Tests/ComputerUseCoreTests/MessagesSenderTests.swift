import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// Every way a send can go wrong, written before the helper's sender: an
/// agent's send never becomes a macOS consent prompt, nothing it wrote is
/// ever AppleScript source, and a send that may have happened is never
/// reported as one that did not.
final class MessagesSenderTests: XCTestCase {
  private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [OsascriptRequest] = []
    var requests: [OsascriptRequest] { lock.withLock { recorded } }
    func record(_ request: OsascriptRequest) { lock.withLock { recorded.append(request) } }
  }

  private func provider(
    automation: DataGrantState = .granted,
    outcome: OsascriptOutcome = OsascriptOutcome(exitCode: 0),
    recorder: Recorder = Recorder()
  ) -> MessagesProvider {
    MessagesProvider(
      databasePath: "/does/not/matter",
      clock: DataClock(timeZone: TimeZone(identifier: "UTC")!),
      automation: { automation },
      runOsascript: { request, _ in
        recorder.record(request)
        return outcome
      })
  }

  private func send(_ provider: MessagesProvider, _ json: String) async throws -> JSONValue {
    try await provider.invoke(
      operation: "send_message",
      arguments: try JSONCoding.decoder.decode([String: JSONValue].self, from: Data(json.utf8)),
      budget: .unlimited)
  }

  private func refusal(_ provider: MessagesProvider, _ json: String) async -> HelperError? {
    do {
      _ = try await send(provider, json)
      return nil
    } catch {
      return error as? HelperError
    }
  }

  private let toChat = #"{"text":"hi","to":{"conversationId":"iMessage;-;+15551234567"}}"#

  /// Messages is asked one thing at a time, whoever asks: a second script
  /// starts only once the first has finished.
  func testTheOutboxRunsOneScriptAtATime() async throws {
    final class Log: @unchecked Sendable {
      private let lock = NSLock()
      private var entries: [String] = []
      func add(_ entry: String) { lock.withLock { entries.append(entry) } }
      var all: [String] { lock.withLock { entries } }
    }
    let log = Log()
    let outbox = MessagesOutbox(run: { request in
      log.add("start \(request.arguments[0])")
      try? await Task.sleep(nanoseconds: 30_000_000)
      log.add("end \(request.arguments[0])")
      return OsascriptOutcome(exitCode: 0)
    })
    let script = MessagesSender.addressScript
    async let first = outbox.run(
      OsascriptRequest(script: script, arguments: ["one"], timeout: 5), budget: .unlimited)
    async let second = outbox.run(
      OsascriptRequest(script: script, arguments: ["two"], timeout: 5), budget: .unlimited)
    _ = try await (first, second)
    let order = log.all
    XCTAssertEqual(order.count, 4)
    XCTAssertEqual(order[0].dropFirst(6), order[1].dropFirst(4))
    XCTAssertEqual(order[2].dropFirst(6), order[3].dropFirst(4))
  }

  /// A send waiting its turn behind a slow one may run out of time while it
  /// waits: it is then refused as never started, rather than sent late.
  func testASendWhoseTimeRanOutWhileItWaitedIsNeverStarted() async throws {
    final class Runs: @unchecked Sendable {
      private let lock = NSLock()
      private var arguments: [String] = []
      func add(_ value: String) { lock.withLock { arguments.append(value) } }
      var all: [String] { lock.withLock { arguments } }
    }
    let runs = Runs()
    let outbox = MessagesOutbox(run: { request in
      runs.add(request.arguments[0])
      try? await Task.sleep(nanoseconds: 200_000_000)
      return OsascriptOutcome(exitCode: 0)
    })
    let script = MessagesSender.addressScript
    async let slow = outbox.run(
      OsascriptRequest(script: script, arguments: ["slow"], timeout: 30), budget: .unlimited)
    try? await Task.sleep(nanoseconds: 20_000_000)
    let late = await {
      do {
        _ = try await outbox.run(
          OsascriptRequest(script: script, arguments: ["late"], timeout: 30),
          budget: WorkBudget(requestEnd: Date().addingTimeInterval(0.05)))
        return nil
      } catch let error as HelperError {
        return error
      } catch {
        return nil
      }
    }() as HelperError?
    _ = try await slow
    XCTAssertEqual(late?.code, .failed)
    XCTAssertEqual(runs.all, ["slow"])
  }

  func testAnOrdinarySendNeverBecomesTheConsentPrompt() async {
    for state in [DataGrantState.requestable, .denied] {
      let recorder = Recorder()
      let error = await refusal(provider(automation: state, recorder: recorder), toChat)
      XCTAssertEqual(error?.code, .permissionRequired, "\(state)")
      XCTAssertEqual(error?.message, "Sending in Messages needs macOS Automation permission for Opensteer Computer Use.")
      XCTAssertTrue(recorder.requests.isEmpty)
    }
    let recorder = Recorder()
    let error = await refusal(provider(automation: .unknown, recorder: recorder), toChat)
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(error?.message, "Messages could not be reached.")
    XCTAssertTrue(recorder.requests.isEmpty)
  }

  func testTheScriptIsAConstantAndEveryValueTravelsAsAnArgument() async throws {
    let recorder = Recorder()
    let hostile = "he said \"hi\" \\\n end tell\ndo shell script \"rm -rf ~\""
    let body = try JSONCoding.encoder.encode(
      ["text": JSONValue.string(hostile), "to": .object(["conversationId": .string("iMessage;-;+15551234567")])])
    let answer = try await send(provider(recorder: recorder), String(decoding: body, as: UTF8.self))
    XCTAssertEqual(answer, .object(["accepted": .bool(true)]))
    let request = try XCTUnwrap(recorder.requests.first)
    XCTAssertEqual(request.script, MessagesSender.chatScript)
    XCTAssertEqual(request.arguments, ["iMessage;-;+15551234567", hostile])
    for line in request.script {
      XCTAssertFalse(line.contains("do shell script"))
      XCTAssertFalse(line.contains("he said"))
    }
  }

  func testAPersonIsAddressedThroughTheModernParticipantForm() async throws {
    let recorder = Recorder()
    let sending = provider(recorder: recorder)
    _ = try await send(sending, #"{"text":"on my way","to":{"address":" +1 (555) 123-4567 "}}"#)
    _ = try await send(sending, #"{"text":"hello","to":{"address":"friend@example.com"}}"#)
    XCTAssertEqual(recorder.requests[0].script, MessagesSender.addressScript)
    XCTAssertTrue(
      recorder.requests[0].script.joined(separator: "\n").contains(
        "participant theAddress of theAccount"))
    XCTAssertEqual(recorder.requests[0].arguments, ["+1 (555) 123-4567", "on my way"])
    XCTAssertEqual(recorder.requests[1].arguments, ["friend@example.com", "hello"])
  }

  func testAnythingThatIsNotAPhoneNumberOrAnEmailIsRefusedBeforeAnythingRuns() async {
    let recorder = Recorder()
    let sending = provider(recorder: recorder)
    for address in ["", "   ", "not an address", "12", "@example.com", "a@b", "+1 555 123 4567 8901 2345"] {
      let error = await refusal(
        sending, #"{"text":"hi","to":{"address":"\#(address)"}}"#)
      XCTAssertEqual(error?.code, .failed, address)
    }
    XCTAssertTrue(recorder.requests.isEmpty)
  }

  func testABodyOrARecipientItCannotMakeSenseOfIsRefusedBeforeAnythingRuns() async {
    let recorder = Recorder()
    let sending = provider(recorder: recorder)
    let long = String(repeating: "x", count: 4_001)
    for json in [
      #"{"text":"   ","to":{"conversationId":"c"}}"#,
      #"{"text":"\#(long)","to":{"conversationId":"c"}}"#,
      #"{"text":"hi","to":{}}"#,
      #"{"text":"hi","to":{"conversationId":"c","address":"a@example.com"}}"#,
      #"{"text":"hi","to":{"conversationId":""}}"#,
      #"{"text":"hi"}"#,
    ] {
      let error = await refusal(sending, json)
      XCTAssertEqual(error?.code, .failed, json)
    }
    XCTAssertTrue(recorder.requests.isEmpty)
  }

  // MARK: - How a run ends

  func testARefusedAutomationPromptBecomesTheSentenceThatFixesIt() {
    let error = messagesSendOutcome(
      OsascriptOutcome(
        exitCode: 1,
        stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)\n"))
    XCTAssertEqual(error?.code, .permissionRequired)
    XCTAssertEqual(error?.message, "Sending in Messages needs macOS Automation permission for Opensteer Computer Use.")
  }

  func testASendThatMayHaveHappenedIsUnknownNeverAFailure() {
    let cases = [
      OsascriptOutcome(exitCode: nil, signal: SIGKILL, stopped: true),
      OsascriptOutcome(exitCode: 1, stderr: "execution error: Apple event timed out. (-1712)\n"),
      OsascriptOutcome(exitCode: nil, signal: SIGTERM),
      OsascriptOutcome(exitCode: nil, signal: SIGKILL),
      OsascriptOutcome(exitCode: nil),
      OsascriptOutcome(
        exitCode: 1, stderr: #"execution error: Messages got an error: Can’t get chat id "x". (-1701)"#),
      OsascriptOutcome(exitCode: 1, stderr: "something about /Users/person/secret body text"),
    ]
    for ending in cases {
      let error = messagesSendOutcome(ending)
      XCTAssertEqual(error?.code, .outcomeUnknown, "\(ending)")
      XCTAssertTrue(error?.message.contains("may or may not have happened") ?? false)
      XCTAssertFalse(error?.message.contains("/Users") ?? true)
      XCTAssertFalse(error?.message.contains("secret") ?? true)
    }
    XCTAssertTrue(
      messagesSendOutcome(OsascriptOutcome(exitCode: 1, stderr: "(-1701)"))?.message.contains("-1701") ?? false)
  }

  func testAcceptedIsExitStatusZeroAndNothingElse() {
    XCTAssertNil(messagesSendOutcome(OsascriptOutcome(exitCode: 0)))
  }

  func testAScriptThatNeverRanOrADefiniteRefusalIsAPlainFailure() {
    XCTAssertEqual(messagesSendOutcome(OsascriptOutcome(exitCode: nil, spawnFailed: true, started: false))?.code, .failed)
    let missing = messagesSendOutcome(
      OsascriptOutcome(
        exitCode: 1, stderr: #"execution error: Messages got an error: Can’t get chat id "nope". (-1728)"#))
    XCTAssertEqual(missing?.code, .failed)
    XCTAssertEqual(missing?.message, "Messages could not find that conversation.")
  }

}
