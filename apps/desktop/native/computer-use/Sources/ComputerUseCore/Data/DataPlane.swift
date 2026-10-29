import Foundation

/// `data.invoke`: one operation of an app the helper serves, checked here
/// against what this build implements before any app is touched. The Host
/// resolved the access and the Runner checked the contract already; the
/// helper checks both again because it is the one holding the grant.
public struct DataPlane: Sendable {
  private let contracts: [String: [String: DataOperationContract]]
  private let grants: [String: DataAppGrants]
  private let providers: [String: any DataProvider]
  /// Where the grants are read from; macOS itself outside tests.
  let grantReader: any DataGrantReading

  public init(
    contracts: [String: [String: DataOperationContract]],
    grants: [String: DataAppGrants],
    providers: [String: any DataProvider],
    grantReader: any DataGrantReading = DataGrantReader.standard
  ) {
    self.contracts = contracts
    self.grants = grants
    self.providers = providers
    self.grantReader = grantReader
  }

  /// The apps this build serves, each through its own provider.
  public static func standard() -> DataPlane {
    DataPlane(
      contracts: DataContracts.operations,
      grants: DataContracts.grants,
      providers: [
        "apple-calendar": CalendarProvider(),
        "apple-contacts": ContactsProvider(),
        "apple-messages": MessagesProvider(),
        "apple-reminders": RemindersProvider(),
      ]
    )
  }

  func invoke(_ params: Wire.DataInvokeParams, budget: WorkBudget) async throws -> JSONValue {
    guard
      let operations = contracts[params.definitionId],
      let appGrants = grants[params.definitionId],
      let provider = providers[params.definitionId]
    else {
      throw HelperError(.unsupported, "This Mac's Opensteer does not serve that app.")
    }
    guard let implemented = operations[params.operation] else {
      throw HelperError(.unsupported, "This operation is not supported.")
    }
    guard implemented.contract == params.contract, implemented.effect == params.effect else {
      throw HelperError(.unsupported, "This operation comes from a different Opensteer version.")
    }
    if implemented.effect == .write && params.access != .readWrite {
      throw HelperError(.failed, "This app is read only.")
    }
    // Only this operation's grant: any other may be a question macOS is
    // holding for the person, and this call must not wait behind it.
    // `unknown` is for the app to settle before it acts, as Messages does.
    let grant = implemented.effect == .write ? appGrants.write : appGrants.read
    let state = await grantReader.state(of: grant)
    // Given after this process started: a retry in a moment, not a grant to
    // go and find. Asked after the read, which may be what found it.
    if await grantReader.awaitingRestart(grant) {
      throw HelperError(.failed, Self.restartingSentence)
    }
    switch state {
    case .granted, .unknown: break
    case .requestable, .denied:
      throw HelperError(.permissionRequired, Self.permissionSentence(grant))
    }
    do {
      return try await provider.invoke(
        operation: params.operation, arguments: params.arguments, budget: budget)
    } catch let error as HelperError {
      throw error
    } catch {
      throw implemented.effect == .write
        ? HelperError(.outcomeUnknown, "The request may already have taken effect.")
        : HelperError(.failed, "This Mac could not complete that request.")
    }
  }

  /// Each sentence names the app macOS lists, because the person has two
  /// Opensteer apps in those lists and only this one is the answer.
  static func permissionSentence(_ grant: DataGrant) -> String {
    switch grant {
    case .automation:
      return "Sending in Messages needs macOS Automation permission for Opensteer Computer Use."
    case .fullDiskAccess:
      return "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use."
    case .contacts:
      return "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use."
    case .calendars:
      return "Calendar needs macOS full access to calendars for Opensteer Computer Use."
    case .reminders:
      return "Reminders needs macOS full access to reminders for Opensteer Computer Use."
    }
  }

  static let restartingSentence =
    "Opensteer Computer Use is restarting to finish setup. Try again in a moment."
}
