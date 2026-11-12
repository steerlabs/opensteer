import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

@MainActor
final class PersonSaveTests: BrokerTestCase {
  private func desktop(_ version: Int64 = 10) async throws -> TestClient {
    let client = try await harness.client(greet: false)
    same(try await client.hello(version: version).result?["protocolVersion"], .integer(version))
    return client
  }

  private func params(
    _ id: String, origin: String = "https://example.com", username: String = "alice@example.com",
    password: String = "synthetic-typed-1"
  ) -> JSONValue {
    .object([
      "transactionId": .string(id), "origin": .string(origin), "username": .string(username),
      "password": .string(password),
    ])
  }

  private func begin(
    _ client: TestClient, _ id: String = UUID().uuidString.lowercased(),
    origin: String = "https://example.com", username: String = "alice@example.com",
    password: String = "synthetic-typed-1"
  ) async throws -> JSONValue? {
    try await client.call(
      "save.begin", params(id, origin: origin, username: username, password: password)
    ).result
  }

  private func offered(
    _ client: TestClient, username: String = "alice@example.com", origin: String = "https://example.com"
  ) async throws -> String {
    let id = UUID().uuidString.lowercased()
    same(
      try await begin(client, id, origin: origin, username: username)?["decision"], .string("offer"))
    return id
  }

  private func commit(_ client: TestClient, _ id: String) async throws -> JSONValue? {
    try await client.call("save.commit", Fixtures.transaction(id)).result
  }

  private func skip(_ reason: Wire.SaveSkipReason) -> JSONValue { Wire.SaveDecision.skip(reason).json }
  private func refused(_ reason: Wire.SaveRefusal) -> JSONValue {
    Wire.SaveCommitResult.refused(reason).json
  }

  func testStatusReportsPersonSaveAndItsChanges() async throws {
    let current = try await desktop()
    try await harness.ready()
    same(try await current.call("status").result?["personSave"], .string("on"))
    _ = current.takeEvents()
    try await broker.setPersonSave(false)
    same(try await current.call("status").result?["personSave"], .string("off"))
    same(current.takeEvents().last?["personSave"], .string("off"))
  }

