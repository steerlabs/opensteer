@preconcurrency import Contacts
@preconcurrency import EventKit
import Foundation

/// Every grant, as `data.status` and `data.request` answer.
public struct DataGrants: Codable, Sendable, Equatable {
  public let automation: DataGrantState
  public let calendars: DataGrantState
  public let contacts: DataGrantState
  public let fullDiskAccess: DataGrantState
  public let reminders: DataGrantState

  public subscript(grant: DataGrant) -> DataGrantState {
    switch grant {
    case .automation: return automation
    case .calendars: return calendars
    case .contacts: return contacts
    case .fullDiskAccess: return fullDiskAccess
    case .reminders: return reminders
    }
  }

  private enum CodingKeys: String, CodingKey {
    case automation, calendars, contacts, reminders
    case fullDiskAccess = "full-disk-access"
  }
}

/// What `data.status`, `data.request` and the data plane ask about grants.
public protocol DataGrantReading: Sendable {
  /// Every grant, never prompting.
  func current() async -> DataGrants
  /// One grant, never prompting.
  func state(of grant: DataGrant) async -> DataGrantState
  /// Asks macOS for one grant. Only a person at this Mac starts this: the
  /// desktop refuses `data.request` from a Runner, as it does
  /// `permissions.request`. Full Disk Access is never asked for — only System
  /// Settings grants it — so asking for it means the person may have switched
  /// it on: the runtime has a fresh process look (`HelperRuntime`).
  func request(_ grant: DataGrant) async -> DataGrants
  /// The grant is there and this process cannot use it until it restarts.
  func awaitingRestart(_ grant: DataGrant) async -> Bool
}

/// The grants as macOS reports them to this process.
///
/// Nothing here runs on the caller's thread for long: Automation and Full
/// Disk Access are their own actors, which take macOS's slow answers off the
/// main actor, and Contacts and EventKit report authorization at once.
public struct DataGrantReader: DataGrantReading {
  public static let standard = DataGrantReader()

  private let automation: MessagesAutomation
  private let fullDiskAccess: FullDiskAccessGrant

  init(
    automation: MessagesAutomation = .shared,
    fullDiskAccess: FullDiskAccessGrant = .shared
  ) {
    self.automation = automation
    self.fullDiskAccess = fullDiskAccess
  }

  public func current() async -> DataGrants {
    async let automation = state(of: .automation)
    async let fullDiskAccess = state(of: .fullDiskAccess)
    return DataGrants(
      automation: await automation,
      calendars: await state(of: .calendars),
      contacts: await state(of: .contacts),
      fullDiskAccess: await fullDiskAccess,
      reminders: await state(of: .reminders)
    )
  }

  public func state(of grant: DataGrant) async -> DataGrantState {
    switch grant {
    case .automation: return await automation.state()
    case .fullDiskAccess: return await fullDiskAccess.state()
    case .contacts: return Self.state(CNContactStore.authorizationStatus(for: .contacts))
    case .calendars: return Self.state(EKEventStore.authorizationStatus(for: .event))
    case .reminders: return Self.state(EKEventStore.authorizationStatus(for: .reminder))
    }
  }

  public func request(_ grant: DataGrant) async -> DataGrants {
    switch grant {
    case .automation:
      _ = await automation.request()
    case .fullDiskAccess:
      // Nothing asks for it: only System Settings grants it.
      break
    case .contacts:
      _ = try? await CNContactStore().requestAccess(for: .contacts)
    case .calendars:
      _ = try? await EKEventStore().requestFullAccessToEvents()
    case .reminders:
      _ = try? await EKEventStore().requestFullAccessToReminders()
    }
    return await current()
  }

  public func awaitingRestart(_ grant: DataGrant) async -> Bool {
    grant == .fullDiskAccess ? await fullDiskAccess.awaitingRestart : false
  }

  /// A limited Contacts grant still reads what the person chose to share.
  static func state(_ status: CNAuthorizationStatus) -> DataGrantState {
    switch status {
    case .authorized, .limited: return .granted
    case .notDetermined: return .requestable
    case .denied, .restricted: return .denied
    @unknown default: return .denied
    }
  }

  /// Adding without reading is not enough for an app that also reads, and
  /// asking for full access upgrades it, so it is requestable.
  static func state(_ status: EKAuthorizationStatus) -> DataGrantState {
    switch status {
    case .fullAccess: return .granted
    case .notDetermined, .writeOnly: return .requestable
    case .denied, .restricted: return .denied
    @unknown default: return .denied
    }
  }
}
