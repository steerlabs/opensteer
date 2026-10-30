import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Real socket journeys for the protocol-5 consent contract in ../../README.md.
@MainActor
final class PasswordsAnywhereTests: BrokerTestCase {
  private func client(_ version: Int64) async throws -> TestClient {
    let desktop = try await harness.client("desktop-v\(version)", greet: false)
    same(try await desktop.hello(version: version).result?["protocolVersion"], .integer(version))
    return desktop
  }

  private func modernRequest(
    _ id: String, workspace: (String, String) = Fixtures.workspace
  ) -> JSONValue {
    guard case .object(var fields) = Fixtures.request(id, workspace: workspace) else {
      preconditionFailure("fixture must be an object")
    }
    fields.removeValue(forKey: "runtimeId")
    fields.removeValue(forKey: "sessionId")
    fields["protocolVersion"] = .integer(5)
    fields["permissionVersion"] = .integer(5)
    return .object(fields)
  }

  private func release(_ id: String, kind: String = "app", origin: String? = nil) -> JSONValue {
    var fields: [String: JSONValue] = [
      "transactionId": .string(id), "field": .string("password"), "kind": .string(kind),
    ]
    if let origin { fields["origin"] = .string(origin) }
    return .object(fields)
  }

  private func approve(_ desktop: TestClient, _ id: String, _ request: JSONValue, remember: Bool)
    async throws
  {
    let decision = try await desktop.call("signin.request", request)
    same(decision.result?["decision"], .string("approve"))
    let account = try unwrap(decision.result?["accounts"]?[0])
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: remember))
        .result?["decision"], .string("authorized"))
  }

  func testHelloNegotiatesBothVersions() async throws {
    for version in [Int64(4), 5] {
      let desktop = try await client(version)
      present(try await desktop.call("status").result)
    }
  }

  func testNegotiatedVersionGatesRequestAndReleaseVariants() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let old = try await client(4)
    let modern = try await client(5)
    let id = UUID().uuidString.lowercased()
    same(try await old.call("signin.request", modernRequest(id)).errorCode, "invalid")
    same(try await modern.call("signin.request", Fixtures.request(id)).errorCode, "invalid")
    guard case .object(var downgraded) = modernRequest(id) else { return XCTFail("fixture") }
    downgraded["permissionVersion"] = .integer(4)
    same(try await modern.call("signin.request", .object(downgraded)).errorCode, "invalid")
    for params in [release(id), release(id, kind: "browser", origin: "https://example.com")] {
      same(try await old.call("signin.release", params).errorCode, "invalid")
    }
    same(try await modern.call("signin.release", Fixtures.release(id)).errorCode, "invalid")
    same(try await old.call("signin.release", Fixtures.transaction(id)).errorCode, "invalid")
    same(try await modern.call("signin.release", Fixtures.transaction(id)).errorCode, "invalid")
    same(try await modern.call("signin.release", release(id, origin: "https://example.com")).errorCode, "invalid")
    same(try await modern.call("signin.release", release(id, kind: "browser")).errorCode, "invalid")
    XCTAssertTrue(broker.deadlines.isEmpty)
  }

  func testOneTimeV5ConsentSurvivesWithoutAGrant() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await client(5)
    let id = UUID().uuidString.lowercased()
    try await approve(desktop, id, modernRequest(id), remember: false)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
    XCTAssertTrue(presence.lastReason?.contains("websites and in apps") == true)
    XCTAssertTrue(presence.lastReason?.contains("tricked agent") == true)
    same(try await desktop.call("signin.release", release(id)).result?["released"], .bool(true))
    same(try await desktop.call("signin.release", release(id, kind: "browser", origin: "https://login.example.com:8443")).result?["released"], .bool(true))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    same(try await desktop.call("signin.release", release(id)).result?["reason"], .string("ended"))
  }

  func testV4ApprovalRemainsOriginOnly() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await client(4)
    let id = UUID().uuidString.lowercased()
    try await approve(desktop, id, Fixtures.request(id), remember: false)
    same(try await desktop.call("signin.release", release(id)).errorCode, "invalid")
    same(try await desktop.call("signin.release", Fixtures.release(id)).result?["released"], .bool(true))
    XCTAssertFalse(presence.lastReason?.contains("in apps") == true)
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  func testV4GrantRequiresReapprovalAndRetainsOtherV4Grants() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let old = try await client(4)
    for workspace in [Fixtures.workspace, Fixtures.otherWorkspace] {
      let id = UUID().uuidString.lowercased()
      try await approve(old, id, Fixtures.request(id, workspace: workspace), remember: true)
      _ = try await old.call("signin.cancel", Fixtures.transaction(id))
    }
    XCTAssertEqual(try harness.savedGrants().map(\.permissionVersion), [4, 4])
    let desktop = try await client(5)
    let id = UUID().uuidString.lowercased()
    let asked = presence.askCount
    try await approve(desktop, id, modernRequest(id), remember: true)
    XCTAssertEqual(presence.askCount, asked + 1)
    XCTAssertEqual(try harness.savedGrants().map(\.permissionVersion).sorted(), [4, 5])
    same(try await desktop.call("signin.release", release(id)).result?["released"], .bool(true))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    let again = UUID().uuidString.lowercased()
    same(try await desktop.call("signin.request", modernRequest(again)).result?["decision"], .string("authorized"))
    XCTAssertEqual(presence.askCount, asked + 1)
    same(try await desktop.call("signin.release", release(again)).result?["released"], .bool(true))
    let legacy = UUID().uuidString.lowercased()
    same(try await request(old, legacy)["decision"], .string("authorized"))
    same(try await old.call("signin.release", Fixtures.release(legacy)).result?["released"], .bool(true))
    // V4 deduplicates by browser session and site, even across Workspaces.
    _ = try await old.call("signin.cancel", Fixtures.transaction(legacy))
    // A later vault commit must not purge either supported grant version.
    _ = try await broker.showLogins()
    _ = try await broker.addLogin(Fixtures.login("example.org"))
    broker.windowClosed()
    let other = UUID().uuidString.lowercased()
    same(try await request(old, other, workspace: Fixtures.otherWorkspace)["decision"], .string("authorized"))
    same(try await old.call("signin.release", Fixtures.release(other)).result?["released"], .bool(true))
    same(try await desktop.call("signin.release", release(again)).result?["released"], .bool(true))
    XCTAssertEqual(try harness.savedGrants().map(\.permissionVersion).sorted(), [4, 5])
  }

  func testV5BrowserReleaseStillChecksOrigin() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await client(5)
    let id = UUID().uuidString.lowercased()
    try await approve(desktop, id, modernRequest(id), remember: false)
    same(try await desktop.call("signin.release", release(id)).result?["released"], .bool(true))
    same(try await desktop.call("signin.release", release(id, kind: "browser", origin: "https://elsewhere.org")).result?["reason"], .string("wrong-site"))
    for origin in ["http://example.com", "https://example.com/", "https://example.com/path"] {
      same(try await desktop.call("signin.release", release(id, kind: "browser", origin: origin)).errorCode, "invalid")
    }
    same(try await desktop.call("signin.release", release(id, kind: "browser", origin: "https://example.com")).result?["released"], .bool(true))
  }

  func testRememberedV5ReleaseRechecksCurrentGrantScope() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await client(5)
    let id = UUID().uuidString.lowercased()
    try await approve(desktop, id, modernRequest(id), remember: true)
    let grant = try unwrap(try harness.savedGrants().first)
    _ = try await broker.removeGrant(grant)
    // A fresh legacy approval replaces it with v4, without changing login/revision.
    let old = try await client(4)
    let legacy = UUID().uuidString.lowercased()
    try await approve(old, legacy, Fixtures.request(legacy), remember: true)
    same(try await desktop.call("signin.release", release(id)).result?["reason"], .string("revoked"))
    _ = try await broker.removeGrant(try unwrap(try harness.savedGrants().first))
    same(try await desktop.call("signin.release", release(id)).result?["reason"], .string("revoked"))
  }

  func testV5DeduplicatesWithinWorkspace() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await client(5)
    let first = UUID().uuidString.lowercased()
    same(try await desktop.call("signin.request", modernRequest(first)).result?["decision"], .string("approve"))
    same(try await desktop.call("signin.request", modernRequest(UUID().uuidString.lowercased())).result?["reason"], .string("busy"))
    same(try await desktop.call("signin.request", modernRequest(UUID().uuidString.lowercased(), workspace: Fixtures.otherWorkspace)).result?["decision"], .string("approve"))
  }
}
