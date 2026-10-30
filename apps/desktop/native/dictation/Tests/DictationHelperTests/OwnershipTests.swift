import Foundation
import XCTest

@testable import DictationHelperKit

final class OwnershipTests: XCTestCase {
  func testConnectionOwnsSessionAndDisconnectReleasesIt() {
    var owner = SessionOwner()
    XCTAssertTrue(owner.claim(session: "first", connection: 1))
    XCTAssertFalse(owner.claim(session: "other", connection: 2))
    XCTAssertFalse(owner.owns(session: "first", connection: 2))
    XCTAssertNil(owner.disconnected(2))
    XCTAssertEqual(owner.disconnected(1), "first")
    XCTAssertTrue(owner.claim(session: "second", connection: 2))
    owner.release(session: "first")
    XCTAssertTrue(owner.owns(session: "second", connection: 2))
  }
  func testRequestWireAndStrictParameters() throws {
    let data = Data(
      #"{"id":1,"method":"start","params":{"session":"00000000-0000-4000-8000-000000000001"}}"#.utf8
    )
    let request = try HelperRequest.decode(data)
    let encoded = try JSONEncoder().encode(request)
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Fixtures/request.json")
    if ProcessInfo.processInfo.environment["UPDATE_DICTATION_FIXTURES"] == "1" {
      try FileManager.default.createDirectory(
        at: fixture.deletingLastPathComponent(), withIntermediateDirectories: true)
      try encoded.write(to: fixture)
    }
    XCTAssertEqual(
      try JSONSerialization.jsonObject(with: encoded) as? NSDictionary,
      try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? NSDictionary)
    XCTAssertThrowsError(
      try HelperRequest.decode(Data(#"{"id":1,"method":"stop","params":{}}"#.utf8)))
  }
}
