import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Release authority: how a login is (and is not) released, over
/// wire v2. The card is the test: it reads the decision and answers with
/// `signin.approve`.
@MainActor
final class SignInTests: BrokerTestCase {
  private func choose(_ decision: JSONValue, file: StaticString = #filePath, line: UInt = #line)
    throws -> [JSONValue]
  {
    XCTAssertEqual(decision["decision"], .string("approve"), "\(decision)", file: file, line: line)
    guard case .array(let accounts)? = decision["accounts"] else {
      XCTFail("no accounts in \(decision)", file: file, line: line)
      return []
    }
    return accounts
  }

  /// X1: one saved login is still offered, not released, until the person
  /// allows it with an authentication.
  func testNothingIsReleasedWithoutAGrantOrThePerson() async throws {
    try await harness.ready(items: [Fixtures.login(username: "alex@example.com")])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let asked = presence.askCount
    let accounts = try choose(try await request(desktop, id))
    XCTAssertEqual(accounts.count, 1)
    XCTAssertEqual(presence.askCount, asked, "offering accounts asks no one")
    same(
      try await desktop.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("ended"))

    let reply = try await desktop.call(
      "signin.approve", Fixtures.approve(id, accounts[0], remember: false))
    XCTAssertEqual(presence.askCount, asked + 1)
    let item = try XCTUnwrap(reply.result?["login"], "\(reply)")
    XCTAssertEqual(reply.result?["decision"], .string("authorized"))
    XCTAssertEqual(item["account"], .string("a•••@example.com"))
    XCTAssertNil(item["password"])
    XCTAssertNil(item["username"])
    XCTAssertNil(item["origins"])
    same(
      try await desktop.call("signin.release", Fixtures.release(id)).result,
      .object(["released": .bool(true), "value": .string("synthetic-password-1")]))
    XCTAssertNil(item["loginURL"], "the sign-in starts on the agent's page, not a saved one")
    XCTAssertEqual(item["hasTOTP"], .bool(false))
    XCTAssertEqual(item["revision"], .integer(1))
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    await harness.activity.flush()
    let entries = await harness.activity.entries()
    XCTAssertEqual(entries.map(\.outcome), [.used])
    XCTAssertEqual(entries.first?.account, "a•••@example.com")
    XCTAssertEqual(entries.first?.automatic, false)
    XCTAssertEqual(entries.first?.workspace, "Main")
  }

  /// X2: a cancelled, failed or impossible authentication releases nothing,
  /// says why in a sentence the card shows, and the sign-in still waits.
  func testCancelledAuthenticationReleasesNothing() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(desktop, id)).first)
    presence.next(.cancel, .fail, .unavailable)
    for message in [Copy.authenticationCancelled, Copy.notConfirmed, Copy.cannotAuthenticate] {
      same(
        try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true)),
        .error(code: "invalid", message: message))
    }
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result?["decision"],
      .string("authorized"), "the card stayed and the next try works")
  }

  /// X3: every approval authenticates on its own; one showing blocks a second.
  func testEveryApprovalAuthenticatesOnItsOwn() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let first = UUID().uuidString.lowercased()
    let second = UUID().uuidString.lowercased()
    let firstAccount = try unwrap(try choose(try await request(desktop, first)).first)
    let secondAccount = try unwrap(
      try choose(
        try await desktop.call("signin.request", Fixtures.request(second, session: "bsn_second"))
          .result ?? .null
      )
      .first)
    let asked = presence.askCount
    presence.next(.holdThenConfirm)
    let held = desktop.send(
      "signin.approve", Fixtures.approve(first, firstAccount, remember: false))
    try await harness.eventually("the first authentication showing") { presence.holdingCount == 1 }
    same(
      try await desktop.call(
        "signin.approve", Fixtures.approve(first, firstAccount, remember: false)),
      .error(code: "invalid", message: Copy.signInMovedOn),
      "a second answer while one authenticates")
    same(
      try await desktop.call(
        "signin.approve", Fixtures.approve(second, secondAccount, remember: false)
      ).result?["decision"],
      .string("authorized"), "the other sign-in asks on its own")
    presence.releaseHeld()
    same(try await desktop.reply(to: held).result?["decision"], .string("authorized"))
    XCTAssertEqual(presence.askCount, asked + 2, "one authentication per approval, never shared")
    XCTAssertEqual(presence.confirmCount, asked + 2)
  }

  func testReleaseIsScopedToTheSite() async throws {
    try await harness.ready(items: [
      Fixtures.login(
        username: "shared", origins: ["https://example.org", "https://login.example.com"],
        loginURL: "https://example.org/signin"),
      Fixtures.login("example.org", username: "elsewhere"),
    ])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let accounts = try choose(try await request(desktop, id))
    XCTAssertEqual(
      accounts.map { $0["username"] }, [.string("shared")],
      "the login only for example.org is not offered")
    let item = try unwrap(
      try await desktop.call("signin.approve", Fixtures.approve(id, accounts[0], remember: false))
        .result?["login"])
    XCTAssertNil(item["origins"], "authorization carries no saved destinations")
    same(
      try await desktop.call("signin.release", Fixtures.release(id, origin: "https://example.org"))
        .result?["reason"], .string("wrong-site"))
    same(
      try await desktop.call(
        "signin.release", Fixtures.release(id, origin: "https://login.example.com")
      ).result?["released"], .bool(true))
    same(
      try await desktop.call(
        "signin.release", Fixtures.release(id, origin: "https://other.example.com")
      ).result?["released"], .bool(true), "the login covers its whole registrable site")
  }

  /// X6, L4: the accounts carry no password and include choices beyond the old 20-account bound.
  func testAccountsCarryNoPasswordsBeyondTwenty() async throws {
    let logins = (0..<25).map {
      Fixtures.login(
        username: String(format: "user%02d@example.com", 24 - $0),
        password: "SYNTHETIC-SECRET-\($0)")
    }
    try await harness.ready(
      items: logins + [Fixtures.login("example.org", username: "org", password: "SYNTHETIC-ORG")])
    let desktop = try await harness.client()
    let decision = try await request(desktop, UUID().uuidString.lowercased())
    let accounts = try choose(decision)
    XCTAssertEqual(accounts.count, 25)
    XCTAssertEqual(
      accounts.map { $0["username"]?.string },
      (0..<25).map { String(format: "user%02d@example.com", $0) })
    for account in accounts {
      guard case .object(let fields) = account else { return XCTFail() }
      XCTAssertEqual(
        Set(fields.keys), ["id", "label", "revision", "username", "host", "onPage", "updatedAt"])
    }
    let text = String(decoding: try CanonicalJSON.encode(decision), as: UTF8.self)
    XCTAssertFalse(text.contains("SYNTHETIC"), "no password in the decision")
  }

  /// X7: no saved login is an empty list; Sign in myself follows.
  func testNoSavedLoginAnswersAnEmptyList() async throws {
    try await harness.ready(items: [Fixtures.login("example.org")])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    same(
      try await request(desktop, id),
      .object(["accounts": .array([]), "decision": .string("approve")]))
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
  }

  func testTransactionIsBoundToItsConnection() async throws {
    try await harness.ready(items: [
      Fixtures.login(totp: try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP"))
    ])
    let owner = try await harness.client("owner")
    let other = try await harness.client("other")
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(owner, id)).first)
    same(
      try await other.call("signin.approve", Fixtures.approve(id, account, remember: true)),
      .error(code: "invalid", message: Copy.signInEnded))
    same(
      try await owner.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result?["decision"],
      .string("authorized"))
    same(
      try await other.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("ended"))
    same(try await other.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    same(
      try await other.call("signin.request", Fixtures.request(id, session: "bsn_other")).errorCode,
      "invalid",
      "another connection cannot reuse the ID")
    present(
      try await owner.call("signin.release", Fixtures.release(id, field: "totp")).result?["value"],
      "still the owner's")
  }

  /// X25: a vault that cannot be read is an error and a reset, never "no saved password".
  func testVaultErrorIsNotHidden() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(desktop, id)).first)
    let objects = harness.paths.vault.appendingPathComponent("objects")
    for name in try FileManager.default.contentsOfDirectory(atPath: objects.path) {
      try Data("tampered".utf8).write(to: objects.appendingPathComponent(name))
    }
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
        .errorCode, "internal")
    try await harness.eventually("the vault reported damaged") {
      broker.condition == .needsReset(.damaged)
    }
    same(try await desktop.call("status").result?["vault"], .string("needs-reset"))
    same(
      try await request(desktop, UUID().uuidString.lowercased()),
      .object(["decision": .string("unavailable"), "reason": .string("not-set-up")]))
  }

  func testLookupVaultErrorIsNotHidden() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let objects = harness.paths.vault.appendingPathComponent("objects")
    for name in try FileManager.default.contentsOfDirectory(atPath: objects.path) {
      try Data("tampered".utf8).write(to: objects.appendingPathComponent(name))
    }
    same(try await desktop.call("signin.request", Fixtures.request()).errorCode, "internal")
    try await harness.eventually("the vault reported damaged") {
      broker.condition == .needsReset(.damaged)
    }
  }

  /// X26: an authentication that finishes after its sign-in ended releases
  /// and grants nothing.
  func testLateAuthenticationIsIgnored() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(desktop, id)).first)
    presence.next(.holdThenConfirm)
    let approve = desktop.send("signin.approve", Fixtures.approve(id, account, remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    same(
      try await desktop.reply(to: approve), .error(code: "unavailable", message: Copy.signInEnded))
    presence.releaseHeld()
    try await harness.eventually("the authentication finished") { presence.holdingCount == 0 }
    try await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertEqual(desktop.pendingFrameCount, 0, "nothing else was answered")
    XCTAssertTrue(try harness.savedGrants().isEmpty, "nothing was granted")
  }

  /// X27, M6: the approval is bound to the login's ID and
  /// revision across the authentication. A login changed or deleted while
  /// the card waited is not released; the answer is the site's accounts as
  /// they are now, with a sentence, and Allow of what is offered now works.
  func testChangedLoginIsOfferedAgain() async throws {
    try await harness.ready(items: [
      Fixtures.login(username: "alex@example.com", password: "synthetic-alex"),
      Fixtures.login(username: "anna@example.com", password: "synthetic-anna"),
    ])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let accounts = try choose(try await request(desktop, id))
    let (alex, anna) = (accounts[0], accounts[1])
    let alexID = try XCTUnwrap(alex["id"]?.string)
    let annaID = try XCTUnwrap(anna["id"]?.string)

    // Changed while the card showed it.
    _ = try await broker.showLogins()
    _ = try await broker.updateLogin(
      LoginEdit(
        id: alexID, origins: ["https://example.com"], loginURL: "https://example.com/login",
        username: "alex@example.com",
        password: "synthetic-alex-new", totp: nil, label: nil))
    let asked = presence.askCount
    let changed = try unwrap(
      try await desktop.call("signin.approve", Fixtures.approve(id, alex, remember: true)).result)
    XCTAssertEqual(changed["message"], .string(Copy.accountChanged))
    let fresh = try choose(changed)
    XCTAssertEqual(
      fresh.map { $0["username"] }, [.string("alex@example.com"), .string("anna@example.com")])
    XCTAssertEqual(fresh.map { $0["revision"] }, [.integer(2), .integer(1)])
    XCTAssertEqual(presence.askCount, asked + 1, "checked again after the authentication")
    XCTAssertTrue(try harness.savedGrants().isEmpty, "nothing was granted")

    // The revision first shown is no longer on offer: answered with the offer, before asking.
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, alex, remember: true)).result,
      .object([
        "accounts": .array(fresh), "decision": .string("approve"),
        "message": .string(Copy.accountChanged),
      ]))
    XCTAssertEqual(presence.askCount, asked + 1)

    // Deleted while the authentication showed.
    presence.next(.holdThenConfirm)
    let held = desktop.send("signin.approve", Fixtures.approve(id, fresh[1], remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }
    _ = try await broker.deleteLogin(id: annaID)
    presence.releaseHeld()
    same(
      try await desktop.reply(to: held).result,
      .object([
        "accounts": .array([fresh[0]]), "decision": .string("approve"),
        "message": .string(Copy.accountGone),
      ]))
    XCTAssertTrue(try harness.savedGrants().isEmpty, "nothing was granted")

    // What is offered now goes through, as it is now.
    let item = try unwrap(
      try await desktop.call("signin.approve", Fixtures.approve(id, fresh[0], remember: true))
        .result?["login"])
    XCTAssertNil(item["password"])
    same(
      try await desktop.call("signin.release", Fixtures.release(id)).result?["value"],
      .string("synthetic-alex-new"))
    XCTAssertEqual(item["revision"], .integer(2))
    XCTAssertEqual(try harness.savedGrants().map(\.loginId), [alexID])
  }

  /// The only account was deleted while the card waited;
  /// the answer offers none, so the card turns to Sign in myself.
  func testDeletedOnlyLoginLeavesSignInMyself() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(desktop, id)).first)
    _ = try await broker.showLogins()
    _ = try await broker.deleteLogin(id: try unwrap(account["id"]?.string))
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result,
      .object([
        "accounts": .array([]), "decision": .string("approve"),
        "message": .string(Copy.accountGone),
      ]))
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
  }

  /// X19: what `signin.approve` refuses, before asking anyone.
  func testApproveRules() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try choose(try await request(desktop, id)).first)
    let asked = presence.askCount
    let stranger = JSONValue.object([
      "id": .string(UUID().uuidString.lowercased()), "revision": .integer(1),
    ])
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, stranger, remember: false)),
      .error(code: "invalid", message: Copy.notOffered))
    same(
      try await desktop.call(
        "signin.approve", Fixtures.approve(UUID().uuidString.lowercased(), account, remember: false)
      ),
      .error(code: "invalid", message: Copy.signInEnded))
    XCTAssertEqual(presence.askCount, asked)
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result?["decision"],
      .string("authorized"))
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false)),
      .error(code: "invalid", message: Copy.signInMovedOn), "after a release")

    XCTAssertEqual(presence.askCount, asked + 1)
  }

  /// X29, P2: the probe says only whether Passwords could sign in, and never asks.
  func testProbeAnswersWithoutAsking() async throws {
    let desktop = try await harness.client()
    func probe(_ site: String = "https://example.com") async throws -> JSONValue? {
      try await desktop.call("signin.probe", Fixtures.probe(site: site)).result
    }
    same(try await probe(), .object(["passwords": .string("not-set-up")]))
    try await harness.ready(items: [Fixtures.login()])
    let asked = presence.askCount
    same(try await probe(), .object(["passwords": .string("has-login")]))
    same(try await probe("https://example.org"), .object(["passwords": .string("no-login")]))
    try await broker.setAgentSignIns(false)
    same(try await probe(), .object(["passwords": .string("off")]))
    try await broker.setAgentSignIns(true)
    XCTAssertEqual(presence.askCount, asked)
    try harness.protected.delete(.ownerKeyPolicy)
    await broker.reload()
    same(
      try await probe(), .object(["passwords": .string("not-set-up")]), "a vault that needs a reset"
    )
  }

  /// X31: a sign-in that ends while its read is under way releases nothing.
  func testEndingDuringALookupReleasesNothing() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let store = try XCTUnwrap(harness.controlled)
    store.close()
    let call = desktop.send("signin.request", Fixtures.request(id))
    try await harness.eventually("the read under way") { store.waitingReads == 1 }
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    same(try await desktop.reply(to: call), .error(code: "unavailable", message: Copy.signInEnded))
    store.open()
    try await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertEqual(desktop.pendingFrameCount, 0, "the read's answer was dropped")
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome), [.cancelled])
  }

  /// U1: accounts are offered whole, even
  /// when they share their first 200 characters; only the history masks.
  func testAccountsAreOfferedWhole() async throws {
    let prefix = String(repeating: "a", count: 200)
    try await harness.ready(items: [
      Fixtures.login(
        username: "alex@example.com", label: "Work",
        origins: ["https://login.example.com", "https://example.org"]),
      Fixtures.login(username: prefix + "-one"), Fixtures.login(username: prefix + "-two"),
    ])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let accounts = try choose(try await request(desktop, id))
    XCTAssertEqual(
      accounts.map { $0["username"]?.string },
      [prefix + "-one", prefix + "-two", "alex@example.com"])
    XCTAssertEqual(accounts[2]["label"], .string("Work"))
    XCTAssertEqual(accounts[0]["label"], .null)
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, accounts[2], remember: false))
    _ = try await desktop.call(
      "signin.release", Fixtures.release(id, origin: "https://login.example.com"))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    await harness.activity.flush()
    same(
      await harness.activity.entries().map(\.account), ["a•••@example.com"],
      "the history still masks")
  }

  /// P3, U2: the broker writes what the prompt allows, naming the Workspace,
  /// site and whole username, cleaned of text that could reorder it.
  func testAuthenticationNamesWhatItAllows() async throws {
    try await harness.ready(items: [Fixtures.login(username: "alex@example.com")])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let decision = try await request(
      desktop, id, workspace: (Fixtures.workspace.0, "Ma\u{202E}in\u{200B}"))
    let account = try XCTUnwrap(try choose(decision).first)
    presence.next(.cancel)
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
    XCTAssertEqual(
      presence.lastReason, "let agents in Main sign in to example.com as alex@example.com")
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
    XCTAssertEqual(presence.lastReason, "sign in to example.com as alex@example.com once")
  }
}
