import Foundation
import OpensteerAppleData

public enum IphonePermission: String, Codable, Sendable {
  case notDetermined = "not-determined", granted, limited, writeOnly = "write-only", denied, restricted
}
public struct IphonePermissionStatus: Equatable {
  public let ready: Bool
  public let detail: String?
  public let remedy: String?
}
public enum InvokeRefusal: Equatable { case unsupported, readOnly, permissionRequired }
public struct InvokeProviderError: Equatable {
  public enum Code: String { case outcomeUnknown = "outcome-unknown", failed }
  public let code: Code
  public let message: String
}

/// Shared Apple stores preserve their Mac contracts; iPhone-only providers use
/// a separate generated table so adding one never changes a Mac helper digest.
public enum InvokeRules {
  public static let apps = ["apple-calendar", "apple-contacts", "apple-reminders", "iphone-location", "iphone-photos"]
  public static func operations(_ definitionId: String) -> [String: DataOperationContract] {
    guard apps.contains(definitionId) else { return [:] }
    return DataContracts.operations[definitionId] ?? IphoneContracts.operations[definitionId] ?? [:]
  }
  public static func contract(_ definitionId: String, _ operation: String) -> String? {
    guard apps.contains(definitionId) else { return nil }
    return operations(definitionId)[operation]?.contract
  }
  public static func effect(_ definitionId: String, _ operation: String) -> DataEffect? {
    guard apps.contains(definitionId) else { return nil }
    return operations(definitionId)[operation]?.effect
  }
  public static func validate(definitionId: String, operation: String, contract: String,
    effect: DataEffect, access: DataAccess, permission: IphonePermission) -> InvokeRefusal? {
    guard apps.contains(definitionId), let implemented = operations(definitionId)[operation],
      implemented.contract == contract, implemented.effect == effect else { return .unsupported }
    if effect == .write && access != .readWrite { return .readOnly }
    if !permissionStatus(permission, app: definitionId).ready { return .permissionRequired }
    return nil
  }
  public static func permissionStatus(_ permission: IphonePermission, app: String) -> IphonePermissionStatus {
    let noun: String
    let remedy: String?
    switch app {
    case "apple-calendar": noun = "Calendar"; remedy = "calendars"
    case "apple-reminders": noun = "Reminders"; remedy = "reminders"
    case "apple-contacts": noun = "Contacts"; remedy = "contacts"
    case "iphone-location": noun = "Location"; remedy = nil
    case "iphone-photos": noun = "Photos"; remedy = nil
    default: return IphonePermissionStatus(ready: false, detail: "This iPhone does not offer that app.", remedy: nil)
    }
    switch permission {
    case .notDetermined where app == "iphone-location" || app == "iphone-photos":
      return IphonePermissionStatus(ready: false,
        detail: "iPhone hasn't asked yet. Turn on \(noun) from Opensteer on this iPhone.", remedy: nil)
    case .granted: return IphonePermissionStatus(ready: true, detail: nil, remedy: nil)
    case .limited where app == "apple-contacts":
      return IphonePermissionStatus(ready: true, detail: "Only the contacts chosen in iPhone Settings are shared.", remedy: nil)
    case .limited where app == "iphone-photos":
      return IphonePermissionStatus(ready: true, detail: "Only the photos chosen in iPhone Settings are shared.", remedy: nil)
    case .restricted:
      return IphonePermissionStatus(ready: false,
        detail: "Screen Time or a device policy keeps Opensteer from using \(noun) on this iPhone.", remedy: remedy)
    case .writeOnly where app == "apple-calendar":
      return IphonePermissionStatus(ready: false,
        detail: "Opensteer can only add events on this iPhone. Calendar needs full access for Opensteer in iPhone Settings.", remedy: remedy)
    default:
      let detail = remedy == nil || noun == "Contacts" ? "\(noun) needs access for Opensteer in iPhone Settings."
        : "\(noun) needs full access for Opensteer in iPhone Settings."
      return IphonePermissionStatus(ready: false, detail: detail, remedy: remedy)
    }
  }
  public static func providerError(effect: DataEffect) -> InvokeProviderError {
    effect == .write
      ? InvokeProviderError(code: .outcomeUnknown, message: "The request may already have taken effect.")
      : InvokeProviderError(code: .failed, message: "This iPhone could not complete that request.")
  }
}
