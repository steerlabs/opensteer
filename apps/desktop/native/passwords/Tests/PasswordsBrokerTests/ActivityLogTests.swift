import Darwin
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Section 12 of FAILURES.md.
final class ActivityLogTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "pwa-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func entry(_ index: Int, outcome: ActivityOutcome = .signedIn) -> ActivityEntry {
    ActivityEntry(
      at: Date(timeIntervalSince1970: 1_800_000_000 + Double(index)), site: "example.com",
      account: "a•••@example.com",
      deployment: "Personal", workspace: "Main", thread: "Thread \(index)",
      automatic: index.isMultiple(of: 2),
      outcome: outcome)
  }

  /// Every entry is a durable rewrite, so the cap is proven on a small log
  /// and the broker's own cap is pinned beside it.
  func testKeepsTheNewest500() async throws {
    XCTAssertEqual(ActivityLog.defaultCapacity, 500)
    let log = ActivityLog(url: directory.appendingPathComponent("activity.jsonl"), capacity: 5)
    for index in 0..<8 { log.append(entry(index)) }
    let entries = await log.entries()
    XCTAssertEqual(entries.map(\.thread), (3..<8).map { "Thread \($0)" })
    XCTAssertEqual(entries.last, entry(7), "an entry reads back exactly")
  }

  func testFileIsPrivate() async throws {
    let url = directory.appendingPathComponent("activity.jsonl")
    let log = ActivityLog(url: url)
    log.append(entry(1))
    await log.flush()
    var information = stat()
    XCTAssertEqual(lstat(url.path, &information), 0)
    XCTAssertEqual(information.st_mode & 0o777, 0o600)
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter {
      $0.hasPrefix(".tmp")
    }
    XCTAssertEqual(leftovers, [], "written through a temp file that was renamed")
  }

  func testUnreadableLinesAreDropped() async throws {
    let url = directory.appendingPathComponent("activity.jsonl")
    let log = ActivityLog(url: url)
    log.append(entry(1, outcome: .declined))
    await log.flush()
    var bytes = try Data(contentsOf: url)
    bytes.append(Data("garbage\n{\"at\":1}\n".utf8))
    try bytes.write(to: url)
    log.append(entry(2, outcome: .expired))
    let entries = await log.entries()
    XCTAssertEqual(entries.map(\.outcome), [.declined, .expired])
  }
}

/// A1, end to end: a real sign-in, then the file's bytes.
@MainActor
final class ActivityPrivacyTests: BrokerTestCase {
  func testNoSecretsReachTheFile() async throws {
    try await harness.ready(items: [
      Fixtures.login(username: "secret-person@example.com", password: "synthetic-secret-value")
    ])
    let desktop = try await harness.client()
    let id = UUID().uuidString.lowercased()
    let reason = "SYNTHETIC-AGENT-REASON"
    let decision = try await desktop.call(
      "signin.request", Fixtures.request(id, extra: ["reason": .string(reason)])
    ).result
    let account = try XCTUnwrap(decision?["accounts"]?[0])
    _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    let automatic = UUID().uuidString.lowercased()
    _ = try await desktop.call(
      "signin.request", Fixtures.request(automatic, extra: ["reason": .string(reason)]))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(automatic))
    await harness.activity.flush()
    let text = String(decoding: try Data(contentsOf: harness.paths.activity), as: UTF8.self)
    XCTAssertTrue(text.contains("s•••@example.com"))
    XCTAssertTrue(text.contains(#""automatic":true"#))
    for secret in [
      "synthetic-secret-value", "secret-person", reason, id, automatic, Fixtures.workspace.0,
    ] {
      XCTAssertFalse(text.contains(secret), secret)
    }
  }
}

/// Section 13: what the person reads.
final class DisplayTests: XCTestCase {
  func testMaskedAccounts() {
    XCTAssertEqual(Display.maskedAccount("alex@example.com"), "a•••@example.com")
    XCTAssertEqual(Display.maskedAccount("a@x.io"), "a•••@x.io")
    XCTAssertEqual(Display.maskedAccount("alex"), "a•••")
    XCTAssertEqual(Display.maskedAccount("  ana@b.co "), "a•••@b.co")
    XCTAssertEqual(Display.maskedAccount("a@b@corp.example"), "a•••@corp.example")
    XCTAssertEqual(Display.maskedAccount("@handle"), "@•••")
    XCTAssertEqual(Display.maskedAccount("é\u{301}lise@example.com"), "é\u{301}•••@example.com")
    XCTAssertEqual(
      Display.maskedAccount("\u{202E}moc.elpmaxe@mit"), "m•••@mit",
      "bidirectional overrides are removed")
    XCTAssertEqual(Display.maskedAccount(""), "No username")
  }

