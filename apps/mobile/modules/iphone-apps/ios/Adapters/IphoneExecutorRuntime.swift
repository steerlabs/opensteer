import CryptoKit
import Foundation
import OpensteerAppleData
import UIKit

@available(iOS 17, *)
final class IphoneExecutorRuntime: @unchecked Sendable {
  static let shared = IphoneExecutorRuntime()
  private let lock = NSRecursiveLock()
  private let clock = SystemContinuousClock()
  private let bootId = "rbt_\(UUID().uuidString.lowercased())"
  private let permissions = IphonePermissions()
  private let providers: [String: any DataProvider] = [
    "apple-calendar": CalendarProvider(clock: .iphone),
    "apple-contacts": ContactsProvider(deviceName: "iPhone"),
    "apple-reminders": RemindersProvider(clock: .iphone),
    "iphone-location": IphoneLocationAdapter(),
    "iphone-photos": IphonePhotosProvider(store: IphonePhotosStore()),
  ]
  private var storage: IdentityStore?
  private var identity: PersistedIphoneIdentity?
  private var gate: AdmissionGate?
  private var dispatcher: IphoneDispatch?
  private var revision = 0
  private var foreground = false
  private var connection = "none"
  private var retryAt: String?
  private var issue: ConnectionIssue?
  private var issueMessage: String?
  private var locationAccuracy: String?
  private var permissionStates: [String: IphonePermission] = [:]
  private var approvalRules: ApprovalRules?
  private var approvalPrompts: [[String: Any]] = []
  private var hostKeyId: String?
  private var hostClock: IphoneHostClock?
  private var primaryLeaseEnd: UInt64 = 0
  private var stream: URLSessionWebSocketTask?
  private var streamFence: AuxiliaryFence?
  private var primary: URLSessionWebSocketTask?
  private var session: URLSession?
  private var connectionTask: Task<Void, Never>?
  private var observer: (([String: Any?]) -> Void)?
  private var pendingOutcomes: [String: CheckedContinuation<[String: Any], Never>] = [:]
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var drainTask: Task<Void, Never>?

  private init() {
    // The executor exists before JS. A locked phone defers Keychain reads until
    // an active/unlocked callback; no missing-identity conclusion is drawn.
    loadIdentity()
  }

  func setObserver(_ observer: (([String: Any?]) -> Void)?) {
    lock.lock(); self.observer = observer; let value = snapshotLocked(); lock.unlock()
    observer?(value)
  }

  func snapshot() -> [String: Any?] {
    lock.lock(); defer { lock.unlock() }
    return snapshotLocked()
  }

  private func snapshotLocked() -> [String: Any?] {
    let supported = UIDevice.current.userInterfaceIdiom == .phone && !ProcessInfo.processInfo.isiOSAppOnMac
    let unsupportedReason: String? = supported ? nil : "not-iphone"
    let enrollment: [String: Any?]?
    if let identity, identity.state != .prepared {
      enrollment = ["deploymentId": identity.deploymentId,
        "deploymentName": identity.deploymentName,
        "runnerId": identity.runnerId, "name": identity.name,
        "state": identity.state.rawValue, "enrollmentId": identity.enrollmentId,
        "hostUrl": identity.hostUrl]
    } else { enrollment = nil }
    let approvalKey: [String: Any?]?
    if identity != nil, let storage,
      let keyId = try? storage.approvalKeyId(), let publicKey = try? storage.approvalPublicKey() {
      approvalKey = ["keyId": keyId, "publicKey": publicKey, "registered": keyId == hostKeyId]
    } else { approvalKey = nil }
    let approvals: [[String: Any?]] = approvalPrompts.compactMap { request in
      guard let id = request["id"] as? String, let definitionId = request["definitionId"] as? String,
        let access = request["access"] as? String else { return nil }
      return ["setupRequestId": id, "definitionId": definitionId, "access": access,
        "reason": request["reason"] is NSNull ? nil : request["reason"],
        "threadTitle": request["threadTitle"] is NSNull ? nil : request["threadTitle"],
        "workspaceName": request["workspaceName"] is NSNull ? nil : request["workspaceName"],
        "createdAt": request["createdAt"], "expiresAt": request["expiresAt"]]
    }
    return ["revision": revision, "supported": supported, "unsupportedReason": unsupportedReason,
      "deviceName": UIDevice.current.name, "enrollment": enrollment,
      "connection": connection, "retryAt": retryAt, "issue": issue.map(Self.issueCode),
      "issueMessage": issueMessage, "approvalKey": approvalKey,
      "permissions": Dictionary(uniqueKeysWithValues: InvokeRules.apps.map { ($0, (permissionStates[$0] ?? .notDetermined).rawValue) }),
      "locationAccuracy": locationAccuracy,
      "approvals": approvals, "working": gate?.inFlight ?? 0]
  }

  private func publish() {
    lock.lock(); revision &+= 1; let value = snapshotLocked(); let listener = observer; lock.unlock()
    if let listener { DispatchQueue.main.async { listener(value) } }
  }

