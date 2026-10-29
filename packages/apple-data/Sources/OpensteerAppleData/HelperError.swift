import Foundation

/// The complete error vocabulary of docs/computer-use.md §2. Nothing else is
/// ever put on the wire, because the Host maps these codes one for one.
public enum HelperErrorCode: String, Codable, Sendable, CaseIterable {
  case permissionRequired = "permission-required"
  case appNotAllowed = "app-not-allowed"
  case appNotFound = "app-not-found"
  case appNotRunning = "app-not-running"
  case noSession = "no-session"
  case busy = "busy"
  case ownerInControl = "owner-in-control"
  case staleObservation = "stale-observation"
  case stoppedByUser = "stopped-by-user"
  case unsupported = "unsupported"
  case failed = "failed"
  /// The action may have happened. Nothing after it in the batch is posted and
  /// nothing is ever retried (§1 invariant 6).
  case outcomeUnknown = "outcome-unknown"
  /// The channel's persisted attempt has no confirmation; repeating the key
  /// cannot resolve it. Unlike a lost bridge answer, this is terminal.
  case deliveryUnconfirmed = "delivery-unconfirmed"
  case incompatibleVersion = "incompatible-version"
}

/// Every error carries one sentence a person or a model can act on, and never a
/// filesystem path (§2 "Errors").
public struct HelperError: Error, Sendable, Equatable {
  public let code: HelperErrorCode
  public let message: String

  public init(_ code: HelperErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}
