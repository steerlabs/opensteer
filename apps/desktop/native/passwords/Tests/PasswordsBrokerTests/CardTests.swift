import Foundation
import PasswordsCore
import XCTest
@testable import PasswordsBrokerKit

@MainActor
final class CardTests: BrokerTestCase {
  func ready() async throws -> Wire.CardChoice {
    try await broker.setUp()
    try await broker.saveCard(CardDraft(number: "4242424242424242", expiryMonth: 3, expiryYear: 2030, cvc: "123"))
    return try unwrap(try await broker.listCards().first)
  }
  func client(_ version: Int64 = 10) async throws -> TestClient {
    let client = try await harness.client(greet: false)
    _ = try await client.hello(version: version)
    return client
  }
  func requestCard(_ client: TestClient, _ id: String) async throws -> JSONValue {
    try unwrap(try await client.call("card.request", Fixtures.request(id,
      extra: ["protocolVersion": .integer(10), "permissionVersion": .integer(7)])).result)
  }
  func approval(_ id: String, _ card: Wire.CardChoice, remember: Bool = false) -> JSONValue {
    var fields: [String: JSONValue] = ["transactionId": .string(id), "cardId": .string(card.id),
      "revision": .integer(card.revision), "permissionVersion": .integer(7)]
    if remember { fields["remember"] = .bool(true) }
    return .object(fields)
  }
  func release(_ id: String, field: String = "number", top: String = "https://example.com") -> JSONValue {
    .object(["transactionId": .string(id), "field": .string(field), "topOrigin": .string(top),
      "frameOrigin": .string("https://js.stripe.com")])
  }