  private static func issueCode(_ issue: ConnectionIssue) -> String {
    switch issue {
    case .enrollmentExpired: "enrollment-expired"
    case .enrollmentRefused: "enrollment-refused"
    case .hostUnreachable: "host-unreachable"
    case .hostMismatch: "host-mismatch"
    case .remoteAccessOff: "remote-access-off"
    case .removed: "removed"
    case .needsUpdate: "needs-update"
    case .profileMismatch: "profile-mismatch"
    case .protocolError: "protocol-error"
    case .failed: "failed"
    }
  }

  private func loadIdentity() {
    do {
      let storage = try IdentityStore(vault: IphoneKeychainVault(), record: IphoneSandboxRecord())
      let loaded = try storage.load()
      lock.lock()
      self.storage = storage
      identity = loaded
      if let loaded {
        let authority = AdmissionGate(runnerId: loaded.runnerId, bootId: bootId, clock: clock)
        gate = authority
        dispatcher = IphoneDispatch(gate: authority, clock: clock, providers: providers,
          onWorkChange: { [weak self] in self?.publish() })
      }
      lock.unlock()
      publish()
    } catch IphoneStorageError.protectedDataUnavailable {
      // Try again after unlocking. The persisted record is still authoritative.
    } catch {
      lock.lock(); issue = .failed; lock.unlock(); publish()
    }
  }

  func becameActive() {
    guard UIDevice.current.userInterfaceIdiom == .phone && !ProcessInfo.processInfo.isiOSAppOnMac else { return }
    if storage == nil { loadIdentity() }
    lock.lock()
    if foreground {
      lock.unlock()
      refreshPermissions()
      connectIfNeeded()
      return
    }
    foreground = true
    drainTask?.cancel(); drainTask = nil
    let background = backgroundTask; backgroundTask = .invalid
    let previousGeneration = gate?.generation
    gate?.activate()
    dispatcher?.cancelAll(generation: previousGeneration)
    let old = connectionTask
    connectionTask = nil
    lock.unlock()
    if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
    old?.cancel()
    closeSockets()
    refreshPermissions()
    connectIfNeeded()
  }

  func enteredBackground() {
    lock.lock()
    foreground = false
    gate?.background()
    connection = identity == nil ? "none" : "background"
    let generation = gate?.generation
    lock.unlock()
    publish()
    let task = UIApplication.shared.beginBackgroundTask(withName: "Opensteer iPhone apps") { [weak self] in
      self?.expireBackground(generation: generation)
    }
    lock.lock(); backgroundTask = task; lock.unlock()
    lock.lock()
    drainTask = Task { [weak self] in
      guard let self else { return }
      let remaining = max(0, UIApplication.shared.backgroundTimeRemaining - 3)
      let seconds = min(remaining.isFinite ? remaining : 20, 20)
      let deadline = self.clock.now() + UInt64(seconds * 1_000_000_000)
      while self.clock.now() < deadline && !Task.isCancelled {
        self.lock.lock(); let working = self.gate?.inFlight ?? 0; self.lock.unlock()
        if working == 0 { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      self.expireBackground(generation: generation)
    }
    lock.unlock()
  }

  private func expireBackground(generation: UInt64?) {
    lock.lock()
    guard !foreground, generation == gate?.generation else { lock.unlock(); return }
    gate?.expireBackground()
    dispatcher?.cancelAll()
    let task = backgroundTask; backgroundTask = .invalid
    connectionTask?.cancel(); connectionTask = nil
    lock.unlock()
    closeSockets()
    if task != .invalid { DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) } }
  }

  func terminate() {
    lock.lock(); gate?.disconnect(); dispatcher?.cancelAll(); foreground = false; connectionTask?.cancel(); lock.unlock()
    closeSockets()
  }

  private func refreshPermissions() {
    Task { @MainActor [weak self] in
      guard let self else { return }
      let current = self.permissions.all()
      let accuracy = self.permissions.locationAccuracy
      self.lock.lock(); self.permissionStates = current; self.locationAccuracy = accuracy; self.lock.unlock()
      self.publish()
      await self.sendStatus()
    }
  }

  func prepare(deploymentId: String) throws -> [String: String] {
    guard !deploymentId.isEmpty else { throw IdentityStoreError.notPrepared }
    lock.lock(); let active = foreground; let storage = self.storage; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    guard let storage else { throw IphoneRuntimeError.busy }
    let prepared = try storage.prepare(deploymentId: deploymentId)
    let loaded = try storage.load()
    lock.lock()
    connectionTask?.cancel(); connectionTask = nil
    gate?.disconnect(); dispatcher?.cancelAll()
    identity = loaded
    let authority = AdmissionGate(runnerId: prepared.runnerId, bootId: bootId, clock: clock)
    gate = authority
    dispatcher = IphoneDispatch(gate: authority, clock: clock, providers: providers,
      onWorkChange: { [weak self] in self?.publish() })
    gate?.activate()
    issue = nil
    lock.unlock()
    closeSockets()
    publish()
    return ["runnerId": prepared.runnerId, "mintKey": prepared.mintKey]
  }

