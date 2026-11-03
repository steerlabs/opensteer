import Contacts
import XCTest
@testable import OpensteerAppleData

final class ContactsStoreTests: XCTestCase {
  func testFormattedNamesFallBackToOrganizationForBusinessContacts() {
    let contact = CNMutableContact()
    contact.organizationName = "Local Business"
    contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: "office@example.com" as NSString)]
    contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMain,
      value: CNPhoneNumber(stringValue: "(555) 123-4567"))]
    let business = ContactsStore.record(contact)
    XCTAssertEqual(business.name, "Local Business")
    XCTAssertEqual(business.emails.first?.value, "office@example.com")
    XCTAssertEqual(business.phones.first?.value, "(555) 123-4567")
    contact.givenName = "Mayank"
    contact.familyName = "Patel"
    XCTAssertEqual(ContactsStore.record(contact).name, "Mayank Patel")
  }

  func testExpiredBudgetStopsBeforeOpeningContacts() {
    XCTAssertThrowsError(try ContactsStore.records(
      budget: WorkBudget(requestEnd: .distantPast)))
  }
}
