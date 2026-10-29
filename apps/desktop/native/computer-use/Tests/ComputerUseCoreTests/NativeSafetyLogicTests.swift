import CoreGraphics
import XCTest

@testable import ComputerUseCore

final class NativeSafetyLogicTests: XCTestCase {
  func testApprovalIdentityIncludesNameAndSigningTeam() {
    let approved = AppIdentity(
      bundleId: "com.example.App", displayName: "Example", teamId: "TEAM123")
    XCTAssertTrue(
      AppCatalog.sameIdentity(
        approved,
        AppIdentity(bundleId: "COM.EXAMPLE.APP", displayName: "Example", teamId: "TEAM123")
      )
    )
    XCTAssertFalse(
      AppCatalog.sameIdentity(
        approved,
        AppIdentity(bundleId: "com.example.App", displayName: "Example", teamId: "OTHER")
      )
    )
    XCTAssertFalse(
      AppCatalog.sameIdentity(
        approved,
        AppIdentity(bundleId: "com.example.App", displayName: "Replacement", teamId: "TEAM123")
      )
    )
  }

  /// Point targets land in the window the observation saw under them — a
  /// popover or child window in front of the key window — and fall back to
  /// the key window elsewhere.
  func testAPointLandsInTheFrontmostObservedWindowUnderIt() {
    let key = ObservedWindow(windowID: 10, frame: CGRect(x: 100, y: 100, width: 800, height: 600))
    let popover = ObservedWindow(
      windowID: 11, frame: CGRect(x: 300, y: 150, width: 200, height: 100))
    let behind = ObservedWindow(
      windowID: 12, frame: CGRect(x: 50, y: 50, width: 1_000, height: 800))
    let windows = [popover, key, behind]
    XCTAssertEqual(
      AppWindows.window(at: CGPoint(x: 350, y: 200), among: windows, keyWindow: key), popover)
    XCTAssertEqual(
      AppWindows.window(at: CGPoint(x: 150, y: 150), among: windows, keyWindow: key), key)
    XCTAssertEqual(
      AppWindows.window(at: CGPoint(x: 60, y: 60), among: windows, keyWindow: key), behind)
    XCTAssertEqual(
      AppWindows.window(at: CGPoint(x: 2_000, y: 2_000), among: windows, keyWindow: key), key)
    XCTAssertEqual(
      AppWindows.window(at: CGPoint(x: 350, y: 200), among: [], keyWindow: key), key)
  }

  func testPermissionTransitionsRequestScreenRecordingRestart() {
    let denied = PermissionsState(accessibility: .denied, screenRecording: .denied)
    let granted = PermissionsState(accessibility: .granted, screenRecording: .granted)
    XCTAssertEqual(
      HelperRuntime.permissionTransition(from: denied, to: granted),
      HelperRuntime.PermissionTransition(restartForScreenRecording: true)
    )
    XCTAssertEqual(
      HelperRuntime.permissionTransition(from: granted, to: granted),
      HelperRuntime.PermissionTransition(restartForScreenRecording: false)
    )
  }
}
