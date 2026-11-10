import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

@MainActor
final class PersonFillTests: BrokerTestCase {
  private func desktop(_ version: Int64 = 8) async throws -> TestClient {
    let client = try await harness.client(greet: false)
    _ = try await client.hello(version: version)
    return client
  }

  private func accounts(_ client: TestClient, origin: String = "https://example.com") async throws
    -> JSONValue
  {
    try unwrap(try await client.call("fill.accounts", .object(["origin": .string(origin)])).result)
  }

  private func begin(
    _ account: JSONValue, id: String, presence: String = "elsewhere",
    origin: String = "https://example.com"
  ) -> JSONValue {
    .object([
      "transactionId": .string(id), "loginId": account["id"] ?? .null,
      "revision": account["revision"] ?? .null, "origin": .string(origin),
      "presence": .string(presence),
    ])
  }

  private func account(_ client: TestClient) async throws -> JSONValue {
    try unwrap(try await accounts(client)["accounts"]?[0])
  }

  func testAccountsNeverPromptAndReturnOnlyWhenReadyAndOn() async throws {
    let client = try await desktop()
    same(try await accounts(client), Wire.fillAccounts(.notSetUp))
    let missing = JSONValue.object([
      "id": .string(UUID().uuidString.lowercased()), "revision": .integer(0),
    ])
    same(
      try await client.call("fill.begin", begin(missing, id: UUID().uuidString.lowercased()))
        .result,
      Wire.FillDecision.unavailable(.notSetUp).json)
    try await harness.ready()
    let prompts = presence.askCount
    same(try await accounts(client), Wire.fillAccounts(.on))
    try await broker.setPersonFill(false)
    same(try await accounts(client), Wire.fillAccounts(.off))
    same(presence.askCount, prompts)
    let id = UUID().uuidString.lowercased()
    let absent = JSONValue.object(["id": .string(id), "revision": .integer(0)])
    same(
      try await client.call("fill.begin", begin(absent, id: id)).result,
      Wire.FillDecision.unavailable(.off).json)
  }

  func testAccountsAreDeduplicatedRankedAndIncludeCodeAndCleanLabels() async throws {
    let code = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    try await harness.ready(items: [
      Fixtures.login("sub.example.com", username: "zulu", totp: code, label: "sub.example.com"),
      Fixtures.login("other.example.com", username: "ALICE", label: "Work"),
      Fixtures.login("other.example.com", username: "bob"),
      Fixtures.login("example.com", username: "outside"),
      Fixtures.login("different.com", username: "excluded"),
    ])
    _ = try await harness.vault.change(Authentication(reason: "test")) { _ in
      VaultChanges(add: [Fixtures.login("sub.example.com", username: "zulu", totp: code)])
    }
    let client = try await desktop()
    let prompts = presence.askCount
    let result = try await accounts(client, origin: "https://sub.example.com:8443")
    same(result["accounts"]?.count, 4)
    same(result["accounts"]?[0]?["username"], .string("zulu"))
    same(result["accounts"]?[0]?["hasCode"], .bool(true))
    same(result["accounts"]?[0]?["label"], .null)
    same(result["accounts"]?[1]?["username"], .string("ALICE"))
    same(result["accounts"]?[1]?["label"], .string("Work"))
    same(result["accounts"]?[2]?["username"], .string("bob"))
    same(result["accounts"]?[3]?["username"], .string("outside"))
    same(presence.askCount, prompts)
  }

  func testAccountCapAndStableOrdering() async throws {
    try await harness.ready()
    let drafts = (0..<101).map {
      Fixtures.login(username: "same", password: "synthetic-unique-\($0)")
    }
    _ = try await harness.vault.change(Authentication(reason: "test")) { _ in
      VaultChanges(add: drafts)
    }
    let client = try await desktop()
    let result = try await accounts(client)
    same(result["accounts"]?.count, 100)
    let saved = try await harness.savedItems().filter { $0.password != nil }.sorted {
      $0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : $0.id < $1.id
    }
    for index in 0..<100 { same(result["accounts"]?[index]?["id"], .string(saved[index].id)) }
  }

  func testOversizedAccountListReturnsBoundedError() async throws {
    try await harness.ready()
    _ = try await harness.vault.change(Authentication(reason: "test")) { _ in
      VaultChanges(
        add: (0..<100).map {
          Fixtures.login(
            username: String(repeating: "\u{01}", count: 1020) + String(format: "%04d", $0),
            label: String(repeating: "\u{01}", count: 200))
        })
    }
    let client = try await desktop()
    same(
      try await client.call("fill.accounts", .object(["origin": .string("https://example.com")]))
        .errorCode, "invalid")
    present(try await client.call("status").result)
  }