  func testConsentCommitDestinationsRevocationAndActivity() async throws {
    let card = try await ready()
    let desktop = try await client()
    let other = try await client()
    let id = UUID().uuidString.lowercased()
    let offered = try await requestCard(desktop, id)
    same(offered["decision"], .string("approve"))
    let listing = String(decoding: try CanonicalJSON.encode(offered), as: UTF8.self)
    XCTAssertFalse(listing.contains("4242424242424242"))
    XCTAssertFalse(listing.contains("\"cvc\""))
    same(try await desktop.call("card.approve", approval(id, card, remember: true)).errorCode, "invalid")
    same(try await other.call("card.approve", approval(id, card)).errorCode, "invalid")
    same(try await desktop.call("card.approve", approval(id, card)).result?["decision"], .string("authorized"))
    same(try await desktop.call("card.release", release(id)).result?["reason"], .string("ended"))
    same(try await desktop.call("signin.commit", Fixtures.transaction(id)).result?["committed"], .bool(true))
    same(try await other.call("card.release", release(id)).result?["reason"], .string("ended"))
    same(try await desktop.call("signin.release", Fixtures.release(id)).result?["reason"], .string("ended"))
    same(try await desktop.call("card.release", release(id, top: "https://example.org")).result?["reason"], .string("wrong-site"))
    same(try await desktop.call("card.release", release(id, field: "name")).result?["reason"], .string("no-field"))
    same(try await desktop.call("card.release", release(id, field: "billing-postal-code")).result?["reason"], .string("no-field"))
    same(try await desktop.call("card.release", release(id)).result?["value"], .string("4242424242424242"))
    same(try await desktop.call("card.release", release(id, field: "expiry")).result?["value"], .string("03/30"))
    same(try await desktop.call("card.release", release(id, field: "expiry-year")).result?["value"], .string("2030"))
    try await broker.setAgentSignIns(false)
    same(try await desktop.call("card.release", release(id)).result?["reason"], .string("passwords-off"))
    try await broker.setAgentSignIns(true)
    var edit = try await broker.cardForEditing(id: card.id).draft
    edit.label = "Changed"
    try await broker.saveCard(edit, id: card.id)
    same(try await desktop.call("card.release", release(id)).result?["reason"], .string("revoked"))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    let entries = await harness.activity.entries()
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries.first?.credential, "card")
    let bytes = try CanonicalJSON.encode(try unwrap(entries.first).json)
    let text = String(decoding: bytes, as: UTF8.self)
    for value in ["4242424242424242", "123", "Changed", "Check the invoice", "2030"] {
      let encoded = String(decoding: try CanonicalJSON.encode(.string(value)), as: UTF8.self)
      XCTAssertFalse(text.contains(encoded))
    }
    XCTAssertTrue(try harness.savedGrants().isEmpty)
  }

  func testCrossKindRefusedAndPANNeedsPresence() async throws {
    let card = try await ready()
    let desktop = try await client()
    _ = try await broker.addLogin(Fixtures.login())
    let id = UUID().uuidString.lowercased()
    let loginRequest = Fixtures.request(id)
    let choice = try unwrap(try await desktop.call("signin.request", loginRequest).result?["accounts"]?[0])
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, choice, remember: true))
    _ = try await desktop.call("signin.commit", Fixtures.transaction(id))
    same(try await desktop.call("card.release", release(id)).result?["reason"], .string("ended"))
    let cardID = UUID().uuidString.lowercased()
    same(try await requestCard(desktop, cardID)["decision"], .string("approve"))
    same(try await desktop.call("card.request", Fixtures.request(id,
      extra: ["protocolVersion": .integer(10), "permissionVersion": .integer(7)])).errorCode, "invalid")
    var draft = try await broker.cardForEditing(id: card.id).draft
    draft.number = "5555555555554444"
    let before = presence.askCount
    try await broker.saveCard(draft, id: card.id)
    XCTAssertEqual(presence.askCount, before + 1)
  }
  func testDeadlineCappedAtAdmissionAndNeverExtended() async throws {
    let card = try await ready()
    let desktop = try await client()
    let id = UUID().uuidString.lowercased()
    let start = Date()
    _ = try await desktop.call("card.request", Fixtures.request(id, expiresIn: 7200,
      extra: ["protocolVersion": .integer(10), "permissionVersion": .integer(7)]))
    let deadline = try unwrap(broker.deadlines[id])
    XCTAssertGreaterThanOrEqual(deadline.timeIntervalSince(start), 1800)
    XCTAssertLessThanOrEqual(deadline.timeIntervalSinceNow, 1800)
    _ = try await desktop.call("card.approve", approval(id, card))
    _ = try await desktop.call("signin.commit", Fixtures.transaction(id))
    XCTAssertEqual(broker.deadlines[id], deadline)
  }

  func testPANAuthenticationPinsRevisionAndVisit() async throws {
    let card = try await ready()
    var edit = try await broker.cardForEditing(id: card.id).draft
    edit.number = "5555555555554444"
    presence.next(.holdThenConfirm)
    let changing = Task { try await broker.saveCard(edit, id: card.id) }
    try await harness.eventually("card authentication") { presence.holdingCount == 1 }
    var other = try await broker.cardForEditing(id: card.id).draft
    other.label = "Concurrent edit"
    try await broker.saveCard(other, id: card.id)
    presence.releaseHeld()
    do { try await changing.value; XCTFail("stale number edit committed") }
    catch VaultError.headMoved { }
    let saved = try await broker.cardForEditing(id: card.id)
    XCTAssertEqual(saved.draft.number, "4242424242424242")
    broker.windowClosed()
    do { _ = try await broker.cardForEditing(id: card.id); XCTFail("closed visit read") }
    catch VaultServiceError.windowLocked { }
  }

  func testClosingVisitDuringPANAuthenticationWritesNothing() async throws {
    let card = try await ready()
    var edit = try await broker.cardForEditing(id: card.id).draft
    edit.number = "5555555555554444"
    presence.next(.holdThenConfirm)
    let changing = Task { try await broker.saveCard(edit, id: card.id) }
    try await harness.eventually("card authentication") { presence.holdingCount == 1 }
    broker.windowClosed()
    presence.releaseHeld()
    do { try await changing.value; XCTFail("closed visit committed") }
    catch PresenceError.cancelled { }
    _ = try await broker.showLogins()
    let saved = try await broker.cardForEditing(id: card.id)
    XCTAssertEqual(saved.revision, card.revision)
  }

  func testQueuedReleaseCannotOutliveCancellation() async throws {
    try await restart { try BrokerHarness(controlledStore: true) }
    let card = try await ready()
    let desktop = try await client()
    let id = UUID().uuidString.lowercased()
    _ = try await requestCard(desktop, id)
    _ = try await desktop.call("card.approve", approval(id, card))
    _ = try await desktop.call("signin.commit", Fixtures.transaction(id))
    let store = try unwrap(harness.controlled)
    store.close()
    defer { store.open() }
    let releaseID = desktop.send("card.release", release(id))
    try await harness.eventually("queued card release") { store.waitingReads == 1 }
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    let result = try await desktop.reply(to: releaseID)
    same(result.result?["reason"], .string("ended"))
    store.open()
    _ = try await harness.vault.cardChoices()
    same(await harness.activity.entries().count, 0)
  }

}
