import XCTest
@testable import PasswordsBrokerKit

final class SelfIdentityPolicyTests: XCTestCase {
  func testOwnSignatureTeamBindsPeersAndKeychainGroup() throws {
    let build = try XCTUnwrap(BrokerBuild.forOwnTeam("ABCDE12345"))
    XCTAssertFalse(build.development)
    XCTAssertEqual(build.keychainAccessGroup, "ABCDE12345.com.opensteer.passwords")
    guard case .codeRequirement(let incoming) = build.desktopRule,
      case .codeRequirement(let reverse) = build.brokerRule
    else { return XCTFail("A signed broker must use code requirements") }
    for requirement in [incoming, reverse] {
      XCTAssertTrue(requirement.contains("anchor apple generic"))
      XCTAssertTrue(requirement.contains("100.6.2.6"))
      XCTAssertTrue(requirement.contains("100.6.1.13"))
      XCTAssertTrue(requirement.contains("subject.OU] = \"ABCDE12345\""))
      XCTAssertFalse(requirement.contains("ZZZZZ12345"))
    }
    XCTAssertTrue(incoming.contains("com.opensteer.opensteer"))
    XCTAssertTrue(incoming.contains("com.steerlabs.opensteer.beta"))
    XCTAssertTrue(reverse.contains("identifier \"com.opensteer.passwords\""))
  }

  func testUnsignedBrokerRefusesTrustRatherThanUsingDevelopmentStorage() {
    XCTAssertNil(BrokerBuild.forOwnTeam(nil))
    XCTAssertNil(BrokerBuild.forOwnTeam("bad"))
  }
}