  func testHereConfirmsCancelsOrFailsWithBrokerReasonAndElsewhereNeverPrompts() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let client = try await desktop()
    let login = try await account(client)
    let before = presence.askCount
    for (outcome, expected) in [
      (ScriptedPresence.Outcome.confirm, "authorized"), (.cancel, "cancelled"),
      (.fail, "cancelled"), (.unavailable, "cancelled"),
    ] {
      presence.next(outcome)
      let id = UUID().uuidString.lowercased()
      same(
        try await client.call("fill.begin", begin(login, id: id, presence: "here")).result?[
          "decision"], .string(expected))
      _ = try await client.call("signin.cancel", Fixtures.transaction(id))
    }
    same(presence.askCount, before + 4)
    same(presence.lastReason, "fill your saved login on example.com")
    let id = UUID().uuidString.lowercased()
    same(
      try await client.call("fill.begin", begin(login, id: id)).result?["decision"],
      .string("authorized"))
    same(presence.askCount, before + 4)
  }

  func testBeginPinsRevisionAndSiteAndRechecksAfterAuthentication() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let client = try await desktop()
    let login = try await account(client)
    let changed = JSONValue.object(["id": login["id"]!, "revision": .integer(999)])
    let missing = JSONValue.object([
      "id": .string(UUID().uuidString.lowercased()), "revision": .integer(0),
    ])
    for (choice, origin) in [
      (changed, "https://example.com"), (missing, "https://example.com"),
      (login, "https://different.com"),
    ] {
      let id = UUID().uuidString.lowercased()
      same(
        try await client.call("fill.begin", begin(choice, id: id, presence: "here", origin: origin))
          .result, Wire.FillDecision.changed.json)
    }
    let waiting = expectation(description: "person authentication started")
    presence.onHolding = { waiting.fulfill() }
    presence.next(.holdThenConfirm)
    let id = UUID().uuidString.lowercased()
    let call = client.send("fill.begin", begin(login, id: id, presence: "here"))
    await fulfillment(of: [waiting], timeout: 2)
    let loginID = try unwrap(login["id"]?.string)
    _ = try await harness.vault.change(Authentication(reason: "test")) { unlocked in
      var item = try unlocked.item(id: loginID)
      item.password = "synthetic-revision-change"
      return VaultChanges(update: [item])
    }
    presence.releaseHeld()
    same(try await client.reply(to: call).result, Wire.FillDecision.changed.json)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  func testCloseWithdrawsPromptAndRejectsLateSuccess() async throws {
    try await harness.ready(items: [Fixtures.login()])
    for outcome in [ScriptedPresence.Outcome.holdUntilWithdrawn, .holdThenConfirm] {
      let client = try await desktop()
      let login = try await account(client)
      let waiting = expectation(description: "person prompt started")
      let withdrawn = expectation(description: "connection close withdrew person prompt")
      let finished = expectation(description: "withdrawn prompt completed")
      presence.onHolding = { waiting.fulfill() }
      presence.onWithdrawn = { withdrawn.fulfill() }
      presence.onFinished = { finished.fulfill() }
      presence.next(outcome)
      let id = UUID().uuidString.lowercased()
      client.send("fill.begin", begin(login, id: id, presence: "here"))
      await fulfillment(of: [waiting], timeout: 2)
      client.close()
      await fulfillment(of: [withdrawn], timeout: 2)
      presence.releaseHeld()
      await fulfillment(of: [finished], timeout: 2)
      let observer = try await desktop()
      _ = try await observer.call("status")
      XCTAssertNil(broker.deadlines[id], "late authentication must not restore authority")
      same(
        try await observer.call("signin.release", Fixtures.release(id)).result?["reason"],
        .string("ended"))
      presence.onFinished = nil
      presence.onHolding = nil
      presence.onWithdrawn = nil
    }
  }

  func testPersonPolicyAllowsAgentSettingOffAndRefusesAgentAndCardPaths() async throws {
    try await harness.ready(items: [Fixtures.login()])
    try await broker.setAgentSignIns(false)
    let client = try await desktop()
    let login = try await account(client)
    let id = UUID().uuidString.lowercased()
    let started = Date()
    let result = try await client.call("fill.begin", begin(login, id: id))
    let deadline = try unwrap(result.result?["expiresAt"]?.string.flatMap(WireRules.isoDate))
    XCTAssertGreaterThanOrEqual(deadline.timeIntervalSince(started), 299)
    XCTAssertLessThanOrEqual(deadline.timeIntervalSince(started), 300.1)
    same(
      try await client.call("signin.release", Fixtures.release(id)).result?["released"], .bool(true)
    )
    let app = JSONValue.object([
      "transactionId": .string(id), "field": .string("password"), "kind": .string("app"),
    ])
    same(try await client.call("signin.release", app).result?["released"], .bool(false))
    same(
      try await client.call("signin.approve", Fixtures.approve(id, login, remember: true))
        .errorCode, "invalid")
    same(try await client.call("signin.commit", Fixtures.transaction(id)).errorCode, "invalid")
    let cardApproval = JSONValue.object([
      "transactionId": .string(id), "cardId": login["id"]!, "revision": login["revision"]!,
      "permissionVersion": .integer(7),
    ])
    same(try await client.call("card.approve", cardApproval).errorCode, "invalid")
    let cardRelease = JSONValue.object([
      "transactionId": .string(id), "topOrigin": .string("https://example.com"),
      "frameOrigin": .string("https://example.com"), "field": .string("number"),
    ])
    same(try await client.call("card.release", cardRelease).result?["released"], .bool(false))
    same(
      try await client.call("signin.release", Fixtures.release(id, origin: "https://different.com"))
        .result?["reason"], .string("wrong-site"))
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    XCTAssertEqual(try unwrap(broker.deadlines[id]).timeIntervalSince(deadline), 0, accuracy: 0.001)
    broker.sweepExpired(now: deadline.addingTimeInterval(1))
    same(
      try await client.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("ended"))
    XCTAssertNil(broker.deadlines[id])
  }

  func testSettingOffDuringPromptWithdrawsItAndDoesNotAuthorizeAfterReenable() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let client = try await desktop()
    let login = try await account(client)
    let waiting = expectation(description: "person prompt started")
    let finished = expectation(description: "late prompt completed")
    presence.onHolding = { waiting.fulfill() }
    presence.onFinished = { finished.fulfill() }
    presence.next(.holdThenConfirm)
    let id = UUID().uuidString.lowercased()
    let call = client.send("fill.begin", begin(login, id: id, presence: "here"))
    await fulfillment(of: [waiting], timeout: 2)
    try await broker.setPersonFill(false)
    same(try await client.reply(to: call).result, Wire.FillDecision.unavailable(.off).json)
    try await broker.setPersonFill(true)
    presence.releaseHeld()
    await fulfillment(of: [finished], timeout: 2)
    _ = try await client.call("status")
    same(
      try await client.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("ended"))
  }

  func testTurningOffWhileReleaseWaitsOnVaultQueueReleasesNothing() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready(items: [Fixtures.login()])
    let client = try await desktop()
    let login = try await account(client)
    let id = UUID().uuidString.lowercased()
    _ = try await client.call("fill.begin", begin(login, id: id))
    let reading = expectation(description: "person release reached the vault queue")
    let store = try unwrap(harness.controlled)
    store.onReadHeld = { reading.fulfill() }
    store.close()
    defer { store.open() }
    let call = client.send("signin.release", Fixtures.release(id))
    await fulfillment(of: [reading], timeout: 2)
    let toggle = Task { try await broker.setPersonFill(false) }
    same(try await client.reply(to: call).result?["released"], .bool(false))
    store.onReadHeld = nil
    store.open()
    try await toggle.value
    _ = try await client.call("status")
    same(await harness.personActivity.entries(), [])
    same(
      try await client.call("signin.release", Fixtures.release(id)).result?["released"],
      .bool(false))
  }

  func testVaultQueueUsesPersonPolicyAndPinnedRevision() async throws {
    try await harness.ready(items: [Fixtures.login()])
    try await broker.setAgentSignIns(false)
    let client = try await desktop()
    let login = try await account(client)
    let id = UUID().uuidString.lowercased()
    _ = try await client.call("fill.begin", begin(login, id: id))
    let descriptor = Wire.Login(
      id: login["id"]!.string!, revision: 1, account: "a•••@example.com", hasTOTP: false)
    let params = try Wire.ReleaseParams(json: Fixtures.release(id), protocolVersion: 8)
    let authority = TransactionAuthority()
    let deadline = Date().addingTimeInterval(300)
    same(
      try await harness.vault.release(
        params, login: descriptor, site: "https://example.com", grant: nil,
        permissionVersion: 8, authority: authority, expiresAt: deadline, kind: .person),
      .released("synthetic-password-1"))
    same(
      try await harness.vault.release(
        params, login: descriptor, site: "https://example.com", grant: Fixtures.grantKey(),
        permissionVersion: 5, authority: authority, expiresAt: deadline, kind: .person),
      .refused(.revoked))
    let app = try Wire.ReleaseParams(
      json: .object([
        "transactionId": .string(id), "field": .string("password"), "kind": .string("app"),
      ]), protocolVersion: 8)
    same(
      try await harness.vault.release(
        app, login: descriptor, site: "https://example.com", grant: nil,
        permissionVersion: 5, authority: authority, expiresAt: deadline, kind: .person),
      .refused(.revoked))
    try harness.protected.write(
      .personFill, Wire.encode(.object(["v": .integer(1), "personFill": .string("off")])))
    same(
      try await harness.vault.release(
        params, login: descriptor, site: "https://example.com", grant: nil,
        permissionVersion: 8, authority: authority, expiresAt: deadline, kind: .person),
      .refused(.passwordsOff))
    try await harness.vault.setPersonFill(true)
    _ = try await harness.vault.change(Authentication(reason: "test")) { unlocked in
      var item = try unlocked.item(id: descriptor.id)
      item.password = "synthetic-password-changed"
      return VaultChanges(update: [item])
    }
    same(
      try await client.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("revoked"))
  }

  func testUnreadablePersonSettingFailsOff() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready()
    let store = try unwrap(harness.controlled)
    store.notUnlockedSinceRestart = true
    same(await harness.vault.personFill(), false)
    store.notUnlockedSinceRestart = false
    same(await harness.vault.personFill(), true)
  }

  func testPersonBeginsShareConcurrencyLimits() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let client = try await desktop()
    let login = try await account(client)
    let waiting = expectation(description: "four person authentications started")
    waiting.expectedFulfillmentCount = Broker.maxUnderWay
    presence.onHolding = { waiting.fulfill() }
    var transactions: [(String, Int64)] = []
    for _ in 0..<Broker.maxUnderWay {
      presence.next(.holdUntilWithdrawn)
      let id = UUID().uuidString.lowercased()
      transactions.append((id, client.send("fill.begin", begin(login, id: id, presence: "here"))))
    }
    await fulfillment(of: [waiting], timeout: 2)
    same(
      try await client.call("fill.begin", begin(login, id: UUID().uuidString.lowercased())).result,
      Wire.FillDecision.unavailable(.busy).json)
    for (id, call) in transactions {
      _ = try await client.call("signin.cancel", Fixtures.transaction(id))
      same(try await client.reply(to: call).result, Wire.FillDecision.cancelled.json)
    }
  }

  func testStrictFillParameterDecoders() throws {
    let id = UUID().uuidString.lowercased()
    let account = JSONValue.object(["id": .string(id), "revision": .integer(0)])
    guard case .object(let valid) = begin(account, id: id) else { return XCTFail("parameters") }
    for (key, value) in [
      ("revision", JSONValue.integer(-1)), ("revision", .integer(9_007_199_254_740_992)),
      ("loginId", .string("not-a-uuid")), ("transactionId", .string("not-a-uuid")),
      ("origin", .string("https://example.com/path")), ("origin", .string("http://example.com")),
      ("presence", .string("unknown")), ("extra", .bool(true)),
    ] {
      var fields = valid
      fields[key] = value
      XCTAssertThrowsError(try Wire.FillBeginParams(json: .object(fields)))
    }
    XCTAssertThrowsError(
      try Wire.FillAccountsParams(json: .object(["origin": .string("https://example.com/")])))
  }

  func testSettingsAreSeparateDefaultOnMalformedOffAndStatusIsVersioned() async throws {
    let clients = try await [desktop(4), desktop(5), desktop(6), desktop(7), desktop(8)]
    same(try await clients[4].call("status").result?["personFill"], .string("off"))
    try await harness.ready(items: [Fixtures.login()])
    same(await harness.vault.personFill(), true)
    try await broker.setAgentSignIns(false)
    let agentSetting = try harness.protected.read(.settings)
    try await broker.setPersonFill(false)
    same(try harness.protected.read(.settings), agentSetting)
    try await broker.setPersonFill(true)
    for (index, client) in clients.enumerated() {
      let status = try await client.call("status").result
      same(status?["agentSignIns"], .string("off"))
      same(status?["personFill"], index == 4 ? .string("on") : nil)
      let events = client.takeEvents()
      XCTAssertFalse(events.isEmpty)
      for event in events {
        if index == 4 {
          XCTAssertNotNil(event["personFill"])
        } else {
          XCTAssertNil(event["personFill"])
        }
      }
      if index < 4 {
        same(
          try await client.call(
            "fill.accounts", .object(["origin": .string("https://example.com")])
          ).errorCode, "invalid")
      }
    }
    for value in [
      Data("broken".utf8),
      Wire.encode(.object(["v": .integer(1), "personFill": .string("maybe")])),
      Wire.encode(.object(["v": .integer(2), "personFill": .string("on")])),
    ] {
      try harness.protected.write(.personFill, value)
      same(await harness.vault.personFill(), false)
    }
    same(try harness.protected.read(.settings), agentSetting)
    try harness.protected.delete(.personFill)
    same(await harness.vault.personFill(), true)
  }

  func testPersonActivityRecordsFirstPasswordOrCodeOnlyAndMergesWithAgentHistory() async throws {
    let code = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    try await harness.ready(items: [Fixtures.login(totp: code)])
    let client = try await desktop()
    let login = try await account(client)
    for (field, location) in [("password", "here"), ("totp", "elsewhere")] {
      let id = UUID().uuidString.lowercased()
      _ = try await client.call("fill.begin", begin(login, id: id, presence: location))
      _ = try await client.call("signin.release", Fixtures.release(id, field: "username"))
      _ = try await client.call("signin.release", Fixtures.release(id, field: field))
      _ = try await client.call("signin.release", Fixtures.release(id, field: field))
      _ = try await client.call("signin.cancel", Fixtures.transaction(id))
    }
    let entries = await harness.personActivity.entries()
    same(entries.count, 2)
    same(entries.map(\.kind), [.password, .code])
    same(entries.map(\.presence), [.here, .elsewhere])
    same(entries.map(\.account), ["a•••@example.com", "a•••@example.com"])
    same(await harness.activity.entries(), [])
    let oldest = ActivityEntry(
      at: Date(timeIntervalSince1970: 0), site: "example.com", account: nil,
      deployment: "Personal", workspace: "Main", thread: "Test", automatic: false, outcome: .used)
    harness.activity.append(oldest)
    let merged = RecentSignIn.merge(await harness.activity.entries(), entries)
    same(merged.count, 3)
    same(merged.last, .agent(oldest))
    let reread = await PersonActivityLog(url: harness.paths.personActivity, capacity: 1).entries()
    same(reread, [entries[1]])
    same(PersonActivityEntry(line: Wire.encode(entries[0].json)), entries[0])
    XCTAssertNil(ActivityEntry(line: Wire.encode(entries[0].json)))
    let text = try String(contentsOf: harness.paths.personActivity, encoding: .utf8)
    XCTAssertFalse(text.contains("synthetic-password"))
    XCTAssertFalse(text.contains("alice@example.com"))
    XCTAssertFalse(text.contains("JBSWY3DPEHPK3PXP"))
  }
}

