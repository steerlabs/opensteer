import XCTest
@testable import PasswordsCore

final class ImportPlanTests: XCTestCase {
  private let totp = try! TOTPParameters(parsing: "JBSWY3DPEHPK3PXP")

  private func candidate(_ row: Int, _ origins: [String], _ username: String, _ password: String, totp: TOTPParameters? = nil) -> ImportCandidate {
    ImportCandidate(origins: origins, loginURL: origins[0] + "/", username: username, password: password, totp: totp, label: nil, sourceRow: row)
  }

  private func item(_ id: String, _ origins: [String], _ username: String, _ password: String, totp: TOTPParameters? = nil) -> Item {
    Item(id: id, draft: ItemDraft(origins: origins, loginURL: origins[0] + "/", username: username, password: password, totp: totp), createdAt: 1, updatedAt: 1, revision: 1)
  }

  private let x = "00000000-0000-4000-8000-00000000000a"
  private let y = "00000000-0000-4000-8000-00000000000b"
  private let z = "00000000-0000-4000-8000-00000000000c"
  private let w = "00000000-0000-4000-8000-00000000000d"
  private let v = "00000000-0000-4000-8000-00000000000e"

  private func makePlan() throws -> ImportPlan {
    let existing = [
      item(x, ["https://example.com"], "alice", "pw1"),
      item(y, ["https://example.org"], "bob", "pw2", totp: totp),
      item(z, ["https://nfd.example.com"], "erin", "p\u{E4}ss"),
      item(w, ["https://example.net"], "frank", "z"),
      item(v, ["https://totp.example.com"], "gina", "pw"),
    ]
    let candidates = [
      candidate(2, ["https://example.com"], "alice", "pw1"),
      candidate(3, ["https://example.org"], "bob", "pw-new"),
      candidate(4, ["https://new.example.com"], "carol", "p"),
      candidate(5, ["https://new.example.com"], "carol", "p"),
      candidate(6, ["https://conflict.example.com"], "dave", "a"),
      candidate(7, ["https://conflict.example.com"], "dave", "b"),
      candidate(9, ["https://nfd.example.com"], "erin", "pa\u{0308}ss"),
      candidate(10, ["https://example.com"], "Alice", "pw1"),
      candidate(11, ["https://www.example.com", "https://example.com"], "alice", "pw1"),
      candidate(12, ["https://example.net"], "frank", "x"),
      candidate(13, ["https://example.net"], "frank", "y"),
      candidate(14, ["https://totp.example.com"], "gina", "pw", totp: totp),
      candidate(15, ["https://example.com"], " alice", "pw1"),
    ]
    return try ImportPlan(candidates: candidates, existing: existing)
  }

  private func classification(_ plan: ImportPlan, row: Int) -> ImportPlan.Classification? {
    plan.entries.first { $0.candidate.sourceRow == row }?.classification
  }

  func testExactDuplicatesAreSkippedEvenInConflictingGroups() throws {
    let plan = try ImportPlan(candidates: [
      candidate(1, ["https://example.com"], "alice", "saved"),
      candidate(2, ["https://example.com"], "alice", "new"),
      candidate(3, ["https://example.com"], "alice", "new"),
    ], existing: [item(x, ["https://example.com"], "alice", "saved")])
    XCTAssertEqual(classification(plan, row: 1), .duplicate(of: .item(x)))
    XCTAssertEqual(classification(plan, row: 3), .duplicate(of: .sourceRow(2)))
    XCTAssertEqual(try plan.changes(selecting: [1, 2, 3]).replace.count, 1)
  }

  func testClassifications() throws {
    let plan = try makePlan()
    XCTAssertEqual(plan.entries.count, 13)
    XCTAssertEqual(classification(plan, row: 2), .duplicate(of: .item(x)))
    XCTAssertEqual(classification(plan, row: 3), .update(itemID: y))
    XCTAssertEqual(classification(plan, row: 4), .new)
    XCTAssertEqual(classification(plan, row: 5), .duplicate(of: .sourceRow(4)))
    XCTAssertEqual(classification(plan, row: 6), .conflict(existingItemID: nil))
    XCTAssertEqual(classification(plan, row: 7), .conflict(existingItemID: nil))
    XCTAssertEqual(classification(plan, row: 9), .update(itemID: z), "NFD and NFC passwords differ")
    XCTAssertEqual(classification(plan, row: 12), .conflict(existingItemID: w))
    XCTAssertEqual(classification(plan, row: 13), .conflict(existingItemID: w))
    XCTAssertEqual(classification(plan, row: 14), .update(itemID: v), "a new TOTP is an update")
  }

  func testUpdateNeedsSameOriginSetAndUsername() throws {
    let plan = try makePlan()
    XCTAssertEqual(classification(plan, row: 10), .new, "usernames compare as exact bytes")
    XCTAssertEqual(classification(plan, row: 11), .new, "a different origin set is a different login")
    XCTAssertEqual(classification(plan, row: 15), .new)
    let reordered = try ImportPlan(
      candidates: [candidate(2, ["https://b.example.com", "https://a.example.com"], "u", "new")],
      existing: [item(x, ["https://a.example.com", "https://b.example.com"], "u", "old")])
    XCTAssertEqual(reordered.entries.first?.classification, .update(itemID: x), "origin order does not matter")
  }

  func testConflictingRowsStayVisible() throws {
    let plan = try makePlan()
    let conflict = plan.entries.filter { [6, 7].contains($0.candidate.sourceRow) }
    XCTAssertEqual(conflict.count, 2)
    XCTAssertEqual(conflict[0].group, conflict[1].group)
  }