  func testBeginSkipsWithoutPromptingWritingOrHolding() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    let client = try await desktop()
    same(try await begin(client), skip(.notSetUp))
    try await harness.ready(items: [Fixtures.login("login.example.com")])
    let prompts = presence.askCount
    let head = try harness.headSeq()
    // The scope release uses: the registrable site, any subdomain, ports ignored.
    for origin in ["https://example.com", "https://app.example.com:8443"] {
      same(try await begin(client, origin: origin), skip(.saved))
    }
    for origin in [
      "https://localhost", "https://127.0.0.1", "https://co.uk", "http://example.com",
      "https://example.com/", "https://EXAMPLE.com", "example.com",
    ] {
      same(try await begin(client, origin: origin), skip(.unsaveable), origin)
    }
    try await broker.setPersonSave(false)
    same(try await begin(client), skip(.off))
    try await broker.setPersonSave(true)
    let store = try unwrap(harness.controlled)
    store.notUnlockedSinceRestart = true
    await broker.reload()
    same(try await begin(client), skip(.unavailable))
    store.notUnlockedSinceRestart = false
    XCTAssertTrue(broker.heldSaves.isEmpty)
    // Usernames match byte for byte, never by case.
    same(try await begin(client, username: "Alice@example.com")?["decision"], .string("offer"))
    same(broker.heldSaves.count, 1)
    same(presence.askCount, prompts)
    same(try harness.headSeq(), head)
  }

  func testCommitAddsExactlyTheTypedLoginOnceWithoutAGrant() async throws {
    try await harness.ready(items: [Fixtures.login("other.com")])
    let client = try await desktop()
    let username = " Ame\u{301}lie@example.com "
    let password = "  pa\u{301}ss word  "
    let origin = "https://app.example.com:8443"
    let head = try harness.headSeq()
    let prompts = presence.askCount
    let id = UUID().uuidString.lowercased()
    let started = Date()
    let offer = try unwrap(
      try await begin(client, id, origin: origin, username: username, password: password))
    same(offer["decision"], .string("offer"))
    let deadline = try unwrap(offer["expiresAt"]?.string.flatMap(WireRules.isoDate))
    XCTAssertGreaterThanOrEqual(deadline.timeIntervalSince(started), 119)
    XCTAssertLessThanOrEqual(deadline.timeIntervalSince(started), 120.1)
    same(try harness.headSeq(), head)
    same(try await commit(client, id), Wire.SaveCommitResult.saved.json)
    same(try await commit(client, id), refused(.ended))
    same(try harness.headSeq(), head + 1)
    let items = try await harness.savedItems()
    same(items.count, 2)
    let added = try unwrap(items.first { $0.origins == [origin] })
    holds(added.username.utf8.elementsEqual(username.utf8))
    holds(try unwrap(added.password).utf8.elementsEqual(password.utf8))
    same(added.loginURL, origin + "/")
    same(added.label, nil)
    XCTAssertNil(added.totp)
    XCTAssertTrue(added.passkeys.isEmpty)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(presence.askCount, prompts)
    same(try await begin(client, origin: "https://example.com", username: username), skip(.saved))

    let saves = await harness.personSaves.entries()
    same(saves.map(\.site), ["example.com"])
    same(saves.map(\.account), [Display.maskedAccount(username)])
    same(Copy.personSaveTitle(saves[0]), "You saved A•••@example.com for example.com")
    same(await harness.personActivity.entries(), [])
    same(await harness.activity.entries(), [])
    let line = Wire.encode(saves[0].json)
    XCTAssertNil(PersonActivityEntry(line: line), "an older broker's fill log never reads a save")
    XCTAssertNil(ActivityEntry(line: line))
    same(RecentSignIn.merge([], [], saves), [.saved(saves[0])])
    let text = try String(contentsOf: harness.paths.personSaves, encoding: .utf8)
    XCTAssertFalse(text.contains("pa\u{301}ss"))
    XCTAssertFalse(text.contains("lie@"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.personActivity.path))
  }

  func testCancelExpiryAndOtherConnectionsEndTheSave() async throws {
    try await harness.ready()
    let client = try await desktop()
    let other = try await desktop()
    let cancelled = try await offered(client)
    for _ in 0..<2 {
      same(try await client.call("save.cancel", Fixtures.transaction(cancelled)).result, Wire.emptyResult)
    }
    same(try await commit(client, cancelled), refused(.ended))
    same(
      try await client.call("save.cancel", Fixtures.transaction(UUID().uuidString.lowercased())).result,
      Wire.emptyResult)

    let owned = try await offered(client)
    same(try await commit(other, owned), refused(.ended))
    same(try await other.call("save.cancel", Fixtures.transaction(owned)).result, Wire.emptyResult)
    same(try await begin(other, owned), nil, "another connection cannot reuse a held ID")
    same(try await commit(client, owned), Wire.SaveCommitResult.saved.json)

    let expiring = try await offered(client, username: "bob")
    broker.sweepExpired(now: Date().addingTimeInterval(Broker.saveLifetime + 1))
    XCTAssertTrue(broker.heldSaves.isEmpty)
    same(try await commit(client, expiring), refused(.ended))
    same(try await harness.savedItems().count, 1)
  }

  func testLoginSavedBetweenBeginAndCommitIsNotAddedAgain() async throws {
    try await harness.ready()
    let client = try await desktop()
    let id = try await offered(client)
    _ = try await harness.vault.change(Authentication(reason: "test")) { _ in
      VaultChanges(add: [Fixtures.login("www.example.com", password: "synthetic-other")])
    }
    let head = try harness.headSeq()
    same(try await commit(client, id), refused(.saved))
    same(try harness.headSeq(), head)
    same(try await harness.savedItems().count, 1)
    same(await harness.personSaves.entries(), [])
  }

  func testEachConnectionHoldsAtMostEight() async throws {
    try await harness.ready()
    let client = try await desktop()
    var held: [String] = []
    for index in 0..<Broker.maxHeldSaves { held.append(try await offered(client, username: "user\(index)")) }
    same(try await begin(client, username: "one-more"), skip(.unavailable))
    let other = try await desktop()
    _ = try await offered(other, username: "one-more")
    _ = try await client.call("save.cancel", Fixtures.transaction(held[0]))
    _ = try await offered(client, username: "one-more")
  }

  func testHeldLoginsDropOnCloseSettingOffLockSleepAndVaultChange() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready()
    let closing = try await desktop()
    _ = try await offered(closing)
    closing.close()
    try await harness.eventually("the closed connection's login dropped") { broker.heldSaves.isEmpty }

    let client = try await desktop()
    let triggers: [(String, () async throws -> Void)] = [
      ("lock", { self.broker.screenLocked() }),
      ("sleep", { self.broker.willSleep() }),
      ("off", {
        try await self.broker.setPersonSave(false)
        try await self.broker.setPersonSave(true)
      }),
      ("not ready", {
        let store = try self.unwrap(self.harness.controlled)
        store.notUnlockedSinceRestart = true
        await self.broker.reload()
        XCTAssertEqual(self.broker.condition, .unavailable)
        store.notUnlockedSinceRestart = false
        await self.broker.reload()
      }),
    ]
    for (name, trigger) in triggers {
      let id = try await offered(client)
      try await trigger()
      XCTAssertTrue(broker.heldSaves.isEmpty, name)
      same(try await commit(client, id), refused(.ended), name)
    }
    same(try await harness.savedItems().count, 0)
  }

  func testLockWhileCommitWaitsOnTheVaultQueueWritesNothing() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready()
    let client = try await desktop()
    let id = try await offered(client)
    let store = try unwrap(harness.controlled)
    let reading = expectation(description: "the save reached the vault queue")
    store.onReadHeld = { reading.fulfill() }
    store.close()
    defer { store.open() }
    let call = client.send("save.commit", Fixtures.transaction(id))
    await fulfillment(of: [reading], timeout: 2)
    broker.screenLocked()
    store.onReadHeld = nil
    store.open()
    same(try await client.reply(to: call).result, refused(.ended))
    same(try await harness.savedItems().count, 0)
    same(await harness.personSaves.entries(), [])
  }

  func testSettingOffWhileCommitWaitsSavesNothing() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready()
    let client = try await desktop()
    let id = try await offered(client)
    let store = try unwrap(harness.controlled)
    let reading = expectation(description: "the save reached the vault queue")
    store.onReadHeld = { reading.fulfill() }
    store.close()
    defer { store.open() }
    let call = client.send("save.commit", Fixtures.transaction(id))
    await fulfillment(of: [reading], timeout: 2)
    let toggle = Task { try await broker.setPersonSave(false) }
    try await harness.eventually("the held login dropped") { broker.heldSaves.isEmpty }
    store.onReadHeld = nil
    store.open()
    try await toggle.value
    same(try await client.reply(to: call).result, refused(.off))
    same(try await harness.savedItems().count, 0)
  }

  func testRefusalsNeverNameAValue() async throws {
    try await harness.ready()
    let client = try await desktop()
    let user = "marker-user"
    let secret = "marker-secret"
    let id = UUID().uuidString.lowercased()
    guard case .object(var extra) = params(id, username: user, password: secret) else {
      return XCTFail("params")
    }
    extra["label"] = .string(user)
    var errors: [TestClient.Reply] = [
      try await client.call("save.begin", .object(extra)),
      try await client.call("save.begin", params(id, username: String(repeating: user, count: 100), password: secret)),
      try await client.call("save.begin", params(id, username: user, password: "")),
      try await client.call("save.begin", params("not-a-uuid", username: user, password: secret)),
    ]
    same(try await begin(client, id, username: user, password: secret)?["decision"], .string("offer"))
    errors.append(try await client.call("save.begin", params(id, username: user, password: secret)))
    for reply in errors {
      guard case .error(let code, let message) = reply else { return XCTFail("\(reply) is not an error") }
      same(code, "invalid")
      XCTAssertFalse(message.contains("marker"), message)
    }
  }

  func testSettingIsSeparateDefaultsOnAndFailsOff() async throws {
    try await harness.ready()
    same(await harness.vault.personSave(), true)
    same(broker.status?.personSave, true)
    let agentSetting = try harness.protected.read(.settings)
    try await broker.setPersonFill(false)
    let fillSetting = try harness.protected.read(.personFill)
    try await broker.setPersonSave(false)
    same(try harness.protected.read(.settings), agentSetting)
    same(try harness.protected.read(.personFill), fillSetting)
    same(broker.personFillSetting, false)
    try await broker.setPersonSave(true)
    for value in [
      Data("broken".utf8),
      Wire.encode(.object(["v": .integer(1), "personSave": .string("maybe")])),
      Wire.encode(.object(["v": .integer(2), "personSave": .string("on")])),
    ] {
      try harness.protected.write(.personSave, value)
      same(await harness.vault.personSave(), false)
    }
    try harness.protected.delete(.personSave)
    same(await harness.vault.personSave(), true)
  }
}
