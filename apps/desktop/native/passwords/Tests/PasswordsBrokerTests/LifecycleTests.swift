import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// How transactions end: connection loss, expiry, cancel and the
/// limits on how many may be open. A screen lock ends none of them.
@MainActor
final class LifecycleTests: BrokerTestCase {
  private func cancel(_ client: TestClient, _ id: String) async throws -> TestClient.Reply {
    try await client.call("signin.cancel", Fixtures.transaction(id))
  }

  /// Requests a sign-in and approves it Only this time; returns the transaction ID.
  private func released(_ client: TestClient, session: String = "bsn_1") async throws -> String {
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await client.call("signin.request", Fixtures.request(id, session: session)).result?[
        "accounts"]?[0])
    let reply = try await client.call(
      "signin.approve", Fixtures.approve(id, account, remember: false))
    XCTAssertEqual(reply.result?["decision"], .string("authorized"))
    return id
  }

  /// Requests a sign-in that waits for the person's choice; returns its ID and the first account.
  private func choosing(_ client: TestClient, session: String) async throws -> (String, JSONValue) {
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await client.call("signin.request", Fixtures.request(id, session: session)).result?[
        "accounts"]?[0])
    return (id, account)
  }

  /// X9, X13.
  func testConnectionLossEndsItsTransactions() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    _ = try await released(desktop, session: "bsn_released")
    _ = try await choosing(desktop, session: "bsn_other")
    let (waiting, account) = try await choosing(desktop, session: "bsn_waiting")
    presence.next(.holdUntilWithdrawn)
    desktop.send("signin.approve", Fixtures.approve(waiting, account, remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }

    desktop.close()
    try await harness.eventually("every transaction ended") { broker.deadlines.isEmpty }
    try await harness.eventually("the authentication withdrawn") { presence.holdingCount == 0 }
    await harness.activity.flush()
    let outcomes = await harness.activity.entries().map(\.outcome)
    XCTAssertEqual(
      outcomes.sorted { $0.rawValue < $1.rawValue }, [.cancelled, .cancelled, .cancelled],
      "a released or person-run sign-in's end is unknown; one still choosing was cancelled")
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  /// X10, A6.
  func testExpiryEndsTheTransaction() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(id, expiresIn: 0.8)).result?[
        "accounts"]?[0])
    presence.next(.holdUntilWithdrawn)
    let call = desktop.send("signin.approve", Fixtures.approve(id, account, remember: false))
    let reply = try await desktop.reply(to: call, timeout: 5)
    XCTAssertEqual(reply, .error(code: "unavailable", message: "This sign-in expired."))
    try await harness.eventually("the authentication withdrawn") { presence.holdingCount == 0 }
    await harness.activity.flush()
    let entries = await harness.activity.entries()
    XCTAssertEqual(entries.map(\.outcome), [.expired])
    XCTAssertEqual(entries.map(\.account), [nil])
  }

  func testDeadlineIsCappedAtSixtyMinutes() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    _ = try await desktop.call("signin.request", Fixtures.request(id, expiresIn: 2 * 3_600))
    let expiresAt = try XCTUnwrap(broker.deadlines[id])
    XCTAssertLessThanOrEqual(expiresAt.timeIntervalSinceNow, 60 * 60 + 1)
    XCTAssertGreaterThan(expiresAt.timeIntervalSinceNow, 60 * 60 - 10)
  }

  func testPastOrMalformedDeadlineIsRefused() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    for expiresAt in [
      Fixtures.iso(Date().addingTimeInterval(-1)), "2026-02-30T10:00:00Z", "2026-10-11T17:00:00",
      "tomorrow",
      "2026-10-11T25:00:00Z", "2026-10-11T17:00:00.000+24:00",
    ] {
      same(
        try await desktop.call("signin.request", Fixtures.request(expiresAt: expiresAt)).errorCode,
        "invalid", expiresAt)
    }
    XCTAssertTrue(broker.deadlines.isEmpty)
    // Every form zod accepts is read.
    for expiresAt in [
      "2099-01-01T10:00Z", "2099-01-01T10:00:00+02:00", "2099-01-01T10:00:00.123456Z",
    ] {
      let id = UUID().uuidString.lowercased()
      same(
        try await desktop.call(
          "signin.request", Fixtures.request(id, session: expiresAt, expiresAt: expiresAt)
        ).result?[
          "decision"], .string("approve"), expiresAt)
      same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    }
  }

  /// X12: a lock hides the window's logins and nothing else; an allowed
  /// account keeps signing in while the Mac is locked.
  func testScreenLockLeavesSignInsRunning() async throws {
    let totp = try TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")
    try await harness.ready(items: [Fixtures.login(totp: totp)])
    let desktop = try await harness.client()
    let releasedID = try await released(desktop, session: "bsn_released")
    let (waiting, account) = try await choosing(desktop, session: "bsn_waiting")
    let model = PasswordsWindowModel(
      broker: broker, activityLog: harness.activity,
      runner: ImportRunner(worker: URL(fileURLWithPath: "/usr/bin/false")))
    await model.showPasswords()
    guard case .shown = model.logins else { return XCTFail("the list should be showing") }

    broker.screenLocked()
    XCTAssertEqual(model.logins, .hidden, "the saved passwords hide")
    XCTAssertFalse(broker.loginsShown)
    present(
      try await desktop.call("signin.release", Fixtures.release(releasedID, field: "totp")).result?[
        "value"], "the release carries on")
    same(
      try await desktop.call("signin.approve", Fixtures.approve(waiting, account, remember: true))
        .result?["decision"],
      .string("authorized"), "an approval still goes through")
    let automatic = UUID().uuidString.lowercased()
    same(
      try await desktop.call("signin.request", Fixtures.request(automatic, session: "bsn_locked"))
        .result?["decision"],
      .string("authorized"), "an allowed account signs in while locked")
    XCTAssertEqual(broker.deadlines.count, 3)
  }

  /// X13.
  func testEndingCancelsARunningAuthentication() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let (id, account) = try await choosing(desktop, session: "bsn_1")
    presence.next(.holdUntilWithdrawn)
    let call = desktop.send("signin.approve", Fixtures.approve(id, account, remember: true))
    try await harness.eventually("the authentication showing") { presence.holdingCount == 1 }
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    try await harness.eventually("the authentication withdrawn") { presence.holdingCount == 0 }
    same(try await desktop.reply(to: call), .error(code: "unavailable", message: Copy.signInEnded))
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  /// X14, X15.
  func testLimits() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let first = UUID().uuidString.lowercased()
    _ = try await desktop.call("signin.request", Fixtures.request(first, session: "bsn_1"))
    same(
      try await desktop.call("signin.request", Fixtures.request(first, session: "bsn_9")).errorCode,
      "invalid", "same ID")
    same(
      try await desktop.call("signin.request", Fixtures.request(session: "bsn_1")).result,
      .object(["decision": .string("unavailable"), "reason": .string("busy")]),
      "same session and site")
    same(
      try await desktop.call(
        "signin.request", Fixtures.request(site: "https://example.org", session: "bsn_1")
      ).result?[
        "decision"], .string("approve"), "another site in the same session is its own sign-in")
    for session in ["bsn_2", "bsn_3"] {
      _ = try await desktop.call("signin.request", Fixtures.request(session: session))
    }
    XCTAssertEqual(broker.deadlines.count, 4)
    same(
      try await desktop.call("signin.request", Fixtures.request(session: "bsn_5")).result,
      .object(["decision": .string("unavailable"), "reason": .string("busy")]), "a fifth")
  }

  /// X15, M11: sign-ins waiting for the person never hold back allowed ones.
  /// Four may wait for approval; idle authorized leases do not occupy pending capacity.
  func testWaitingSignInsDoNotHoldBackAllowedOnes() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let allowed = UUID().uuidString.lowercased()
    let account = try unwrap(
      try await desktop.call("signin.request", Fixtures.request(allowed, session: "bsn_allow"))
        .result?["accounts"]?[0])
    _ = try await desktop.call("signin.approve", Fixtures.approve(allowed, account, remember: true))
    _ = try await cancel(desktop, allowed)
    let busy = JSONValue.object(["decision": .string("unavailable"), "reason": .string("busy")])

    for n in 1...4 {
      same(
        try await request(
          desktop, UUID().uuidString.lowercased(), session: "bsn_wait_\(n)",
          workspace: Fixtures.otherWorkspace)[
            "decision"], .string("approve"), "waiting \(n)")
    }
    same(
      try await request(
        desktop, UUID().uuidString.lowercased(), session: "bsn_wait_5",
        workspace: Fixtures.otherWorkspace),
      busy, "a fifth waiting for the person")
    var running: [String] = []
    for n in 1...6 {
      let id = UUID().uuidString.lowercased()
      same(
        try await request(desktop, id, session: "bsn_run_\(n)")["decision"], .string("authorized"),
        "allowed \(n)")
      running.append(id)
    }
    XCTAssertEqual(
      broker.deadlines.count, 10, "idle authorized leases do not occupy pending capacity")
    for id in running.prefix(2) { same(try await cancel(desktop, id).result, .object([:])) }
    await harness.activity.flush()
    same(
      await harness.activity.entries().map(\.outcome), [.cancelled, .cancelled, .cancelled],
      "busy answers record nothing")
  }

  /// X23.
  func testCancelIsIdempotent() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let unknown = UUID().uuidString.lowercased()
    same(try await cancel(desktop, unknown).result, .object([:]))
    same(
      try await desktop.call("signin.cancel", Fixtures.transaction(unknown)).result, .object([:]))
    let id = try await released(desktop)
    same(try await cancel(desktop, id).result, .object([:]))
    same(try await cancel(desktop, id).result, .object([:]), "idempotent cancel")
    same(
      try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]),
      "cancel again")
    let cancelled = try await released(desktop, session: "bsn_2")
    same(
      try await desktop.call("signin.cancel", Fixtures.transaction(cancelled)).result, .object([:]))
    same(try await cancel(desktop, cancelled).result, .object([:]), "idempotent cancel")
  }

}
