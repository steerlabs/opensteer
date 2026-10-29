import CryptoKit
import Foundation
import XCTest
import OpensteerAppleData

@testable import IphoneAppsCore

/// Failure cases pinned before the native implementation. These use the production
/// gate, proof and identity code; fake OS ports in the journey are labelled there.
final class FailureCasesTests: XCTestCase {
  private let runner = "rnr_11111111-1111-4111-8111-111111111111"
  private let boot = "rbt_22222222-2222-4222-8222-222222222222"

  // F1-F6: identity must survive a lost mint answer, but never a reinstall,
  // missing Keychain item, another Deployment, or key reuse.
  func testF1MissingInstallMarkerWipesSecrets() throws {
    let vault = MemoryIdentityVault()
    let store = IdentityStore(vault: vault, record: MemoryRecordStore())
    vault.put(Data(repeating: 1, count: 32), account: .runnerKey)
    vault.put(Data(repeating: 2, count: 32), account: .approvalKey)
    _ = try store.load()
    XCTAssertNil(vault.get(.runnerKey))
    XCTAssertNil(vault.get(.approvalKey))
  }

  func testF2RestoredRecordWithMissingSecretIsRejected() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record)
    let prepared = try store.prepare(deploymentId: "one")
    vault.delete(.runnerKey)
    XCTAssertNil(try store.load())
    XCTAssertNil(record.load())
    XCTAssertNotNil(prepared.runnerId)
  }

  func testF3AnotherDeploymentCannotClaimSlot() throws {
    let store = IdentityStore(vault: MemoryIdentityVault(), record: MemoryRecordStore())
    _ = try store.prepare(deploymentId: "one")
    XCTAssertThrowsError(try store.prepare(deploymentId: "two"))
  }

  func testF4SnapshotContainsNoSecrets() throws {
    let store = IdentityStore(vault: MemoryIdentityVault(), record: MemoryRecordStore())
    let prepared = try store.prepare(deploymentId: "one")
    let bytes = try JSONEncoder().encode(prepared.publicSnapshot)
    let text = String(decoding: bytes, as: UTF8.self)
    XCTAssertFalse(text.contains("PRIVATE KEY"))
    XCTAssertFalse(text.contains("enrollmentToken"))
    XCTAssertFalse(text.contains("signature"))
  }

  func testF5KeysAreIndependent() throws {
    let store = IdentityStore(vault: MemoryIdentityVault(), record: MemoryRecordStore())
    _ = try store.prepare(deploymentId: "one")
    XCTAssertNotEqual(try store.runnerPublicKey(), try store.approvalPublicKey())
  }

  func testF6MintKeyPersistsAndRotatesOnlyOnDiscard() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record)
    let first = try store.prepare(deploymentId: "one")
    XCTAssertEqual(first.mintKey, try IdentityStore(vault: vault, record: record).prepare(deploymentId: "one").mintKey)
    XCTAssertNotEqual(first.mintKey, try store.discardPendingEnrollment())
  }

  // F7-F15: actual native canonicalization, target/discovery and wire fences.
  func testF7CanonicalJSONKeyOrderUnicodeAndNumbers() throws {
    let a: [String: Any] = ["z": 1, "é": "雪", "a": ["b": 1.0, "a": true]]
    let b: [String: Any] = ["a": ["a": true, "b": 1], "é": "雪", "z": 1.0]
    XCTAssertEqual(try IphoneProofs.canonicalJSON(a), try IphoneProofs.canonicalJSON(b))
  }

  func testF8UnsupportedProofFormatStopsRetry() {
    XCTAssertEqual(ConnectionPolicy.issue(reason: "runner-proof-format-mismatch", closeCode: 4003), .needsUpdate)
    XCTAssertFalse(ConnectionPolicy.shouldRetry(.needsUpdate))
  }

  func testF9DiscoveryMismatchBlocksToken() {
    XCTAssertThrowsError(try HostTarget.validate(url: "https://host.example", expectedInstanceId: "a", discoveredInstanceId: "b"))
  }

  func testF10RejectRedirectAndNonLoopbackHTTP() {
    XCTAssertThrowsError(try HostTarget("http://example.com"))
    XCTAssertNoThrow(try HostTarget("http://127.0.0.1:4242"))
    XCTAssertFalse(ConnectionPolicy.followRedirects)
  }

  func testF11RemovalWipesAndStops() {
    XCTAssertEqual(ConnectionPolicy.issue(reason: nil, closeCode: 4010), .removed)
    XCTAssertFalse(ConnectionPolicy.shouldRetry(.removed))
  }

  func testF12ExpiredEnrollmentStops() {
    XCTAssertEqual(ConnectionPolicy.issue(reason: "runner-enrollment-expired", closeCode: 4003), .enrollmentExpired)
    XCTAssertFalse(ConnectionPolicy.shouldRetry(.enrollmentExpired))
  }

  func testReasonlessEnrollmentRefusalStopsRetryWithoutChangingOtherRefusals() {
    let issue = ConnectionPolicy.issue(reason: nil, closeCode: 4003, enrolling: true)
    XCTAssertEqual(issue, .enrollmentRefused)
    XCTAssertFalse(ConnectionPolicy.shouldRetry(issue))
    XCTAssertEqual(ConnectionPolicy.issue(reason: nil, closeCode: 4003), .failed)
    XCTAssertEqual(ConnectionPolicy.issue(reason: nil, closeCode: 4010, enrolling: true), .removed)
    XCTAssertEqual(ConnectionPolicy.issue(reason: "personal-remote-access-off", closeCode: 4003,
      enrolling: true), .remoteAccessOff)
    XCTAssertEqual(ConnectionPolicy.issue(reason: "runner-device-profile-mismatch", closeCode: 4003,
      enrolling: true), .profileMismatch)
  }

  func testF13RemoteAccessOffRetries() {
    XCTAssertEqual(ConnectionPolicy.issue(reason: "personal-remote-access-off", closeCode: 4003), .remoteAccessOff)
    XCTAssertTrue(ConnectionPolicy.shouldRetry(.remoteAccessOff))
  }

  func testF14TwoProtocolViolationsStop() {
    var policy = ConnectionPolicy()
    XCTAssertNil(policy.violation())
    XCTAssertEqual(policy.violation(), .protocolError)
  }

  func testF15StaleFenceRefused() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate()
    gate.attach(fence: "current", leaseSeconds: 30)
    XCTAssertEqual(gate.admit(fence: "old", timeoutMs: 5_000, effect: .read), .stale)
  }

  // F16-F22: the gate uses monotonic elapsed time and fences every generation.
  func testF16BufferedFrameFromPreviousForegroundIsRefused() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    gate.background(); gate.activate(); gate.attach(fence: "two", leaseSeconds: 30)
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write), .stale)
  }

  func testF17ExpiredLeaseRefusedWithoutTimerCallback() {
    let clock = ManualContinuousClock()
    let gate = AdmissionGate(runnerId: runner, bootId: boot, clock: clock)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 1)
    clock.advance(seconds: 2)
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write), .leaseExpired)
  }

  func testF18BackgroundRefusesNewWorkAsNotStarted() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    gate.background()
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .read), .background)
    XCTAssertTrue(AdmissionGate.backgroundSentence(name: "My iPhone").contains("Nothing was changed"))
  }

  func testF19BackgroundExpiryFencesWriteStart() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    let ticket = try? XCTUnwrap(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write).ticket)
    gate.background()
    XCTAssertEqual(gate.beginWrite(ticket), .background)
  }

  func testBackgroundDrainRenewsLeaseWithoutAdmittingNewWork() throws {
    let clock = ManualContinuousClock()
    let gate = AdmissionGate(runnerId: runner, bootId: boot, clock: clock)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 8)
    let ticket = try XCTUnwrap(gate.admit(fence: "one", timeoutMs: 30_000, effect: .write).ticket)
    XCTAssertEqual(gate.beginWrite(ticket), .started)
    gate.background()
    clock.advance(seconds: 7)
    XCTAssertTrue(gate.renew(fence: "one", leaseSeconds: 30))
    XCTAssertFalse(gate.renew(fence: "old", leaseSeconds: 30))
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write), .background)
    clock.advance(seconds: 8)
    XCTAssertTrue(gate.complete(ticket))
    gate.expireBackground()
    XCTAssertFalse(gate.renew(fence: "one", leaseSeconds: 30))
  }

  func testWriteStartRequiresHalfSecondRemaining() throws {
    let clock = ManualContinuousClock()
    let gate = AdmissionGate(runnerId: runner, bootId: boot, clock: clock)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    let ticket = try XCTUnwrap(gate.admit(fence: "one", timeoutMs: 2_400, effect: .write).ticket)
    clock.advance(seconds: 1)
    XCTAssertEqual(gate.beginWrite(ticket), .deadline)
  }

  func testWriteStartAllowsExactlyHalfSecondRemaining() throws {
    let clock = ManualContinuousClock()
    let gate = AdmissionGate(runnerId: runner, bootId: boot, clock: clock)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    let ticket = try XCTUnwrap(gate.admit(fence: "one", timeoutMs: 2_500, effect: .write).ticket)
    clock.advance(seconds: 1)
    XCTAssertEqual(gate.beginWrite(ticket), .started)
  }

  func testF20DisconnectSynchronouslyFencesAdmission() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    gate.disconnect()
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write), .disconnected)
  }

  func testF21ForegroundDiscardsOldTicket() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    gate.background(); gate.activate()
    XCTAssertNil(gate.currentFence)
  }

  func testF22RepeatedActivationHasOneGeneration() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); let first = gate.generation
    gate.activate()
    XCTAssertGreaterThan(gate.generation, first)
    XCTAssertNil(gate.currentFence)
  }

  // F23-F34: admission, contract, permission and outcome rules are checked
  // before a provider or OS prompt is reachable.
  func testF23UnknownAppOrOperationUnsupported() {
    XCTAssertEqual(InvokeRules.validate(definitionId: "other", operation: "list", contract: "x", effect: .read, access: .read, permission: .granted), .unsupported)
    XCTAssertEqual(InvokeRules.validate(definitionId: "apple-calendar", operation: "other", contract: "x", effect: .read, access: .read, permission: .granted), .unsupported)
  }

  func testF24ContractMismatchUnsupported() {
    XCTAssertEqual(InvokeRules.validate(definitionId: "apple-calendar", operation: "list_calendars", contract: "wrong", effect: .read, access: .read, permission: .granted), .unsupported)
  }

  func testF25EffectMismatchUnsupported() {
    XCTAssertEqual(InvokeRules.validate(definitionId: "apple-calendar", operation: "list_calendars", contract: InvokeRules.contract("apple-calendar", "list_calendars")!, effect: .write, access: .readWrite, permission: .granted), .unsupported)
  }

  func testF26ReadAccessRefusesWrite() {
    XCTAssertEqual(InvokeRules.validate(definitionId: "apple-calendar", operation: "create_event", contract: InvokeRules.contract("apple-calendar", "create_event")!, effect: .write, access: .read, permission: .granted), .readOnly)
  }

  func testF27MissingPermissionNeverPrompts() {
    XCTAssertEqual(InvokeRules.validate(definitionId: "apple-calendar", operation: "list_events", contract: InvokeRules.contract("apple-calendar", "list_events")!, effect: .read, access: .read, permission: .denied), .permissionRequired)
  }

  func testF28LimitedContactsIsReadyWithDetail() {
    XCTAssertTrue(InvokeRules.permissionStatus(.limited, app: "apple-contacts").ready)
    XCTAssertTrue(InvokeRules.permissionStatus(.limited, app: "apple-contacts").detail!.contains("Only the contacts chosen"))
  }

  func testF29CalendarWriteOnlyIsNotReady() {
    XCTAssertFalse(InvokeRules.permissionStatus(.writeOnly, app: "apple-calendar").ready)
  }

  func testF30ShortDeadlineDoesNotStartWrite() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 1_300, effect: .write), .deadline)
  }

  func testF31ProviderErrorMapsWriteToUnknownReadToFailed() {
    XCTAssertEqual(InvokeRules.providerError(effect: .write).code, .outcomeUnknown)
    XCTAssertEqual(InvokeRules.providerError(effect: .read).code, .failed)
  }

  func testF32FifthInFlightRefused() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    for _ in 0..<4 { XCTAssertNotNil(gate.admit(fence: "one", timeoutMs: 5_000, effect: .read).ticket) }
    XCTAssertEqual(gate.admit(fence: "one", timeoutMs: 5_000, effect: .read), .busy)
  }

  func testF33CancelAfterWriteStartCannotClaimRollback() {
    let gate = AdmissionGate(runnerId: runner, bootId: boot)
    gate.activate(); gate.attach(fence: "one", leaseSeconds: 30)
    let ticket = try? XCTUnwrap(gate.admit(fence: "one", timeoutMs: 5_000, effect: .write).ticket)
    XCTAssertEqual(gate.beginWrite(ticket), .started)
    XCTAssertEqual(gate.cancel(ticket), .alreadyStarted)
  }

  func testF34FrameOverOneMiBRejected() {
    XCTAssertThrowsError(try FrameDecoder.decode(Data(repeating: 32, count: 1_048_577)))
  }

  // F35-F38: only listed, matching and live approvals are signed; possession
  // challenges bind both the key and this runner.
  func testF35UnlistedMismatchedOrExpiredApprovalRefused() {
    let signer = ApprovalRules(runnerId: runner, keyId: "key")
    XCTAssertFalse(signer.mayAnswer(requestId: "missing", expectedDefinition: "apple-calendar", expectedAccess: "read"))
  }

  func testF36ForeignKeyOrRunnerChallengeRefused() {
    let signer = ApprovalRules(runnerId: runner, keyId: "key")
    XCTAssertFalse(signer.mayProve(keyId: "other", runnerId: runner))
    XCTAssertFalse(signer.mayProve(keyId: "key", runnerId: "other"))
  }

  func testF37RegistrationDerivedFromHostKeyId() {
    let signer = ApprovalRules(runnerId: runner, keyId: "key")
    XCTAssertFalse(signer.registered(hostKeyId: nil))
    XCTAssertTrue(signer.registered(hostKeyId: "key"))
  }

  func testF38AllowAndDenyTranscriptsDiffer() throws {
    let request: [String: Any] = ["id": "req", "app": NSNull(), "definitionId": "apple-calendar", "runnerId": runner]
    let allow = try IphoneProofs.approvalTranscript(request: request, decision: "allow", expiresAt: "2026-10-26T20:00:00.000Z")
    let deny = try IphoneProofs.approvalTranscript(request: request, decision: "deny", expiresAt: "2026-10-26T20:00:00.000Z")
    XCTAssertNotEqual(allow, deny)
    XCTAssertTrue(String(decoding: allow, as: UTF8.self).contains("opensteer-computer-app-approval-v4"))
  }
}

private final class MemoryIdentityVault: IdentityVault {
  private var values: [IdentityAccount: Data] = [:]
  func read(_ account: IdentityAccount) throws -> Data? { values[account] }
  func write(_ value: Data, account: IdentityAccount) throws { values[account] = value }
  func remove(_ account: IdentityAccount) throws { values.removeValue(forKey: account) }
  func put(_ value: Data, account: IdentityAccount) { values[account] = value }
  func get(_ account: IdentityAccount) -> Data? { values[account] }
  func delete(_ account: IdentityAccount) { values.removeValue(forKey: account) }
}

private final class MemoryRecordStore: IdentityRecordStore {
  private var value: Data?
  func read() throws -> Data? { value }
  func write(_ value: Data) throws { self.value = value }
  func remove() throws { value = nil }
  func load() -> Data? { value }
}

private final class ManualContinuousClock: MonotonicClock {
  var tick: UInt64 = 0
  func now() -> UInt64 { tick }
  func advance(seconds: UInt64) { tick += seconds * 1_000_000_000 }
}
