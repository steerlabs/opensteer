import Foundation

public final class PhoneBrowserConnection: @unchecked Sendable {
  public typealias Sender = (URLSessionWebSocketTask.Message, @escaping (Error?) -> Void) -> Void
  private let lock = NSRecursiveLock()
  private let queue: DispatchQueue
  private let admission = PhoneBrowserAdmission()
  private let now: () -> Int64
  private let onRetire: (Int, String) -> Void
  private let onDetach: (Int, String) -> Void
  private var sender: Sender?
  private var observer: (([String: Any]) -> Void)?
  private var keys: [[String: Any]] = []
  private var runtimeId = ""
  private var ledger: PhoneBrowserReplayLedger?
  private var channels: [String: Channel] = [:]
  private var tickets: [String: Ticket] = [:]
  private var permits: [String: Permit] = [:]
  private var agents: [String: (channelId: String, sessionId: String, actorToken: String)] = [:]
  private var actions: [String: Action] = [:]
  private struct Action {
    let channelId: String
    let attachmentId: String
    let sessionId: String
    let actorToken: String
    let deadline: Int64
    let message: NSDictionary
  }
  private var leaseTimer: DispatchSourceTimer?
  private var closeTransport: (() -> Void)?
  private var pendingFrames: Set<String> = []
  private var pendingResults = 0
  private var streamRevision = UUID()
  private struct Channel {
    let capability: [String: Any]
    var sequence = 0
    var lastFrameIds: [String: Int] = [:]
    var authorized = false
    var closing = false
    var claims: [String: Any]?
    var actorToken: String?
  }
  private struct Ticket {
    let bytes: String
    let channelId: String
    let capability: [String: Any]
    let receivedAt: Int64
    var verified: PhoneBrowserVerifiedTicket?
    var witness: PhoneBrowserReplayState?
  }
  public struct Permit {
    public let epoch: Int
    public let fence: AuxiliaryFence
    public let channelId: String
    public let claims: [String: Any]
    public let claimsDigest: String
  }

  public init(now: @escaping () -> Int64,
    queue: DispatchQueue = DispatchQueue(label: "com.opensteer.phone-browser.writer", qos: .userInitiated),
    onRetire: @escaping (Int, String) -> Void = { _, _ in },
    onDetach: @escaping (Int, String) -> Void = { _, _ in }) {
    self.now = now; self.queue = queue; self.onRetire = onRetire; self.onDetach = onDetach
  }

  public func setObserver(_ observer: (([String: Any]) -> Void)?) {
    lock.lock(); self.observer = observer
    let current = admission.fence.map { online($0) }; lock.unlock()
    if let current { observer?(current) }
  }

  public var epoch: Int { lock.lock(); defer { lock.unlock() }; return admission.epoch }

