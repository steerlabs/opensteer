import Foundation

/// Contacts on this device, read through the Contacts framework under the grant
/// this process holds. Everything but the read itself — which contacts match,
/// how they page, what each looks like — is `ContactsSearch`, which needs no
/// grant to be held to its rules.
public actor ContactsProvider: DataProvider {
  private let deviceName: String

  public init(deviceName: String = "Mac") { self.deviceName = deviceName }

  public func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    guard operation == "search_contacts" else {
      throw HelperError(.unsupported, "This operation is not supported.")
    }
    let parsed = try DataArguments.decode(ContactsSearchArguments.self, from: arguments)
    let page = try ContactsSearch.page(
      try ContactsStore.records(budget: budget, deviceName: deviceName), arguments: parsed)
    return try JSONValue(encoding: page)
  }
}
