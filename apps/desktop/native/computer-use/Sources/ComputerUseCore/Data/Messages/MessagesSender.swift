import Darwin
import Foundation

/// One run of `/usr/bin/osascript`: a script that is a constant of this file,
/// and the values it reads as `argv`.
public struct OsascriptRequest: Sendable, Equatable {
  public let script: [String]
  /// The only place a recipient or a body appears.
  public let arguments: [String]
  public let timeout: TimeInterval
}

/// How one run ended. `stopped` is this helper's own kill at the deadline;
/// `signal` is any signal that ended it, whoever sent it.
public struct OsascriptOutcome: Sendable, Equatable {
  public var exitCode: Int32?
  public var signal: Int32?
  public var spawnFailed = false
  /// True once the process exists, and so once a send may have happened.
  public var started = true
  public var stderr = ""
  public var stdout = ""
  public var stopped = false
}

/// Every run of `osascript` against Messages, one at a time: the agent's
/// sends and the iMessage channel's alike, so Messages is never asked two
/// things at once and their order is the order they were asked in.
public actor MessagesOutbox {
  static let shared = MessagesOutbox(run: { await MessagesSender.runOsascript($0) })

  private let runner: OsascriptRunner
  /// The run most recently queued; each waits for the one before it, since
  /// an actor alone would let a second start while the first is suspended.
  private var last: Task<Void, Never> = Task {}

  init(run: @escaping OsascriptRunner) {
    runner = run
  }

  /// Runs one script once every script asked before it has finished. The
  /// write starts only then: one whose request ran out of time while it
  /// waited is refused as never started, and the time left is what it may
  /// run for.
  func run(_ request: OsascriptRequest, budget: WorkBudget) async throws -> OsascriptOutcome {
    let previous = last
    let runner = self.runner
    let queued = Task { () throws -> OsascriptOutcome in
      await previous.value
      try budget.startWrite()
      return await runner(
        OsascriptRequest(
          script: request.script, arguments: request.arguments,
          timeout: min(request.timeout, max(1, budget.remaining() - 1))))
    }
    last = Task { _ = try? await queued.value }
    return try await queued.value
  }
}

public typealias OsascriptRunner = @Sendable (OsascriptRequest) async -> OsascriptOutcome

/// Sending goes through `osascript` with a constant script and the recipient
/// and body as `argv`, so nothing a person or an agent wrote is ever
/// AppleScript source: a body holding a quote or `do shell script` stays a
/// body. The run is a child of this helper, so macOS asks the person about
/// Opensteer Computer Use controlling Messages, never about Opensteer.
enum MessagesSender {
  static let osascript = "/usr/bin/osascript"
  static let timeout: TimeInterval = 30
  static let textMaxLength = 4_000
  static let conversationIdMaxLength = 256

  static let chatScript = [
    "on run argv",
    "set theChatId to item 1 of argv",
    "set theText to item 2 of argv",
    "tell application \"Messages\" to send theText to chat id theChatId",
    "end run",
  ]

  /// macOS 13 and later name the other end a `participant`.
  static let addressScript = [
    "on run argv",
    "set theAddress to item 1 of argv",
    "set theText to item 2 of argv",
    "tell application \"Messages\"",
    "set theAccount to 1st account whose service type = iMessage",
    "send theText to participant theAddress of theAccount",
    "end tell",
    "end run",
  ]

  struct Arguments: Decodable {
    struct Recipient: Decodable {
      let address: String?
      let conversationId: String?
    }

    let text: String
    let to: Recipient
  }

  /// The run a send makes, or why it makes none: every refusal here is
  /// before anything was sent.
  static func request(_ arguments: Arguments) throws -> OsascriptRequest {
    let text = arguments.text
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.count <= textMaxLength
    else {
      throw HelperError(.failed, "text must be between 1 and \(textMaxLength) characters.")
    }
    switch (arguments.to.conversationId, arguments.to.address) {
    case (let conversationId?, nil):
      guard (1...conversationIdMaxLength).contains(conversationId.count) else {
        throw HelperError(.failed, "to.conversationId is not a conversation.")
      }
      return OsascriptRequest(script: chatScript, arguments: [conversationId, text], timeout: timeout)
    case (nil, let address?):
      // Refused here rather than by Messages: a send is not a thing to find
      // out about by trying.
      guard let address = sendable(address) else {
        throw HelperError(.failed, "to.address must be a phone number or an email address.")
      }
      return OsascriptRequest(script: addressScript, arguments: [address, text], timeout: timeout)
    case (.some, .some):
      throw HelperError(.failed, "to must name either a conversation or an address, not both.")
    case (nil, nil):
      throw HelperError(.failed, "to must name a conversation or an address.")
    }
  }

