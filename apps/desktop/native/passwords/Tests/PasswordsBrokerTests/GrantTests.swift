import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Grant authority: Allow remembers an account for a Workspace and
/// site, and the next sign-in there needs no one.
@MainActor
final class GrantTests: BrokerTestCase {
  private static let alex = Fixtures.login(username: "alex@example.com", password: "synthetic-alex")
  private static let anna = Fixtures.login(username: "anna@example.com", password: "synthetic-anna")

  /// Requests a sign-in and allows `username` with `remember`, then finishes it.
  @discardableResult
  private func allow(
    _ desktop: TestClient, _ username: String, remember: Bool = true,
    workspace: (String, String) = Fixtures.workspace
  ) async throws -> JSONValue {
    let id = UUID().uuidString.lowercased()
    let decision = try await request(desktop, id, workspace: workspace)
    guard case .array(let accounts)? = decision["accounts"],
      let account = accounts.first(where: { $0["username"] == .string(username) })
    else {
      XCTFail("\(username) was not offered: \(decision)")
      return .null
    }
    let reply = try await desktop.call(
      "signin.approve", Fixtures.approve(id, account, remember: remember))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    return try XCTUnwrap(reply.result?["login"], "\(reply)")
  }

  /// A request answered: the credential's username, or nil when the person is asked.
  private func automaticUsername(
    _ desktop: TestClient, workspace: (String, String) = Fixtures.workspace,
    site: String = "https://example.com"
  )
    async throws -> String?
  {
    let id = UUID().uuidString.lowercased()
    let decision = try await request(desktop, id, site: site, workspace: workspace)
    if decision["decision"] == .string("authorized") {
      let username = try await desktop.call(
        "signin.release", Fixtures.release(id, field: "username", origin: site)
      ).result?["value"]?.string
      _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
      return username
    }
    XCTAssertEqual(decision["decision"], .string("approve"))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    return nil
  }

  /// G2, A7, P2: Allow writes the grant; the next request for the same
  /// Deployment, Workspace and site is released with no prompt, and recorded
  /// as automatic.
  func testAllowRemembersAndTheNextRequestSignsInByItself() async throws {
    try await harness.ready(items: [Self.alex, Self.anna])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com")
    let grants = try harness.savedGrants()
    XCTAssertEqual(grants.map(\.key), [Fixtures.grantKey()])
    XCTAssertEqual(grants.first?.workspaceName, "Main")
    XCTAssertEqual(grants.first?.deploymentName, "Personal")

    let asked = presence.askCount
    let id = UUID().uuidString.lowercased()
    let decision = try await request(desktop, id)
    XCTAssertEqual(decision["decision"], .string("authorized"))
    XCTAssertEqual(decision["login"]?["account"], .string("a•••@example.com"))
    XCTAssertNil(decision["login"]?["password"])
    XCTAssertEqual(presence.askCount, asked, "nobody was asked")
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    await harness.activity.flush()
    let entries = await harness.activity.entries()
    XCTAssertEqual(entries.map(\.automatic), [false, true])
    XCTAssertEqual(entries.map(\.outcome), [.cancelled, .cancelled])
    XCTAssertEqual(entries.last?.account, "a•••@example.com")
  }

  /// G1: the grant answers only for its own Deployment, Workspace and site.
  func testAGrantMatchesOnlyItsTriple() async throws {
    try await harness.ready(items: [
      Self.alex, Fixtures.login("example.org", username: "alex@example.com"),
    ])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com")
    let otherWorkspace = try await automaticUsername(desktop, workspace: Fixtures.otherWorkspace)
    XCTAssertNil(otherWorkspace, "another Workspace asks")
    let otherSite = try await automaticUsername(desktop, site: "https://example.org")
    XCTAssertNil(otherSite, "another site asks")
    let id = UUID().uuidString.lowercased()
    let otherDeployment = try await desktop.call(
      "signin.request", Fixtures.request(id, deploymentId: "dep_other")
    ).result
    XCTAssertEqual(otherDeployment?["decision"], .string("approve"), "another Deployment asks")
    let matching = try await automaticUsername(desktop)
    XCTAssertEqual(matching, "alex@example.com")
  }