  func enroll(pairing: [String: String], enrollmentId: String, token: String,
    expiresAt: String, name: String) throws {
    let deploymentId = pairing["deploymentId"] ?? ""
    let deploymentName = pairing["deploymentName"] ?? ""
    let hostInstanceId = pairing["hostInstanceId"] ?? ""
    let hostUrl = pairing["hostUrl"] ?? ""
    _ = try HostTarget(hostUrl)
    guard !deploymentId.isEmpty, !hostInstanceId.isEmpty, !enrollmentId.isEmpty,
      !name.isEmpty, !token.isEmpty else { throw IphoneRuntimeError.invalidTarget }
    lock.lock(); let storage = self.storage; let active = foreground; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    guard let storage else { throw IphoneRuntimeError.busy }
    try storage.enroll(deploymentId: deploymentId, deploymentName: deploymentName,
      hostInstanceId: hostInstanceId, hostUrl: hostUrl,
      enrollmentId: enrollmentId, enrollmentToken: token, expiresAt: expiresAt, name: name)
    lock.lock(); identity = try storage.load(); issue = nil; lock.unlock()
    publish(); connectIfNeeded()
  }

  func discardPendingEnrollment() throws -> [String: String] {
    lock.lock()
    let storage = self.storage
    guard foreground else { lock.unlock(); throw IphoneRuntimeError.notForeground }
    guard identity?.state == .pending || identity?.state == .prepared else {
      lock.unlock(); throw IdentityStoreError.notPrepared
    }
    gate?.activate(); dispatcher?.cancelAll()
    connectionTask?.cancel(); connectionTask = nil
    lock.unlock()
    guard let storage else { throw IdentityStoreError.notPrepared }
    let mintKey = try storage.discardPendingEnrollment()
    lock.lock()
    identity = try storage.load()
    connection = "none"; issue = nil; issueMessage = nil; retryAt = nil
    approvalPrompts = []; approvalRules = nil; hostKeyId = nil
    lock.unlock()
    closeSockets(); publish()
    return ["mintKey": mintKey]
  }

  func retarget(_ pairing: [String: String]) throws {
    let hostUrl = pairing["hostUrl"] ?? ""
    _ = try HostTarget(hostUrl)
    lock.lock(); let storage = self.storage; let identity = self.identity; let active = foreground; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    guard let identity, let storage,
      identity.deploymentId == pairing["deploymentId"],
      identity.hostInstanceId == pairing["hostInstanceId"] else { throw IdentityStoreError.wrongDeployment }
    try storage.retarget(hostInstanceId: identity.hostInstanceId!, hostUrl: hostUrl)
    lock.lock(); self.identity = try storage.load(); lock.unlock()
    reconnect()
  }

  func disconnect() -> [String: String?] {
    lock.lock()
    let ids: [String: String?] = ["deploymentId": identity?.deploymentId, "runnerId": identity?.runnerId]
    gate?.disconnect() // synchronous admission fence before any network await
    dispatcher?.cancelAll()
    connectionTask?.cancel(); connectionTask = nil
    identity = nil
    dispatcher = nil
    approvalPrompts = []; approvalRules = nil; hostKeyId = nil
    connection = "stopped"; issue = nil
    do { try storage?.wipe() }
    catch {
      issue = .failed
      issueMessage = "This iPhone could not remove its local enrollment. Reopen Opensteer and try again."
    }
    lock.unlock()
    closeSockets(); publish()
    return ids
  }

  func requestPermission(_ app: String) async throws -> String {
    guard InvokeRules.apps.contains(app) else { throw IphoneRuntimeError.unsupported }
    lock.lock(); let active = foreground; let authority = gate; let generation = gate?.generation; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    let state = await permissions.request(app)
    let accuracy = await permissions.locationAccuracy
    lock.lock(); let current = generation == gate?.generation && gate === authority && foreground
    if current { permissionStates[app] = state; locationAccuracy = accuracy }
    lock.unlock()
    if current { publish(); await sendStatus() }
    return state.rawValue
  }

  func chooseContacts() async throws -> String {
    lock.lock(); let active = foreground; let authority = gate; let generation = gate?.generation; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    let state = await permissions.chooseContacts()
    lock.lock(); let current = generation == gate?.generation && gate === authority && foreground
    if current { permissionStates["apple-contacts"] = state }
    lock.unlock()
    if current { publish(); await sendStatus() }
    return state.rawValue
  }

  func choosePhotos() async throws -> String {
    lock.lock(); let active = foreground; let authority = gate; let generation = gate?.generation; lock.unlock()
    guard active else { throw IphoneRuntimeError.notForeground }
    let state = await permissions.choosePhotos()
    lock.lock(); let current = generation == gate?.generation && gate === authority && foreground
    if current { permissionStates["iphone-photos"] = state }
    lock.unlock()
    if current { publish(); await sendStatus() }
    return state.rawValue
  }

