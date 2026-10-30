import Foundation

/// Apple returns both BCP-47 and ICU identifiers for the same resolved locale.
func localeIdentity(_ locale: Locale) -> String {
  locale.identifier(.bcp47).lowercased()
}

/// Serializes inventory operations across recognizers, including suspended reserve calls.
/// Actor isolation alone does not prevent reentrancy while Apple APIs are awaited.
actor ReservationCoordinator {
  private var tail: Task<Void, Never>?
  private var createdReservation: Locale?

  /// Inventory transactions record ownership before suspending in Apple's reserve API.
  func recordCreatedReservation(_ locale: Locale?) {
    createdReservation = locale
  }

  /// Only the serialized transaction or cleanup can consume this service-wide ownership.
  func takeCreatedReservation() -> Locale? {
    defer { createdReservation = nil }
    return createdReservation
  }

  func run<T: Sendable>(_ operation: @escaping @Sendable () async -> T) async -> T {
    let previous = tail
    let task = Task {
      await previous?.value
      return await operation()
    }
    tail = Task { _ = await task.value }
    return await task.value
  }
}
