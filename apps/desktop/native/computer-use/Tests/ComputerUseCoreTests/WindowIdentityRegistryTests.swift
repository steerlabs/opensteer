import XCTest
@testable import ComputerUseCore

final class WindowIdentityRegistryTests: XCTestCase {
  @WorkActor func testIdentityOutlivesLeasesButNotRetirementOrHelperBoot() throws {
      struct Identity: Equatable { let process: Int; let ax: Int }
      let registry = WindowIdentityRegistry<Identity>()
      let window = Identity(process: 1, ax: 1)
      let id = registry.retain(window, same: ==)
      XCTAssertTrue(id.hasPrefix("win_"))
      XCTAssertNotNil(UUID(uuidString: String(id.dropFirst(4))))
      XCTAssertEqual(registry.retain(window, same: ==), id)
      XCTAssertNotEqual(registry.retain(Identity(process: 2, ax: 1), same: ==), id)
      XCTAssertNotEqual(registry.retain(Identity(process: 1, ax: 2), same: ==), id)
      XCTAssertEqual(try registry.resolve(id), window)
      registry.retire(id)
      XCTAssertThrowsError(try registry.resolve(id)) { error in
        XCTAssertEqual(error as? HelperError, SessionWindows.closed)
      }
      XCTAssertNotEqual(registry.retain(window, same: ==), id)
      let restarted = WindowIdentityRegistry<Identity>()
      XCTAssertThrowsError(try restarted.resolve(id)) { error in
        XCTAssertEqual((error as? OwnerViewWindow.Failure)?.reason, "window-identity-lost")
      }
  }
}
