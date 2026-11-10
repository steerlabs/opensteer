import XCTest
import CryptoKit
@testable import IphoneAppsCore

final class PhoneBrowserTransportTests: XCTestCase {
  private func vector(_ name: String) throws -> [String: Any] {
    var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while root.path != "/" {
      let file = root.appendingPathComponent("packages/browser-core/test-vectors/\(name).v1.json")
      if FileManager.default.fileExists(atPath: file.path) {
        return try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
      }
      root.deleteLastPathComponent()
    }
    throw NSError(domain: "Missing shared vectors", code: 1)
  }

  func testAllTicketVectors() throws {
    let fixture = try vector("attach-tickets")
    let keys = [["keyId": "fixture", "publicKeyPem": fixture["publicKeyPem"]!]]
    for test in fixture["cases"] as! [[String: Any]] {
      let operation = {
        try PhoneBrowserTickets.verify(test["token"] as! String, keys: keys,
          runtimeId: test["runtimeId"] as? String ?? fixture["runtimeId"] as! String,
          now: (test["now"] as? NSNumber ?? fixture["now"] as! NSNumber).int64Value)
      }
      if test["accepted"] as! Bool {
        XCTAssertNoThrow(try operation(), test["name"] as! String)
      } else {
        XCTAssertThrowsError(try operation(), test["name"] as! String)
      }
    }
  }

  func testSignedInvalidClaimsAndNoncanonicalSignatureAreRefused() throws {
    let fixture = try vector("attach-tickets")
    let key = Curve25519.Signing.PrivateKey()
    let header = IphoneProofs.base64url(try JSONSerialization.data(withJSONObject: ["alg": "EdDSA", "kid": "test", "typ": "opensteer-browser-attach+jwt"]))
    let keys: [[String: Any]] = [["keyId": "test", "publicKeyPem": IphoneProofs.publicKeyPem(key)]]
    let claims = fixture["claims"] as! [String: Any]
    for patch: [String: Any] in [["unknown": true], ["wireVersion": true], ["viewport": ["width": true, "height": 100]],
      ["initialNavigation": ["operationKey": "open", "url": "https://person:secret@example.test"]],
      ["identity": ["kind": "profile-local", "binding": [:], "initialized": true, "readyUrl": "about:blank"]]] {
      let payload = IphoneProofs.base64url(try JSONSerialization.data(withJSONObject: claims.merging(patch) { _, next in next }))
      let signed = header + "." + payload
      let token = signed + "." + IphoneProofs.base64url(try key.signature(for: Data(signed.utf8)))
      XCTAssertThrowsError(try PhoneBrowserTickets.verify(token, keys: keys, runtimeId: "phone", now: 1794225600000))
    }
    let valid = (fixture["cases"] as! [[String: Any]])[0]["token"] as! String
    let fixtureKeys = [["keyId": "fixture", "publicKeyPem": fixture["publicKeyPem"]!]]
    XCTAssertThrowsError(try PhoneBrowserTickets.verify(String(valid.dropLast()) + "B", keys: fixtureKeys, runtimeId: "phone", now: 1794225600000))
    XCTAssertThrowsError(try PhoneBrowserTickets.verify(String(repeating: "a", count: 16_385), keys: fixtureKeys, runtimeId: "phone", now: 1794225600000))
  }

  func testFenceVectorsAndQueuedEpochRefusal() throws {
    let fixture = try vector("fences")
    let fields = fixture["fence"] as! [String: Any]
    let now = (fixture["now"] as! NSNumber).int64Value
    let state = PhoneBrowserAdmission()
    try state.setEpoch(1)
    try state.adopt(fixture["welcome"] as! [String: Any], now: now)
    for test in fixture["comparisons"] as! [[String: Any]] {
      let changed = fields.merging(test["patch"] as! [String: Any]) { _, new in new }
      XCTAssertEqual(state.accepts(changed, epoch: 1, now: now), test["accepted"] as! Bool)
    }
    XCTAssertFalse(state.accepts(fields, epoch: 1, now: now + 1000))
    try state.renew(until: now + 2000, now: now + 999)
    XCTAssertTrue(state.accepts(fields, epoch: 1, now: now + 1000))
    state.retire()
    XCTAssertFalse(state.accepts(fields, epoch: 1, now: now))
    XCTAssertThrowsError(try state.setEpoch(1))
    try state.setEpoch(3)
    XCTAssertFalse(state.accepts(fields, epoch: 3, now: now))
  }

