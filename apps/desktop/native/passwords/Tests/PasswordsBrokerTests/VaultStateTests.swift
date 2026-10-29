import PasswordsCore
import PasswordsTestSupport
import XCTest

@testable import PasswordsBrokerKit

/// Section 11 of FAILURES.md: setup, needs-reset, the key policy, the Mac
/// not yet unlocked since restart, settings and status.
@MainActor
final class VaultStateTests: BrokerTestCase {
  private func status(_ client: TestClient) async throws -> JSONValue? {
    try await client.call("status").result
  }

  private func statusJSON(_ vault: String, _ agents: String) -> JSONValue {
    .object(["agentSignIns": .string(agents), "vault": .string(vault)])
  }

  /// X16.
  func testRequestsNeedAReadyVaultAndTheSetting() async throws {
    let desktop = try await harness.client()
    same(
      try await desktop.call("signin.request", Fixtures.request()).result,
      .object(["decision": .string("unavailable"), "reason": .string("not-set-up")]))
    try await harness.ready(items: [Fixtures.login()])
    try await broker.setAgentSignIns(false)
    same(
      try await desktop.call("signin.request", Fixtures.request()).result,
      .object(["decision": .string("unavailable"), "reason": .string("passwords-off")]))
    try await broker.setAgentSignIns(true)
    same(
      try await desktop.call("signin.request", Fixtures.request()).result?["decision"],
      .string("approve"))
  }