  /// I21: a row is a duplicate only when it would add nothing, its
  /// two-factor seed included.
  func testDifferentTOTPSeedsConflict() throws {
    let other = try TOTPParameters(parsing: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    let plan = try ImportPlan(
      candidates: [
        candidate(2, ["https://example.com"], "alice", "SYNTHETIC", totp: totp),
        candidate(3, ["https://example.com"], "alice", "SYNTHETIC", totp: other),
      ],
      existing: [])
    XCTAssertEqual(plan.entries.map(\.classification), [.conflict(existingItemID: nil), .conflict(existingItemID: nil)])
    XCTAssertEqual(try plan.changes(selecting: [3]).add.map(\.totp), [other], "the second seed can be chosen")
    XCTAssertThrowsError(try plan.changes(selecting: [2, 3])) {
      XCTAssertEqual($0 as? ImportPlan.PlanError, .conflictingSelection(rows: [2, 3]))
    }

    let existing = try ImportPlan(
      candidates: [candidate(2, ["https://example.com"], "alice", "SYNTHETIC", totp: other)],
      existing: [item(x, ["https://example.com"], "alice", "SYNTHETIC", totp: totp)])
    XCTAssertEqual(existing.entries.first?.classification, .update(itemID: x), "another seed for a saved login is an update")
  }

  /// A row without a seed adds nothing to an identical row, or saved login, that has one.
  func testMissingSeedAddsNothing() throws {
    let rows = try ImportPlan(
      candidates: [
        candidate(2, ["https://example.com"], "alice", "SYNTHETIC"),
        candidate(3, ["https://example.com"], "alice", "SYNTHETIC", totp: totp),
      ],
      existing: [])
    XCTAssertEqual(rows.entries.map(\.classification), [.duplicate(of: .sourceRow(3)), .new])
    let saved = try ImportPlan(
      candidates: [candidate(2, ["https://example.com"], "alice", "SYNTHETIC")],
      existing: [item(x, ["https://example.com"], "alice", "SYNTHETIC", totp: totp)])
    XCTAssertEqual(saved.entries.first?.classification, .duplicate(of: .item(x)))
    let seedOnly = try ImportPlan(
      candidates: [candidate(2, ["https://example.com"], "alice", "SYNTHETIC", totp: totp)],
      existing: [item(x, ["https://example.com"], "alice", "SYNTHETIC")])
    XCTAssertEqual(seedOnly.entries.first?.classification, .update(itemID: x), "a seed for a saved login without one")
  }

  func testChanges() throws {
    let plan = try makePlan()
    let changes = try plan.changes(selecting: [2, 3, 4, 5, 6, 9, 12, 14])
    XCTAssertEqual(changes.add.map(\.origins), [["https://new.example.com"], ["https://conflict.example.com"]])
    XCTAssertTrue(changes.update.isEmpty, "updates are intents, resolved against the item at commit")
    XCTAssertEqual(changes.replace.map(\.itemID), [y, z, w, v])
    let updatedY = try XCTUnwrap(changes.replace.first { $0.itemID == y })
    XCTAssertEqual(updatedY.password, "pw-new")
    XCTAssertNil(updatedY.totp, "an update without a TOTP keeps the saved one")
    let updatedZ = try XCTUnwrap(changes.replace.first { $0.itemID == z })
    XCTAssertTrue(try XCTUnwrap(updatedZ.password).utf8.elementsEqual("pa\u{0308}ss".utf8))
    XCTAssertEqual(try XCTUnwrap(changes.replace.first { $0.itemID == v }).totp, totp)
    XCTAssertTrue(changes.delete.isEmpty)

    XCTAssertThrowsError(try plan.changes(selecting: [6, 7])) {
      XCTAssertEqual($0 as? ImportPlan.PlanError, .conflictingSelection(rows: [6, 7]))
    }
    XCTAssertTrue(try plan.changes(selecting: [2, 5]).add.isEmpty, "duplicates add nothing")
  }

  /// I25: the plan lives while the person reviews the preview, so it keeps
  /// saved items' IDs, never their passwords or two-factor seeds; a commit
  /// applies the new password to the item as it is then. (Second review,
  /// finding 7.)
  func testPlanKeepsNoSavedSecrets() throws {
    let fixture = try VaultFixture(items: [draft("example.com", username: "alice", password: "SYNTHETIC-SAVED", totp: totp, label: "Saved label")])
    let row = candidate(2, ["https://example.com"], "alice", "SYNTHETIC-NEW")
    let plan = try fixture.withUnlocked { try ImportPlan(candidates: [row], existing: try $0.items()) }
    let dump = String(reflecting: plan)
    XCTAssertFalse(dump.contains("SYNTHETIC-SAVED"), "the saved password is not in the plan")
    XCTAssertFalse(dump.contains("JBSWY3DP") || dump.contains("Saved label"))
    try fixture.withUnlocked { _ = try $0.commit(try plan.changes(selecting: [2])) }
    let saved = try XCTUnwrap(try fixture.items().first)
    XCTAssertEqual(saved.password, "SYNTHETIC-NEW")
    XCTAssertEqual(saved.totp, totp, "the saved seed is kept, read at commit")
    XCTAssertEqual(saved.label, "Saved label")
    XCTAssertEqual(saved.revision, 2)
  }

  /// I26: rows are told apart by `sourceRow`, so two candidates sharing one
  /// would let a selected row carry a second, unseen login. (Second review,
  /// finding 8.)
  func testDuplicateSourceRowsRefused() {
    let shown = candidate(5, ["https://bank.example.com"], "alice", "pw")
    let hidden = candidate(5, ["https://attacker.example"], "alice", "pw")
    XCTAssertThrowsError(try ImportPlan(candidates: [shown, hidden], existing: [])) {
      XCTAssertEqual($0 as? ImportPlan.PlanError, .duplicateSourceRow(5))
    }
  }
}