final class PersonActivityLogTests: XCTestCase {
  func testSeparatePrivateStoreKeepsNewestEntriesAndPreservesAgentFile() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "pw-person-\(UUID().uuidString)")
    try AtomicFile.makePrivateDirectory(directory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let paths = BrokerPaths(root: directory)
    let agentBytes = Data("existing agent history\n".utf8)
    try agentBytes.write(to: paths.activity)
    let log = PersonActivityLog(url: paths.personActivity, capacity: 2)
    for index in 0..<3 {
      log.append(
        PersonActivityEntry(
          at: Date(timeIntervalSince1970: Double(index)), site: "example.com",
          account: "a•••@example.com", kind: .password, presence: .here))
    }
    let entries = await log.entries()
    XCTAssertEqual(
      entries.map(\.at), [Date(timeIntervalSince1970: 1), Date(timeIntervalSince1970: 2)])
    XCTAssertEqual(try Data(contentsOf: paths.activity), agentBytes)
    let composed = Display.maskedAccount(String(repeating: "👩‍", count: 80) + "👩@example.com")
    XCTAssertGreaterThan(composed.utf16.count, 200)
    let unicode = PersonActivityEntry(
      at: Date(timeIntervalSince1970: 3), site: "example.com",
      account: composed, kind: .password, presence: .here)
    log.append(unicode)
    let afterUnicode = await log.entries()
    XCTAssertEqual(afterUnicode.last, unicode)
    let permissions =
      try FileManager.default.attributesOfItem(atPath: paths.personActivity.path)[.posixPermissions]
      as? Int
    XCTAssertEqual(permissions, 0o600)
  }
}
