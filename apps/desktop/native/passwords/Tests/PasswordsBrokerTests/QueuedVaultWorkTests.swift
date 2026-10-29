import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Section 10, X32–X34: an approval or a save whose vault work waits behind
/// other vault work still answers to its sign-in and to the switch. The
/// store's reads are held, so the work is queued or under way when the
/// sign-in ends or the switch goes off.
@MainActor
final class QueuedVaultWorkTests: BrokerTestCase {
  override func setUp() async throws {
    try await super.setUp()
    try await restart { try BrokerHarness(controlledStore: true) }
  }

  private var store: ControlledStore { harness.controlled! }

  /// Lets every held read go, then waits until the vault queue is empty.
  private func drainVaultQueue() async throws {
    store.open()
    _ = try await harness.vault.hasLogin(withinSite: "https://example.com")
  }

  /// X32 (off race): the person turns agent sign-ins off
  /// while an approval authenticates; the switch's write is queued ahead of
  /// the approval's vault work. Nothing is granted or released, and the card
  /// hears why.
  func testSwitchingOffAheadOfAQueuedApprovalReleasesNothing() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, id)["accounts"]?[0])
    store.close()
    let vault = harness.vault
    let earlier = Task { try await vault.hasLogin(withinSite: "https://example.com") }
    try await harness.eventually("earlier vault work holding the queue") { store.waitingReads == 1 }
    let off = Task { try await self.broker.setAgentSignIns(false) }
    try await Task.sleep(nanoseconds: 20_000_000)
    let confirmed = presence.confirmCount
    let approve = desktop.send("signin.approve", Fixtures.approve(id, account, remember: true))
    try await harness.eventually("the approval authenticated") { presence.confirmCount > confirmed }
    try await Task.sleep(nanoseconds: 20_000_000)
    store.open()
    _ = try await earlier.value
    try await off.value
    same(
      try await desktop.reply(to: approve),
      .result(.object(["decision": .string("unavailable"), "reason": .string("passwords-off")])))
    XCTAssertTrue(try harness.savedGrants().isEmpty, "nothing was granted")
    XCTAssertEqual(broker.status, Wire.Status(vault: .ready, agentSignIns: false))
    same(
      try await desktop.call("signin.release", Fixtures.release(id)).result?["reason"],
      .string("ended"), "the sign-in ended")
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome), [.cancelled])
  }

  /// X33 (cancel race): the sign-in ends (cancel, the
  /// person's decline, the desktop gone, expiry) while its approval reads
  /// the vault. When the read goes on, the approval writes no grant.
  func testEndingWhileAnApprovalIsQueuedWritesNoGrant() async throws {
    try await harness.ready(items: [Fixtures.login()])
    for (index, ending) in ["cancel", "decline", "connection lost", "expiry"].enumerated() {
      let desktop = try await harness.client(ending)
      let id = UUID().uuidString.lowercased()
      let request = Fixtures.request(
        id, session: "bsn_\(index)", expiresIn: ending == "expiry" ? 1 : 600)
      let account = try unwrap(
        try await desktop.call("signin.request", request).result?["accounts"]?[0])
      store.close()
      let approve = desktop.send("signin.approve", Fixtures.approve(id, account, remember: true))
      try await harness.eventually("the approval reading the vault") { store.waitingReads == 1 }
      switch ending {
      case "cancel":
        same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
      case "decline":
        same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
      case "expiry":
        try await harness.eventually("the sign-in expired") { broker.deadlines.isEmpty }
      default:
        desktop.close()
        try await harness.eventually("the sign-in ended") { broker.deadlines.isEmpty }
      }
      if ending != "connection lost" {
        let message = ending == "expiry" ? "This sign-in expired." : Copy.signInEnded
        same(
          try await desktop.reply(to: approve), .error(code: "unavailable", message: message),
          ending)
      }
      try await drainVaultQueue()
      XCTAssertTrue(try harness.savedGrants().isEmpty, "\(ending): nothing was granted")
      if ending != "connection lost" {
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(
          desktop.pendingFrameCount, 0, "\(ending): the approval's late answer was dropped")
      }
    }
    await harness.activity.flush()
    same(
      await harness.activity.entries().map(\.outcome),
      [.cancelled, .cancelled, .cancelled, .expired])
  }

  /// X37: the withdrawal arrives while the save's commit is under way. It
  /// waits for the commit, which stands, and the save is answered as saved
  /// before the withdrawal is answered, so the desktop reports it honestly.

  /// A queued release has no authority after cancel, even if it resumes later.
  func testEndingWhileAReleaseIsQueuedReleasesNothing() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, id)["accounts"]?[0])
    same(
      try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: false))
        .result?["decision"], .string("authorized"))
    store.close()
    let release = desktop.send("signin.release", Fixtures.release(id))
    try await harness.eventually("the release reading the vault") { store.waitingReads == 1 }
    same(try await desktop.call("signin.cancel", Fixtures.transaction(id)).result, .object([:]))
    same(
      try await desktop.reply(to: release).result,
      .object(["released": .bool(false), "reason": .string("ended")]))
    try await drainVaultQueue()
    try await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertEqual(desktop.pendingFrameCount, 0, "no late field value")
    await harness.activity.flush()
    same(await harness.activity.entries().map(\.outcome), [.cancelled])
  }

}
