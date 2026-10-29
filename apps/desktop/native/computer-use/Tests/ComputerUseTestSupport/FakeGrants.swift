import Foundation

@testable import ComputerUseCore

/// Grants as fixed answers, recording which ones were asked about. A grant
/// in `discovering` is found given after launch by the read of it, as the
/// real reader's fresh-process check does.
final class FakeGrants: DataGrantReading, @unchecked Sendable {
  private let lock = NSLock()
  private let states: [DataGrant: DataGrantState]
  private let discovering: Set<DataGrant>
  private var restarting: Set<DataGrant>
  private var asked: [DataGrant] = []

  init(
    _ states: [DataGrant: DataGrantState], restarting: Set<DataGrant> = [],
    discovering: Set<DataGrant> = []
  ) {
    self.states = states
    self.restarting = restarting
    self.discovering = discovering
  }

  var askedAbout: [DataGrant] { lock.withLock { asked } }

  func current() async -> DataGrants {
    DataGrants(
      automation: states[.automation] ?? .denied, calendars: states[.calendars] ?? .denied,
      contacts: states[.contacts] ?? .denied,
      fullDiskAccess: states[.fullDiskAccess] ?? .denied,
      reminders: states[.reminders] ?? .denied)
  }

  func state(of grant: DataGrant) async -> DataGrantState {
    lock.withLock {
      asked.append(grant)
      if discovering.contains(grant) { restarting.insert(grant) }
      return states[grant] ?? .denied
    }
  }

  func request(_ grant: DataGrant) async -> DataGrants { await current() }

  func awaitingRestart(_ grant: DataGrant) async -> Bool {
    lock.withLock { restarting.contains(grant) }
  }
}
