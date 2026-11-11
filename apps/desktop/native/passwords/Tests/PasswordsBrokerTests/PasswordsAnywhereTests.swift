import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

@MainActor
final class PasswordsAnywhereTests: BrokerTestCase {
  private func prepare(_ desktop: TestClient, _ id: String, remember: Bool = true) async throws
    -> JSONValue
  {
    let decision = try await desktop.call("signin.request", Fixtures.request(id))
    let account = try unwrap(decision.result?["accounts"]?[0])
    let before = presence.askCount
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: remember))
        .result?["decision"], .string("authorized"))
    XCTAssertEqual(
      presence.askCount, before, "sign-in consent never asks the vault Mac for presence")
    return account
  }
  private func release(_ id: String, kind: String = "app", origin: String? = nil) -> JSONValue {
    var fields: [String: JSONValue] = [
      "transactionId": .string(id), "field": .string("password"), "kind": .string(kind),
    ]
    if let origin { fields["origin"] = .string(origin) }
    return .object(fields)
  }
  func testPrepareCannotReleaseOrRememberUntilHostCommit() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, id)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(try await desktop.call("signin.release", release(id)).result?["reason"], .string("ended"))
    same(
      try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"],
      .bool(true))
    XCTAssertEqual(try harness.savedGrants().count, 1)
    same(try await desktop.call("signin.release", release(id)).result?["released"], .bool(true))
    same(
      try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"],
      .bool(true))
    XCTAssertEqual(try harness.savedGrants().count, 1, "commit replay is idempotent")
  }
  func testCancelledPrepareLeavesNoGrantAndCannotCommitLater() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, id)
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    same(try await desktop.call("signin.commit", Fixtures.transaction(id)).errorCode, "invalid")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(try await desktop.call("signin.release", release(id)).result?["reason"], .string("ended"))
  }
  func testLosingPrepareCleanupCannotEraseNewerGrant() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let losing = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, losing)
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(losing))
    let winner = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, winner)
    _ = try await desktop.call("signin.commit", Fixtures.transaction(winner))
    let grant = try harness.savedGrants()
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(losing))
    XCTAssertEqual(try harness.savedGrants(), grant)
  }
  func testCommitRechecksRevisionAndOffSwitch() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let selected = try await prepare(desktop, id)
    _ = try await broker.showLogins()
    let item = try unwrap(try await harness.savedItems().first)
    _ = try await broker.updateLogin(
      LoginEdit(
        id: item.id, origins: item.origins, loginURL: item.loginURL, username: item.username,
        password: "changed", totp: nil, label: nil))
    same(
      try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"],
      .bool(false))
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    XCTAssertNotNil(selected["revision"])
    let next = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, next)
    try await broker.setAgentSignIns(false)
    let committed = try await desktop.call("signin.commit", Fixtures.transaction(next))
    XCTAssertNotEqual(committed.result?["committed"], .bool(true))
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }
  func testOnlyThisTimePinsConsentWithoutRemembering() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, id, remember: false)
    same(
      try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"],
      .bool(true))
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(try await desktop.call("signin.release", release(id)).result?["released"], .bool(true))
    same(
      try await desktop.call(
        "signin.release", release(id, kind: "browser", origin: "https://elsewhere.org")
      ).result?["reason"], .string("wrong-site"))
    same(
      try await desktop.call(
        "signin.release", release(id, kind: "browser", origin: "https://login.example.com:8443")
      ).result?["released"], .bool(true))
  }
  func testTransactionConnectionOwnsPrepareAndCommit() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let other = try await harness.client("other")
    let id = UUID().uuidString.lowercased()
    _ = try await prepare(desktop, id)
    same(try await other.call("signin.commit", Fixtures.transaction(id)).errorCode, "invalid")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    same(
      try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"],
      .bool(true))
  }
  func testOldProtocolsCannotApproveAndConsentCannotDowngrade() async throws {
    try await harness.ready(items: [Fixtures.login()])
    for version: Int64 in [4, 5, 6, 7, 8, 9] {
      let old = try await harness.client("old", greet: false)
      same(try await old.hello(version: version).result?["protocolVersion"], .integer(10))
      try await old.waitUntilClosed()
    }
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let request = try await desktop.call("signin.request", Fixtures.request(id))
    guard
      case .object(var params) = Fixtures.approve(
        id, request.result?["accounts"]?[0], remember: true)
    else { return XCTFail("fixture") }
    params["permissionVersion"] = .integer(4)
    same(try await desktop.call("signin.approve", .object(params)).errorCode, "invalid")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }
  func testOldConsentShapesAreRefused() throws {
    guard case .object(var fields) = Fixtures.request() else { return XCTFail("fixture") }
    for version: Int64 in [4, 5, 6, 7, 8, 9] {
      fields["protocolVersion"] = .integer(version)
      XCTAssertThrowsError(try Wire.SignInRequestParams(json: .object(fields)))
    }
    fields["protocolVersion"] = .integer(10)
    fields["workspaceId"] = .string("wsp_00000000-0000-4000-8000-000000000003")
    XCTAssertThrowsError(try Wire.SignInRequestParams(json: .object(fields)))
  }

  func testVaultManagementStillRequiresPresence() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let before = presence.askCount
    _ = try await broker.showLogins()
    XCTAssertEqual(presence.askCount, before + 1)
  }
}
