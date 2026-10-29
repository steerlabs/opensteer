import PasswordsCore
import XCTest
@testable import PasswordsBrokerKit

/// Section 18's window visit, U7, U8, U23 and the import (W11, U10–U12, U16),
/// driven through the window's model. What needs authentication, and when
/// the logins hide, is checked against the broker, not the model's flags.
@MainActor
final class WindowTests: BrokerTestCase {
  private func model() -> PasswordsWindowModel {
    PasswordsWindowModel(broker: broker, activityLog: harness.activity, runner: ImportRunner(worker: builtWorker))
  }

  /// A model whose saved logins are shown: one authentication, a live visit.
  private func shown(file: StaticString = #filePath, line: UInt = #line) async throws -> PasswordsWindowModel {
    let window = model()
    await window.showPasswords()
    guard case .shown = window.logins else {
      XCTFail("the list should be showing", file: file, line: line)
      throw TestClient.Timeout()
    }
    XCTAssertTrue(broker.loginsShown, file: file, line: line)
    return window
  }

  func testScreens() async throws {
    let window = model()
    XCTAssertEqual(window.screen, .setUp)
    XCTAssertTrue(window.development)
    await window.setUp()
    XCTAssertEqual(window.screen, .setUpDone, "then Import, Add or Done")
    XCTAssertEqual(window.logins, .shown([]), "setup opened the first visit")
    window.finishSetup()
    XCTAssertEqual(window.screen, .ready)
    XCTAssertTrue(window.agentSignIns)
    await window.setAgentSignIns(false)
    XCTAssertFalse(window.agentSignIns)
    XCTAssertEqual(broker.status?.agentSignIns, false)

    try harness.protected.delete(.ownerSigningKey)
    await window.tryAgain()
    try await harness.eventually("needs reset") { window.screen == .needsReset(.otherMac) }
    XCTAssertEqual(window.logins, .hidden)
    try harness.protected.delete(.ownerKeyPolicy)
    await window.tryAgain()
    try await harness.eventually("an older version") { window.screen == .needsReset(.olderVersion) }
    presence.next(.cancel)
    await window.startFresh()
    XCTAssertEqual(window.screen, .needsReset(.olderVersion), "cancelled: nothing deleted")
    XCTAssertNil(window.message)
    await window.startFresh()
    XCTAssertEqual(window.screen, .setUp)
  }

  func testCancelledSetupStaysOnSetUp() async throws {
    let window = model()
    presence.next(.cancel)
    await window.setUp()
    XCTAssertEqual(window.screen, .setUp)
    XCTAssertNil(window.message, "cancelling is the person's choice, not an error")
    presence.next(.fail)
    await window.setUp()
    XCTAssertEqual(window.message, Copy.notConfirmed)
  }

  /// P4, P8: one authentication shows the list; hiding it ends the visit.
  func testLoginListNeedsAuthenticationOncePerVisit() async throws {
    try await harness.ready(items: [Fixtures.login(username: "zed@example.com"), Fixtures.login("github.com", username: "sam")])
    let window = model()
    XCTAssertEqual(window.logins, .hidden)
    let before = presence.askCount
    await window.showPasswords()
    XCTAssertEqual(presence.askCount, before + 1)
    XCTAssertEqual(presence.lastReason, "show your saved passwords")
    XCTAssertEqual(window.visibleLogins.map(\.site), ["example.com", "github.com"])
    window.search = "GIT"
    XCTAssertEqual(window.visibleLogins.map(\.username), ["sam"])
    window.hidePasswords()
    XCTAssertEqual(window.logins, .hidden)
    XCTAssertEqual(window.search, "")
    XCTAssertFalse(broker.loginsShown, "Hide ends the visit in the broker")
    await window.showPasswords()
    XCTAssertEqual(presence.askCount, before + 2, "showing again asks again")
    window.hidePasswords()
    presence.next(.cancel)
    await window.showPasswords()
    XCTAssertEqual(window.logins, .hidden)
    XCTAssertNil(window.message)
    XCTAssertFalse(broker.loginsShown, "a cancelled authentication opens nothing")
  }

