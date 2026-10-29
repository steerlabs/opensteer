import Foundation
import XCTest
import OpensteerAppleData
@testable import IphoneAppsCore

final class IphoneProviderStatusTests: XCTestCase {
  func testIphoneProvidersHaveSeparateReadContractsAndExplicitPermissionStates() throws {
    for (app, operation) in [("iphone-location", "current_location"), ("iphone-photos", "list_assets"), ("iphone-photos", "list_albums")] {
      XCTAssertTrue(InvokeRules.apps.contains(app))
      let contract = try XCTUnwrap(InvokeRules.contract(app, operation))
      XCTAssertEqual(InvokeRules.effect(app, operation), .read)
      XCTAssertNil(InvokeRules.validate(definitionId: app, operation: operation,
        contract: contract, effect: .read, access: .read, permission: .granted))
      for permission in [IphonePermission.notDetermined, .denied, .restricted, .writeOnly] {
        let status = InvokeRules.permissionStatus(permission, app: app)
        XCTAssertFalse(status.ready)
        XCTAssertNotNil(status.detail)
        XCTAssertNil(status.remedy)
        XCTAssertFalse(status.detail?.contains("Contacts") ?? true)
        if permission == .notDetermined {
          XCTAssertEqual(status.detail, "iPhone hasn't asked yet. Turn on \(app == "iphone-location" ? "Location" : "Photos") from Opensteer on this iPhone.")
        }
      }
    }
    XCTAssertTrue(InvokeRules.permissionStatus(.limited, app: "iphone-photos").ready)
    XCTAssertFalse(InvokeRules.permissionStatus(.limited, app: "iphone-location").ready)
    XCTAssertFalse(InvokeRules.permissionStatus(.granted, app: "unknown").ready)
  }
  func testNativeStatusReportsDeniedProvidersWithoutAddingRemedies() throws {
    let fence = try AuxiliaryFence(["runnerId": "rnr_test", "bootId": "rbt_test",
      "connectionId": "connection", "connectionLeaseId": "lease", "connectionGeneration": 1,
      "auxiliaryStreamId": "stream", "module": "integrations"])
    let frame = IphoneWire.status(fence, permissions: ["iphone-location": .denied, "iphone-photos": .limited])
    let apps = try XCTUnwrap(frame["apps"] as? [[String: Any]])
    let location = try XCTUnwrap(apps.first { $0["definitionId"] as? String == "iphone-location" })
    let operations = try XCTUnwrap(location["operations"] as? [[String: Any]])
    XCTAssertEqual(operations.count, 1)
    XCTAssertEqual(operations[0]["state"] as? String, "permission-required")
    XCTAssertNotNil(operations[0]["detail"] as? String)
    XCTAssertTrue(operations[0]["remedy"] is NSNull)
    let photos = try XCTUnwrap(apps.first { $0["definitionId"] as? String == "iphone-photos" })
    XCTAssertEqual((photos["operations"] as? [[String: Any]])?.count, 2)
  }
}
