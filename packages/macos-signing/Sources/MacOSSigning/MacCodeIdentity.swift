import Foundation
import Security

public enum MacCodeIdentity {
  /// A missing, invalid or ad-hoc self signature never supplies release authority.
  public static func ownTeamId() -> String? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
      SecCodeCheckValidity(code, [], nil) == errSecSuccess
    else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
      let values = information as? [String: Any],
      let flags = values[kSecCodeInfoFlags as String] as? NSNumber,
      flags.uint32Value & 0x00000002 == 0,
      let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
      validTeam(team)
    else { return nil }
    return team
  }

  /// Public for fixture identities in host-safe tests; production passes ownTeamId().
  public static func requirement(teamId: String?, identifiers: [String]) -> String? {
    guard let teamId, validTeam(teamId), !identifiers.isEmpty,
      identifiers.allSatisfy({ $0.range(of: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil })
    else { return nil }
    let peers = identifiers.map { "identifier \"\($0)\"" }.joined(separator: " or ")
    return "anchor apple generic "
      + "and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ "
      + "and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ "
      + "and certificate leaf[subject.OU] = \"\(teamId)\" and (\(peers))"
  }

  private static func validTeam(_ team: String) -> Bool {
    team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
  }
}
