import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore

/// The Host parses these with strict zod schemas, so a nullable field has to
/// arrive as `null` rather than as a missing key, and no result may carry a
/// key the schema does not name.
final class WireShapeTests: XCTestCase {
  private func object(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONCoding.encoder.encode(value)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testAnIdentityIsBundleIdDisplayNameAndTeamId() throws {
    let encoded = try object(
      AppIdentity(bundleId: "com.example.app", displayName: "App", teamId: nil)
    )
    XCTAssertEqual(Set(encoded.keys), ["bundleId", "displayName", "teamId"])
    XCTAssertTrue(encoded["teamId"] is NSNull, "An unsigned app's team is null, not absent.")
  }

  func testAnInstalledAppWithoutAnIconOmitsIconPng() throws {
    let encoded = try object(
      InstalledApp(
        identity: AppIdentity(
          bundleId: "com.example.app", displayName: "App", teamId: "ABCDE12345"),
        running: false,
        iconPng: nil
      )
    )
    XCTAssertEqual(Set(encoded.keys), ["identity", "running"])
    XCTAssertNil(encoded["iconPng"])
  }

  func testTheObservationCarriesEveryDocumentedKey() throws {
    let observation = Observation(
      snapshot: "0123456789abcdef",
      app: AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil),
      window: Observation.WindowSummary(
        ref: "ref-A", id: 1,
        title: "",
        frame: Observation.Rect(CGRect(x: 10, y: 20, width: 800, height: 600)),
        scale: 1.8
      ),
      tree: "[0] window (0,0 800×600)",
      elementCount: 1,
      truncated: false,
      geometry: Observation.Geometry(width: 1440, height: 992),
      screenshot: Observation.Screenshot(
        mime: "image/jpeg",
        base64: "AA==",
        width: 1_440,
        height: 900
      ),
      focusChanged: true,
      capturedAt: Observation.timestamp(Date(timeIntervalSince1970: 0))
    )
    let encoded = try object(observation)
    XCTAssertEqual(
      Set(encoded.keys),
      [
        "snapshot", "app", "window", "windows", "blockedBy", "alone", "tree", "elementCount",
        "truncated", "screenshot",
        "focusChanged", "capturedAt", "geometry",
      ]
    )
    let window = try XCTUnwrap(encoded["window"] as? [String: Any])
    XCTAssertEqual(Set(window.keys), ["ref", "id", "title", "frame", "scale"])
    // The window as a whole is nullable; the title inside it is a string.
    XCTAssertEqual(window["title"] as? String, "")
    let frame = try XCTUnwrap(window["frame"] as? [String: Any])
    XCTAssertEqual(Set(frame.keys), ["x", "y", "width", "height"])
    let screenshot = try XCTUnwrap(encoded["screenshot"] as? [String: Any])
    XCTAssertEqual(Set(screenshot.keys), ["mime", "base64", "width", "height"])
    XCTAssertEqual(screenshot["mime"] as? String, "image/jpeg")
    XCTAssertEqual(encoded["capturedAt"] as? String, "1970-01-01T00:00:00.000Z")
  }

