@preconcurrency import Contacts
import Foundation

public enum ContactsStore {
  private static func keys() -> [any CNKeyDescriptor] {
    [
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactPhoneNumbersKey as CNKeyDescriptor,
      CNContactBirthdayKey as CNKeyDescriptor,
    ]
  }

  /// Every contact, in the order the person sorts them in Contacts. A read
  /// that outlives its request stops rather than answering nobody.
  public static func records(budget: WorkBudget, deviceName: String = "Mac") throws -> [ContactRecord] {
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

  static func record(_ contact: CNContact) -> ContactRecord {
    let name = CNContactFormatter.string(from: contact, style: .fullName)
    return ContactRecord(
      id: contact.identifier,
      name: name?.isEmpty == false
        ? name : (contact.organizationName.isEmpty ? nil : contact.organizationName),
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