  func answerApproval(requestId: String, decision: String, definitionId: String, access: String) async -> [String: Any] {
    lock.lock()
    let allowed = foreground && connection == "online" &&
      streamFence?.tag == gate?.currentFence &&
      approvalRules?.registered(hostKeyId: hostKeyId) == true &&
      approvalRules?.mayAnswer(requestId: requestId, expectedDefinition: definitionId,
        expectedAccess: access, now: hostClock?.now() ?? Date.distantFuture) == true
    let request = approvalRules?.request(requestId)
    let storage = self.storage
    let stream = self.stream
    let fence = streamFence
    let time = hostClock
    let generation = gate?.generation
    lock.unlock()
    guard allowed, let request, let storage, let stream, let fence, let time else {
      return ["kind": "unavailable", "message": "That approval is no longer waiting on this iPhone."]
    }
    do {
      let expiry = try WireField.date(request, "expiresAt")
      let answerExpiry = min(expiry, time.now().addingTimeInterval(30))
      let expiresAt = IphoneHostClock.iso(answerExpiry)
      let signature = try IphoneProofs.approval(storage.approvalKey(), request: request,
        decision: decision, expiresAt: expiresAt)
      let answer: [String: Any] = ["kind": decision, "approval": ["requestId": requestId,
        "expiresAt": expiresAt, "signature": signature]]
      let frame = fence.fields.merging(["type": "runner.integrations.computer-app-approval-answer",
        "setupRequestId": requestId, "answer": answer]) { _, new in new }
      return await withCheckedContinuation { continuation in
        lock.lock()
        guard generation == gate?.generation, self.stream === stream,
          streamFence == fence, gate?.currentFence == fence.tag,
          pendingOutcomes[requestId] == nil else {
          lock.unlock(); continuation.resume(returning: ["kind": "unavailable", "message": "This iPhone is no longer connected."]); return
        }
        pendingOutcomes[requestId] = continuation
        lock.unlock()
        Task { [weak self] in
          guard let self else { return }
          do { try await self.send(frame, over: stream) }
          catch {
            self.finishOutcome(requestId, outcome: ["kind": "unavailable", "message": "This iPhone could not send that answer."])
            return
          }
          try? await Task.sleep(nanoseconds: 10_000_000_000)
          self.finishOutcome(requestId, outcome: ["kind": "unavailable", "message": "Opensteer did not answer in time."])
        }
      }
    } catch {
      return ["kind": "unavailable", "message": "This iPhone could not send that answer."]
    }
  }

  private func finishOutcome(_ id: String, outcome: [String: Any]) {
    lock.lock(); let continuation = pendingOutcomes.removeValue(forKey: id); lock.unlock()
    continuation?.resume(returning: outcome)
  }

  private func reconnect() {
    lock.lock(); gate?.activate(); dispatcher?.cancelAll(); connectionTask?.cancel(); connectionTask = nil; lock.unlock()
    closeSockets(); connectIfNeeded()
  }

  private func connectIfNeeded() {
    lock.lock()
    guard foreground, let identity, identity.state != .prepared,
      connectionTask == nil, let gate else { lock.unlock(); return }
    connection = "connecting"; issue = nil; retryAt = nil
    let generation = gate.generation
    connectionTask = Task { [weak self] in
      await self?.connectionLoop(identity: identity, generation: generation, authority: gate)
    }
    lock.unlock()
    publish()
  }

