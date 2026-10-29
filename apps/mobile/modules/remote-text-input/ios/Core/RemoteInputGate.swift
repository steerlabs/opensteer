import Foundation

/// One event at a time: the bridge must decide before UIKit applies the default.
@MainActor final class RemoteInputGate {
  var deliver: (([String: Any]) -> Void)?
  var contextId: String?
  private var jobs: [() -> Void] = []
  private var next = 0
  private var waiting: (Int, () -> Void)?
  private var running = false
  private var insertion = 0
  var apply: (([String: Any]) -> Void)?

  func enqueue(_ job: @escaping () -> Void) {
    if running { jobs.insert(job, at: insertion); insertion += 1 } else { jobs.append(job) }
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
      let job = jobs.removeFirst(); job()
      running = false
    }
  }
}
