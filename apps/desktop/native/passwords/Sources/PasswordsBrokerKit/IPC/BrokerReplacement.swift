import Foundation
import MacOSSigning
public typealias BrokerReplacement = MacOSSigning.SignedHelperReplacement
typealias ReplacementRunningApplication = MacOSSigning.ReplacementRunningApplication
typealias ReplacementFileIdentity = MacOSSigning.ReplacementFileIdentity
extension SignedHelperReplacement {
  public static func prepare(development: Bool, rule: PeerRule) -> Bool {
    let paths = BrokerPaths.canonical(development: development)
    return prepare(bundleIdentifier: BrokerIdentity.bundleIdentifier(development: development),
      canonicalBundle: paths.application, executableName: "Opensteer Passwords", rule: rule)
  }
}
