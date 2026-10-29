import CryptoKit
import Foundation

/// Owned by one authenticated socket. The lock covers authentication and all
/// replay reservations together, so overlapping batches cannot both win.
final class LoginTextReceiver: @unchecked Sendable {
  private static let generation = Locked<Int>(0)
  let key: LoginReceiverKey
  private let lock = NSLock()
  private var privateKey: P256.KeyAgreement.PrivateKey?
  private var claims: [String: Int] = [:]
  private let now: @Sendable () -> Double
  private let uptime: @Sendable () -> Double
  private let clockAnchor: Double
  private let uptimeAnchor: Double
  private var lastNow: Double

  init(
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1_000 },
    uptime: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.now = now
    self.uptime = uptime
    clockAnchor = now()
    uptimeAnchor = uptime()
    lastNow = clockAnchor
    let privateKey = P256.KeyAgreement.PrivateKey()
    self.privateKey = privateKey
    let generation = Self.generation.withLock { value in
      value += 1
      return value
    }
    key = LoginReceiverKey(
      connectionId: UUID().uuidString, connectionGeneration: generation,
      publicKey: LoginEnvelopeCrypto.base64(privateKey.publicKey.x963Representation))
  }

  private func currentTime() -> Double {
    lastNow = max(lastNow, now(), clockAnchor + max(0, uptime() - uptimeAnchor) * 1_000)
    return lastNow
  }

  func invalidate() {
    lock.lock()
    defer { lock.unlock() }
    privateKey = nil
    claims.removeAll()
  }

  func prepare(
    actions: [ActionRequest], context: LoginActContext?, sessionId: String, runId: String?
  ) throws -> PreparedLoginBatch {
    lock.lock()
    defer { lock.unlock() }
    var envelopes: [Int: SealedLoginEnvelope] = [:]
    for (index, action) in actions.enumerated() {
      guard case .savedText(let envelope, _) = action else { continue }
      envelopes[index] = envelope
    }
    guard !envelopes.isEmpty else { return PreparedLoginBatch(receiver: self, envelopes: [:]) }
    guard let privateKey, let context, let runId, context.runId == runId,
      (1...32).contains(actions.count)
    else { throw LoginEnvelopeCrypto.refusal }
    let now = currentTime()
    claims = claims.filter { Double($0.value) > now }
    var texts: [String] = []
    for (index, envelope) in envelopes {
      let binding = envelope.binding
      guard binding.connectionId == key.connectionId,
        binding.connectionGeneration == key.connectionGeneration,
        binding.runId == runId, binding.sessionId == sessionId,
        binding.actId == context.actId, binding.actionIndex == index,
        claims[binding.replayIdentity] == nil
      else { throw LoginEnvelopeCrypto.refusal }
      // Authenticate the entire batch before its first action, including a
      // literal click. Plaintext is discarded; the input route opens again.
      texts.append(
        try LoginEnvelopeCrypto.open(envelope, expected: binding, privateKey: privateKey, now: now))
    }
    for envelope in envelopes.values {
      claims[envelope.binding.replayIdentity] = envelope.binding.expiresAt
    }
    // A refused saved value still consumes its authenticated action slot.
    for text in texts { try SavedLoginInput.validate(text) }
    return PreparedLoginBatch(receiver: self, envelopes: envelopes)
  }

  fileprivate func check(_ envelope: SealedLoginEnvelope) throws {
    lock.lock()
    defer { lock.unlock() }
    try checkLocked(envelope)
  }

  private func checkLocked(_ envelope: SealedLoginEnvelope) throws {
    guard privateKey != nil, claims[envelope.binding.replayIdentity] == envelope.binding.expiresAt
    else { throw LoginEnvelopeCrypto.refusal }
    guard Double(envelope.binding.expiresAt) > currentTime() else { throw LoginEnvelopeCrypto.expired }
  }

  fileprivate func open(_ envelope: SealedLoginEnvelope) throws -> SavedLoginValue {
    lock.lock()
    defer { lock.unlock() }
    try checkLocked(envelope)
    guard let privateKey else { throw LoginEnvelopeCrypto.refusal }
    let text = try LoginEnvelopeCrypto.open(
      envelope, expected: envelope.binding, privateKey: privateKey, now: currentTime())
    try SavedLoginInput.validate(text)
    return SavedLoginValue(text: text, field: envelope.binding.field)
  }
}

struct SavedLoginValue: Sendable {
  let text: String
  let field: LoginField
}

/// No plaintext is retained while earlier actions wait or run.
final class PreparedLoginBatch: @unchecked Sendable {
  private let receiver: LoginTextReceiver
  private let envelopes: [Int: SealedLoginEnvelope]
  private let opened = Locked<Set<Int>>([])

  fileprivate init(receiver: LoginTextReceiver, envelopes: [Int: SealedLoginEnvelope]) {
    self.receiver = receiver
    self.envelopes = envelopes
  }

  func check(index: Int) throws {
    guard let envelope = envelopes[index] else { throw LoginEnvelopeCrypto.refusal }
    try receiver.check(envelope)
  }

  func open(index: Int) throws -> SavedLoginValue {
    let first = opened.withLock { $0.insert(index).inserted }
    guard first, let envelope = envelopes[index] else { throw LoginEnvelopeCrypto.refusal }
    return try receiver.open(envelope)
  }
}