  public func publishCurrent() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let fence = admission.fence, admission.accepts(fence.fields, epoch: admission.epoch, now: now()) else { return false }
    observer?(online(fence)); return true
  }

  public func configure(epoch: Int, runtimeId: String, ledger: PhoneBrowserReplayLedger) throws {
    lock.lock(); defer { lock.unlock() }
    guard epoch == admission.epoch else { throw PhoneBrowserFailure.forbidden }
    self.runtimeId = runtimeId; self.ledger = ledger
  }

  @discardableResult public func fence() -> Int {
    lock.lock(); defer { lock.unlock() }
    retireChannels()
    return admission.advanceEpoch()
  }

  private func retireChannels() {
    for attachment in agents.keys { onDetach(admission.epoch, attachment) }
    tickets.removeAll(); permits.removeAll(); channels.removeAll(); agents.removeAll(); actions.removeAll()
  }

  public func adopt(_ welcome: [String: Any], sender: @escaping Sender, close: @escaping () -> Void) throws {
    lock.lock(); defer { lock.unlock() }
    if admission.fence != nil { offline(reason: "stream-replaced") }
    guard ledger != nil else { throw PhoneBrowserFailure.unavailable }
    let keys = try Self.parseKeys(welcome)
    _ = try WireField.int(welcome, "browserWireVersion", range: 1...1)
    try admission.adopt(welcome, now: now())
    streamRevision = UUID()
    self.keys = keys; self.sender = sender; closeTransport = close
    armLease()
    observer?(online(admission.fence!))
  }

  public func offline(reason: String) {
    lock.lock(); defer { lock.unlock() }
    let lost = admission.fence
    leaseTimer?.cancel(); leaseTimer = nil
    admission.release()
    streamRevision = UUID()
    sender = nil; closeTransport?(); closeTransport = nil
    keys.removeAll(); retireChannels()
    onRetire(admission.epoch, reason)
    if let lost { observer?(["type": "connection", "state": "offline", "reason": reason, "fence": lost.fields]) }
  }

  public func receive(_ frame: [String: Any]) throws {
    lock.lock(); defer { lock.unlock() }
    if frame["type"] as? String == "host.auxiliary.rejected" {
      offline(reason: "rejected"); throw PhoneBrowserFailure.unavailable
    }
    guard admission.accepts(frame, epoch: admission.epoch, now: now()) else { throw PhoneBrowserFailure.forbidden }
    let type = try WireField.string(frame, "type")
    let fields: [String: [String]] = [
      "host.auxiliary.lease-renewed": ["streamLeaseExpiresAt", "browserAttachPublicKeys"],
      "capability.grant": ["requestId", "lease"], "capability.revoke": ["requestId", "capability"],
      "browser.health.request": ["requestId"], "browser.attach": ["requestId", "attachTicket", "capability", "channelId"],
      "browser.close": ["requestId", "capability", "channelId"], "browser.client-message": ["capability", "channelId", "message"],
      "browser.profile.delete": ["requestId", "capability", "binding", "deletionId"],
    ]
    guard let extra = fields[type], let fence = admission.fence,
      Set(frame.keys).isSubset(of: Set(Array(fence.fields.keys) + ["type"] + extra)) else { throw PhoneBrowserFailure.forbidden }
    if type == "host.auxiliary.lease-renewed" {
      try admission.renew(until: PhoneBrowserAdmission.milliseconds(frame, "streamLeaseExpiresAt"), now: now())
      if frame["browserAttachPublicKeys"] != nil { keys = try Self.parseKeys(frame) }
      armLease(); observer?(online(admission.fence!)); return
    }
    var sanitized = frame
    var event: [String: Any] = ["type": "relayCommand"]
    if type == "capability.grant" {
      let lease = try WireField.object(frame, "lease")
      guard lease["runtimeId"] as? String == runtimeId else { throw PhoneBrowserFailure.forbidden }
      let previous = admission.capability
      try admission.grant(lease, now: now())
      if let previous, !PhoneBrowserAdmission.sameCapability(previous, lease) {
        retireChannels(); onRetire(admission.epoch, "capability-replaced")
      }
      armLease()
    } else if type == "capability.revoke" {
      let capability = try WireField.object(frame, "capability")
      try admission.check(epoch: admission.epoch, now: now(), capability: capability)
      admission.revoke(capability)
      retireChannels(); onRetire(admission.epoch, "capability-revoked")
      armLease()
    } else if type != "browser.health.request" {
      let capability = try WireField.object(frame, "capability")
      try admission.check(epoch: admission.epoch, now: now(), capability: capability)
      if type == "browser.attach" {
        let channelId = try WireField.string(frame, "channelId")
        guard channels[channelId] == nil, channels.count < 128 else { throw PhoneBrowserFailure.forbidden }
        channels[channelId] = Channel(capability: capability)
        let handle = try saveTicket(WireField.string(frame, "attachTicket"), channelId: channelId, capability: capability)
        sanitized.removeValue(forKey: "attachTicket"); sanitized["attachHandle"] = handle
      } else if type == "browser.client-message" {
        let channelId = try WireField.string(frame, "channelId")
        guard var channel = channels[channelId], !channel.closing, PhoneBrowserAdmission.sameCapability(channel.capability, capability) else { throw PhoneBrowserFailure.forbidden }
        var message = try WireField.object(frame, "message")
        if message["type"] as? String == "agent.attach" {
          guard channel.authorized, channel.claims?["access"] as? String == "read-write",
            let session = message["sessionId"] as? String, session == channel.claims?["sessionId"] as? String,
            message["backend"] as? String == "actions", let actor = message["actorToken"] as? String,
            UUID(uuidString: actor) != nil, let id = message["attachmentId"] as? String,
            UUID(uuidString: id) != nil, agents[id] == nil, agents.count < 128 else { throw PhoneBrowserFailure.forbidden }
          agents[id] = (channelId, session, actor)
        } else if message["type"] as? String == "agent.detach", let id = message["attachmentId"] as? String {
          guard agents[id]?.channelId == channelId else { throw PhoneBrowserFailure.forbidden }
          try detachAgent(epoch: admission.epoch, attachmentId: id)
        } else if message["type"] as? String == "agent.action" {
          let attachment = try WireField.string(message, "attachmentId")
          let actor = try WireField.string(message, "actorToken")
          let request = try WireField.object(message, "request")
          let session = try WireField.string(request, "sessionId")
          let requestId = try WireField.string(message, "requestId")
          try checkAgent(epoch: admission.epoch, channelId: channelId, sessionId: session, attachmentId: attachment, actorToken: actor)
          let timeout = try WireField.int(request, "timeoutMs", range: 1...30000)
          if let previous = actions[requestId] {
            guard previous.channelId == channelId, previous.message == message as NSDictionary else { throw PhoneBrowserFailure.forbidden }
          } else {
            actions = actions.filter { $0.value.deadline > now() }
            guard actions.count < 128 else { throw PhoneBrowserFailure.full }
            actions[requestId] = Action(channelId: channelId, attachmentId: attachment, sessionId: session,
              actorToken: actor, deadline: now() + Int64(timeout), message: message as NSDictionary)
          }
        }
        if let actor = message["actorToken"] as? String, UUID(uuidString: actor) != nil {
          channel.actorToken = actor; channels[channelId] = channel
        }
        if message["type"] as? String == "cdp.command", var command = message["command"] as? [String: Any],
          var parameters = command["parameters"] as? [String: Any], let raw = parameters.removeValue(forKey: "operationAuthority") as? String {
          guard command["method"] as? String == "Opensteer.openTab", message["actorToken"] == nil else { throw PhoneBrowserFailure.forbidden }
          event["authorityHandle"] = try saveTicket(raw, channelId: channelId, capability: capability)
          command["parameters"] = parameters; message["command"] = command; sanitized["message"] = message
        }
      } else if type == "browser.close" {
        let channelId = try WireField.string(frame, "channelId")
        channels[channelId]?.closing = true
        tickets = tickets.filter { $0.value.channelId != channelId }
        permits = permits.filter { $0.value.channelId != channelId }
        for (attachment, agent) in agents where agent.channelId == channelId {
          try detachAgent(epoch: admission.epoch, attachmentId: attachment)
        }
        actions = actions.filter { $0.value.channelId != channelId }
      }
    }
    event["message"] = sanitized
    observer?(event)
  }

  private func saveTicket(_ bytes: String, channelId: String, capability: [String: Any]) throws -> String {
    tickets = tickets.filter { $0.value.receivedAt > now() - 300_000 }
    guard bytes.utf8.count <= 16_384, tickets.count < 512 else { throw PhoneBrowserFailure.full }
    let handle = UUID().uuidString
    tickets[handle] = Ticket(bytes: bytes, channelId: channelId, capability: capability, receivedAt: now())
    return handle
  }

  public func verifyAttach(epoch: Int, attachHandle: String) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    guard var ticket = tickets[attachHandle], channels[ticket.channelId]?.closing == false, let ledger else { throw PhoneBrowserFailure.forbidden }
    try admission.check(epoch: epoch, now: now(), capability: ticket.capability)
    let verified = try PhoneBrowserTickets.verify(ticket.bytes, keys: keys, runtimeId: runtimeId, now: now())
    let state = try ledger.snapshot()
    ticket.verified = verified; ticket.witness = state; tickets[attachHandle] = ticket
    let replay = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state))
    return ["claims": verified.claims, "claimsDigest": verified.digest, "replayState": replay, "maxReplayEntries": ledger.capacity]
  }

  public func commitAttach(epoch: Int, attachHandle: String, claimsDigest: String, replayTransition: [String: Any]) throws -> String {
    lock.lock(); defer { lock.unlock() }
    guard let ticket = tickets[attachHandle], let verified = ticket.verified, let witness = ticket.witness,
      verified.digest == claimsDigest, let ledger, let fence = admission.fence, channels[ticket.channelId]?.closing == false else { throw PhoneBrowserFailure.forbidden }
    try admission.check(epoch: epoch, now: now(), capability: ticket.capability)
    guard verified.expiresAt > now(), try PhoneBrowserAdmission.milliseconds(verified.claims, "operationExpiresAt") > now() else { throw PhoneBrowserFailure.forbidden }
    let proposed = try JSONDecoder().decode(PhoneBrowserReplayState.self, from: JSONSerialization.data(withJSONObject: replayTransition))
    guard proposed.highWaterAt <= now() + 5000, proposed.highWaterAt >= now() - 5000 else { throw PhoneBrowserFailure.forbidden }
    _ = try PhoneBrowserTickets.verify(ticket.bytes, keys: keys, runtimeId: runtimeId, now: now())
    permits = permits.filter { (try? PhoneBrowserAdmission.milliseconds($0.value.claims, "operationExpiresAt")) ?? 0 > now() }
    try ledger.claim(nonce: verified.nonce, expiresAt: verified.expiresAt, now: proposed.highWaterAt, expected: witness, proposed: proposed)
    channels[ticket.channelId]?.authorized = true
    channels[ticket.channelId]?.claims = verified.claims
    tickets.removeValue(forKey: attachHandle)
    let handle = UUID().uuidString
    permits[handle] = Permit(epoch: epoch, fence: fence, channelId: ticket.channelId, claims: verified.claims, claimsDigest: verified.digest)
    return handle
  }

  public func permit(_ handle: String, epoch: Int) throws -> Permit {
    lock.lock(); defer { lock.unlock() }
    if handle.hasPrefix("action:") {
      let requestId = String(handle.dropFirst("action:".count))
      guard let action = actions[requestId],
        let request = action.message["request"] as? [String: Any],
        (request["action"] as? [String: Any])?["type"] as? String == "surface.open",
        let permit = permits.values.first(where: { $0.channelId == action.channelId && $0.epoch == epoch && $0.fence == admission.fence }) else { throw PhoneBrowserFailure.forbidden }
      try checkAction(epoch: epoch, channelId: action.channelId, sessionId: action.sessionId,
        attachmentId: action.attachmentId, actorToken: action.actorToken, requestId: requestId)
      return permit
    }
    guard let permit = permits[handle], permit.epoch == epoch, permit.fence == admission.fence,
      let channel = channels[permit.channelId], !channel.closing else { throw PhoneBrowserFailure.forbidden }
    try admission.check(epoch: epoch, now: now(), capability: channel.capability)
    guard try PhoneBrowserAdmission.milliseconds(permit.claims, "operationExpiresAt") > now() else { throw PhoneBrowserFailure.forbidden }
    return permit
  }

  public func sendRelay(epoch: Int, message: [String: Any], completion: @escaping (Error?) -> Void) {
    lock.lock(); let fence = admission.fence; let revision = streamRevision; lock.unlock()
    queue.async { [self] in
      lock.lock(); defer { lock.unlock() }
      do {
        guard revision == streamRevision, fence != nil, fence == admission.fence,
          admission.accepts(message, epoch: epoch, now: now()), let sender else { throw PhoneBrowserFailure.unavailable }
        let type = try WireField.string(message, "type")
        if let capability = message["capability"] as? [String: Any] {
          if type == "capability.revoked" {
            guard let current = admission.capability, PhoneBrowserAdmission.sameCapability(current, capability) else { throw PhoneBrowserFailure.forbidden }
          } else { try admission.check(epoch: epoch, now: now(), capability: capability) }
        }
        if let channelId = message["channelId"] as? String, type != "browser.closed", type != "browser.command-error" {
          guard channels[channelId]?.closing == false else { throw PhoneBrowserFailure.forbidden }
        }
        let data = try FrameDecoder.encode(message)
        sender(.string(String(decoding: data, as: UTF8.self)), completion)
      } catch { completion(PhoneBrowserFailure.unavailable) }
    }
  }

  public func closeChannel(epoch: Int, channelId: String) throws {
    lock.lock(); defer { lock.unlock() }
    try admission.check(epoch: epoch, now: now())
    guard channels[channelId] != nil else { throw PhoneBrowserFailure.forbidden }
    channels.removeValue(forKey: channelId)
    tickets = tickets.filter { $0.value.channelId != channelId }
    permits = permits.filter { $0.value.channelId != channelId }
    for (attachment, agent) in agents where agent.channelId == channelId {
      try detachAgent(epoch: epoch, attachmentId: attachment)
    }
    actions = actions.filter { $0.value.channelId != channelId }
  }

  public func sendHeartbeat() async throws {
    let (epoch, frame) = try heartbeatFrame()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      sendRelay(epoch: epoch, message: frame) { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }

  private func heartbeatFrame() throws -> (Int, [String: Any]) {
    lock.lock(); defer { lock.unlock() }
    guard let fence = admission.fence else { throw PhoneBrowserFailure.unavailable }
    return (admission.epoch, IphoneWire.auxiliaryHeartbeat(fence, sentAt: admission.heartbeat(now: now())))
  }

  public func renewPrimary(until deadline: Int64) {
    lock.lock(); defer { lock.unlock() }
    admission.primaryLeaseDeadline = deadline
    if admission.fence != nil { armLease() }
  }

  public func frameWriter(epoch: Int, channelId: String) throws -> any PhoneBrowserFrameWriter {
    lock.lock(); defer { lock.unlock() }
    guard let channel = channels[channelId], channel.authorized, !channel.closing, let fence = admission.fence else { throw PhoneBrowserFailure.forbidden }
    try admission.check(epoch: epoch, now: now(), capability: channel.capability)
    return Writer(connection: self, epoch: epoch, channelId: channelId, fence: fence, revision: streamRevision)
  }

  public func checkChannel(epoch: Int, channelId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard let channel = channels[channelId], channel.authorized, !channel.closing else { throw PhoneBrowserFailure.forbidden }
    try admission.check(epoch: epoch, now: now(), capability: channel.capability)
  }

  public func checkViewer(epoch: Int, channelId: String, sessionId: String, control: Bool = true) throws {
    lock.lock(); defer { lock.unlock() }
    try checkChannel(epoch: epoch, channelId: channelId)
    guard let claims = channels[channelId]?.claims, claims["sessionId"] as? String == sessionId,
      !control || claims["access"] as? String == "read-write" else { throw PhoneBrowserFailure.forbidden }
  }

  public func checkAgent(epoch: Int, channelId: String, sessionId: String, attachmentId: String, actorToken: String) throws {
    lock.lock(); defer { lock.unlock() }
    try checkViewer(epoch: epoch, channelId: channelId, sessionId: sessionId)
    guard let agent = agents[attachmentId], agent.channelId == channelId,
      agent.sessionId == sessionId, agent.actorToken == actorToken else { throw PhoneBrowserFailure.forbidden }
  }

  public func detachAgent(epoch: Int, attachmentId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard epoch == admission.epoch else { throw PhoneBrowserFailure.forbidden }
    agents.removeValue(forKey: attachmentId)
    actions = actions.filter { $0.value.attachmentId != attachmentId }
    onDetach(epoch, attachmentId)
  }

  public func checkAction(epoch: Int, channelId: String, sessionId: String, attachmentId: String, actorToken: String, requestId: String, request: [String: Any]? = nil) throws {
    lock.lock(); defer { lock.unlock() }
    try checkAgent(epoch: epoch, channelId: channelId, sessionId: sessionId, attachmentId: attachmentId, actorToken: actorToken)
    guard let action = actions[requestId], action.channelId == channelId, action.sessionId == sessionId,
      action.attachmentId == attachmentId, action.actorToken == actorToken, action.deadline > now() else { throw PhoneBrowserFailure.forbidden }
    if let request {
      guard let observed = action.message["request"] as? NSDictionary,
        observed == request as NSDictionary else { throw PhoneBrowserFailure.forbidden }
    }
  }

  public func eventRoutes(epoch: Int, sessionId: String, actorToken: String?) -> [(channelId: String, actorToken: String)] {
    lock.lock(); defer { lock.unlock() }
    return channels.compactMap { id, channel in
      guard (try? checkViewer(epoch: epoch, channelId: id, sessionId: sessionId, control: false)) != nil else { return nil }
      return (id, actorToken ?? channel.actorToken ?? "")
    }
  }

  private func write(epoch: Int, channelId: String, fence: AuxiliaryFence, revision: UUID, header: [String: Any]?, message: [String: Any]?, completion: @escaping (Bool) -> Void, pixels: Data, dataPath: [String]? = nil,
    withValidity: (((() -> Void) -> Bool))? = nil) {
    let pendingKey = "\(epoch):\(revision):\(channelId)"
    lock.lock()
    guard pixels.count <= PhoneBrowserFrames.maxFrameBytes,
      header == nil ? pendingResults < 64 : !pendingFrames.contains(pendingKey) else { lock.unlock(); completion(false); return }
    if header != nil { pendingFrames.insert(pendingKey) } else { pendingResults += 1 }
    let timeout = message.flatMap { $0["requestId"] as? String }.flatMap { actions[$0] }.map { max(0, $0.deadline - now()) } ?? 30_000
    lock.unlock()
    var completed = false
    let finished: (Bool) -> Void = { [self] success in
      lock.lock()
      guard !completed else { lock.unlock(); return }
      completed = true
      if header != nil { pendingFrames.remove(pendingKey) } else { pendingResults -= 1 }
      lock.unlock(); completion(success)
    }
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeout))) { finished(false) }
    queue.async { [self] in
      let send = {
      lock.lock(); defer { lock.unlock() }
      do {
        guard !completed, revision == streamRevision, fence == admission.fence, var channel = channels[channelId], channel.authorized,
          !channel.closing, let sender else { throw PhoneBrowserFailure.unavailable }
        try admission.check(epoch: epoch, now: now(), capability: channel.capability)
        if let header {
          let frameId = try WireField.int(header, "frameId", range: 0...9_007_199_254_740_991)
          let surfaceId = try WireField.string(header, "surfaceId")
          guard header["watchToken"] == nil, frameId > (channel.lastFrameIds[surfaceId] ?? -1) else { throw PhoneBrowserFailure.forbidden }
          var outer = fence.fields
          outer.merge(["type": "browser.frame", "channelId": channelId, "capability": channel.capability, "sequence": channel.sequence + 1]) { _, next in next }
          let frame = try PhoneBrowserFrames.envelope(header: header, payload: pixels)
          let relay = try PhoneBrowserFrames.relay(header: outer, frame: frame)
          channel.sequence += 1; channel.lastFrameIds[surfaceId] = frameId
          channels[channelId] = channel
          sender(.data(relay)) { finished($0 == nil) }
        } else if var message {
          guard message["type"] as? String == "agent.result", let requestId = message["requestId"] as? String,
            let action = actions[requestId], message["attachmentId"] as? String == action.attachmentId,
            let request = action.message["request"] as? [String: Any],
            (request["action"] as? [String: Any])?["type"] as? String == "page.capture" else { throw PhoneBrowserFailure.forbidden }
          try checkAction(epoch: epoch, channelId: channelId, sessionId: action.sessionId,
            attachmentId: action.attachmentId, actorToken: action.actorToken, requestId: requestId)
          if let dataPath {
            func inserting(_ object: [String: Any], path: ArraySlice<String>) -> [String: Any]? {
              guard let key = path.first else { return nil }
              var result = object
              if path.count == 1 { result[key] = pixels.base64EncodedString(); return result }
              guard let child = object[key] as? [String: Any], let next = inserting(child, path: path.dropFirst()) else { return nil }
              result[key] = next; return result
            }
            guard let result = inserting(message, path: dataPath[...]) else { throw PhoneBrowserFailure.invalidFrame }
            message = result
          }
          let outer = fence.fields.merging(["type": "browser.server-message", "channelId": channelId, "capability": channel.capability, "message": message]) { _, next in next }
          let data = try FrameDecoder.encode(outer)
          sender(.string(String(decoding: data, as: UTF8.self))) { finished($0 == nil) }
        } else { throw PhoneBrowserFailure.invalidFrame }
      } catch { finished(false) }
      }
      if let withValidity {
        if !withValidity(send) { finished(false) }
      } else { send() }
    }
  }

  private final class Writer: PhoneBrowserFrameWriter {
    private weak var connection: PhoneBrowserConnection?
    private let epoch: Int
    private let channelId: String
    private let fence: AuxiliaryFence
    private let revision: UUID
    init(connection: PhoneBrowserConnection, epoch: Int, channelId: String, fence: AuxiliaryFence, revision: UUID) {
      self.connection = connection; self.epoch = epoch; self.channelId = channelId; self.fence = fence; self.revision = revision
    }
    func writeFrame(header: [String: Any], pixels: Data, completion: @escaping (Bool) -> Void) {
      guard let connection else { completion(false); return }
      connection.write(epoch: epoch, channelId: channelId, fence: fence, revision: revision, header: header, message: nil, completion: completion, pixels: pixels)
    }
    func writePixelResult(message: [String: Any], dataPath: [String], pixels: Data, completion: @escaping (Bool) -> Void) {
      guard let connection, pixels.count <= PhoneBrowserFrames.maxFrameBytes else { completion(false); return }
      connection.write(epoch: epoch, channelId: channelId, fence: fence, revision: revision, header: nil, message: message, completion: completion, pixels: pixels, dataPath: dataPath)
    }
    func writePixelResult(message: [String: Any], dataPath: [String], pixels: Data,
      withValidity: @escaping (() -> Void) -> Bool, completion: @escaping (Bool) -> Void) {
      guard let connection, pixels.count <= PhoneBrowserFrames.maxFrameBytes else { completion(false); return }
      connection.write(epoch: epoch, channelId: channelId, fence: fence, revision: revision, header: nil,
        message: message, completion: completion, pixels: pixels, dataPath: dataPath, withValidity: withValidity)
    }
  }

  private static func parseKeys(_ frame: [String: Any]) throws -> [[String: Any]] {
    guard let keys = frame["browserAttachPublicKeys"] as? [[String: Any]], (1...4).contains(keys.count) else { throw PhoneBrowserFailure.forbidden }
    for key in keys {
      guard Set(key.keys) == Set(["publicKeyPem", "keyId"]),
        try WireField.string(key, "keyId").range(of: "^[A-Za-z0-9._:-]{1,255}$", options: .regularExpression) != nil else { throw PhoneBrowserFailure.forbidden }
      _ = try PhoneBrowserTickets.publicKey(WireField.string(key, "publicKeyPem"))
    }
    return keys
  }

  private func online(_ fence: AuxiliaryFence) -> [String: Any] {
    ["type": "connection", "state": "online", "fence": fence.fields, "leaseDeadline": admission.leaseDeadline]
  }

  private func armLease() {
    leaseTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    var deadline = min(admission.leaseDeadline, admission.primaryLeaseDeadline)
    if admission.capabilityDeadline > 0 { deadline = min(deadline, admission.capabilityDeadline) }
    timer.schedule(deadline: .now() + .milliseconds(Int(max(0, min(86_400_000, deadline - now())))))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      lock.lock(); defer { lock.unlock() }
      if min(admission.leaseDeadline, admission.primaryLeaseDeadline) <= now() { offline(reason: "lease-expired") }
      else {
        if admission.capabilityDeadline > 0, admission.capabilityDeadline <= now(), let capability = admission.capability {
          admission.revoke(capability)
          retireChannels(); onRetire(admission.epoch, "capability-expired")
        }
        armLease()
      }
    }
    leaseTimer = timer; timer.resume()
  }
}
