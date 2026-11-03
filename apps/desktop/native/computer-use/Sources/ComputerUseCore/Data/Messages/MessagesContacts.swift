import Foundation

/// The name Messages would show for a handle, from this Mac's Contacts.
/// Phones match on their last nine digits, so a number saved with or without
/// its country or trunk prefix is the same number; when that leaves more than
/// one person, the handle gets no name rather than a guess.
struct MessagesContacts: Sendable {
  /// A person is their name, or their own record when they have none: the
  /// same person saved twice is one name, and a nameless contact is still
  /// someone else.
  private enum Person: Hashable {
    case named(String)
    case unnamed(String)
  }

  private var emails: [String: Set<Person>] = [:]
  private var phones: [String: Set<Person>] = [:]

  init(_ records: [ContactRecord]) {
    for record in records {
      let person = (DataText.present(record.name) ?? DataText.present(record.organization))
        .map(Person.named) ?? .unnamed(record.id)
      for email in record.emails {
        emails[email.value.lowercased(), default: []].insert(person)
      }
      for phone in record.phones {
        if let key = Self.phoneKey(phone.value) { phones[key, default: []].insert(person) }
      }
    }
  }

  func name(for handle: String) -> String? {
    let people: Set<Person>?
    if handle.contains("@") {
      people = emails[handle.lowercased()]
    } else if handle.unicodeScalars.allSatisfy(Self.phoneCharacters.contains),
      let key = Self.phoneKey(handle)
    {
      people = phones[key]
    } else {
      people = nil
    }
    guard let people, people.count == 1, case .named(let name) = people.first else { return nil }
    return name
  }

  private static let phoneCharacters = CharacterSet(charactersIn: "0123456789+-(). ")

  private static func phoneKey(_ value: String) -> String? {
    let digits = ContactsSearch.onlyDigits(value)
    guard !digits.isEmpty else { return nil }
    return String(digits.suffix(9))
  }
}
