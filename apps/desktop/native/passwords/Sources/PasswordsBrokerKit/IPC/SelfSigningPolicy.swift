import MacOSSigning

extension BrokerBuild {
  public static var current: BrokerBuild? {
    #if OPENSTEER_DEV_TRUST
    return BrokerBuild(development: true, desktopRule: .sameUser, brokerRule: .sameUser, keychainAccessGroup: nil)
    #else
    return forOwnTeam(MacCodeIdentity.ownTeamId())
    #endif
  }

  static func forOwnTeam(_ teamId: String?) -> BrokerBuild? {
    guard let teamId,
      let desktop = MacCodeIdentity.requirement(teamId: teamId, identifiers: ["com.opensteer.opensteer", "com.steerlabs.opensteer.beta"]),
      let broker = MacCodeIdentity.requirement(teamId: teamId, identifiers: ["com.opensteer.passwords"])
    else { return nil }
    return BrokerBuild(development: false, desktopRule: .codeRequirement(desktop), brokerRule: .codeRequirement(broker), keychainAccessGroup: "\(teamId).com.opensteer.passwords")
  }
}