  func testReplayVectorsAndDurability() throws {
    let fixture = try vector("fences")["replay"] as! [String: Any]
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let ledger = try PhoneBrowserReplayLedger(directory: directory, capacity: 1)
    for test in fixture["cases"] as! [[String: Any]] {
      let operation = {
        try ledger.claim(nonce: test["nonce"] as! String,
          expiresAt: (test["expiresAt"] as? NSNumber ?? fixture["expiresAt"] as! NSNumber).int64Value,
          now: (test["now"] as! NSNumber).int64Value)
      }
      if test["accepted"] as! Bool { XCTAssertNoThrow(try operation()) }
      else { XCTAssertThrowsError(try operation()) }
    }
    let restarted = try PhoneBrowserReplayLedger(directory: directory, capacity: 1)
    XCTAssertEqual(try ledger.snapshot(), try restarted.snapshot())
    XCTAssertThrowsError(try restarted.claim(nonce: "fixture-replay-nonce-0001", expiresAt: 1794225603000, now: 1794225601000))
    XCTAssertThrowsError(try restarted.claim(nonce: "fixture-replay-nonce-0003", expiresAt: 1794225603000, now: 1794225601000))
    let file = directory.appendingPathComponent("replay.json")
    try Data("broken".utf8).write(to: file)
    XCTAssertThrowsError(try PhoneBrowserReplayLedger(directory: directory))
    try FileManager.default.removeItem(at: file)
    XCTAssertThrowsError(try PhoneBrowserReplayLedger(directory: directory))
    try FileManager.default.removeItem(at: directory)
    XCTAssertThrowsError(try PhoneBrowserReplayLedger(directory: directory, allowCreate: false))
  }

  func testFrameVectors() throws {
    let fixture = try vector("frames")
    func bytes(_ text: String) -> Data {
      var data = Data(); var offset = text.startIndex
      while offset < text.endIndex {
        let end = text.index(offset, offsetBy: 2)
        data.append(UInt8(text[offset..<end], radix: 16)!); offset = end
      }
      return data
    }
    let frame = bytes(fixture["envelopeHex"] as! String)
    let relay = bytes(fixture["relayEnvelopeHex"] as! String)
    let decoded = try PhoneBrowserFrames.decodeRelay(relay)
    XCTAssertEqual(decoded.payload, frame)
    let padded = Data(repeating: 0, count: 13) + relay
    XCTAssertEqual(try PhoneBrowserFrames.decodeRelay(padded.dropFirst(13)).payload, frame)
    XCTAssertEqual(try PhoneBrowserFrames.envelope(header: fixture["header"] as! [String: Any], payload: bytes(fixture["payloadHex"] as! String)), frame)
    let encoded = try PhoneBrowserFrames.relay(header: decoded.header, frame: frame)
    XCTAssertEqual(try PhoneBrowserFrames.decodeRelay(encoded).payload, frame)
    for invalid in fixture["invalidHex"] as! [String] {
      XCTAssertThrowsError(try PhoneBrowserFrames.validateFrame(bytes(invalid)))
    }
    XCTAssertThrowsError(try PhoneBrowserFrames.relay(header: decoded.header, frame: Data(count: 8 * 1024 * 1024 + 1)))
  }

