import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

@MainActor
final class AccountChoiceTests: BrokerTestCase {
  func testDistinctPasswordsAndNewestDuplicatesWithoutPageRanking() async throws {
    let origins = ["https://signin.aws.amazon.com", "https://www.amazon.com"]
    try await harness.ready(items: [
      Fixtures.login("www.amazon.com", username: "sam", password: "same", label: "www.amazon.com"),
      Fixtures.login("www.amazon.com", username: "sam", password: "different", label: "amazon.com"),
      Fixtures.login(username: "sam", password: "same", label: "Shopping", origins: origins),
      Fixtures.login("www.amazon.com", username: "Alice", password: "alice"),
      Fixtures.login("signin.aws.amazon.com", username: "sam", password: "aws"),
      Fixtures.login("portal.aws.amazon.com", username: "sam", password: "same"),
    ])
    let saved = try await harness.savedItems()
    let newest = try XCTUnwrap(saved.first { $0.label == "Shopping" })
    let desktop = try await harness.client()
    let asked = presence.askCount
    let reply = try await desktop.call(
      "signin.request", Fixtures.request(site: "https://amazon.com"))
    let accounts = try XCTUnwrap(reply.result?["accounts"], "\(reply)")
    guard case .array(let rows) = accounts else { return XCTFail("No choices") }
    XCTAssertEqual(rows.count, 5)
    XCTAssertTrue(rows.allSatisfy { $0["onPage"] == .bool(false) })
    XCTAssertEqual(
      rows.map { $0["host"] },
      [
        .string("portal.aws.amazon.com"), .string("signin.aws.amazon.com"),
        .string("signin.aws.amazon.com"), .string("www.amazon.com"), .string("www.amazon.com"),
      ])
    let selected = try XCTUnwrap(rows.first { $0["id"] == .string(newest.id) })
    XCTAssertEqual(selected["label"], .string("Shopping"))
    XCTAssertNotNil(selected["updatedAt"]?.string.flatMap(WireRules.isoDate))
    XCTAssertEqual(presence.askCount, asked)
  }

  func testOneHundredChoices() async throws {
    try await harness.ready(
      items: (0..<101).map { Fixtures.login(username: String(format: "user%03d", $0)) })
    let desktop = try await harness.client()
    let reply = try await desktop.call("signin.request", Fixtures.request())
    guard case .array(let rows)? = reply.result?["accounts"] else { return XCTFail("\(reply)") }
    XCTAssertEqual(rows.count, 100)
    XCTAssertEqual(rows.last?["username"], .string("user099"))
    XCTAssertTrue(rows.allSatisfy { $0["onPage"] == .bool(false) })
  }

  func testEscapedWorstCaseReturnsBoundedErrorInsteadOfClosingSocket() async throws {
    try await harness.ready(
      items: (0..<100).map {
        Fixtures.login(
          username: String(repeating: "\u{01}", count: 1020) + String(format: "%04d", $0),
          label: String(repeating: "\u{01}", count: 200))
      })
    let desktop = try await harness.client()
    let reply = try await desktop.call("signin.request", Fixtures.request())
    same(reply.errorCode, "invalid")
    present(try await desktop.call("status").result)
  }

  /// A sign-in always starts on the agent's page, so the request names it.
  func testRefusesRemovedPageOriginParameter() async throws {
    try await harness.ready()
    let desktop = try await harness.client()
    for origin in [
      "http://example.com", "https://example.org", "https://example.com/path",
      "https://example.com/",
    ] {
      same(
        try await desktop.call(
          "signin.request", Fixtures.request(extra: ["pageOrigin": .string(origin)])
        ).errorCode, "invalid")
    }
    same(
      try await desktop.call("signin.request", Fixtures.request(extra: ["pageOrigin": .null]))
        .errorCode, "invalid")
  }
}
