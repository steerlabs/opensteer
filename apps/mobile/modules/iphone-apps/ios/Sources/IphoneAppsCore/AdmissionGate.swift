import Foundation
import OpensteerAppleData


/// Elapsed time advances through suspension, unlike an app's timer callbacks.
public protocol MonotonicClock: AnyObject {
  func now() -> UInt64 // nanoseconds since an arbitrary monotonic origin
}

public final class SystemContinuousClock: MonotonicClock {
  private let clock = ContinuousClock()
  private let origin: ContinuousClock.Instant
  public init() { origin = clock.now }
  public func now() -> UInt64 {
    let components = origin.duration(to: clock.now).components
    let seconds = max(0, components.seconds)
    let nanos = max(0, components.attoseconds / 1_000_000_000)
    return UInt64(seconds) &* 1_000_000_000 &+ UInt64(nanos)
  }
}

public struct AdmissionTicket: Equatable, Hashable {
  public let id: UUID
  public let generation: UInt64
  public let fence: String
}

public enum AdmissionDecision: Equatable {
  case accepted(AdmissionTicket)
  case disconnected, background, stale, leaseExpired, busy, deadline
  public var ticket: AdmissionTicket? {
    if case .accepted(let ticket) = self { return ticket }
    return nil
  }
}

public enum WriteStartDecision: Equatable { case started, background, stale, leaseExpired, deadline }
public enum CancelDecision: Equatable { case notStarted, alreadyStarted, unknown }

/// One synchronous admission authority shared by transport and JS disconnect.
/// Callback work always checks its ticket's generation before touching state.
public final class AdmissionGate {
  private struct Active {
    let ticket: AdmissionTicket
    let effect: DataEffect
    let deadline: UInt64
    var writeStarted: Bool
  }
  private let lock = NSRecursiveLock()
  private let clock: any MonotonicClock
  private let runnerId: String
  private let bootId: String
  private var active: [UUID: Active] = [:]
  private var epoch: UInt64 = 0
  private var fence: String?
  private var leaseEnd: UInt64 = 0
  private var foreground = false
  private var draining = false
  private var stopped = false

  public init(runnerId: String, bootId: String, clock: any MonotonicClock = SystemContinuousClock()) {
    self.runnerId = runnerId
    self.bootId = bootId
    self.clock = clock
  }

  public var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
  public var currentFence: String? { lock.lock(); defer { lock.unlock() }; return fence }
  public var inFlight: Int { lock.lock(); defer { lock.unlock() }; return active.count }

  public func activate() {
    lock.lock(); defer { lock.unlock() }
    guard !stopped else { return }
    epoch &+= 1
    fence = nil
    leaseEnd = 0
    foreground = true
    draining = false
    active.removeAll()
  }

  public func attach(fence: String, leaseSeconds: UInt64) {
    lock.lock(); defer { lock.unlock() }
    guard foreground && !draining && !stopped else { return }
    self.fence = fence
    leaseEnd = clock.now() &+ leaseSeconds &* 1_000_000_000
  }

  public func renew(fence: String, leaseSeconds: UInt64) -> Bool {
    lock.lock(); defer { lock.unlock() }
    let now = clock.now()
    guard self.fence == fence, !stopped, now < leaseEnd else { return false }
    // A live drain still needs its lease to deliver admitted work's results.
    leaseEnd = now &+ leaseSeconds &* 1_000_000_000
    return true
  }

  public func detach(generation: UInt64) {
    lock.lock(); defer { lock.unlock() }
    guard epoch == generation else { return }
    fence = nil
    leaseEnd = 0
    active.removeAll()
  }

  public func background() {
    lock.lock(); defer { lock.unlock() }
    draining = true
    foreground = false
    // Keep the fence for already admitted reads and writes. New admission and
    // write-start are fenced immediately; expiration ends the drain.
  }

  public func expireBackground() {
    lock.lock(); defer { lock.unlock() }
    epoch &+= 1
    fence = nil
    leaseEnd = 0
    active.removeAll()
  }

  public func disconnect() {
    lock.lock(); defer { lock.unlock() }
    stopped = true
    draining = true
    foreground = false
    fence = nil
    leaseEnd = 0
    epoch &+= 1
    // Admitted writes that crossed beginWrite may complete, but their result
    // cannot revive a stopped identity. No new write can cross the check.
    active.removeAll()
  }

  public func admit(fence: String, timeoutMs: Int, effect: DataEffect) -> AdmissionDecision {
    lock.lock(); defer { lock.unlock() }
    if stopped { return .disconnected }
    if !foreground || draining { return .background }
    guard self.fence == fence else { return .stale }
    let now = clock.now()
    guard now < leaseEnd else { return .leaseExpired }
    guard active.count < 4 else { return .busy }
    // The Host's timeout started at frame arrival. One second is reserved for
    // the answer, and a write needs at least half a second to begin safely.
    guard timeoutMs >= 1_500 else { return .deadline }
    let deadline = now &+ UInt64(timeoutMs - 1_000) &* 1_000_000
    let ticket = AdmissionTicket(id: UUID(), generation: epoch, fence: fence)
    active[ticket.id] = Active(ticket: ticket, effect: effect, deadline: deadline, writeStarted: false)
    return .accepted(ticket)
  }

  public func beginWrite(_ ticket: AdmissionTicket?) -> WriteStartDecision {
    lock.lock(); defer { lock.unlock() }
    guard let ticket, var call = active[ticket.id], call.ticket == ticket else { return .stale }
    if stopped || draining || !foreground { return .background }
    guard epoch == ticket.generation, fence == ticket.fence else { return .stale }
    let now = clock.now()
    guard now < leaseEnd else { return .leaseExpired }
    guard now < call.deadline, call.deadline - now >= 500_000_000 else { return .deadline }
    call.writeStarted = true
    active[ticket.id] = call
    return .started
  }

  public func cancel(_ ticket: AdmissionTicket?) -> CancelDecision {
    lock.lock(); defer { lock.unlock() }
    guard let ticket, let call = active[ticket.id], call.ticket == ticket else { return .unknown }
    if call.writeStarted { return .alreadyStarted }
    active.removeValue(forKey: ticket.id)
    return .notStarted
  }

  public func complete(_ ticket: AdmissionTicket) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let call = active.removeValue(forKey: ticket.id), call.ticket == ticket else { return false }
    return !stopped && epoch == ticket.generation && fence == ticket.fence && clock.now() < leaseEnd
  }

  public static func backgroundSentence(name: String) -> String {
    "Opensteer on \(name) moved to the background before this started. Nothing was changed."
  }
}
