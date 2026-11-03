import Foundation

struct MessagesContacts: Sendable {
  private var emails: [String: Set<String>] = [:]
  private var phones: [String: Set<String>] = [:]

  init(_ records: [ContactRecord]) {
    for record in records {
      guard let name = DataText.present(record.name) ?? DataText.present(record.organization) else { continue }
      for email in record.emails {
        emails[email.value.lowercased(), default: []].insert(name)
      }
      for phone in record.phones {
        if let key = Self.phoneKey(phone.value) { phones[key, default: []].insert(name) }
      }
    }
  }

  func name(for handle: String) -> String? {
    let names: Set<String>?
    if handle.contains("@") {
      names = emails[handle.lowercased()]
    } else if handle.unicodeScalars.allSatisfy(Self.phoneCharacters.contains),
      let key = Self.phoneKey(handle)
    {
      names = phones[key]
    } else {
      names = nil
    }
    return names?.count == 1 ? names?.first : nil
  }

  private static let phoneCharacters = CharacterSet(charactersIn: "0123456789+-(). ")

  private static func phoneKey(_ value: String) -> String? {
    let digits = ContactsSearch.onlyDigits(value)
    guard !digits.isEmpty else { return nil }
    return String(digits.suffix(9))
  }
}
