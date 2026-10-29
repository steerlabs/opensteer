import XCTest
@testable import ComputerUseCore

final class SelfIdentityPolicyTests: XCTestCase {
  func testOwnTeamIsInjectedIntoBothExactPeerRequirements() throws {
    for team in ["ABCDE12345", "ZZZZZ12345"] {
      guard case .codeRequirement(let incoming) = PeerRequirement.policy(teamId: team),
        case .codeRequirement(let reverse) = HelperPeerVerifier.policy(teamId: team)
      else { return XCTFail("A signed helper must use code requirements") }
      for requirement in [incoming, reverse] {
        XCTAssertTrue(requirement.contains("anchor apple generic"))
        XCTAssertTrue(requirement.contains("100.6.2.6"))
        XCTAssertTrue(requirement.contains("100.6.1.13"))
        XCTAssertTrue(requirement.contains("subject.OU] = \"\(team)\""))
      }
      XCTAssertTrue(incoming.contains("com.opensteer.opensteer"))
      XCTAssertTrue(incoming.contains("com.steerlabs.opensteer.beta"))
      XCTAssertTrue(reverse.contains("identifier \"com.opensteer.computer-use\""))
      XCTAssertFalse(reverse.contains(team == "ABCDE12345" ? "ZZZZZ12345" : "ABCDE12345"))
    }
  }

  func testUnsignedOrInvalidSelfIdentityNeverDefaultsToDevelopmentTrust() {
    for team in [nil, "", "bad", "ABCDE12345\" or true"] as [String?] {
      XCTAssertEqual(PeerRequirement.policy(teamId: team), .refuse)
      XCTAssertEqual(HelperPeerVerifier.policy(teamId: team), .refuse)
    }
  }
}