  /// U2.
  func testAgentTextIsCleaned() {
    XCTAssertEqual(
      Display.clean("Pay\nthe \u{202E}bill\u{0000}  now\t", limit: 100), "Pay the bill now")
    XCTAssertEqual(
      Display.clean("👨\u{200D}👩\u{200D}👧 team", limit: 100), "👨\u{200D}👩\u{200D}👧 team",
      "joiners stay")
    XCTAssertEqual(Display.clean("\u{200F}\u{2066}x\u{2069}", limit: 100), "x")
    XCTAssertEqual(
      Display.clean(String(repeating: "a", count: 20), limit: 10),
      String(repeating: "a", count: 9) + "…")
  }
}

/// U5: where the Mac says what the web and phone say, the words are the same.
final class CopyParityTests: XCTestCase {
  private func clientSource() throws -> String {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("../../../../packages/client/src/host/passwords.ts")
      .standardizedFileURL
    return try String(contentsOf: url, encoding: .utf8)
  }

  func testSharedSentencesMatchTheClient() throws {
    let source = try clientSource()
    let shared =
      [
        Copy.agentSignIns, Copy.setUpLead, Copy.unsupported, Copy.developmentBanner, Copy.appName,
        Copy.setUpNote,
      ]
      + Copy.setUpFacts
    for sentence in shared {
      XCTAssertTrue(
        source.contains("\"\(sentence)\""),
        "packages/client/src/host/passwords.ts says “\(sentence)” differently")
    }
  }

  /// U13: the Mac promises only what the code keeps.
  func testNoSentenceOverpromises() {
    let sentences =
      [
        Copy.setUpLead, Copy.startFreshConfirm, Copy.otherMac, Copy.damaged, Copy.olderVersion,
        Copy.agentSignInsDetail,
      ]
      + Copy.setUpFacts
    for sentence in sentences {
      for claim in [
        "never leave", "stays on this Mac", "import them again", "import again", "approve each use",
        "approve every use",
      ] {
        XCTAssertFalse(sentence.contains(claim), "“\(claim)” in “\(sentence)”")
      }
    }
    XCTAssertTrue(Copy.setUpLead.contains("never sends your password to the agent"))
    XCTAssertTrue(Copy.setUpLead.contains("website or app, which can read it"))
    XCTAssertTrue(
      Copy.setUpLead.contains("You allow an account with Touch ID or your Mac password"))
    XCTAssertEqual(
      Copy.startFreshConfirm,
      "This permanently deletes the passwords saved on this Mac. Ones you added or changed here can’t be recovered unless you also keep them somewhere else."
    )
  }

  /// The refusals the card and the sign-in sheet show word for word: one
  /// short sentence each, nothing internal.
  func testRefusalsArePlainSentences() {
    let refusals = [
      Copy.notConfirmed, Copy.authenticationCancelled, Copy.cannotAuthenticate, Copy.accountChanged,
      Copy.accountGone,
      Copy.notOffered, Copy.signInMovedOn, Copy.signInEnded, Copy.notReadyForSignIn,
      Copy.couldNotOpenForSignIn, Copy.notUnlockedSinceRestart,
    ]
    for sentence in refusals {
      XCTAssertLessThanOrEqual(sentence.count, 100, sentence)
      XCTAssertTrue(sentence.hasSuffix("."), sentence)
      for word in ["transaction", "sign-in ID", "invalid", "broker", "vault", "grant", "revision"] {
        XCTAssertFalse(sentence.contains(word), "\(word) in \(sentence)")
      }
    }
  }

  func testHouseStyle() {
    let sentences =
      [
        Copy.agentSignIns, Copy.setUpLead, Copy.unsupported, Copy.confirming, Copy.locked,
        Copy.otherMac, Copy.damaged,
        Copy.olderVersion, Copy.startFreshConfirm, Copy.deleteExport, Copy.couldNotRead,
        Copy.authenticationCancelled,
        Copy.accountChanged, Copy.allowedIn("Main", site: nil),
      ] + Copy.setUpFacts + ImportSource.allCases.flatMap(\.steps)
      + ImportSource.allCases.compactMap(\.note)
    for sentence in sentences {
      XCTAssertFalse(sentence.contains("'"), "curly apostrophes: \(sentence)")
      XCTAssertFalse(sentence.contains("..."), "an ellipsis character: \(sentence)")
      for word in ["vault key", "broker", "HPKE", "epoch"] {
        XCTAssertFalse(sentence.lowercased().contains(word.lowercased()), "\(word) in \(sentence)")
      }
    }
    // Titles end without a period unless they ask.
    for title in [Copy.setUpDone, Copy.locked] { XCTAssertFalse(title.hasSuffix("."), title) }
    XCTAssertEqual(Copy.setUpDone, "You’re all set")
    XCTAssertEqual(Copy.setUpFacts.last, "In the browser, each password goes only to its own website. In apps, the agent checks it’s the real app.")
    // The system prompt reads "“Opensteer Passwords” is trying to <reason>."
    for reason in [
      Copy.setUpReason, Copy.startFreshReason, Copy.showReason,
      Copy.allowReason(workspace: "Main", site: "a.com", username: "u"),
      Copy.onceReason(site: "a.com", username: "u"),
      Copy.repointReason(site: "a.com"),
    ] {
      XCTAssertFalse(reason.hasSuffix("."), reason)
      XCTAssertEqual(
        reason.first.map { String($0) }, reason.first.map { String($0).lowercased() }, reason)
    }
  }
}