  private func current(_ generation: UInt64, authority: AdmissionGate? = nil) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return foreground && gate?.generation == generation && identity != nil &&
      (authority == nil || gate === authority)
  }

  private func transportAlive(_ generation: UInt64, session expected: URLSession) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return gate?.generation == generation && identity != nil && session === expected
  }

  private func connectionLoop(identity initial: PersistedIphoneIdentity, generation: UInt64,
    authority: AdmissionGate) async {
    var delaySeconds = 1
    var policy = ConnectionPolicy()
    while current(generation, authority: authority) && !Task.isCancelled {
      lock.lock(); let latest = self.identity; lock.unlock()
      guard let latest, latest.runnerId == initial.runnerId,
        latest.deploymentId == initial.deploymentId else { break }
      do {
        let renewed = try await attempt(identity: latest, generation: generation, authority: authority)
        if renewed { delaySeconds = 1 }
        policy.validFrame()
        if !current(generation, authority: authority) { break }
        setIssue(.hostUnreachable, message: nil, connection: "retrying", authority: authority, generation: generation)
      } catch let failure as IphoneConnectionFailure {
        if !current(generation, authority: authority) { break }
        if failure.violation {
          if policy.violation() == .protocolError {
            setIssue(.protocolError, message: nil, connection: "stopped", authority: authority, generation: generation)
            break
          }
        } else { policy.validFrame() }
        if failure.issue == .removed {
          _ = disconnect()
          lock.lock()
          if gate === authority {
            issue = .removed; issueMessage = failure.message; connection = "stopped"
          }
          lock.unlock(); publish()
          break
        }
        setIssue(failure.issue, message: failure.message,
          connection: ConnectionPolicy.shouldRetry(failure.issue) ? "retrying" : "stopped",
          authority: authority, generation: generation)
        if !ConnectionPolicy.shouldRetry(failure.issue) { break }
      } catch {
        if !current(generation, authority: authority) { break }
        if error is IphoneWireError || error is FrameDecodeError {
          if policy.violation() == .protocolError {
            setIssue(.protocolError, message: nil, connection: "stopped", authority: authority, generation: generation)
            break
          }
          setIssue(.protocolError, message: nil, connection: "retrying", authority: authority, generation: generation)
        } else {
          setIssue(.hostUnreachable, message: nil, connection: "retrying", authority: authority, generation: generation)
        }
      }
      if !current(generation, authority: authority) { break }
      let until = Date().addingTimeInterval(TimeInterval(delaySeconds))
      lock.lock()
      if gate === authority && authority.generation == generation { retryAt = IphoneHostClock.iso(until) }
      lock.unlock(); publish()
      try? await Task.sleep(nanoseconds: UInt64(delaySeconds) * 1_000_000_000)
      delaySeconds = min(delaySeconds * 2, 30)
    }
    lock.lock()
    if gate === authority && gate?.generation == generation { connectionTask = nil }
    lock.unlock()
  }

  private func setIssue(_ issue: ConnectionIssue, message: String?, connection: String,
    authority: AdmissionGate, generation: UInt64) {
    lock.lock()
    guard gate === authority && authority.generation == generation else { lock.unlock(); return }
    self.issue = issue; issueMessage = message; self.connection = connection
    lock.unlock(); publish()
  }

  private func attempt(identity initial: PersistedIphoneIdentity, generation: UInt64,
    authority: AdmissionGate) async throws -> Bool {
    guard let raw = initial.hostUrl, let expectedInstance = initial.hostInstanceId else {
      throw IphoneConnectionFailure(.failed)
    }
    let target = try HostTarget(raw)
    let delegate = IphoneNoRedirectDelegate()
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    lock.lock()
    guard gate === authority && authority.generation == generation && foreground else {
      lock.unlock(); session.invalidateAndCancel(); throw CancellationError()
    }
    self.session = session
    lock.unlock()
    defer {
      authority.detach(generation: generation)
      lock.lock()
      if gate === authority { dispatcher?.cancelAll(generation: generation) }
      lock.unlock()
      closeSockets(only: session)
    }
    do {
      try await discover(target: target, deploymentId: initial.deploymentId,
        instanceId: expectedInstance, session: session)
    } catch let failure as IphoneConnectionFailure { throw failure }
    catch { throw IphoneConnectionFailure(.hostUnreachable) }
    guard current(generation, authority: authority) else { throw CancellationError() }
    let primary = openSocket(session: session, target: target, path: "/internal/v1/runners")
    lock.lock()
    guard self.session === session && gate === authority && authority.generation == generation else {
      lock.unlock(); throw CancellationError()
    }
    self.primary = primary
    lock.unlock()
    primary.resume()
    let first = try await receive(primary)
    if try WireField.string(first.frame, "type") == "host.error" { throw refusal(first.frame) }
    let challenge: ProofChallenge
    do { challenge = try IphoneWire.challenge(first.frame) }
    catch { throw IphoneConnectionFailure(.needsUpdate, violation: true) }
    let key = try storage!.runnerKey()
    let descriptor = IphoneProofs.descriptor(bootId: bootId, runnerId: initial.runnerId,
      name: initial.name ?? "iPhone", runtimeVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")
    let token = initial.state == .pending ? try storage!.enrollmentToken() : nil
    guard initial.state != .pending || token != nil else { throw IphoneConnectionFailure(.enrollmentRefused) }
    try await send(IphoneWire.authenticateFrame(challenge: challenge, descriptor: descriptor, key: key, token: token), over: primary)
    let answer = try await receive(primary)
    if try WireField.string(answer.frame, "type") == "host.error" {
      throw refusal(answer.frame, enrolling: initial.state == .pending)
    }
    let welcome: PrimaryWelcome
    do { welcome = try IphoneWire.primaryWelcome(answer.frame, runnerId: initial.runnerId, bootId: bootId) }
    catch { throw IphoneConnectionFailure(.protocolError, violation: true) }
    let hostClock = IphoneHostClock(serverTime: welcome.serverTime, tick: answer.receivedAt, clock: clock)
    let primaryLeaseSeconds = max(0, welcome.leaseExpiresAt.timeIntervalSince(welcome.serverTime))
    guard primaryLeaseSeconds > 0 else { throw IphoneConnectionFailure(.protocolError, violation: true) }
    lock.lock(); primaryLeaseEnd = answer.receivedAt &+ UInt64(primaryLeaseSeconds * 1_000_000_000); lock.unlock()
    if initial.state == .pending {
      guard current(generation, authority: authority) else { throw CancellationError() }
      let enrolled = try storage!.markEnrolled()
      lock.lock()
      guard self.gate === authority && authority.generation == generation else {
        lock.unlock(); throw CancellationError()
      }
      identity = enrolled
      lock.unlock(); publish()
    }
    let ticketRequestId = "aux:\(UUID().uuidString.lowercased())"
    try await send(IphoneWire.ticketRequest(welcome.fence, requestId: ticketRequestId), over: primary)
    var ticket: String?
    while ticket == nil {
      let frame = try await receive(primary)
      let type = try WireField.string(frame.frame, "type")
      if type == "host.error" { throw refusal(frame.frame) }
      if type == "host.auxiliary.ticket" {
        guard try PrimaryFence(frame.frame) == welcome.fence,
          try WireField.string(frame.frame, "requestId") == ticketRequestId,
          try WireField.string(frame.frame, "module") == "integrations" else {
          throw IphoneConnectionFailure(.protocolError, violation: true)
        }
        ticket = try WireField.string(frame.frame, "ticket")
      } else if type == "host.connection.lease-renewed" {
        guard try PrimaryFence(frame.frame) == welcome.fence,
          try WireField.date(frame.frame, "connectionLeaseExpiresAt") > hostClock.now() else {
          throw IphoneConnectionFailure(.protocolError, violation: true)
        }
      } else {
        throw IphoneConnectionFailure(.protocolError, violation: true)
      }
    }
    guard current(generation, authority: authority) else { throw CancellationError() }
    let stream = openSocket(session: session, target: target, path: "/internal/v1/runners/auxiliary/integrations")
    lock.lock()
    guard self.session === session && gate === authority && authority.generation == generation else {
      lock.unlock(); throw CancellationError()
    }
    self.stream = stream
    lock.unlock()
    stream.resume()
    let streamChallenge = try await receive(stream)
    if try WireField.string(streamChallenge.frame, "type") == "host.auxiliary.rejected" { throw refusal(streamChallenge.frame) }
    let auxChallenge = try IphoneWire.challenge(streamChallenge.frame, auxiliary: true)
    try await send(IphoneWire.auxiliaryAuthenticateFrame(challenge: auxChallenge, key: key,
      runnerId: initial.runnerId, bootId: bootId, ticket: ticket!), over: stream)
    let streamAnswer = try await receive(stream)
    if try WireField.string(streamAnswer.frame, "type") == "host.auxiliary.rejected" { throw refusal(streamAnswer.frame) }
    let auxWelcome = try IphoneWire.auxiliaryWelcome(streamAnswer.frame, primary: welcome.fence)
    let leaseSeconds = max(0, Int(auxWelcome.leaseExpiresAt.timeIntervalSince(auxWelcome.serverTime)))
    guard leaseSeconds > 0 else { throw IphoneConnectionFailure(.protocolError, violation: true) }
    lock.lock()
    guard gate === authority && authority.generation == generation else {
      lock.unlock(); throw CancellationError()
    }
    authority.attach(fence: auxWelcome.fence.tag, leaseSeconds: UInt64(leaseSeconds))
    self.hostClock = hostClock
    streamFence = auxWelcome.fence
    connection = "online"; issue = nil; issueMessage = nil; retryAt = nil
    let keyId = try storage!.approvalKeyId()
    approvalRules = ApprovalRules(runnerId: initial.runnerId, keyId: keyId)
    lock.unlock()
    try await send(IphoneWire.modulesReport(welcome.fence, checkedAt: hostClock.isoNow()), over: primary)
    await sendStatus()
    try await send(auxWelcome.fence.fields.merging(["type": "runner.integrations.computer-app-approvals-sync"]) { _, new in new }, over: stream)
    publish()
    return try await withThrowingTaskGroup(of: Bool.self) { group in
      group.addTask { try await self.primaryLoop(primary, welcome: welcome, generation: generation, session: session, clock: hostClock) }
      group.addTask { try await self.streamLoop(stream, fence: auxWelcome.fence, generation: generation, session: session) }
      group.addTask { try await self.heartbeats(primary: primary, stream: stream, primaryFence: welcome.fence,
        streamFence: auxWelcome.fence, primaryMs: welcome.heartbeatIntervalMs, streamMs: auxWelcome.heartbeatIntervalMs,
        generation: generation, session: session, clock: hostClock) }
      group.addTask { try await self.statusLoop(generation: generation, session: session) }
      do {
        let result = try await group.next() ?? false
        group.cancelAll()
        // A cancelled URLSession receive need not finish until its socket closes.
        stream.cancel(with: .goingAway, reason: nil)
        primary.cancel(with: .goingAway, reason: nil)
        return result
      } catch {
        group.cancelAll()
        stream.cancel(with: .goingAway, reason: nil)
        primary.cancel(with: .goingAway, reason: nil)
        throw error
      }
    }
  }

  private func discover(target: HostTarget, deploymentId: String, instanceId: String, session: URLSession) async throws {
    let url = target.url.appendingPathComponent(".well-known/opensteer")
    var request = URLRequest(url: url)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count <= 16_384,
      let outer = try? FrameDecoder.decode(data),
      let authority = outer["authority"] as? [String: Any],
      let document = authority["document"] as? [String: Any] else {
      throw IphoneConnectionFailure(.hostUnreachable)
    }
    guard document["deploymentId"] as? String == deploymentId,
      document["hostInstanceId"] as? String == instanceId else {
      throw IphoneConnectionFailure(.hostMismatch)
    }
  }

  private func openSocket(session: URLSession, target: HostTarget, path: String) -> URLSessionWebSocketTask {
    var components = URLComponents(url: target.url, resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = path
    return session.webSocketTask(with: components.url!)
  }

  private func receive(_ socket: URLSessionWebSocketTask) async throws -> (frame: [String: Any], receivedAt: UInt64) {
    let message: URLSessionWebSocketTask.Message
    do { message = try await socket.receive() }
    catch {
      if socket.closeCode.rawValue == 4010 { throw IphoneConnectionFailure(.removed) }
      throw error
    }
    let tick = clock.now()
    let data: Data
    switch message {
    case .string(let value): data = Data(value.utf8)
    case .data: throw IphoneConnectionFailure(.protocolError, violation: true)
    @unknown default: throw IphoneConnectionFailure(.protocolError, violation: true)
    }
    do { return (try FrameDecoder.decode(data), tick) }
    catch { throw IphoneConnectionFailure(.protocolError, violation: true) }
  }

  private func send(_ frame: [String: Any], over socket: URLSessionWebSocketTask) async throws {
    let data = try FrameDecoder.encode(frame)
    guard let text = String(data: data, encoding: .utf8) else { throw IphoneConnectionFailure(.protocolError) }
    try await socket.send(.string(text))
  }

  private func refusal(_ frame: [String: Any], enrolling: Bool = false) -> IphoneConnectionFailure {
    let error = frame["error"] as? [String: Any] ?? [:]
    let reason = error["reason"] as? String
    let message = error["message"] as? String
    let issue = ConnectionPolicy.issue(reason: reason, closeCode: 4003, enrolling: enrolling)
    return IphoneConnectionFailure(issue, message: issue == .enrollmentRefused ? nil : message)
  }

  private func primaryLoop(_ socket: URLSessionWebSocketTask, welcome: PrimaryWelcome,
    generation: UInt64, session: URLSession, clock: IphoneHostClock) async throws -> Bool {
    var renewed = false
    while transportAlive(generation, session: session) && !Task.isCancelled {
      let received = try await receive(socket)
      guard transportAlive(generation, session: session) else { break }
      let frame = received.frame
      let type = try WireField.string(frame, "type")
      if type == "host.error" { throw refusal(frame) }
      guard type == "host.connection.lease-renewed", try PrimaryFence(frame) == welcome.fence else {
        throw IphoneConnectionFailure(.protocolError, violation: true)
      }
      let expiry = try WireField.date(frame, "connectionLeaseExpiresAt")
      let seconds = expiry.timeIntervalSince(clock.now())
      guard seconds > 0 else { throw IphoneConnectionFailure(.hostUnreachable) }
      lock.lock()
      if self.session === session { primaryLeaseEnd = received.receivedAt &+ UInt64(seconds * 1_000_000_000) }
      lock.unlock()
      renewed = true
    }
    return renewed
  }

  private func streamLoop(_ socket: URLSessionWebSocketTask, fence: AuxiliaryFence,
    generation: UInt64, session: URLSession) async throws -> Bool {
    while transportAlive(generation, session: session) && !Task.isCancelled {
      let received = try await receive(socket)
      guard transportAlive(generation, session: session) else { break }
      let frame = received.frame
      let type = try WireField.string(frame, "type")
      guard try AuxiliaryFence(frame) == fence else { throw IphoneConnectionFailure(.protocolError, violation: true) }
      switch type {
      case "host.auxiliary.lease-renewed":
        let expiry = try WireField.date(frame, "streamLeaseExpiresAt")
        lock.lock(); let now = hostClock?.now() ?? Date.distantFuture
        let renewed = gate?.renew(fence: fence.tag, leaseSeconds: UInt64(max(0, Int(expiry.timeIntervalSince(now))))) ?? false
        lock.unlock()
        if !renewed { throw IphoneConnectionFailure(.hostUnreachable) }
      case "host.integrations.invoke":
        Task { [weak self] in await self?.execute(frame, fence: fence, receivedAt: received.receivedAt,
          generation: generation, session: session) }
      case "host.integrations.cancel":
        if let requestId = frame["requestId"] as? String { cancel(requestId) }
      case "host.integrations.computer-app-approvals":
        applyApprovals(frame, generation: generation, fence: fence)
      case "host.integrations.computer-app-approval-outcome":
        if let id = frame["setupRequestId"] as? String,
          let outcome = frame["outcome"] as? [String: Any] { finishOutcome(id, outcome: outcome) }
      case "host.integrations.computer-app-approval-key-challenge":
        try await proveApprovalKey(frame, fence: fence, stream: socket, generation: generation)
      default:
        throw IphoneConnectionFailure(.protocolError, violation: true)
      }
    }
    return false
  }

  private func cancel(_ requestId: String) {
    lock.lock(); let dispatcher = self.dispatcher; lock.unlock()
    dispatcher?.cancel(requestId)
  }

  private func execute(_ frame: [String: Any], fence: AuxiliaryFence, receivedAt: UInt64,
    generation: UInt64, session expected: URLSession) async {
    lock.lock()
    let socket = stream
    let dispatcher = self.dispatcher
    let live = gate?.generation == generation && gate?.currentFence == fence.tag &&
      streamFence == fence && session === expected
    let app = frame["definitionId"] as? String ?? ""
    let permission = permissionStates[app] ?? .notDetermined
    let name = identity?.name ?? "iPhone"
    lock.unlock()
    guard live, let socket, let dispatcher else { return }
    let result = await dispatcher.run(frame, fence: fence, receivedAt: receivedAt,
      permission: permission, deviceName: name)
    if let result, transportAlive(generation, session: expected) { try? await send(result, over: socket) }
  }

  private func applyApprovals(_ frame: [String: Any], generation: UInt64, fence: AuxiliaryFence) {
    guard let entries = frame["approvals"] as? [[String: Any]] else { return }
    let requests = entries.compactMap { $0["request"] as? [String: Any] }
    lock.lock()
    guard gate?.generation == generation, gate?.currentFence == fence.tag,
      streamFence == fence else { lock.unlock(); return }
    approvalRules?.replace(requests)
    approvalPrompts = requests.filter { request in
      request["runnerId"] as? String == identity?.runnerId &&
      request["kind"] as? String == "app" &&
      InvokeRules.apps.contains(request["definitionId"] as? String ?? "")
    }
    hostKeyId = frame["approvalKeyId"] as? String
    lock.unlock(); publish()
  }

  private func proveApprovalKey(_ frame: [String: Any], fence: AuxiliaryFence,
    stream: URLSessionWebSocketTask, generation: UInt64) async throws {
    lock.lock()
    let allowed = streamFence == fence && gate?.currentFence == fence.tag && self.stream === stream &&
      (approvalRules?.mayProve(keyId: frame["keyId"] as? String ?? "",
        runnerId: frame["runnerId"] as? String ?? "") ?? false)
    let storage = self.storage
    lock.unlock()
    guard allowed, let storage, current(generation) else { throw IphoneConnectionFailure(.protocolError, violation: true) }
    let challenge: [String: Any] = ["challengeId": try WireField.string(frame, "challengeId"),
      "expiresAt": try WireField.string(frame, "expiresAt"),
      "keyId": try WireField.string(frame, "keyId"), "nonce": try WireField.string(frame, "nonce"),
      "runnerId": try WireField.string(frame, "runnerId")]
    let signature = try IphoneProofs.keyChallenge(storage.approvalKey(), challenge: challenge)
    try await send(fence.fields.merging(["type": "runner.integrations.computer-app-approval-key-proof",
      "challengeId": challenge["challengeId"]!, "signature": signature]) { _, new in new }, over: stream)
  }

  private func heartbeats(primary: URLSessionWebSocketTask, stream: URLSessionWebSocketTask,
    primaryFence: PrimaryFence, streamFence: AuxiliaryFence, primaryMs: Int, streamMs: Int,
    generation: UInt64, session: URLSession, clock: IphoneHostClock) async throws -> Bool {
    let cadence = max(1_000, min(primaryMs, streamMs) / 2)
    while transportAlive(generation, session: session) && !Task.isCancelled {
      try await Task.sleep(nanoseconds: UInt64(cadence) * 1_000_000)
      guard transportAlive(generation, session: session) else { break }
      lock.lock(); let leaseEnd = primaryLeaseEnd; lock.unlock()
      guard self.clock.now() < leaseEnd else { throw IphoneConnectionFailure(.hostUnreachable) }
      try await send(IphoneWire.heartbeat(primaryFence, sentAt: clock.isoNow()), over: primary)
      try await send(IphoneWire.auxiliaryHeartbeat(streamFence, sentAt: clock.isoNow()), over: stream)
    }
    return false
  }

  private func statusLoop(generation: UInt64, session: URLSession) async throws -> Bool {
    // Finishing this task closes its sibling transports, including an active drain.
    while transportAlive(generation, session: session) && !Task.isCancelled {
      try await Task.sleep(nanoseconds: 30_000_000_000)
      guard transportAlive(generation, session: session) else { break }
      await sendStatus()
    }
    return false
  }

  private func sendStatus() async {
    lock.lock(); let fence = streamFence; let stream = self.stream; let states = permissionStates; let accuracy = locationAccuracy
    let allowed = connection == "online" && foreground && gate?.currentFence == fence?.tag
    lock.unlock()
    guard allowed, let fence, let stream else { return }
    try? await send(IphoneWire.status(fence, permissions: states, locationAccuracy: accuracy), over: stream)
  }

  private func closeSockets(only expected: URLSession? = nil) {
    lock.lock()
    if let expected, self.session !== expected { lock.unlock(); return }
    let primary = self.primary; self.primary = nil
    let stream = self.stream; self.stream = nil; streamFence = nil
    let session = self.session; self.session = nil
    primaryLeaseEnd = 0
    let outcomes = pendingOutcomes; pendingOutcomes.removeAll()
    lock.unlock()
    for continuation in outcomes.values {
      continuation.resume(returning: ["kind": "unavailable", "message": "This iPhone is no longer connected."])
    }
    stream?.cancel(with: .goingAway, reason: nil)
    primary?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
  }
}

private enum IphoneRuntimeError: Error { case unsupported, invalidTarget, notForeground, busy }

private struct IphoneConnectionFailure: Error {
  let issue: ConnectionIssue
  let message: String?
  let violation: Bool
  init(_ issue: ConnectionIssue, message: String? = nil, violation: Bool = false) {
    self.issue = issue; self.message = message; self.violation = violation
  }
}

private final class IphoneNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

private final class IphoneHostClock {
  private let serverTime: Date
  private let tick: UInt64
  private let clock: SystemContinuousClock
  init(serverTime: Date, tick: UInt64, clock: SystemContinuousClock) {
    self.serverTime = serverTime; self.tick = tick; self.clock = clock
  }
  func now() -> Date {
    serverTime.addingTimeInterval(Double(clock.now() - tick) / 1_000_000_000)
  }
  func isoNow() -> String { Self.iso(now()) }
  static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}