  func testAnObservationWithNoWindowOrPictureStillCarriesBothKeys() throws {
    let observation = Observation(
      snapshot: String(repeating: "f", count: 16),
      app: AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil),
      window: Observation.WindowSummary(
        ref: "ref-A", id: 1, title: "", frame: Observation.Rect(.zero), scale: 1),
      tree: "",
      elementCount: 0,
      truncated: false,
      geometry: Observation.Geometry(width: 1440, height: 992),
      screenshot: nil,
      focusChanged: false,
      capturedAt: Observation.timestamp()
    )
    let encoded = try object(observation)
    XCTAssertNotNil(encoded["window"] as? [String: Any])
    XCTAssertTrue(encoded["screenshot"] is NSNull)
  }

  func testObserveAnswersWithAWrappedObservation() throws {
    let encoded = try object(
      Wire.ObservationResult(
        observation: Observation(
          snapshot: "0123456789abcdef",
          app: AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil),
          window: Observation.WindowSummary(
            ref: "ref-A", id: 1, title: "", frame: Observation.Rect(.zero), scale: 1),
          tree: "",
          elementCount: 0,
          truncated: false,
          geometry: Observation.Geometry(width: 1440, height: 992),
          screenshot: nil,
          focusChanged: false,
          capturedAt: Observation.timestamp()
        )
      )
    )
    XCTAssertEqual(Set(encoded.keys), ["observation"])
  }

  func testActReportsProgressAndFailureWithANullObservation() throws {
    let encoded = try object(
      Wire.ActResult(
        performed: [#"Clicked "Save""#, #"Typed "Venue shortlist" into "Title""#],
        error: Wire.ActResult.Failure(
          HelperError(.staleObservation, "The person is using this app right now.")
        )
      )
    )
    XCTAssertEqual(Set(encoded.keys), ["performed", "error"])
    XCTAssertEqual(
      encoded["performed"] as? [String],
      [#"Clicked "Save""#, #"Typed "Venue shortlist" into "Title""#])
    let error = try XCTUnwrap(encoded["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "stale-observation")
  }

  func testAnObservationIdentifierIsSixteenHexCharacters() {
    for _ in 0..<50 {
      let identifier = Observation.newIdentifier()
      XCTAssertEqual(identifier.count, 16)
      XCTAssertNil(
        identifier.rangeOfCharacter(
          from: CharacterSet(charactersIn: "0123456789abcdef").inverted
        )
      )
    }
  }

  func testHelloNamesBothProtocolBoundsAndTheRoute() throws {
    let encoded = try object(
      Wire.HelloResult(
        ownerViewVersion: 3,
        helperVersion: "0.1.79",
        minProtocolVersion: HelperRuntime.minProtocolVersion,
        permissions: PermissionsState(accessibility: .denied, screenRecording: .granted),
        protocolVersion: HelperRuntime.protocolVersion,
        routes: Wire.HelloResult.Routes(windowLocation: true, windowGroups: true)
      )
    )
    XCTAssertEqual(
      Set(encoded.keys),
      [
        "helperVersion", "minProtocolVersion", "permissions", "protocolVersion", "routes",
        "ownerViewVersion",
      ]
    )
    XCTAssertEqual(encoded["protocolVersion"] as? Int, 10)
    XCTAssertEqual(encoded["minProtocolVersion"] as? Int, 10)
    let permissions = try XCTUnwrap(encoded["permissions"] as? [String: Any])
    XCTAssertEqual(permissions["accessibility"] as? String, "denied")
    XCTAssertEqual(permissions["screenRecording"] as? String, "granted")
    let routes = try XCTUnwrap(encoded["routes"] as? [String: Any])
    XCTAssertEqual(routes["windowLocation"] as? Bool, true)
  }

  func testScreenshotDecisionRequiresAnExplicitChoice() throws {
    XCTAssertTrue(try Wire.screenshotDecision(true))
    XCTAssertFalse(try Wire.screenshotDecision(false))
    XCTAssertThrowsError(try Wire.screenshotDecision(nil)) { error in
      XCTAssertEqual((error as? HelperError)?.code, .failed)
    }
  }

  func testPermissionsAreWrappedUnderTheirOwnKey() throws {
    let encoded = try object(
      Wire.PermissionsResult(
        permissions: PermissionsState(accessibility: .granted, screenRecording: .denied)
      )
    )
    XCTAssertEqual(Set(encoded.keys), ["permissions"])
  }

  func testActRequiresAWindowAndSnapshotFieldAndRejectsWait() throws {
    let app =
      #"{"access":"read-write","identity":{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}}"#
    let valid =
      "{\"sessionId\":\"s\",\"app\":\(app),\"window\":\"ref-A\",\"snapshot\":null,\"actions\":[{\"type\":\"key\",\"keys\":\"Escape\"}]}"
    _ = try JSONCoding.decoder.decode(Wire.ActParams.self, from: Data(valid.utf8))
    for field in [",\"window\":\"ref-A\"", ",\"snapshot\":null"] {
      XCTAssertThrowsError(
        try JSONCoding.decoder.decode(
          Wire.ActParams.self, from: Data(valid.replacingOccurrences(of: field, with: "").utf8)))
    }
    for action in [#"{"type":"wait","ms":1}"#, #"{"type":"launch"}"#] {
      XCTAssertThrowsError(
        try JSONCoding.decoder.decode(ActionRequest.self, from: Data(action.utf8)))
    }
  }

  func testTheResolvedAppIsWrappedUnderApp() throws {
    let encoded = try object(
      Wire.ResolveAppResult(
        app: ResolvedApp(
          allowed: true,
          identity: AppIdentity(bundleId: "com.apple.Safari", displayName: "Safari", teamId: nil),
          path: "/Applications/Safari.app",
          reason: AppPolicy.verdict(for: "com.apple.Safari").reason,
          risk: AppPolicy.verdict(for: "com.apple.Safari").risk,
          running: false
        )
      )
    )
    XCTAssertEqual(Set(encoded.keys), ["app"])
    let app = try XCTUnwrap(encoded["app"] as? [String: Any])
    XCTAssertEqual(
      Set(app.keys),
      ["allowed", "identity", "path", "reason", "risk", "running"]
    )
    XCTAssertEqual(app["risk"] as? String, "elevated")
  }

  /// Opening a session is bookkeeping: it answers with the session and nothing
  /// about any app.
  func testSessionOpenAnswersWithTheSessionOnly() throws {
    let encoded = try object(
      Wire.SessionOpenResult(sessionId: "cus_4a7c2f18-9b3e-4d61-8a02-5f6c1d9e0b74"))
    XCTAssertEqual(Set(encoded.keys), ["sessionId"])
  }

  func testSessionCloseAnswersWithAnEmptyObject() throws {
    XCTAssertTrue(try object(Wire.EmptyResult()).isEmpty)
  }

  func testAnOrdinaryAppIsStandardRisk() throws {
    XCTAssertEqual(AppPolicy.verdict(for: "com.apple.Notes").risk, .standard)
    let encoded = try JSONCoding.encoder.encode([AppRisk.standard, AppRisk.elevated])
    XCTAssertEqual(String(decoding: encoded, as: UTF8.self), #"["standard","elevated"]"#)
  }
}
