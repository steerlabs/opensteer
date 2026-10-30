import Foundation

/// One lane for AX mutations and synthetic events in an app. Idle attachments
/// reserve nothing; only a batch's execution or an actual held contact excludes.
final class AppMutationCoordinator: @unchecked Sendable {
  private let gate = OwnerFocusGate()
  private let contacts = Locked<Set<String>>([])
  private let edits = Locked(0)
  static let refusal = HelperError(.failed, "A person is pressing in this app; try again.")
  var revision: Int { edits.current }

  func beginAgent() async throws {
    guard contacts.current.isEmpty else { throw Self.refusal }
    await gate.acquire()
    guard contacts.current.isEmpty else { gate.release(); throw Self.refusal }
  }
  func endAgent() { edits.withLock { $0 += 1 }; gate.release() }
  func beginPerson() async { await gate.acquire() }
  func endPerson() { gate.release() }
  var hasWaitingInput: Bool { gate.hasWaiters }
  /// Called while the lane is held, after delivery or physical cleanup.
  func setHeld(_ held: Bool, attachment: String) {
    contacts.withLock { if held { $0.insert(attachment) } else { $0.remove(attachment) } }
  }
  func notePersonEdit() { edits.withLock { $0 += 1 } }
  /// Another view of this app (another window, or another viewer's lane) still
  /// holds a button or key; only its holder may add to or release it.
  func heldByOther(_ attachment: String) -> Bool {
    contacts.withLock { !$0.subtracting([attachment]).isEmpty }
  }
}

/// Reserves a complete batch before queueing it. Replays, overflow and expired
/// reservations never run even when a queued Task is already scheduled.
final class OwnerInputAdmission: @unchecked Sendable {
  struct Reservation: Sendable { let id: UUID; let revision: Int }
  private struct State {
    var revision = 0
    var lastSequence = -1
    var closed = false
    var pending: [UUID: Int] = [:]
  }
  private let state = Locked(State())
  let maxBatches: Int
  let maxBytes: Int
  init(maxBatches: Int = 4, maxBytes: Int = 131_072) {
    self.maxBatches = maxBatches; self.maxBytes = maxBytes
  }
  var pendingBatches: Int { state.withLock { $0.pending.count } }
  func admit(sequence: Int, bytes: Int) throws -> Reservation {
    try state.withLock {
      guard !$0.closed, sequence >= 0, sequence > $0.lastSequence,
        bytes > 0, $0.pending.count < maxBatches,
        bytes <= maxBytes - $0.pending.values.reduce(0, +)
      else { throw HelperError(.busy, "Owner input is out of order or its lane is full.") }
      let reservation = Reservation(id: UUID(), revision: $0.revision)
      $0.lastSequence = sequence
      $0.pending[reservation.id] = bytes
      return reservation
    }
  }
  func isCurrent(_ reservation: Reservation) -> Bool {
    state.withLock { !$0.closed && $0.revision == reservation.revision && $0.pending[reservation.id] != nil }
  }
  func complete(_ reservation: Reservation) { state.withLock { $0.pending[reservation.id] = nil } }
  func invalidate() {
    state.withLock { $0.closed = true; $0.revision += 1; $0.pending.removeAll() }
  }
}

/// A source callback carries the identity of its capture, never the producer's
/// current map. Retirement precedes stop/drain; start follows that drain.
final class OwnerSampleFence: @unchecked Sendable {
  struct Incarnation: Sendable, Equatable { let generation: Int }
  private struct State { var generation = 1; var open = true }
  private let state = Locked(State())
  var current: Incarnation { state.withLock { Incarnation(generation: $0.generation) } }
  func accepts(_ incarnation: Incarnation) -> Bool {
    state.withLock { $0.open && $0.generation == incarnation.generation }
  }
  /// Reports whether the layout changed, and retires samples taken for the
  /// previous one. Only a known layout's samples can go stale: a stream's
  /// first layout is the one its first samples were taken for, and while a
  /// restart is pending the change that began it already retired the fence and
  /// the restarted stream's own layout is not recorded yet.
  func retireIfLayoutChanged(
    from previous: WindowGroup.CaptureLayout?, to next: WindowGroup.CaptureLayout,
    restartPending: Bool = false
  ) -> Bool {
    guard previous != next else { return false }
    if previous != nil, !restartPending { retire() }
    return true
  }
  func retire() { state.withLock { $0.open = false } }
  func start() -> Incarnation {
    state.withLock { $0.generation += 1; $0.open = true; return Incarnation(generation: $0.generation) }
  }
}

/// Arrivals join the scheduled drain, including while its focus guard settles.
/// Finishing and the next append share one lock so no batch loses its wakeup.
final class OwnerInputMailbox<Value: Sendable>: @unchecked Sendable {
  private struct State { var values: [Value] = []; var scheduled = false }
  private let state = Locked(State())
  func append(_ value: Value) -> Bool {
    state.withLock {
      $0.values.append(value)
      let start = !$0.scheduled
      $0.scheduled = true
      return start
    }
  }
  func pop() -> Value? {
    state.withLock { $0.values.isEmpty ? nil : $0.values.removeFirst() }
  }
  var hasPending: Bool { state.withLock { !$0.values.isEmpty } }
  func finishIfEmpty() -> Bool {
    state.withLock {
      guard $0.values.isEmpty else { return false }
      $0.scheduled = false
      return true
    }
  }
}

/// One focus round may accept more owner input while its final watch runs,
/// but continuous arrivals cannot renew its share of the app's input lane.
struct OwnerInputBurst {
  let deadline: TimeInterval
  private var ended = false
  init(started: TimeInterval) { deadline = started + 5 }
  mutating func end() { ended = true }
  func acceptsInput(at time: TimeInterval) -> Bool { !ended && time < deadline }
}

/// AX discovery stays on separate executors; only the bounded native focus
/// rounds share this gate, so restoration cannot compete over the local app.
final class OwnerFocusGate: @unchecked Sendable {
  static let shared = OwnerFocusGate()
  private struct State { var held = false; var waiting: [CheckedContinuation<Void, Never>] = [] }
  private let state = Locked(State())
  var hasWaiters: Bool { state.withLock { !$0.waiting.isEmpty } }
  func acquire() async {
    await withCheckedContinuation { continuation in
      let ready = state.withLock {
        guard !$0.held else { $0.waiting.append(continuation); return false }
        $0.held = true
        return true
      }
      if ready { continuation.resume() }
    }
  }
  func release() {
    let next = state.withLock { value -> CheckedContinuation<Void, Never>? in
      if !value.waiting.isEmpty { return value.waiting.removeFirst() }
      value.held = false
      return nil
    }
    next?.resume()
  }
}
