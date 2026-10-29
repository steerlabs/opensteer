import AppKit
import CoreGraphics
import Darwin
import Foundation
import Security
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class NativeSafetyRegressionTests: XCTestCase {
  func testPermissionRequestsKeepLegacySequenceAndNameOneGrantInProtocol4() throws {
    let neither = PermissionsState(accessibility: .denied, screenRecording: .denied)
    let screenGranted = PermissionsState(accessibility: .denied, screenRecording: .granted)
    let bothGranted = PermissionsState(accessibility: .granted, screenRecording: .granted)

    XCTAssertEqual(
      Permissions.requestActions(pane: nil, permissions: neither),
      [.accessibility, .screenRecording])
    XCTAssertEqual(
      Permissions.requestActions(pane: nil, permissions: screenGranted), [.accessibility])
    XCTAssertTrue(Permissions.requestActions(pane: nil, permissions: bothGranted).isEmpty)
    XCTAssertEqual(
      Permissions.requestActions(pane: .accessibility, permissions: neither), [.accessibility])
    XCTAssertEqual(
      Permissions.requestActions(pane: .screenRecording, permissions: neither), [.screenRecording])
    XCTAssertTrue(
      Permissions.requestActions(pane: .screenRecording, permissions: screenGranted).isEmpty)

    let decoder = JSONDecoder()
    XCTAssertEqual(
      try decoder.decode(
        Wire.PermissionsRequestParams.self, from: Data(#"{"pane":"screen-recording"}"#.utf8)
      ).pane,
      .screenRecording)
    XCTAssertNil(try decoder.decode(Wire.PermissionsRequestParams.self, from: Data("{}".utf8)).pane)
    XCTAssertThrowsError(
      try decoder.decode(
        Wire.PermissionsRequestParams.self, from: Data(#"{"pane":"unknown"}"#.utf8)))
  }

  func testPermissionRequestWireRespectsNegotiatedProtocol() throws {
    let decoder = JSONDecoder()
    let emptyRequest = try decoder.decode(
      RequestEnvelope.self,
      from: Data(#"{"id":1,"method":"permissions.request","params":{}}"#.utf8))
    let explicitRequest = try decoder.decode(
      RequestEnvelope.self,
      from: Data(
        #"{"id":2,"method":"permissions.request","params":{"pane":"screen-recording"}}"#
          .utf8))
    let emptyParams = try emptyRequest.decodeParams(
      Wire.PermissionsRequestParams.self, method: emptyRequest.method)
    let explicitParams = try explicitRequest.decodeParams(
      Wire.PermissionsRequestParams.self, method: explicitRequest.method)

    var descriptors: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
    defer {
      Darwin.close(descriptors[0])
      Darwin.close(descriptors[1])
    }
    let connection = IPCConnection(
      id: 1, fileDescriptor: descriptors[0], onFrame: { _, _ in }, onClose: { _ in })
    XCTAssertFalse(connection.isGreeted)
    connection.markGreeted(protocolVersion: 10)
    XCTAssertTrue(connection.isGreeted)
    XCTAssertEqual(connection.negotiatedProtocolVersion, 10)
    XCTAssertThrowsError(
      try emptyParams.validatedPane()
    ) { error in
      XCTAssertEqual(
        error as? HelperError,
        HelperError(.failed, "A permission request must name one macOS grant."))
    }
    XCTAssertEqual(
      try explicitParams.validatedPane(),
      .screenRecording)

  }

  static let developerIDIntermediate = "certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */"
  static let developerIDLeaf = "certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */"

  /// Only a Developer ID-signed Opensteer build passes: any certificate of the
  /// team — an Apple Development one included — without the two markers.
  func testReleaseReversePeerRequirementPinsBundleTeamAndDeveloperID() throws {
    guard case .codeRequirement(let requirement) = HelperPeerVerifier.policy(teamId: "ABCDE12345") else { return XCTFail("Expected strict signature policy") }
    XCTAssertTrue(requirement.contains("com.opensteer.computer-use"))
    XCTAssertTrue(requirement.contains("ABCDE12345"))
    XCTAssertTrue(requirement.contains("anchor apple generic"))
    XCTAssertTrue(requirement.contains(Self.developerIDIntermediate))
    XCTAssertTrue(requirement.contains(Self.developerIDLeaf))
    var compiled: SecRequirement?
    XCTAssertEqual(
      SecRequirementCreateWithString(requirement as CFString, [], &compiled), errSecSuccess)
  }

  /// The desktop's requirement is compiled into the helper by the build
  /// script, so the script is where the same markers must be.
  func testSelfSignatureReaderUsesSecurityTeamInformation() throws {
    let source = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("packages/macos-signing/Sources/MacOSSigning/MacCodeIdentity.swift")
    let text = try String(contentsOf: source, encoding: .utf8)
    XCTAssertTrue(text.contains("SecCodeCopySelf"))
    XCTAssertTrue(text.contains("SecCodeCopySigningInformation"))
    XCTAssertTrue(text.contains("kSecCodeInfoTeamIdentifier"))
    XCTAssertTrue(text.contains(Self.developerIDIntermediate))
    XCTAssertTrue(text.contains(Self.developerIDLeaf))
  }

  @MainActor
  func testObservationCommitRejectsAReplacementEvenWithTheSameSessionAndAppIDs() {
    let identity = AppIdentity(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil)
    let old = HelperSession(sessionId: "same", connectionID: 7)
    let oldApp = hostApp(identity: identity, path: "/tmp/Fixture.app")
    old.add(oldApp, access: .readWrite)
    let replacement = HelperSession(sessionId: "same", connectionID: 7)
    replacement.add(
      hostApp(identity: identity, path: "/tmp/Fixture.app"), access: .readWrite
    )

    XCTAssertThrowsError(
      try HelperRuntime.validateObservationCommit(
        current: replacement,
        expected: old,
        app: oldApp,
        connectionID: 7
      )
    ) { error in
      XCTAssertEqual((error as? HelperError)?.code, .noSession)
    }
  }

  @MainActor
  func testObservationRevisionRejectsWindowChangesDuringCapture() {
    let monitor = WindowMonitor()
    let pid = getpid()
    monitor.noteObservation(
      processIdentifier: pid, windowID: 42, window: AXUIElementCreateApplication(pid))

    var token = monitor.observationRevision(processIdentifier: pid)
    monitor.noteWindowEvent(processIdentifier: pid, kind: .focusedWindowChanged(windowID: 43))
    XCTAssertEqual(
      monitor.observationError(since: token, processIdentifier: pid)?.code, .staleObservation)

    monitor.noteObservation(
      processIdentifier: pid, windowID: 42, window: AXUIElementCreateApplication(pid))
    token = monitor.observationRevision(processIdentifier: pid)
    monitor.forget(processIdentifier: pid)
    monitor.noteObservation(
      processIdentifier: pid, windowID: 42, window: AXUIElementCreateApplication(pid))
    XCTAssertEqual(
      monitor.observationError(since: token, processIdentifier: pid)?.code, .staleObservation)
    monitor.forget(processIdentifier: pid)
  }

  @MainActor
  func testSameWindowFocusDoesNotInvalidateButUnknownAndDifferentWindowsStaySticky() {
    let monitor = WindowMonitor()
    let pid = getpid()
    monitor.noteObservation(
      processIdentifier: pid, windowID: 42, window: AXUIElementCreateApplication(pid))

    let unchanged = monitor.observationRevision(processIdentifier: pid)
    monitor.noteWindowEvent(processIdentifier: pid, kind: .focusedWindowChanged(windowID: 42))
    XCTAssertEqual(monitor.observationRevision(processIdentifier: pid), unchanged)
    XCTAssertNil(monitor.state(of: pid).staleReason)

    monitor.noteWindowEvent(processIdentifier: pid, kind: .focusedWindowChanged(windowID: 43))
    XCTAssertNil(monitor.state(of: pid).staleReason)
    monitor.noteWindowEvent(processIdentifier: pid, kind: .focusedWindowChanged(windowID: 42))
    XCTAssertNil(monitor.state(of: pid).staleReason)

    monitor.noteObservation(
      processIdentifier: pid, windowID: 42, window: AXUIElementCreateApplication(pid))
    XCTAssertNil(monitor.state(of: pid).staleReason)
    monitor.noteWindowEvent(processIdentifier: pid, kind: .focusedWindowChanged(windowID: nil))
    XCTAssertNil(monitor.state(of: pid).staleReason)
    monitor.forget(processIdentifier: pid)
  }

  @MainActor
  func testIncompressibleScreenshotIsResizedUnderWireBound() throws {
    let side = 1_024
    var bytes = [UInt8](repeating: 0, count: side * side * 4)
    var state: UInt64 = 0x1234_5678_9abc_def0
    for offset in stride(from: 0, to: bytes.count, by: 4) {
      state ^= state << 13
      state ^= state >> 7
      state ^= state << 17
      bytes[offset] = UInt8(truncatingIfNeeded: state)
      bytes[offset + 1] = UInt8(truncatingIfNeeded: state >> 8)
      bytes[offset + 2] = UInt8(truncatingIfNeeded: state >> 16)
      bytes[offset + 3] = 255
    }
    let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
    let image = try XCTUnwrap(
      CGImage(
        width: side,
        height: side,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: side * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
      )
    )
    let initial = try XCTUnwrap(
      WindowCapture.encodeJPEG(image, quality: WindowCapture.reducedQuality)
    )
    .base64EncodedString()
    XCTAssertGreaterThan(initial.utf8.count, WindowCapture.maxBase64Bytes)
    let bounded = try WindowCapture.boundedJPEG(image)
    XCTAssertLessThanOrEqual(bounded.base64.utf8.count, WindowCapture.maxBase64Bytes)
    XCTAssertLessThan(bounded.image.width, image.width)

    // Exercise the real outer JSON shape with a full tree of the characters
    // JSON escapes most expensively (six bytes each). The Runner's
    // integration frame is one mebibyte.
    let tree = String(repeating: "\u{1}", count: TreeFormatter.maxBytes)
    XCTAssertEqual(tree.utf8.count, TreeFormatter.maxBytes)
    let observation = Observation(
      snapshot: "0123456789abcdef",
      app: AppIdentity(bundleId: "com.example.Fixture", displayName: "Fixture", teamId: nil),
      window: Observation.WindowSummary(
        ref: "ref-A", id: 1,
        title: "Fixture",
        frame: Observation.Rect(CGRect(x: 0, y: 0, width: 1_024, height: 1_024)),
        scale: 1
      ),
      tree: tree,
      elementCount: 1_500,
      truncated: true,
      geometry: Observation.Geometry(width: 1440, height: 992),
      screenshot: Observation.Screenshot(
        mime: "image/jpeg",
        base64: bounded.base64,
        width: bounded.image.width,
        height: bounded.image.height
      ),
      focusChanged: false,
      capturedAt: "2026-09-21T00:00:00.000Z"
    )
    let frame = try JSONEncoder().encode(Wire.ObservationResult(observation: observation))
    XCTAssertLessThan(frame.count, 1_048_576)
  }
}
