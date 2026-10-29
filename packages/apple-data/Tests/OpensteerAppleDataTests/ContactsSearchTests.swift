@testable import OpensteerAppleData
import XCTest

/// What `search_contacts` answers, from records rather than the Contacts
/// framework: finding, paging and writing contacts needs no macOS grant, so
/// every rule is held here and only the store read is left to a person's Mac.
final class ContactsSearchTests: XCTestCase {
  private let records: [ContactRecord] = [
    ContactRecord(
      id: "c-ada", name: "Ada Lovelace", organization: "Analytical Engines",
      emails: [LabeledText(label: "work", value: "ada@engines.example")],
      phones: [LabeledText(label: "mobile", value: "+1 (555) 123-4567")],
      birthday: DateComponents(year: 1815, month: 12, day: 10)),
    ContactRecord(
      id: "c-jose", name: "José Núñez", organization: nil,
      emails: [LabeledText(label: nil, value: "Jose@Example.org")],
      phones: [], birthday: DateComponents(month: 4, day: 5)),
    ContactRecord(
      id: "c-acme", name: nil, organization: "Acme Plumbing", emails: [],
      phones: [LabeledText(label: "work", value: "020 7946 0018")], birthday: nil),
  ]

  private func search(
    query: String? = nil, cursor: String? = nil, limit: Int? = nil,
    in records: [ContactRecord]? = nil
  ) throws -> ContactsPage {
    try ContactsSearch.page(
      records ?? self.records,
      arguments: ContactsSearchArguments(cursor: cursor, limit: limit, query: query))
  }

  func testWithoutAQueryEveryContactIsListedInTheMacsOrder() throws {
    let page = try search()
    XCTAssertEqual(page.contacts.map(\.id), ["c-ada", "c-jose", "c-acme"])
    XCTAssertNil(page.nextCursor)
  }

  func testANameMatchesWhateverItsCaseAndAccents() throws {
    XCTAssertEqual(try search(query: "jose nunez").contacts.map(\.id), ["c-jose"])
    XCTAssertEqual(try search(query: "LOVELACE").contacts.map(\.id), ["c-ada"])
  }

  func testAnOrganizationAndAnEmailAddressMatch() throws {
    XCTAssertEqual(try search(query: "plumbing").contacts.map(\.id), ["c-acme"])
    XCTAssertEqual(try search(query: "jose@example.org").contacts.map(\.id), ["c-jose"])
  }

  func testAPhoneNumberMatchesByItsDigitsHoweverEitherSideIsWritten() throws {
    XCTAssertEqual(try search(query: "555-123-4567").contacts.map(\.id), ["c-ada"])
    XCTAssertEqual(try search(query: "+15551234567").contacts.map(\.id), ["c-ada"])
    XCTAssertEqual(try search(query: "7946 0018").contacts.map(\.id), ["c-acme"])
    // Two digits say nothing about a phone number; they are text.
    XCTAssertEqual(try search(query: "55").contacts.map(\.id), [])
  }

  func testNothingMatchingIsAnEmptyPageNotAnError() throws {
    let page = try search(query: "nobody at all")
    XCTAssertEqual(page.contacts, [])
    XCTAssertNil(page.nextCursor)
  }

  func testPagesOnACursorWithoutRepeatingOrDroppingAContact() throws {
    let many = (0..<7).map { index in
      ContactRecord(
        id: "c-\(index)", name: "Person \(index)", organization: nil, emails: [], phones: [],
        birthday: nil)
    }
    var seen: [String] = []
    var cursor: String?
    repeat {
      let page = try search(cursor: cursor, limit: 3, in: many)
      XCTAssertLessThanOrEqual(page.contacts.count, 3)
      seen += page.contacts.map(\.id)
      cursor = page.nextCursor
    } while cursor != nil
    XCTAssertEqual(seen, many.map(\.id))
  }

  func testACursorIsValidOnlyForTheSearchThatIssuedIt() throws {
    let first = try search(query: "a", limit: 1)
    let cursor = try XCTUnwrap(first.nextCursor)
    XCTAssertThrowsError(try search(query: "b", cursor: cursor, limit: 1)) { error in
      XCTAssertEqual((error as? HelperError)?.code, .failed)
    }
    for forged in ["not a cursor", "\(cursor)0.1", "\(cursor).", "\(cursor)x"] {
      XCTAssertThrowsError(try search(query: "a", cursor: forged)) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
    // Contacts deleted since the cursor was issued end the search, not fail it.
    let ended = try search(query: "a", cursor: cursor, in: Array(records.prefix(1)))
    XCTAssertEqual(ended.contacts.map(\.id), [])
    XCTAssertNil(ended.nextCursor)
  }

  func testALimitOutsideItsRangeIsRefused() throws {
    for limit in [0, 101] {
      XCTAssertThrowsError(try search(limit: limit)) { error in
        XCTAssertEqual((error as? HelperError)?.code, .failed)
      }
    }
    XCTAssertEqual(try search(limit: 1).contacts.count, 1)
  }

  func testWritesEachContactInTheCatalogsShape() throws {
    let page = try search()
    XCTAssertEqual(
      page.contacts.first,
      ContactView(
        birthday: "1815-12-10", emails: [LabeledText(label: "work", value: "ada@engines.example")],
        id: "c-ada", name: "Ada Lovelace", organization: "Analytical Engines",
        phones: [LabeledText(label: "mobile", value: "+1 (555) 123-4567")]))
    // A birthday without a year keeps the day and month it has.
    XCTAssertEqual(page.contacts[1].birthday, "--04-05")
    // A business card has no name, and says so rather than inventing one.
    XCTAssertNil(page.contacts[2].name)
  }

  func testKeepsOneContactWithinItsBudget() throws {
    let long = String(repeating: "x", count: 5_000)
    let crowded = ContactRecord(
      id: "c-long", name: long, organization: long,
      emails: (0..<40).map { LabeledText(label: long, value: "\($0)\(long)@example.org") },
      phones: (0..<40).map { LabeledText(label: nil, value: "\($0)") }, birthday: nil)
    let view = try XCTUnwrap(try search(in: [crowded]).contacts.first)
    XCTAssertLessThanOrEqual(view.name?.count ?? 0, ContactsSearch.maxTextLength)
    XCTAssertLessThanOrEqual(view.organization?.count ?? 0, ContactsSearch.maxTextLength)
    XCTAssertEqual(view.emails.count, ContactsSearch.maxEntries)
    XCTAssertEqual(view.phones.count, ContactsSearch.maxEntries)
    XCTAssertTrue(view.emails.allSatisfy { $0.value.count <= ContactsSearch.maxTextLength })
    XCTAssertTrue(view.emails.allSatisfy { ($0.label?.count ?? 0) <= ContactsSearch.maxTextLength })
  }
}
