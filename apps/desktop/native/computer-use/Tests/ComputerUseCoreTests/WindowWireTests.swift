import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

final class WindowWireTests: XCTestCase {
  func testProtocolTenRequiresExplicitWindowAndNullableSnapshot() throws {
    let app =
      #"{"access":"read-write","identity":{"bundleId":"com.example.fixture","displayName":"Fixture","teamId":null}}"#
    let act =
      #"{"sessionId":"s","app":\#(app),"window":"ref-A","snapshot":null,"actions":[{"type":"key","keys":"Escape"}]}"#
    let decoded = try JSONCoding.decoder.decode(Wire.ActParams.self, from: Data(act.utf8))
    XCTAssertEqual(decoded.window, "ref-A")
    XCTAssertNil(decoded.snapshot)
    for invalid in [
      act.replacingOccurrences(of: #","snapshot":null"#, with: ""),
      act.replacingOccurrences(of: "ref-A", with: ""),
    ] {
      XCTAssertThrowsError(
        try JSONCoding.decoder.decode(Wire.ActParams.self, from: Data(invalid.utf8)))
    }
    XCTAssertThrowsError(
      try JSONCoding.decoder.decode(ActionRequest.self, from: Data(#"{"type":"wait","ms":1}"#.utf8))
    )
  }

  func testOwnerWindowInventoryNeverCarriesAnAgentRef() throws {
    let info = OwnerWindowInfo(
      id: 3, title: "A", focused: false, main: true, minimized: false, onScreen: true)
    let value =
      try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(info)) as! [String: Any]
    XCTAssertEqual(Set(value.keys), ["id", "title", "focused", "main", "minimized", "onScreen"])
  }

  func testActOnlyReturnsReceiptsAndExplicitNullableError() throws {
    let result = Wire.ActResult(performed: ["Pressed Escape"], error: nil)
    let value =
      try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(result)) as! [String: Any]
    XCTAssertEqual(Set(value.keys), ["performed", "error"])
    XCTAssertTrue(value["error"] is NSNull)
  }
}
