import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Field releases on a live authorization, driven through the real socket.
@MainActor
final class FollowUpTests: BrokerTestCase {
  private func authorize(_ client: TestClient, remember: Bool = false, session: String = "bsn_1")
    async throws -> String
  {
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await client.call("signin.request", Fixtures.request(id, session: session)).result?[
        "accounts"]?[0])
    let answer = try await client.call(
      "signin.approve", Fixtures.approve(id, account, remember: remember))
    same(answer.result?["decision"], .string("authorized"))
    XCTAssertNil(answer.result?["item"])
    XCTAssertNil(answer.result?["login"]?["password"])
    same(answer.result?["login"]?["account"], .string("a•••@example.com"))
    return id
  }

  private func release(
    _ client: TestClient, _ id: String, _ field: String = "password",
    origin: String = "https://example.com"
  ) async throws -> JSONValue? {
    try await client.call(
      "signin.release",
      .object(["transactionId": .string(id), "field": .string(field), "origin": .string(origin)])
    ).result
  }

  func testTOTPRules() async throws {
    let totp = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    try await harness.ready(items: [Fixtures.login(totp: totp)])
    let desktop = try await harness.client()
    let waiting = UUID().uuidString.lowercased()
    _ = try await request(desktop, waiting)
    same(
      try await release(desktop, waiting),
      .object(["released": .bool(false), "reason": .string("ended")]))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(waiting))
    let id = try await authorize(desktop)
    same(
      try await release(desktop, id, "username"),
      .object(["released": .bool(true), "value": .string("alice@example.com")]))
    for _ in 0..<4 {
      let before = try totp.code(at: Date())
      let code = try unwrap(try await release(desktop, id, "totp")?["value"]?.string)
      XCTAssertTrue([before, try totp.code(at: Date())].contains(code))
      XCTAssertFalse(code.contains("JBSWY3DPEHPK3PXP"))
    }
    same(
      try await release(desktop, id, origin: "https://example.org"),
      .object(["released": .bool(false), "reason": .string("wrong-site")]))
    same(
      try await release(desktop, id, origin: "https://other.example.com"),
      .object(["released": .bool(true), "value": .string("synthetic-password-1")]),
      "the login covers its whole registrable site")
    for _ in 0..<2 {
      same(
        try await release(desktop, id),
        .object(["released": .bool(true), "value": .string("synthetic-password-1")]))
    }
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome.rawValue), ["cancelled", "used"])
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    same(
      try await release(desktop, id),
      .object(["released": .bool(false), "reason": .string("ended")]))
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome.rawValue), ["cancelled", "used"])
  }

  func testReleaseRechecksLoginAndGrant() async throws {
    for remember in [false, true] {
      try await restart { try BrokerHarness() }
      try await harness.ready(items: [Fixtures.login()])
      let desktop = try await harness.client()
      let id = try await authorize(desktop, remember: remember)
      same(
        try await release(desktop, id, "totp"),
        .object(["released": .bool(false), "reason": .string("no-totp")]))
      let stranger = try await harness.client("stranger")
      same(
        try await release(stranger, id),
        .object(["released": .bool(false), "reason": .string("ended")]))
      try await broker.setAgentSignIns(false)
      same(
        try await release(desktop, id),
        .object(["released": .bool(false), "reason": .string("passwords-off")]))
      try await broker.setAgentSignIns(true)
      _ = try await broker.showLogins()
      let item = try unwrap(try await harness.savedItems().first)
      _ = try await broker.updateLogin(
        LoginEdit(
          id: item.id, origins: item.origins, loginURL: item.loginURL, username: item.username,
          password: "synthetic-new", totp: nil, label: nil))
      same(
        try await release(desktop, id),
        .object(["released": .bool(false), "reason": .string("revoked")]))
    }
    try await restart { try BrokerHarness() }
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = try await authorize(desktop, remember: true)
    let grant = try unwrap(try harness.savedGrants().first)
    _ = try await broker.removeGrant(grant)
    same(
      try await release(desktop, id),
      .object(["released": .bool(false), "reason": .string("revoked")]))
  }
}