  func testWelcomeAcceptsOnlyOldOrPhoneGrantAndSignsBrowserProof() throws {
    let fixture = try vector("fences")
    var welcome = fixture["welcome"] as! [String: Any]
    welcome["type"] = "host.welcome"
    welcome["connectionLeaseExpiresAt"] = welcome["streamLeaseExpiresAt"]
    let runner = welcome["runnerId"] as! String
    let boot = welcome["bootId"] as! String
    for modules in [["integrations"], ["browser", "integrations"], ["integrations", "browser"]] {
      welcome["allowedModules"] = modules
      XCTAssertEqual(try IphoneWire.primaryWelcome(welcome, runnerId: runner, bootId: boot).allowedModules, modules)
    }
    for modules in [[], ["browser"], ["agents", "integrations"], ["integrations", "integrations"]] {
      welcome["allowedModules"] = modules
      XCTAssertThrowsError(try IphoneWire.primaryWelcome(welcome, runnerId: runner, bootId: boot))
    }
    let key = Curve25519.Signing.PrivateKey()
    let challenge = ProofChallenge(challengeId: "challenge", nonce: "nonce", hostSessionId: "host", expiresAt: "2026-11-09T12:00:01.000Z")
    let browser = try IphoneProofs.auxiliary(key, challenge: challenge, runnerId: runner, bootId: boot, ticket: "disposable", module: "browser")
    let integration = try IphoneProofs.auxiliary(key, challenge: challenge, runnerId: runner, bootId: boot, ticket: "disposable")
    XCTAssertNotEqual(browser, integration)
    XCTAssertEqual(ConnectionPolicy.issue(reason: "runner-identity-revoked", closeCode: 4003), .removed)
  }