  /// X17: off stops every release from then on; a sign-in already released finishes.
  func testTurningOffStopsFutureReleases() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let using = UUID().uuidString.lowercased()
    let usingAccount = try unwrap(try await request(desktop, using)["accounts"]?[0])
    _ = try await desktop.call(
      "signin.approve", Fixtures.approve(using, usingAccount, remember: false))
    let waiting = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(waiting, session: "bsn_waiting"))
        .result?["accounts"]?[0])
    let held = UUID().uuidString.lowercased()
    let heldAccount = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(held, session: "bsn_held")).result?[
        "accounts"]?[0])
    presence.next(.holdThenConfirm)
    let authenticating = desktop.send(
      "signin.approve", Fixtures.approve(held, heldAccount, remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }

    try await broker.setAgentSignIns(false)
    let asked = presence.askCount
    let off = TestClient.Reply.result(
      .object(["decision": .string("unavailable"), "reason": .string("passwords-off")]))
    same(
      try await desktop.call("signin.approve", Fixtures.approve(waiting, account, remember: true)),
      off)
    XCTAssertEqual(presence.askCount, asked, "refused before asking")
    presence.releaseHeld()
    same(try await desktop.reply(to: authenticating), off, "checked again after the authentication")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    for id in [waiting, held] {
      same(
        try await desktop.call("signin.release", Fixtures.release(id)).result?["reason"],
        .string("ended"), "that answer ended it")
    }
    same(
      try await desktop.call("signin.release", Fixtures.release(using)).result?["reason"],
      .string("passwords-off"))
    present(try await desktop.call("signin.cancel", Fixtures.transaction(using)).result)
    XCTAssertEqual(broker.status, Wire.Status(vault: .ready, agentSignIns: false))
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome), [.cancelled, .cancelled, .cancelled])
  }

  /// M5: Allow after the vault stopped being ready says so, in the
  /// approval's own answer, before asking anyone.
  func testAllowWhenTheVaultIsNoLongerReady() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, id)["accounts"]?[0])
    try harness.protected.delete(.ownerKeyPolicy)
    await broker.reload()
    let asked = presence.askCount
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result,
      .object(["decision": .string("unavailable"), "reason": .string("not-set-up")]))
    XCTAssertEqual(presence.askCount, asked)
  }

  /// S1.
  func testVaultThisMacCannotOpenNeedsReset() async throws {
    try await harness.ready(items: [Fixtures.login()])
    // Another Mac's keys: the vault's owner is someone else.
    let keys = try harness.protected.read(.ownerAgreementKey)
    let signing = try harness.protected.read(.ownerSigningKey)
    let other = SoftwareOwnerKeyStore()
    try harness.protected.write(.ownerAgreementKey, other.agreementKey.rawRepresentation)
    try harness.protected.write(.ownerSigningKey, other.signingKey.rawRepresentation)
    await broker.reload()
    XCTAssertEqual(broker.condition, .needsReset(.otherMac))
    // No keys at all, as after Migration Assistant copied the folder alone.
    try harness.protected.delete(.ownerAgreementKey)
    await broker.reload()
    XCTAssertEqual(broker.condition, .needsReset(.otherMac))
    // This Mac's keys, but a history that fails verification.
    try harness.protected.write(.ownerAgreementKey, try XCTUnwrap(keys))
    try harness.protected.write(.ownerSigningKey, try XCTUnwrap(signing))
    await broker.reload()
    XCTAssertEqual(broker.condition, .ready)
    let commit = harness.paths.vault.appendingPathComponent("commits/000000000001.json")
    var bytes = try Data(contentsOf: commit)
    bytes[bytes.count / 2] ^= 0x01
    try bytes.write(to: commit)
    await broker.reload()
    XCTAssertEqual(broker.condition, .needsReset(.damaged))
    let desktop = try await harness.client()
    same(try await status(desktop), statusJSON("needs-reset", "off"))
    same(
      try await desktop.call("signin.request", Fixtures.request()).result,
      .object(["decision": .string("unavailable"), "reason": .string("not-set-up")]))
  }

  /// S12: a vault from before the key policy (or of another one) needs a
  /// reset; nothing migrates it.
  func testOldKeyPolicyNeedsReset() async throws {
    try await harness.ready(items: [Fixtures.login()])
    XCTAssertTrue(
      OwnerKeyPolicy.isCurrent(try harness.protected.read(.ownerKeyPolicy)),
      "setup records the policy")
    for record in [nil, #"{"policy":1,"v":1}"#, #"{"policy":2,"v":2}"#, "2"] as [String?] {
      if let record {
        try harness.protected.write(.ownerKeyPolicy, Data(record.utf8))
      } else {
        try harness.protected.delete(.ownerKeyPolicy)
      }
      await broker.reload()
      XCTAssertEqual(broker.condition, .needsReset(.olderVersion), record ?? "no record")
    }
    let desktop = try await harness.client()
    same(try await status(desktop), statusJSON("needs-reset", "off"))
    XCTAssertEqual(Copy.olderVersion.hasSuffix("Set up Opensteer Passwords again."), true)
    try await broker.startFresh()
    try await broker.setUp()
    XCTAssertEqual(broker.condition, .ready)
    holds(try await harness.savedItems().isEmpty, "nothing was carried over")
  }

  /// S13, S14: a keychain that cannot be read before the first unlock is
  /// `unavailable`, never `needs-reset`, and recovers once the Mac is unlocked.
  func testBeforeFirstUnlockIsUnavailable() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready(items: [Fixtures.login()])
    let store = try XCTUnwrap(harness.controlled)
    let desktop = try await harness.client()
    store.notUnlockedSinceRestart = true
    await broker.reload()
    XCTAssertEqual(broker.condition, .unavailable)
    XCTAssertNil(broker.status)
    same(
      try await desktop.call("status"),
      .error(code: "unavailable", message: Copy.notUnlockedSinceRestart))
    same(
      try await desktop.call("signin.probe", Fixtures.probe()).result,
      .object(["passwords": .string("unavailable")]))
    same(
      try await desktop.call("signin.request", Fixtures.request()),
      .error(code: "unavailable", message: Copy.notUnlockedSinceRestart))
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: harness.paths.vault.path), "nothing was reset")
    _ = desktop.takeEvents()

    store.notUnlockedSinceRestart = false
    same(try await status(desktop), statusJSON("ready", "on"), "examined again on the next call")
    try await harness.eventually("the status event") {
      desktop.takeEvents() == [statusJSON("ready", "on")]
    }
    store.notUnlockedSinceRestart = true
    await broker.reload()
    store.notUnlockedSinceRestart = false
    broker.screenUnlocked()
    try await harness.eventually("examined again when the screen unlocks") {
      broker.condition == .ready
    }
  }

  /// X39: examined again, the vault cannot be read because the Mac has not
  /// been unlocked since it started. Allow and Save say so with the broker's
  /// unlock sentence, as `status` and `signin.request` do; never "not set up".
  func testNotUnlockedSinceRestartIsNeverNotSetUp() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready(items: [Fixtures.login()])
    let store = try XCTUnwrap(harness.controlled)
    let desktop = try await harness.client()
    let notUnlocked = TestClient.Reply.error(
      code: "unavailable", message: Copy.notUnlockedSinceRestart)
    let first = UUID().uuidString.lowercased()
    let second = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, first)["accounts"]?[0])
    let other = try unwrap(
      try await request(desktop, second, session: "bsn_second")["accounts"]?[0])

    presence.next(.holdThenConfirm)
    let held = desktop.send("signin.approve", Fixtures.approve(first, account, remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }
    store.notUnlockedSinceRestart = true
    await broker.reload()
    XCTAssertEqual(broker.condition, .unavailable)
    presence.releaseHeld()
    same(try await desktop.reply(to: held), notUnlocked, "Allow, after its authentication")
    let asked = presence.askCount
    same(
      try await desktop.call("signin.approve", Fixtures.approve(second, other, remember: false)),
      notUnlocked, "Allow")
    XCTAssertEqual(presence.askCount, asked, "nobody was asked")
    for ended in [first, second] {
      same(
        try await desktop.call("signin.release", Fixtures.release(ended)).result?["reason"],
        .string("ended"), "the approval ended")
    }
    XCTAssertTrue(try harness.savedGrants().isEmpty, "nothing was granted")
  }

  /// S2.
  func testUnsupportedMac() async throws {
    try await restart { try BrokerHarness(secureEnclave: false) }
    XCTAssertEqual(broker.condition, .unsupported)
    do {
      try await broker.setUp()
      XCTFail("setup must refuse")
    } catch {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.vault.path))
    let desktop = try await harness.client()
    same(try await desktop.call("status").result, statusJSON("unsupported", "off"))
  }

  /// S3, P1: setup asks first and creates nothing when cancelled; then it
  /// replaces whatever protected state an earlier attempt left.
  func testSetUpAuthenticatesFirst() async throws {
    presence.next(.cancel)
    do {
      try await broker.setUp()
      XCTFail("a cancelled Touch ID sets nothing up")
    } catch {
      XCTAssertEqual(error as? PresenceError, .cancelled)
    }
    XCTAssertEqual(presence.lastReason, "set up Opensteer Passwords")
    XCTAssertEqual(broker.condition, .notSetUp)
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.vault.path))
    for name in ProtectedName.allCases {
      XCTAssertNil(try harness.protected.read(name), name.rawValue)
    }
    // What an interrupted setup or an earlier vault left is replaced.
    try harness.protected.write(.ownerAgreementKey, Data("garbage".utf8))
    try harness.protected.write(.settings, Data(#"{"agentSignIns":"off","v":1}"#.utf8))
    try await broker.setUp()
    XCTAssertEqual(broker.condition, .ready)
    XCTAssertTrue(broker.agentSignInsSetting, "setting up is the opt-in")
    XCTAssertTrue(broker.loginsShown, "setup's authentication opens the first visit")
    XCTAssertEqual(try harness.headSeq(), 0)
    XCTAssertTrue(OwnerKeyPolicy.isCurrent(try harness.protected.read(.ownerKeyPolicy)))
  }

  /// S4.
  func testSetupRefusesAnExistingVault() async throws {
    try await harness.ready()
    do {
      try await broker.setUp()
      XCTFail("setup over a vault")
    } catch {}
    do {
      _ = try await harness.vault.setUp(Authentication(reason: "test"))
      XCTFail("setup over a vault")
    } catch {
      XCTAssertEqual(error as? VaultServiceError, .alreadySetUp)
    }
  }

  /// S5, S6.
  func testSettings() async throws {
    try await harness.ready()
    same(await harness.vault.agentSignIns(), true, "missing means on")
    try await harness.vault.setAgentSignIns(false)
    same(await harness.vault.agentSignIns(), false)
    try await harness.vault.setAgentSignIns(true)
    same(await harness.vault.agentSignIns(), true)
    for damaged in [
      #"{"agentSignIns":"yes","v":1}"#, #"{"agentSignIns":"on","v":2}"#, "on",
      #"{"agentSignIns":"on","v":1,"x":0}"#,
    ] {
      try harness.protected.write(.settings, Data(damaged.utf8))
      same(await harness.vault.agentSignIns(), false, damaged)
    }
  }

  /// S7, G9, P1: Start Fresh only for a vault that needs a reset, after
  /// authentication, and the grants go with the vault.
  func testStartFresh() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, id)["accounts"]?[0])
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
    XCTAssertEqual(try harness.savedGrants().count, 1)
    do {
      try await broker.startFresh()
      XCTFail("a readable vault is never removed")
    } catch {}
    XCTAssertEqual(broker.condition, .ready)
    try harness.protected.delete(.checkpoint)
    await broker.reload()
    XCTAssertEqual(broker.condition, .needsReset(.damaged))
    presence.next(.cancel)
    do {
      try await broker.startFresh()
      XCTFail("Start Fresh needs the person")
    } catch {
      XCTAssertEqual(error as? PresenceError, .cancelled)
    }
    XCTAssertEqual(presence.lastReason, "delete the passwords saved on this Mac")
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: harness.paths.vault.path), "nothing deleted")
    try await broker.startFresh()
    XCTAssertEqual(broker.condition, .notSetUp)
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.vault.path))
    for name in ProtectedName.allCases {
      XCTAssertNil(try harness.protected.read(name), name.rawValue)
    }
    try await broker.setUp()
    XCTAssertEqual(broker.condition, .ready)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  /// S8, S9.
  func testStatusAndItsEvents() async throws {
    let desktop = try await harness.client()
    same(try await status(desktop), statusJSON("not-set-up", "off"))
    try await harness.ready(items: [Fixtures.login()])
    try await broker.setAgentSignIns(false)
    try await broker.setAgentSignIns(true)
    _ = try await request(desktop, UUID().uuidString.lowercased())
    try await broker.setAgentSignIns(true)
    _ = try await desktop.call("status")
    let events = desktop.takeEvents()
    XCTAssertEqual(
      events, [statusJSON("ready", "on"), statusJSON("ready", "off"), statusJSON("ready", "on")],
      "one event per change, none for a sign-in or a change to the same value")
  }
}
