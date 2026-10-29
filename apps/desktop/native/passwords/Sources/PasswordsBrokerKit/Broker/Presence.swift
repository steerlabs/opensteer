import Foundation
@preconcurrency import LocalAuthentication

public enum PresenceError: Error, Equatable, Sendable {
  /// The person cancelled, or the check was withdrawn (its action ended).
  case cancelled
  /// Touch ID or the password did not match.
  case failed
  /// This Mac cannot ask (no password set, or authentication is locked out).
  case unavailable
}

/// Proof that the person just authenticated, with Touch ID or the Mac
/// password, for the one action named in `reason`. Only a `PresenceChecker`
/// makes one, after the system prompt succeeded, and the broker hands it
/// only to that action: every vault change made on the person's behalf takes
/// one.
public struct Authentication: Sendable {
  public let reason: String

  init(reason: String) {
    self.reason = reason
  }
}

/// When the person must authenticate is the broker's policy, not the owner
/// keys'. It asks here, with its own reason text, for exactly the actions
/// the design lists.
public protocol PresenceChecker: Sendable {
  /// Asks once, never reusing an earlier unlock. Cancelling the calling task
  /// withdraws the prompt, which then throws `cancelled`.
  func authenticate(reason: String) async throws -> Authentication
}

/// `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`: Touch ID, or the
/// Mac password when Touch ID is unavailable. macOS shows `reason` as
/// "Opensteer Passwords is trying to <reason>."
public struct LocalAuthenticationPresence: PresenceChecker {
  public init() {}

  public func authenticate(reason: String) async throws -> Authentication {
    let context = LAContext()
    // A recent device unlock never stands in for this action's check.
    context.touchIDAuthenticationAllowableReuseDuration = 0
    if Task.isCancelled { throw PresenceError.cancelled }
    do {
      _ = try await withTaskCancellationHandler {
        try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
      } onCancel: {
        context.invalidate()
      }
    } catch let error as LAError {
      switch error.code {
      case .userCancel, .appCancel, .systemCancel, .invalidContext, .notInteractive:
        throw PresenceError.cancelled
      case .passcodeNotSet, .biometryLockout:
        throw PresenceError.unavailable
      default:
        throw PresenceError.failed
      }
    }
    if Task.isCancelled { throw PresenceError.cancelled }
    return Authentication(reason: reason)
  }
}