  /// G3: Only this time remembers nothing.
  func testOnlyThisTimeRemembersNothing() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com", remember: false)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    let next = try await automaticUsername(desktop)
    XCTAssertNil(next, "it asks again")
  }

  /// G4: a cancelled authentication grants nothing.
  func testCancelledAuthenticationGrantsNothing() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, id)["accounts"]?[0])
    let seq = try harness.headSeq()
    presence.next(.cancel)
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
        .errorCode, "invalid")
    XCTAssertEqual(try harness.headSeq(), seq, "no commit")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  /// G5: one account per Workspace and site. Two sign-ins offered accounts
  /// before either was allowed: the later Allow replaces the earlier.
  func testAllowForAnotherAccountReplacesTheGrant() async throws {
    try await harness.ready(items: [Self.alex, Self.anna])
    let desktop = try await harness.client()
    let first = UUID().uuidString.lowercased()
    let second = UUID().uuidString.lowercased()
    let firstAccounts = try unwrap(try await request(desktop, first)["accounts"])
    let secondAccounts = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(second, session: "bsn_second"))
        .result?["accounts"])
    _ = try await desktop.call(
      "signin.approve", Fixtures.approve(first, firstAccounts[0], remember: true))
    _ = try await desktop.call(
      "signin.approve", Fixtures.approve(second, secondAccounts[1], remember: true))
    for id in [first, second] {
      _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    }
    let annaID = try XCTUnwrap(secondAccounts[1]?["id"]?.string)
    XCTAssertEqual(try harness.savedGrants().map(\.loginId), [annaID])
    try await allow(desktop, "alex@example.com", workspace: Fixtures.otherWorkspace)
    XCTAssertEqual(try harness.savedGrants().count, 2, "one per Workspace")
    let next = try await automaticUsername(desktop)
    XCTAssertEqual(next, "anna@example.com")
  }

  /// G6, P2: Remove needs no authentication and no open window.
  func testRemoveNeedsNoAuthentication() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com")
    let asked = presence.askCount
    XCTAssertFalse(broker.loginsShown)
    let grant = try unwrap(try harness.savedGrants().first)
    let list = try await broker.removeGrant(grant)
    XCTAssertNil(list, "no list without a visit")
    XCTAssertEqual(presence.askCount, asked)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    let next = try await automaticUsername(desktop)
    XCTAssertNil(next)
    let again = try await broker.removeGrant(grant)
    XCTAssertNil(again, "removing what is gone is done")
  }

  /// G6: Remove takes off the grant the window showed, by its
  /// login. When another Allow replaced it meanwhile, the replacement stays.
  func testRemoveTakesOffOnlyTheLoginItShowed() async throws {
    try await harness.ready(items: [Self.alex, Self.anna])
    let desktop = try await harness.client()
    let first = UUID().uuidString.lowercased()
    let second = UUID().uuidString.lowercased()
    let firstAccounts = try unwrap(try await request(desktop, first)["accounts"])
    let secondAccounts = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(second, session: "bsn_second"))
        .result?["accounts"])
    _ = try await desktop.call(
      "signin.approve", Fixtures.approve(first, firstAccounts[0], remember: true))
    let window = PasswordsWindowModel(
      broker: broker, activityLog: harness.activity,
      runner: ImportRunner(worker: URL(fileURLWithPath: "/usr/bin/false")))
    await window.showPasswords()
    let shown = try unwrap(
      window.visibleLogins.first { $0.username == "alex@example.com" }?.grants.first)
    let annaID = try unwrap(secondAccounts[1]?["id"]?.string)
    _ = try await desktop.call(
      "signin.approve", Fixtures.approve(second, secondAccounts[1], remember: true))
    for id in [first, second] {
      _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    }
    await window.removeGrant(shown)
    XCTAssertEqual(
      try harness.savedGrants().map(\.loginId), [annaID], "the grant that replaced it stays")
    let next = try await automaticUsername(desktop)
    XCTAssertEqual(next, "anna@example.com")
    let current = try unwrap(try harness.savedGrants().first)
    await window.removeGrant(current)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  /// G15: a Workspace or Deployment name with control
  /// characters, or with nothing left to show once cleaned, is stored
  /// cleaned, and Allow and Save with "let agents use it" go through.
  func testGrantNamesAreCleaned() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await desktop.call(
        "signin.request",
        Fixtures.request(
          id, workspace: (Fixtures.workspace.0, "Ma\u{7}in\u{85}Team"),
          extra: ["deploymentName": .string("Per\u{1B}sonal")])
      ).result?["accounts"]?[0])
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
        .result?["decision"],
      .string("authorized"))
    let grant = try unwrap(try harness.savedGrants().first)
    XCTAssertEqual(grant.workspaceName, "Ma in Team")
    XCTAssertEqual(grant.deploymentName, "Per sonal")

  }

  /// G7, G8: deleting a login, or changing its websites, login page or
  /// username, removes its grants; a password or label change keeps them.
  func testEditsThatRepointALoginRemoveItsGrants() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    let id = try unwrap(try await harness.savedItems().first).id
    func edit(
      origins: [String] = ["https://example.com"], loginURL: String = "https://example.com/login",
      username: String = "alex@example.com", password: String? = nil, label: String? = nil
    ) async throws {
      _ = try await broker.showLogins()
      _ = try await broker.updateLogin(
        LoginEdit(
          id: id, origins: origins, loginURL: loginURL, username: username, password: password,
          totp: nil, label: label))
      broker.windowClosed()
    }
    try await allow(desktop, "alex@example.com")
    try await edit(password: "synthetic-new")
    try await edit(label: "Work")
    XCTAssertEqual(try harness.savedGrants().count, 1, "a password or label change keeps the grant")
    let kept = try await automaticUsername(desktop)
    XCTAssertNil(kept, "a changed revision must be approved again")

    try await edit(username: "alex@example.org", label: "Work")
    XCTAssertTrue(try harness.savedGrants().isEmpty, "a username change removes it")
    try await allow(desktop, "alex@example.org")
    try await edit(
      loginURL: "https://example.com/other", username: "alex@example.org", label: "Work")
    XCTAssertTrue(try harness.savedGrants().isEmpty, "a login page change removes it")
    try await allow(desktop, "alex@example.org")
    try await edit(
      origins: ["https://example.com", "https://login.example.com"],
      loginURL: "https://example.com/other",
      username: "alex@example.org", label: "Work")
    XCTAssertTrue(try harness.savedGrants().isEmpty, "a websites change removes it")
    try await allow(desktop, "alex@example.org")
    _ = try await broker.showLogins()
    _ = try await broker.deleteLogin(id: id)
    XCTAssertTrue(try harness.savedGrants().isEmpty, "deleting the login removes it")
    let gone = try await request(desktop, UUID().uuidString.lowercased())
    XCTAssertEqual(gone, .object(["accounts": .array([]), "decision": .string("approve")]))
  }

  /// G10: off stops allowed accounts too.
  func testSwitchOffStopsAutomaticSignIns() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com")
    try await broker.setAgentSignIns(false)
    same(
      try await request(desktop, UUID().uuidString.lowercased()),
      .object(["decision": .string("unavailable"), "reason": .string("passwords-off")]))
    try await broker.setAgentSignIns(true)
    let back = try await automaticUsername(desktop)
    XCTAssertEqual(back, "alex@example.com", "the grant was kept")
  }

  /// G13: removing the grant or turning off affects later releases; one
  /// already released finishes and is recorded.
  func testRemovalAffectsOnlyLaterReleases() async throws {
    try await harness.ready(items: [Self.alex])
    let desktop = try await harness.client()
    try await allow(desktop, "alex@example.com")
    let id = UUID().uuidString.lowercased()
    same(try await request(desktop, id)["decision"], .string("authorized"))
    _ = try await broker.removeGrant(try unwrap(try harness.savedGrants().first))
    try await broker.setAgentSignIns(false)
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    await harness.activity.flush()
    same(await harness.activity.entries().last?.outcome, .cancelled)
  }
}
