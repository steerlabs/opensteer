import Darwin
import Foundation
import PasswordsCore

public enum ImportFailure: Error, Equatable, Sendable {
  /// The worker crashed, hung, flooded its output or printed something that
  /// is not an answer: "Opensteer couldn’t read that file."
  case unreadable
  /// The worker read the file and refused it, with a reason the person can act on.
  case refused(ImportError)
}

/// Runs the sandboxed import worker on one export.
///
/// The export's open file is the worker's standard input, so the broker
/// never parses it. The worker gets 20 seconds and 64 MiB of output; past
/// either it is killed. Its answer is parsed strictly (`ImportWire`).
public struct ImportRunner: Sendable {
  public let worker: URL
  public let timeout: TimeInterval
  public let outputLimit: Int

  public init(worker: URL, timeout: TimeInterval = 20, outputLimit: Int = ImportWire.maxOutputBytes) {
    self.worker = worker
    self.timeout = timeout
    self.outputLimit = outputLimit
  }

  /// The worker inside this app: `Contents/Helpers/Opensteer Passwords Import`.
  public static func bundled(in bundle: Bundle = .main) -> ImportRunner {
    ImportRunner(
      worker: bundle.bundleURL.appendingPathComponent("Contents/Helpers/\(BrokerIdentity.importWorkerName)", isDirectory: false))
  }

  public func run(input: FileHandle) async -> Result<ImportResult, ImportFailure> {
    let input = Unchecked(input)
    return await withCheckedContinuation { continuation in
      Thread.detachNewThread {
        continuation.resume(returning: runNow(input: input.value))
      }
    }
  }

  private func runNow(input: FileHandle) -> Result<ImportResult, ImportFailure> {
    let process = Process()
    process.executableURL = worker
    process.arguments = []
    // Nothing from the broker's environment reaches the parser.
    process.environment = [:]
    process.standardInput = input
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      Log.importer.error("The import worker could not start.")
      return .failure(.unreadable)
    }

    let state = RunState()
    let pid = process.processIdentifier
    let running = Unchecked(process)
    // SIGKILL, because a parser a crafted file took over can ignore anything
    // softer. `isRunning` turns false once Foundation reaps the worker, so a
    // pid that was reused is not signalled.
    let stop: @Sendable (String) -> Void = { reason in
      if running.value.isRunning, state.markKilled(reason: reason) { kill(pid, SIGKILL) }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { stop("timeout") }

    var data = Data()
    let reader = output.fileHandleForReading
    while true {
      let chunk = reader.availableData
      if chunk.isEmpty { break }
      data.append(chunk)
      if data.count > outputLimit {
        stop("output")
        break
      }
    }
    process.waitUntilExit()
    state.finish()
    try? reader.close()

    if let reason = state.killedReason {
      Log.importer.error("The import worker was stopped: \(reason, privacy: .public).")
      return .failure(.unreadable)
    }
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      Log.importer.error("The import worker failed (\(process.terminationStatus, privacy: .public)).")
      return .failure(.unreadable)
    }
    do {
      switch try ImportWire.decode(data) {
      case .success(let result): return .success(result)
      case .failure(let error): return .failure(.refused(error))
      }
    } catch {
      Log.importer.error("The import worker's answer was unreadable.")
      return .failure(.unreadable)
    }
  }
}

/// Whether the worker was killed, and why; shared with the timeout timer.
private final class RunState: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false
  private(set) var killedReason: String?

  /// True when the caller should kill now: the worker still runs and was not killed yet.
  func markKilled(reason: String) -> Bool {
    lock.withLock {
      guard !finished, killedReason == nil else { return false }
      killedReason = reason
      return true
    }
  }

  func finish() {
    lock.withLock { finished = true }
  }
}