  /// P4: within the visit, add, a password or label edit, delete and import
  /// ask for nothing more.
  func testInVisitChangesNeedNoFurtherPrompt() async throws {
    try await harness.ready()
    let window = try await shown()
    let asked = presence.askCount
    same(
      await window.add(website: "example.com", username: "ana", password: "synthetic-1", twoFactor: "", label: ""), .saved)
    let login = try XCTUnwrap(window.visibleLogins.first)
    same(
      await window.edit(
        login, websites: "example.com", username: "ana", newPassword: "synthetic-2", twoFactor: "JBSWY3DPEHPK3PXP",
        removeTwoFactor: false, label: "Work"), .saved)
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    await flow.read(try export(), from: .other)
    await flow.importNow()
    XCTAssertEqual(flow.stage, .done(count: 1))
    await window.delete(try XCTUnwrap(window.visibleLogins.first { $0.username == "ana" }))
    XCTAssertEqual(presence.askCount, asked, "nothing asked again")
    same(try await harness.savedItems().map(\.username), ["a"])
  }

  /// P5: the visit ends with the window, a screen lock, sleep and idle time.
  func testVisitEndsOnCloseLockSleepAndIdle() async throws {
    try await restart { try BrokerHarness(windowIdleLimit: 0.4) }
    try await harness.ready(items: [Fixtures.login()])
    for (what, end) in [
      ("closing the window", { (window: PasswordsWindowModel) in window.windowClosed() }),
      ("a screen lock", { (_: PasswordsWindowModel) in self.broker.screenLocked() }),
      ("sleep", { (_: PasswordsWindowModel) in self.broker.willSleep() }),
    ] {
      let window = try await shown()
      end(window)
      XCTAssertEqual(window.logins, .hidden, what)
      XCTAssertFalse(broker.loginsShown, what)
    }
    // Idle: a window action keeps the visit; none for the limit ends it.
    let window = try await shown()
    try await Task.sleep(nanoseconds: 250_000_000)
    _ = try await broker.listLogins()
    try await Task.sleep(nanoseconds: 250_000_000)
    XCTAssertTrue(broker.loginsShown, "the action restarted the idle time")
    try await harness.eventually("idle", timeout: 2) { !broker.loginsShown }
    XCTAssertEqual(window.logins, .hidden)
    let asked = presence.askCount
    await window.showPasswords()
    XCTAssertEqual(presence.askCount, asked + 1)
  }

  /// P6: the broker refuses window actions outside a visit, whatever the
  /// window shows.
  func testBrokerRefusesWindowActionsOutsideAVisit() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let id = try unwrap(try await harness.savedItems().first).id
    let asked = presence.askCount
    let seq = try harness.headSeq()
    let attempts: [(String, () async throws -> Void)] = [
      ("list", { _ = try await self.broker.listLogins() }),
      ("add", { _ = try await self.broker.addLogin(Fixtures.login("example.org")) }),
      ("edit", {
        _ = try await self.broker.updateLogin(
          LoginEdit(
            id: id, origins: ["https://example.com"], loginURL: "https://example.com/login", username: "alice@example.com",
            password: "synthetic-x", totp: nil, label: nil))
      }),
      ("delete", { _ = try await self.broker.deleteLogin(id: id) }),
      ("import", { _ = try self.broker.beginImport() }),
    ]
    for (what, attempt) in attempts {
      do {
        try await attempt()
        XCTFail("\(what) outside a visit")
      } catch {
        XCTAssertEqual(error as? VaultServiceError, .windowLocked, what)
      }
    }
    XCTAssertEqual(presence.askCount, asked)
    XCTAssertEqual(try harness.headSeq(), seq, "nothing written")

