// tests/remote-input-port.ts ports RemoteInputGate.swift, RemoteInputTextView.swift and
// RemoteInputEdits.swift to TypeScript for the JavaScript adapter's tests: change it with them.
// Tests/Cases/remote-input-edits.json holds RemoteInputEdits' cases, run against both.
import Foundation

/// One event at a time: the bridge must decide before UIKit applies the default.
@MainActor final class RemoteInputGate {
  var deliver: (([String: Any]) -> Void)?
  var contextId: String?
  private var jobs: [(run: () -> Void, report: Bool)] = []
  private var next = 0
  private var waiting: (Int, () -> Void)?
  private var running = false
  private var insertion = 0
  var apply: (([String: Any]) -> Void)?
  /// Nothing is waiting for an answer or for its turn.
  var idle: (() -> Void)?

  /// Jobs waiting for their turn.
  var queued: Int { jobs.count }

  func enqueue(_ job: @escaping () -> Void) { add(job, report: false) }
  /// A report of state that a newer report supersedes (where the selection is): it replaces the
  /// queued report nothing was queued after, so a drag queues one report, not one per frame.
  func report(_ job: @escaping () -> Void) { add(job, report: true) }
  private func add(_ job: @escaping () -> Void, report: Bool) {
    let last = running ? insertion - 1 : jobs.count - 1
    if report, jobs.indices.contains(last), jobs[last].report { jobs[last] = (job, true) }
    else if running { jobs.insert((job, report), at: insertion); insertion += 1 }
    else { jobs.append((job, report)) }
    drain()
  }
  func event(_ event: [String: Any], default action: @escaping () -> Void = {}) {
    next += 1
    waiting = (next, action)
    var packet: [String: Any] = ["id": next, "event": event]
    if let contextId { packet["contextId"] = contextId }
    deliver?(packet)
  }
  func notify(_ event: [String: Any]) { enqueue { self.event(event) } }
  func respond(_ instruction: [String: Any]) {
    let id = (instruction["id"] as? NSNumber)?.intValue ?? -1
    if id == 0 { apply?(instruction); return }
    guard let current = waiting, id == current.0 else { return }
    waiting = nil
    running = true; insertion = 0
    if instruction["preventDefault"] as? Bool != true { current.1() }
    apply?(instruction)
    running = false
    drain()
  }
  private func drain() {
    guard !running else { return }
    while waiting == nil && !jobs.isEmpty {
      running = true; insertion = 0
      let job = jobs.removeFirst(); job.run()
      running = false
    }
    if waiting == nil && jobs.isEmpty { idle?() }
  }
}