  private static func sendable(_ value: String) -> String? {
    let address = value.trimmingCharacters(in: .whitespaces)
    guard !address.isEmpty, address.count <= 254 else { return nil }
    if address.wholeMatch(of: #/[^\s@]{1,64}@[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})+/#) != nil {
      return address
    }
    guard address.wholeMatch(of: #/\+?[0-9][0-9\s().-]{3,23}/#) != nil else { return nil }
    let digits = address.filter(\.isASCII).filter(\.isNumber).count
    return (5...15).contains(digits) ? address : nil
  }

  /// Turns one run into an answer. What matters is whether it could already
  /// have sent: one that never started could not, so it is a plain failure;
  /// one that started and ended any way not named here may have, so it is
  /// `outcome-unknown` and nothing repeats it.
  static func check(_ outcome: OsascriptOutcome) throws {
    if outcome.spawnFailed || !outcome.started {
      throw HelperError(.failed, "Messages could not be reached.")
    }
    if outcome.stopped {
      throw HelperError(
        .outcomeUnknown, "Messages did not answer in time. The send may or may not have happened.")
    }
    guard outcome.signal == nil, let exitCode = outcome.exitCode else {
      // A signal nobody here sent reached a script already talking to Messages.
      throw HelperError(
        .outcomeUnknown,
        "Messages was stopped before it answered. The send may or may not have happened.")
    }
    if exitCode == 0 { return }
    switch errorNumber(outcome.stderr) {
    case -1743:
      throw HelperError(.permissionRequired, DataPlane.permissionSentence(.automation))
    case -1728:
      throw HelperError(.failed, "Messages could not find that conversation.")
    case let number?:
      throw HelperError(
        .outcomeUnknown,
        "Messages did not confirm the send (AppleScript error \(number)). The send may or may not have happened."
      )
    case nil:
      throw HelperError(
        .outcomeUnknown, "Messages did not confirm the send. The send may or may not have happened.")
    }
  }

  /// The error number is the only part of the error safe to pass on: the
  /// rest quotes the script's own values, the recipient and the body.
  private static func errorNumber(_ stderr: String) -> Int? {
    guard let match = stderr.prefix(8_192).firstMatch(of: #/\(\s*(-[0-9]{1,6})\s*\)/#) else {
      return nil
    }
    return Int(match.1)
  }

  /// Runs the real `osascript`, killing it at the deadline.
  static func runOsascript(_ request: OsascriptRequest, binary: String = osascript) async
    -> OsascriptOutcome
  {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(returning: run(request, binary: binary))
      }
    }
  }

  private static func run(_ request: OsascriptRequest, binary: String) -> OsascriptOutcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    // `--` so a body starting with `-` is never read as an option.
    process.arguments = request.script.flatMap { ["-e", $0] } + ["--"] + request.arguments
    process.standardInput = FileHandle.nullDevice
    let output = Pipe()
    process.standardOutput = output
    let errors = Pipe()
    process.standardError = errors
    do {
      try process.run()
    } catch {
      return OsascriptOutcome(exitCode: nil, spawnFailed: true, started: false)
    }
    let stopped = StopFlag()
    let deadline = DispatchWorkItem { [process] in
      guard process.isRunning else { return }
      stopped.set()
      kill(process.processIdentifier, SIGKILL)
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + request.timeout, execute: deadline)
    // Both pipes drain at once, so neither can fill and stall the other.
    let collected = OutputBox()
    let reading = DispatchGroup()
    reading.enter()
    DispatchQueue.global().async {
      collected.stdout = output.fileHandleForReading.readDataToEndOfFile().prefix(8_192)
      reading.leave()
    }
    let stderr = errors.fileHandleForReading.readDataToEndOfFile().prefix(8_192)
    reading.wait()
    process.waitUntilExit()
    deadline.cancel()
    let signaled = process.terminationReason == .uncaughtSignal
    return OsascriptOutcome(
      exitCode: signaled ? nil : process.terminationStatus,
      signal: signaled ? process.terminationStatus : nil,
      stderr: String(decoding: stderr, as: UTF8.self),
      stdout: String(decoding: collected.stdout, as: UTF8.self),
      stopped: stopped.isSet)
  }

  private final class OutputBox: @unchecked Sendable {
    var stdout = Data()
  }

  private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
  }
}
