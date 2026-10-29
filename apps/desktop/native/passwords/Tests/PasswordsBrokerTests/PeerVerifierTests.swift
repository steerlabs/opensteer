import Darwin
import Foundation
import XCTest
@testable import PasswordsBrokerKit

/// B1 and B15: who may be on the other end of the socket, both directions.
final class PeerVerifierTests: XCTestCase {
  /// The release desktop's requirement, as the build script compiles it.
  private let desktopRequirement =
    #"anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ "#
    + #"and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ "#
    + #"and certificate leaf[subject.OU] = "ABCDE12345" "#
    + #"and (identifier "com.opensteer.opensteer" or identifier "com.steerlabs.opensteer.beta")"#

  private func pair() -> (Int32, Int32) {
    var descriptors: [Int32] = [-1, -1]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
    return (descriptors[0], descriptors[1])
  }

  func testSameUserAcceptsThisProcess() {
    let (one, two) = pair()
    defer {
      close(one)
      close(two)
    }
    XCTAssertTrue(PeerVerifier(rule: .sameUser).verify(fileDescriptor: one))
  }

  func testCodeRequirementRefusesThisTestRunner() {
    let (one, two) = pair()
    defer {
      close(one)
      close(two)
    }
    XCTAssertFalse(PeerVerifier(rule: .codeRequirement(desktopRequirement)).verify(fileDescriptor: one))
    XCTAssertFalse(PeerVerifier(rule: .codeRequirement("this is not a requirement")).verify(fileDescriptor: one),
      "a requirement that does not compile refuses everyone")
  }

  func testInheritedSocketVerification() throws {
    let (one, two) = pair()
    defer {
      close(one)
      close(two)
    }
    XCTAssertTrue(InheritedSocketVerifier.verify(rule: .sameUser, descriptor: one))
    XCTAssertFalse(
      InheritedSocketVerifier.verify(rule: .codeRequirement(#"identifier "com.opensteer.passwords""#), descriptor: one),
      "the release rule names the release broker, which this test runner is not")
    let file = open("/dev/null", O_RDONLY)
    defer { close(file) }
    XCTAssertFalse(InheritedSocketVerifier.verify(rule: .sameUser, descriptor: file), "not a socket")
    XCTAssertFalse(InheritedSocketVerifier.verify(rule: .sameUser, descriptor: 9_999), "not open")
  }
}
