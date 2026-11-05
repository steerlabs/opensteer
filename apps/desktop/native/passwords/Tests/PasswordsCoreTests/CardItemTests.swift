import XCTest
@testable import PasswordsCore

final class CardItemTests: XCTestCase {
  func card() -> CardDraft { CardDraft(number: "4242424242424242", expiryMonth: 1, expiryYear: 2000, cvc: "123") }

  func testWriteValidationAndStructuralRead() throws {
    let valid = card()
    XCTAssertNoThrow(try valid.validate())
    for number in ["4242424242424241", "4242 424242424242", "４２４２４２４２４２４２", String(repeating: "4", count: 20)] {
      var draft = valid
      draft.number = number
      XCTAssertThrowsError(try draft.validate())
    }
    for cvc in ["12", "12345", "1a3"] {
      var draft = valid; draft.cvc = cvc
      XCTAssertThrowsError(try draft.validate())
    }
    for month in [0, 13] {
      var draft = valid; draft.expiryMonth = Int64(month)
      XCTAssertThrowsError(try draft.validate())
    }
    for year in [999, 10000] {
      var draft = valid; draft.expiryYear = Int64(year)
      XCTAssertThrowsError(try draft.validate())
    }
    for field in ["name", "label", "postal"] {
      var draft = valid
      if field == "name" { draft.name = String(repeating: "é", count: 101) }
      if field == "label" { draft.label = String(repeating: "x", count: 201) }
      if field == "postal" { draft.postalCode = String(repeating: "é", count: 17) }
      XCTAssertThrowsError(try draft.validate())
    }
    var invalid = valid
    invalid.number = "4242424242424241"
    let saved = CardItem(id: "00000000-0000-4000-8000-000000000001", draft: invalid, createdAt: 0, updatedAt: 0, revision: 8)
    XCTAssertNoThrow(try CardItem(json: saved.json, revision: 8))
    guard case .object(var fields) = saved.json else { return XCTFail() }
    fields["extra"] = .null
    XCTAssertThrowsError(try CardItem(json: .object(fields), revision: 8))
  }

  func testTypedAccessRevisionsAndGrants() throws {
    let fixture = try VaultFixture(items: [draft()])
    let id = try fixture.withUnlocked { try $0.commit(VaultChanges(addCards: [card()])).added[0] }
    try fixture.withUnlocked { vault in
      XCTAssertEqual(try vault.items().count, 1)
      XCTAssertEqual(try vault.items(withinSite: "https://example.com").count, 1)
      XCTAssertThrowsError(try vault.item(id: id))
      let saved = try vault.card(id: id)
      XCTAssertEqual(saved.brand, "Visa")
      XCTAssertEqual(saved.lastFour, "4242")
      XCTAssertThrowsError(try vault.commit(VaultChanges(updateCards: [saved])))
      var edited = saved
      edited.draft.label = "New label"
      _ = try vault.commit(VaultChanges(updateCards: [edited]))
      XCTAssertEqual(try vault.card(id: id).revision, 2)
    }
    try fixture.withUnlocked { vault in
      let change = GrantChange(key: GrantKey(deploymentId: "d", workspaceId: "w", site: "https://example.com"),
        login: .saved(id: id), deploymentName: "D", workspaceName: "W")
      XCTAssertThrowsError(try vault.commit(VaultChanges(grant: [change])))
      XCTAssertTrue(vault.grants.isEmpty)
    }
  }

  func testCardCap() throws {
    let fixture = try VaultFixture()
    try fixture.withUnlocked { vault in
      _ = try vault.commit(VaultChanges(addCards: Array(repeating: card(), count: 100)))
      XCTAssertThrowsError(try vault.commit(VaultChanges(addCards: [card()])))
      XCTAssertEqual(try vault.cards().count, 100)
    }
  }
}
