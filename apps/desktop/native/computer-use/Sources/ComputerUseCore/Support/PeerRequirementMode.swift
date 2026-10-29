import MacOSSigning
import Foundation

/// Policy checked against the connected process's kernel audit token.
public enum PeerRequirementMode: Sendable, Equatable {
  /// A code-signing designated requirement, checked with `SecCodeCheckValidity`.
  case codeRequirement(String)
  case refuse
  /// A development build: only a process running as this same user may connect.
  case sameUser
}

/// How the build labels the compiled requirement, for the one lifecycle log
/// line the helper writes at startup.
public enum PeerRequirementLabel: String, Sendable {
  case release
  case development
}

public enum PeerRequirement {
  public static var label: PeerRequirementLabel {
    #if OPENSTEER_DEV_TRUST
    return .development
    #else
    return .release
    #endif
  }

  public static var mode: PeerRequirementMode {
    #if OPENSTEER_DEV_TRUST
    return .sameUser
    #else
    return policy(teamId: MacCodeIdentity.ownTeamId())
    #endif
  }

  static func policy(teamId: String?) -> PeerRequirementMode {
    guard let text = MacCodeIdentity.requirement(teamId: teamId,
      identifiers: ["com.opensteer.opensteer", "com.steerlabs.opensteer.beta"])
    else { return .refuse }
    return .codeRequirement(text)
  }
}