    // A window still drawn as shown after its visit ended.
    let window = try await shown()
    let stale = PasswordsWindowModel(broker: broker, activityLog: harness.activity, runner: ImportRunner(worker: builtWorker))
    window.hidePasswords()
    same(
      await stale.add(website: "example.net", username: "x", password: "synthetic", twoFactor: "", label: ""), .stays(nil))
    XCTAssertEqual(try harness.headSeq(), seq)
  }

  /// P7, P8: a websites, login page or username change authenticates
  /// afresh, even within the visit.
  func testDestinationEditsAlwaysAuthenticate() async throws {
    try await harness.ready()
    let window = try await shown()
    _ = await window.add(website: "example.com", username: "ana", password: "synthetic-1", twoFactor: "", label: "")
    var asked = presence.askCount
    func login() throws -> LoginSummary { try XCTUnwrap(window.visibleLogins.first) }
    same(
      await window.edit(try login(), websites: "example.com", username: "ana", newPassword: "synthetic-2", twoFactor: "", removeTwoFactor: false, label: "Work"),
      .saved)
    XCTAssertEqual(presence.askCount, asked, "a password or label change rides on the visit")

    let seq = try harness.headSeq()
    presence.next(.cancel)
    same(
      await window.edit(try login(), websites: "example.com", username: "ana@example.com", newPassword: "", twoFactor: "", removeTwoFactor: false, label: "Work"),
      .stays(nil))
    XCTAssertEqual(presence.lastReason, "change the website or username saved for example.com")
    XCTAssertEqual(try harness.headSeq(), seq, "cancelled: nothing written")
    XCTAssertTrue(broker.loginsShown, "the visit is unchanged")
    asked = presence.askCount

    for (websites, username, what) in [
      ("example.com", "ana@example.com", "username"),
      ("example.com\nlogin.example.com", "ana@example.com", "websites"),
      ("login.example.com", "ana@example.com", "login page"),
    ] {
      same(
        await window.edit(try login(), websites: websites, username: username, newPassword: "", twoFactor: "", removeTwoFactor: false, label: "Work"),
        .saved, what)
      XCTAssertEqual(presence.askCount, asked + 1, what)
      asked += 1
    }
    let saved = try unwrap(try await harness.savedItems().first)
    XCTAssertEqual(saved.origins, ["https://login.example.com"])
    XCTAssertEqual(saved.loginURL, "https://login.example.com/")
    XCTAssertEqual(saved.username, "ana@example.com")
  }

  /// U7: a form error costs no authentication.
  func testInvalidFormsNeverAskForAuthentication() async throws {
    try await harness.ready()
    let window = try await shown()
    let before = presence.reasons.count
    for (website, password, twoFactor, expected) in [
      ("", "x", "", Copy.badWebsite), ("http://example.com", "x", "", Copy.badWebsite), ("127.0.0.1", "x", "", Copy.badWebsite),
      ("example.com", "", "", Copy.noPassword), ("example.com", "x", "not base32!", Copy.badTwoFactor),
      ("example.com", String(repeating: "p", count: 4_097), "", Copy.tooLong),
    ] {
      let outcome = await window.add(website: website, username: "a", password: password, twoFactor: twoFactor, label: "")
      XCTAssertEqual(outcome, .stays(expected), website)
    }
    _ = await window.add(website: "example.com", username: "a", password: "synthetic", twoFactor: "", label: "")
    let login = try XCTUnwrap(window.visibleLogins.first)
    same(
      await window.edit(login, websites: "http://example.com", username: "b", newPassword: "", twoFactor: "", removeTwoFactor: false, label: ""),
      .stays(Copy.badWebsite), "a bad destination edit asks nothing")
    XCTAssertEqual(presence.reasons.count, before, "no form error asked")
  }

  /// U8: one commit per action.
  func testAddEditDeleteAreOneCommitEach() async throws {
    try await harness.ready()
    let window = try await shown()
    var seq = try harness.headSeq()

    let added = await window.add(
      website: "https://example.com/login", username: "ana@example.com", password: "synthetic-1",
      twoFactor: "JBSWY3DPEHPK3PXP", label: "Work")
    XCTAssertEqual(added, .saved)
    XCTAssertEqual(try harness.headSeq(), seq + 1)
    seq += 1
    let login = try XCTUnwrap(window.visibleLogins.first, "the list shows the change without asking again")
    XCTAssertEqual(login.loginURL, "https://example.com/login")
    XCTAssertTrue(login.hasTOTP)

    let edited = await window.edit(
      login, websites: "example.com\nlogin.example.com", username: "ana@example.com", newPassword: "", twoFactor: "",
      removeTwoFactor: true, label: "Work")
    XCTAssertEqual(edited, .saved)
    XCTAssertEqual(try harness.headSeq(), seq + 1)
    seq += 1
    let saved = try await harness.savedItems()
    XCTAssertEqual(saved.first?.origins, ["https://example.com", "https://login.example.com"])
    XCTAssertEqual(saved.first?.password, "synthetic-1", "an empty new password keeps the saved one")
    XCTAssertNil(saved.first?.totp)
    XCTAssertEqual(window.visibleLogins.first?.hasTOTP, false)

    let unchanged = await window.edit(
      try XCTUnwrap(window.visibleLogins.first), websites: "example.com\nlogin.example.com", username: "ana@example.com",
      newPassword: "", twoFactor: "", removeTwoFactor: false, label: "Work")
    XCTAssertEqual(unchanged, .saved)
    XCTAssertEqual(try harness.headSeq(), seq, "an edit that changes nothing writes nothing")

    await window.delete(try XCTUnwrap(window.visibleLogins.first))
    XCTAssertEqual(try harness.headSeq(), seq + 1)
    XCTAssertEqual(window.logins, .shown([]))
    let remaining = try await harness.savedItems()
    XCTAssertTrue(remaining.isEmpty)
  }

  /// U23, G14: each login says which Workspaces may use it, each with Remove.
  func testLoginsShowWhereAgentsMayUseThem() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    for workspace in [Fixtures.workspace, Fixtures.otherWorkspace] {
      let id = UUID().uuidString.lowercased()
      let account = try unwrap(try await request(desktop, id, workspace: workspace)["accounts"]?[0])
      _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
      _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    }
    let window = try await shown()
    let login = try XCTUnwrap(window.visibleLogins.first)
    XCTAssertEqual(login.grants.map(\.workspaceName), ["Main", "Side projects"])
    XCTAssertEqual(Copy.allowedIn("Main", site: nil), "Allowed for agents in: Main")
    XCTAssertEqual(Copy.allowedIn("Main", site: "example.org"), "Allowed for agents in: Main, on example.org")
    let asked = presence.askCount
    await window.removeGrant(try XCTUnwrap(login.grants.first))
    XCTAssertEqual(window.visibleLogins.first?.grants.map(\.workspaceName), ["Side projects"], "the list follows at once")
    XCTAssertEqual(presence.askCount, asked, "Remove asks nothing")
    XCTAssertEqual(try harness.savedGrants().map(\.workspaceName), ["Side projects"])
  }

  /// W11: the visit covers the preview and the import's one commit.
  func testImportIsOneCommitInTheVisit() async throws {
    try await harness.ready(items: [Fixtures.login(username: "alice", password: "synthetic-same")])
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    XCTAssertEqual(window.sheet, .importing)
    flow.choose(.other)
    XCTAssertEqual(flow.stage, .steps(.other))
    let export = harness.directory.appendingPathComponent("export.csv")
    let csv = """
      url,username,password
      https://example.com,alice,synthetic-same
      https://example.org,bob,synthetic-bob
      https://example.net,carol,synthetic-carol
      http://plain.example,dave,synthetic-dave
      https://example.org,erin,
      """
    try Data(csv.utf8).write(to: export)
    let seq = try harness.headSeq()
    let asked = presence.reasons.count

    await flow.read(export, from: .other)
    guard case .preview(_, let preview) = flow.stage else { return XCTFail("\(flow.stage)") }
    XCTAssertEqual(preview.new, 2)
    XCTAssertEqual(preview.updates, 0)
    XCTAssertEqual(preview.alreadySaved, 1)
    XCTAssertEqual(preview.skipped, [
      ImportPreview.SkippedRow(row: 5, reason: "not an https website"), ImportPreview.SkippedRow(row: 6, reason: "no password"),
    ])
    XCTAssertEqual(Copy.importCounts(new: 2, updates: 0, already: 1, skipped: 2), "2 new · 1 already saved · 2 skipped")
    XCTAssertEqual(Copy.importCounts(new: 0, updates: 1, already: 0, skipped: 0), "1 update")
    XCTAssertEqual(try harness.headSeq(), seq, "nothing is written before Import")

    await flow.importNow()
    XCTAssertEqual(flow.stage, .done(count: 2))
    XCTAssertEqual(presence.reasons.count, asked, "the visit covered the preview and the import")
    XCTAssertEqual(try harness.headSeq(), seq + 1, "one commit")
    let usernames = try await harness.savedItems().map(\.username).sorted()
    XCTAssertEqual(usernames, ["alice", "bob", "carol"])

    flow.moveFileToTrash()
    XCTAssertFalse(FileManager.default.fileExists(atPath: export.path))
    XCTAssertNil(window.importFlow)
    try await harness.eventually("the list read again") { window.visibleLogins.count == 3 }
  }

  func testImportReportsConflictsPlainly() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    let export = harness.directory.appendingPathComponent("seeds.csv")
    try Data(
      """
      url,username,password,totp
      https://example.com,alice,synthetic,JBSWY3DPEHPK3PXP
      https://example.com,alice,synthetic,GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
      """.utf8
    ).write(to: export)
    await flow.read(export, from: .other)
    guard case .preview(_, let preview) = flow.stage else { return XCTFail("\(flow.stage)") }
    XCTAssertEqual(preview.importCount, 0)
    XCTAssertEqual(preview.skipped.map(\.reason), [ImportText.conflictInFile, ImportText.conflictInFile])
    flow.close()
    try await harness.eventually("the prepared import is dropped") { window.importFlow == nil }
  }

  func testScreenLockDropsAPreparedImport() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    let export = harness.directory.appendingPathComponent("export.csv")
    try Data("url,username,password\nhttps://example.com,a,synthetic\n".utf8).write(to: export)
    await flow.read(export, from: .chrome)
    guard case .preview = flow.stage else { return XCTFail("\(flow.stage)") }
    let id = try XCTUnwrap(flow.importID)
    let seq = try harness.headSeq()
    broker.screenLocked()
    XCTAssertNil(window.importFlow, "the sheet closes with the visit")
    XCTAssertEqual(window.logins, .hidden)
    await assertEnded(id, seq: seq)
  }

  /// U11: quitting ends the import before the process does.
  func testStopEndsTheImport() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    await flow.read(try export(), from: .other)
    guard case .preview = flow.stage else { return XCTFail("\(flow.stage)") }
    let id = try XCTUnwrap(flow.importID)
    let seq = try harness.headSeq()
    broker.stop()
    await assertEnded(id, seq: seq)
  }

  /// Import `id` cannot be committed, nothing was written, and the vault it unlocked is dropped.
  private func assertEnded(_ id: ImportID, seq: Int64, file: StaticString = #filePath, line: UInt = #line) async {
    do {
      _ = try await broker.commitImport(id)
      XCTFail("an ended import cannot be committed", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? VaultServiceError, .noImport, file: file, line: line)
    }
    XCTAssertEqual(try? harness.headSeq(), seq, "nothing was written", file: file, line: line)
    let holds = await harness.vault.holdsImport
    XCTAssertFalse(holds, "the vault unlocked for it is dropped", file: file, line: line)
  }

  private func export(_ name: String = "export.csv") throws -> URL {
    let url = harness.directory.appendingPathComponent(name)
    try Data("url,username,password\nhttps://example.com,a,synthetic-import\n".utf8).write(to: url)
    return url
  }

  /// U11: closing the window ends the import, whatever the sheet showed.
  func testClosingTheWindowEndsTheImport() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    await flow.read(try export(), from: .other)
    guard case .preview = flow.stage else { return XCTFail("\(flow.stage)") }
    let id = try XCTUnwrap(flow.importID)
    let holds = await harness.vault.holdsImport
    XCTAssertTrue(holds)
    let seq = try harness.headSeq()
    window.windowClosed()
    XCTAssertNil(window.importFlow)
    XCTAssertFalse(broker.loginsShown)
    await assertEnded(id, seq: seq)
  }

  /// U12: a file read that finishes after the window closed does not bring the import back.
  func testLateCompletionsDoNotReopenAnImport() async throws {
    try await harness.ready()
    let slow = harness.directory.appendingPathComponent("slow-worker")
    try Data("#!/bin/sh\n/bin/sleep 0.5\nexec '\(builtWorker.path)'\n".utf8).write(to: slow)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: slow.path)
    let window = PasswordsWindowModel(broker: broker, activityLog: harness.activity, runner: ImportRunner(worker: slow))
    await window.showPasswords()
    window.startImport()
    let reading = try XCTUnwrap(window.importFlow)
    let asked = presence.reasons.count
    let first = try export()
    let parse = Task { await reading.read(first, from: .other) }
    try await harness.eventually("reading") { reading.stage == .reading(.other) }
    let parsing = try XCTUnwrap(reading.importID)
    window.windowClosed()
    await parse.value
    XCTAssertEqual(presence.reasons.count, asked, "nothing asked for an import that was closed")
    await assertEnded(parsing, seq: try harness.headSeq())
  }

  /// U16: a named pipe in place of the export is refused at once, not waited on.
  func testNamedPipeExportIsRefusedAtOnce() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    let pipe = harness.directory.appendingPathComponent("export.csv")
    XCTAssertEqual(mkfifo(pipe.path, 0o600), 0)
    let started = Date()
    await flow.read(pipe, from: .other)
    XCTAssertLessThan(Date().timeIntervalSince(started), 1, "nothing waited for a writer")
    XCTAssertEqual(flow.stage, .failed(.other, Copy.couldNotRead))
  }

  /// I24 in the preview: web addresses Bitwarden never fills are left out and listed.
  func testImportListsLeftOutAddresses() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    let export = harness.directory.appendingPathComponent("bitwarden.json")
    try Data(
      #"{"encrypted":false,"items":[{"type":1,"name":"Work","login":{"uris":[{"match":null,"uri":"https://work.example.com"},{"match":5,"uri":"https://kiosk.example.org"}],"username":"a","password":"synthetic","totp":null}}]}"#
        .utf8
    ).write(to: export)
    await flow.read(export, from: .bitwarden)
    guard case .preview(_, let preview) = flow.stage else { return XCTFail("\(flow.stage)") }
    XCTAssertEqual(preview.new, 1)
    XCTAssertEqual(preview.leftOut, [ImportPreview.SkippedRow(row: 1, reason: "Bitwarden is set never to fill it there")])
    XCTAssertEqual(Copy.leftOutAddress(1, "Bitwarden is set never to fill it there"), "Row 1, one web address: Bitwarden is set never to fill it there")
    flow.close()
  }

  func testUnreadableExportsSaySo() async throws {
    try await harness.ready()
    let window = try await shown()
    window.startImport()
    let flow = try XCTUnwrap(window.importFlow)
    let export = harness.directory.appendingPathComponent("encrypted.json")
    try Data(contentsOf: coreFixtures.appendingPathComponent("bitwarden-encrypted.json")).write(to: export)
    let asked = presence.reasons.count
    await flow.read(export, from: .bitwarden)
    XCTAssertEqual(flow.stage, .failed(.bitwarden, "Export from Bitwarden without a password, then import."))
    XCTAssertEqual(presence.reasons.count, asked, "a file that cannot be read asks nothing")
  }
}
