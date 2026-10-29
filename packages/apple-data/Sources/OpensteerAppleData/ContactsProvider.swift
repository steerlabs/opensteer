@preconcurrency import Contacts
import Foundation

/// Contacts on this device, read through the Contacts framework under the grant
/// this process holds. Everything but the read itself — which contacts match,
/// how they page, what each looks like — is `ContactsSearch`, which needs no
/// grant to be held to its rules.
public actor ContactsProvider: DataProvider {
  private let deviceName: String
  private static func keys() -> [any CNKeyDescriptor] {
    [
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactPhoneNumbersKey as CNKeyDescriptor,
      CNContactBirthdayKey as CNKeyDescriptor,
    ]
  }

  public init(deviceName: String = "Mac") { self.deviceName = deviceName }

  public func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    guard operation == "search_contacts" else {
      throw HelperError(.unsupported, "This operation is not supported.")
    }
    let parsed = try DataArguments.decode(ContactsSearchArguments.self, from: arguments)
    let page = try ContactsSearch.page(try records(budget: budget), arguments: parsed)
    return try JSONValue(encoding: page)
  }

  /// Every contact, in the order the person sorts them in Contacts. A read
  /// that outlives its request stops rather than answering nobody.
  private func records(budget: WorkBudget) throws -> [ContactRecord] {
    guard budget.remaining() > 0 else { throw Self.outOfTime }
    let request = CNContactFetchRequest(keysToFetch: Self.keys())
    request.sortOrder = .userDefault
    var records: [ContactRecord] = []
    var expired = false
    do {
      try CNContactStore().enumerateContacts(with: request) { contact, stop in
        if records.count % 256 == 0 && budget.remaining() <= 0 {
          expired = true
          stop.pointee = true
          return
        }
        records.append(Self.record(contact))
      }
    } catch {
      throw HelperError(.failed, "Contacts could not be read on this \(deviceName).")
    }
    if expired { throw Self.outOfTime }
    return records
  }

  private static let outOfTime = HelperError(
    .failed, "Contacts took too long to read; try again with a narrower search.")

  private static func record(_ contact: CNContact) -> ContactRecord {
    let name = CNContactFormatter.string(from: contact, style: .fullName)
    return ContactRecord(
      id: contact.identifier,
      name: name?.isEmpty == false ? name : nil,
      organization: contact.organizationName.isEmpty ? nil : contact.organizationName,
      emails: contact.emailAddresses.map {
        LabeledText(label: label($0.label), value: $0.value as String)
      },
      phones: contact.phoneNumbers.map {
        LabeledText(label: label($0.label), value: $0.value.stringValue)
      },
      birthday: contact.birthday
    )
  }

  /// The label as the person reads it in Contacts: `mobile` rather than
  /// `_$!<Mobile>!$_`; null for an entry nobody labeled.
  private static func label(_ raw: String?) -> String? {
    guard let raw, !raw.isEmpty else { return nil }
    return CNLabeledValue<NSString>.localizedString(forLabel: raw)
  }
}