  func testRemovalAndSignoutRetainIdentityUntilErasureConfirmed() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record)
    let original = try store.prepare(deploymentId: "deployment")
    _ = try store.markBrowserReplayInitialized(storageInstanceId: UUID().uuidString)
    let stopped = try store.markBrowserErasurePending()
    XCTAssertEqual(stopped.runnerId, original.runnerId)
    XCTAssertNotNil(try vault.read(.runnerKey))
    XCTAssertThrowsError(try store.wipe())
    XCTAssertThrowsError(try store.prepare(deploymentId: "deployment"))
    XCTAssertThrowsError(try store.discardPendingEnrollment())
    XCTAssertFalse(try store.completeBrowserErasure(deploymentId: "deployment", confirmed: false))
    let restarted = IdentityStore(vault: vault, record: record)
    XCTAssertTrue(try restarted.load()?.browserErasurePending == true)
    XCTAssertThrowsError(try restarted.completeBrowserErasure(deploymentId: "another", confirmed: true))
    XCTAssertEqual(try restarted.load()?.runnerId, original.runnerId)
    let pendingBytes = try XCTUnwrap(record.read())
    try record.write(Data("corrupt".utf8))
    XCTAssertThrowsError(try restarted.load())
    XCTAssertThrowsError(try restarted.wipe())
    XCTAssertNotNil(try vault.read(.runnerKey))
    try record.write(pendingBytes)
    XCTAssertTrue(try restarted.completeBrowserErasure(deploymentId: "deployment", confirmed: true))
    XCTAssertNil(try restarted.load())
    XCTAssertNil(try vault.read(.runnerKey))
  }

  func testOpaqueTicketsCommitWitnessAndReconnectReplay() async throws {
    let ticketFixture = try vector("attach-tickets")
    let fenceFixture = try vector("fences")
    let now = (ticketFixture["now"] as! NSNumber).int64Value
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let ledger = try PhoneBrowserReplayLedger(directory: directory)
    let clock = BrowserTestClock(now)
    let queue = DispatchQueue(label: "test.browser-pixels")
    var detached: [String] = []
    let connection = PhoneBrowserConnection(now: { clock.now }, queue: queue, onDetach: { _, attachment in detached.append(attachment) })
    try connection.configure(epoch: 0, runtimeId: "phone", ledger: ledger)
    var welcome = fenceFixture["welcome"] as! [String: Any]
    welcome["browserWireVersion"] = 1
    welcome["browserAttachPublicKeys"] = [["keyId": "fixture", "publicKeyPem": ticketFixture["publicKeyPem"]!]]
    var events: [[String: Any]] = []
    let sends = BrowserSentMessages()
    connection.setObserver { events.append($0) }
    try connection.adopt(welcome, sender: { message, completion in sends.append(message); completion(nil) }, close: {})
    XCTAssertEqual(events.last!["leaseDeadline"] as? Int64, now + 1000)
    defer { connection.offline(reason: "test-finished") }
    let fence = fenceFixture["fence"] as! [String: Any]
    let capability: [String: Any] = ["capabilityGeneration": 1, "capabilityLeaseId": "bcl_11111111-1111-4111-8111-111111111111", "runtimeId": "phone"]
    let lease = capability.merging(["expiresAt": "2026-11-09T12:00:01.000Z"]) { _, next in next }
    try connection.receive(fence.merging(["type": "capability.grant", "lease": lease, "requestId": "grant"]) { _, next in next })
    let token = (ticketFixture["cases"] as! [[String: Any]])[0]["token"] as! String
    let channelId = "bch_11111111-1111-4111-8111-111111111111"
    let attach = fence.merging(["type": "browser.attach", "requestId": "attach", "channelId": channelId, "capability": capability, "attachTicket": token]) { _, next in next }
    try connection.receive(attach)
    let forwarded = events.last!["message"] as! [String: Any]
    XCTAssertNil(forwarded["attachTicket"])
    let handle = forwarded["attachHandle"] as! String
    XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: events), as: UTF8.self).contains(token))
    let verified = try connection.verifyAttach(epoch: 0, attachHandle: handle)
    let transition = try ledger.snapshot().claiming(nonce: "fixture-ticket-nonce-0001", expiresAt: now + 60_000, now: now, capacity: ledger.capacity)
    let proposed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(transition)) as! [String: Any]
    XCTAssertThrowsError(try connection.commitAttach(epoch: 0, attachHandle: handle, claimsDigest: "changed", replayTransition: proposed))
    XCTAssertEqual(try ledger.snapshot().entries.count, 0)
    let permit = try connection.commitAttach(epoch: 0, attachHandle: handle, claimsDigest: verified["claimsDigest"] as! String, replayTransition: proposed)
    XCTAssertEqual(try connection.permit(permit, epoch: 0).claimsDigest, verified["claimsDigest"] as! String)
    let claims = verified["claims"] as! [String: Any]
    let sessionId = claims["sessionId"] as! String
    let actor = UUID().uuidString
    let attachment = UUID().uuidString
    XCTAssertThrowsError(try connection.checkAgent(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor))
    let agentAttach: [String: Any] = ["type": "agent.attach", "sessionId": sessionId, "attachmentId": attachment, "actorToken": actor, "backend": "actions"]
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": agentAttach]) { _, next in next })
    XCTAssertNoThrow(try connection.checkAgent(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor))
    XCTAssertThrowsError(try connection.checkAgent(epoch: 0, channelId: channelId, sessionId: "another-session", attachmentId: attachment, actorToken: actor))
    XCTAssertThrowsError(try connection.checkAgent(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: UUID().uuidString))
    XCTAssertThrowsError(try connection.checkAction(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor, requestId: "unobserved"))
    let actionRequest: [String: Any] = ["type": "agent.action", "attachmentId": attachment,
      "actorToken": actor, "requestId": "observed", "request": ["sessionId": sessionId, "surfaceId": "tab", "documentId": "document", "timeoutMs": 1, "action": ["type": "page.capture"]]]
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability, "message": actionRequest]) { _, next in next })
    XCTAssertNoThrow(try connection.checkAction(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor, requestId: "observed"))
    XCTAssertThrowsError(try connection.permit("action:observed", epoch: 0))
    let opening: [String: Any] = ["type": "agent.action", "attachmentId": attachment,
      "actorToken": actor, "requestId": "opening", "request": ["sessionId": sessionId, "timeoutMs": 30000, "action": ["type": "surface.open"]]]
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability, "message": opening]) { _, next in next })
    XCTAssertEqual(try connection.permit("action:opening", epoch: 0).claimsDigest, verified["claimsDigest"] as! String)
    let observedRequest = actionRequest["request"] as! [String: Any]
    XCTAssertNoThrow(try connection.checkAction(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor, requestId: "observed", request: observedRequest))
    var changedRequest = observedRequest
    changedRequest["surfaceId"] = "another-tab"
    XCTAssertThrowsError(try connection.checkAction(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor, requestId: "observed", request: changedRequest))
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": ["type": "agent.detach", "sessionId": sessionId, "attachmentId": attachment]]) { _, next in next })
    XCTAssertThrowsError(try connection.checkAgent(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor))
    XCTAssertThrowsError(try connection.checkAction(epoch: 0, channelId: channelId, sessionId: sessionId, attachmentId: attachment, actorToken: actor, requestId: "observed"))
    XCTAssertTrue(detached.contains(attachment))
    XCTAssertThrowsError(try connection.permit("action:opening", epoch: 0))
    XCTAssertThrowsError(try connection.commitAttach(epoch: 0, attachHandle: handle, claimsDigest: verified["claimsDigest"] as! String, replayTransition: proposed))
    let writer = try connection.frameWriter(epoch: 0, channelId: channelId)
    var header = try vector("frames")["header"] as! [String: Any]
    let watchToken = UUID().uuidString
    header["watchToken"] = watchToken
    let hostToken = expectation(description: "Host-only Watch tokens cannot be sent by the phone runtime")
    writer.writeFrame(header: header, pixels: Data([0xff])) { delivered in XCTAssertFalse(delivered); hostToken.fulfill() }
    await fulfillment(of: [hostToken], timeout: 2)
    header.removeValue(forKey: "watchToken")
    let sent = expectation(description: "Native frame delivered without JavaScript or a Host Watch token")
    writer.writeFrame(header: header, pixels: Data([0xff, 0xd8, 0xff, 0xd9])) { delivered in XCTAssertTrue(delivered); sent.fulfill() }
    await fulfillment(of: [sent], timeout: 2)
    let duplicate = expectation(description: "The same native frame cannot be replayed")
    writer.writeFrame(header: header, pixels: Data([0xff])) { delivered in XCTAssertFalse(delivered); duplicate.fulfill() }
    await fulfillment(of: [duplicate], timeout: 2)
    header["frameId"] = 8
    let nextFrame = expectation(description: "Socket completion, not a viewer Watch acknowledgement, admits the next native frame")
    writer.writeFrame(header: header, pixels: Data([0xff])) { delivered in XCTAssertTrue(delivered); nextFrame.fulfill() }
    await fulfillment(of: [nextFrame], timeout: 2)
    XCTAssertEqual(sends.binarySequences(), [1, 2])
    let result = expectation(description: "One-shot pixels are encoded only on the native socket writer")
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": agentAttach]) { _, next in next })
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": actionRequest]) { _, next in next })
    writer.writePixelResult(message: ["type": "agent.result", "requestId": "observed", "attachmentId": attachment, "result": ["type": "page.capture"]],
      dataPath: ["result", "data"], pixels: Data([1, 2, 3])) { delivered in XCTAssertTrue(delivered); result.fulfill() }
    await fulfillment(of: [result], timeout: 2)
    let stalePicture = expectation(description: "A document or geometry fence refuses captured pixels before socket submission")
    writer.writePixelResult(message: ["type": "agent.result", "requestId": "observed", "attachmentId": attachment, "result": ["type": "page.capture"]],
      dataPath: ["result", "data"], pixels: Data([1]), withValidity: { _ in false }) { delivered in
      XCTAssertFalse(delivered); stalePicture.fulfill()
    }
    await fulfillment(of: [stalePicture], timeout: 2)
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": ["type": "agent.detach", "sessionId": sessionId, "attachmentId": attachment]]) { _, next in next })
    let detachedPicture = expectation(description: "Detached agents cannot deliver a completed screenshot")
    writer.writePixelResult(message: ["type": "agent.result", "requestId": "observed", "attachmentId": attachment, "result": ["type": "page.capture"]],
      dataPath: ["result", "data"], pixels: Data([1])) { delivered in
      XCTAssertFalse(delivered); detachedPicture.fulfill()
    }
    await fulfillment(of: [detachedPicture], timeout: 2)
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": agentAttach]) { _, next in next })
    var expiring = actionRequest
    expiring["requestId"] = "expiring"
    try connection.receive(fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": expiring]) { _, next in next })
    let expiredPicture = expectation(description: "A screenshot queued past its request deadline is never submitted")
    queue.suspend()
    writer.writePixelResult(message: ["type": "agent.result", "requestId": "expiring", "attachmentId": attachment, "result": ["type": "page.capture"]],
      dataPath: ["result", "data"], pixels: Data([1])) { delivered in
      XCTAssertFalse(delivered); expiredPicture.fulfill()
    }
    clock.advance(2)
    queue.resume()
    await fulfillment(of: [expiredPicture], timeout: 2)
    let command = fence.merging(["type": "browser.client-message", "channelId": channelId, "capability": capability,
      "message": ["type": "cdp.command", "requestId": "open", "command": ["method": "Opensteer.openTab", "parameters": ["operationAuthority": token, "idempotencyKey": "open"]]]]) { _, next in next }
    try connection.receive(command)
    XCTAssertNotNil(events.last!["authorityHandle"])
    XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: events.last!), as: UTF8.self).contains(token))
    connection.offline(reason: "reconnect")
    XCTAssertEqual(connection.epoch, 0)
    XCTAssertEqual(events.last!["state"] as? String, "offline")
    XCTAssertEqual(events.last!["reason"] as? String, "reconnect")
    XCTAssertEqual(try AuxiliaryFence(events.last!["fence"] as! [String: Any]), try AuxiliaryFence(fence))
    let dropped = expectation(description: "Writer from a lost stream drops native pictures")
    writer.writeFrame(header: header, pixels: Data([0xff])) { delivered in XCTAssertFalse(delivered); dropped.fulfill() }
    await fulfillment(of: [dropped], timeout: 2)
    XCTAssertThrowsError(try connection.permit(permit, epoch: 0))
    try connection.adopt(welcome, sender: { _, completion in completion(nil) }, close: {})
    try connection.receive(fence.merging(["type": "capability.grant", "lease": lease, "requestId": "grant"]) { _, next in next })
    try connection.receive(attach)
    let nextHandle = (events.last!["message"] as! [String: Any])["attachHandle"] as! String
    _ = try connection.verifyAttach(epoch: connection.epoch, attachHandle: nextHandle)
    XCTAssertThrowsError(try connection.commitAttach(epoch: connection.epoch, attachHandle: nextHandle, claimsDigest: verified["claimsDigest"] as! String, replayTransition: proposed))
  }

  func testQueuedRelayCannotCrossEpochOrStream() async throws {
    let fixture = try vector("fences")
    let ticketFixture = try vector("attach-tickets")
    let now = (fixture["now"] as! NSNumber).int64Value
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let queue = DispatchQueue(label: "test.browser-queued")
    let connection = PhoneBrowserConnection(now: { now }, queue: queue)
    try connection.configure(epoch: 0, runtimeId: "phone", ledger: PhoneBrowserReplayLedger(directory: directory))
    var welcome = fixture["welcome"] as! [String: Any]
    welcome["browserWireVersion"] = 1
    welcome["browserAttachPublicKeys"] = [["keyId": "fixture", "publicKeyPem": ticketFixture["publicKeyPem"]!]]
    try connection.adopt(welcome, sender: { _, completion in XCTFail("Retired call reached socket"); completion(nil) }, close: {})
    defer { connection.offline(reason: "test-finished") }
    let message = (fixture["fence"] as! [String: Any]).merging(["type": "browser.profile.inventory", "complete": true]) { _, next in next }
    let refused = expectation(description: "Queued old-epoch relay is refused")
    queue.suspend()
    connection.sendRelay(epoch: 0, message: message) { error in XCTAssertNotNil(error); refused.fulfill() }
    XCTAssertEqual(connection.fence(), 1)
    queue.resume()
    await fulfillment(of: [refused], timeout: 2)
    let lost = expectation(description: "Queued old-stream relay is refused")
    queue.suspend()
    connection.sendRelay(epoch: 1, message: message) { error in XCTAssertNotNil(error); lost.fulfill() }
    connection.offline(reason: "replaced")
    welcome["auxiliaryStreamId"] = "rax_22222222-2222-4222-8222-222222222222"
    try connection.adopt(welcome, sender: { _, completion in XCTFail("Old fence reached new socket"); completion(nil) }, close: {})
    queue.resume()
    await fulfillment(of: [lost], timeout: 2)
    var currentFence = try AuxiliaryFence(welcome).fields
    let primaryExpired = expectation(description: "Queued call refuses an expired primary lease")
    queue.suspend()
    connection.sendRelay(epoch: connection.epoch, message: currentFence.merging(["type": "browser.profile.inventory"]) { _, next in next }) { error in
      XCTAssertNotNil(error); primaryExpired.fulfill()
    }
    connection.renewPrimary(until: now)
    queue.resume()
    await fulfillment(of: [primaryExpired], timeout: 2)
    connection.renewPrimary(until: .max)
    welcome["auxiliaryStreamId"] = "rax_33333333-3333-4333-8333-333333333333"
    try connection.adopt(welcome, sender: { _, completion in XCTFail("Retired capability reached socket"); completion(nil) }, close: {})
    currentFence = try AuxiliaryFence(welcome).fields
    let capability: [String: Any] = ["capabilityGeneration": 1, "capabilityLeaseId": "bcl_11111111-1111-4111-8111-111111111111", "runtimeId": "phone"]
    let grant = currentFence.merging(["type": "capability.grant", "requestId": "grant", "lease": capability.merging(["expiresAt": "2026-11-09T12:00:01.000Z"]) { _, next in next }]) { _, next in next }
    try connection.receive(grant)
    let replacedCapability = expectation(description: "Queued call refuses a retired capability lease")
    queue.suspend()
    connection.sendRelay(epoch: connection.epoch, message: currentFence.merging(["type": "capability.accepted", "requestId": "grant", "capability": capability]) { _, next in next }) { error in
      XCTAssertNotNil(error); replacedCapability.fulfill()
    }
    var replacement = capability
    replacement["capabilityGeneration"] = 2
    replacement["capabilityLeaseId"] = "bcl_22222222-2222-4222-8222-222222222222"
    try connection.receive(currentFence.merging(["type": "capability.grant", "requestId": "grant2", "lease": replacement.merging(["expiresAt": "2026-11-09T12:00:01.000Z"]) { _, next in next }]) { _, next in next })
    queue.resume()
    await fulfillment(of: [replacedCapability], timeout: 2)
  }
}

private final class BrowserSentMessages: @unchecked Sendable {
  private let lock = NSLock()
  private var messages: [URLSessionWebSocketTask.Message] = []
  func append(_ message: URLSessionWebSocketTask.Message) {
    lock.lock(); messages.append(message); lock.unlock()
  }
  func binarySequences() -> [Int] {
    lock.lock(); defer { lock.unlock() }
    return messages.compactMap { message in
      guard case .data(let bytes) = message else { return nil }
      return (try? PhoneBrowserFrames.decodeRelay(bytes).header["sequence"]) as? Int
    }
  }
}

private final class BrowserTestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64
  init(_ value: Int64) { self.value = value }
  var now: Int64 { lock.lock(); defer { lock.unlock() }; return value }
  func advance(_ milliseconds: Int64) { lock.lock(); value += milliseconds; lock.unlock() }
}
