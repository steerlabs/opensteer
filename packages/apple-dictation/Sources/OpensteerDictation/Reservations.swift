import Foundation

/// Apple returns both BCP-47 and ICU identifiers for the same resolved locale.
func localeIdentity(_ locale: Locale) -> String {
  locale.identifier(.bcp47).lowercased()
}

/// Serializes inventory operations across recognizers, including suspended reserve calls.
/// Actor isolation alone does not prevent reentrancy while Apple APIs are awaited.
actor ReservationCoordinator {
  private var tail: Task<Void, Never>?

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
