import CryptoKit
import Foundation
import XCTest

@testable import IphoneAppsCore

/// The session-binding and leave proofs against the TypeScript Host's own
/// vectors (packages/runner-auth/fixtures/device-proofs.v1.json). CryptoKit
/// randomizes Ed25519 signatures, so bytes are compared at the transcript and
/// each side verifies the other's signature.
final class DeviceProofTests: XCTestCase {
  func testTranscriptsMatchTheHostByteForByte() throws {
    let fixture = try vectors()
    let bind = fixture["bind"] as! [String: String]
    let leave = fixture["leave"] as! [String: String]
    XCTAssertEqual(hex(try IphoneProofs.deviceSessionBindTranscript(deploymentId: bind["deploymentId"]!,
      runnerId: bind["runnerId"]!, sessionId: bind["sessionId"]!, issuedAt: bind["issuedAt"]!)), bind["transcriptHex"])
    XCTAssertEqual(hex(try IphoneProofs.deviceLeaveTranscript(deploymentId: leave["deploymentId"]!,
      runnerId: leave["runnerId"]!, issuedAt: leave["issuedAt"]!)), leave["transcriptHex"])
  }

  func testEachSideVerifiesTheOthersSignatures() throws {
    let fixture = try vectors()
    let key = try Curve25519.Signing.PrivateKey(rawRepresentation: bytes(fixture["runnerSeed"] as! String))
    XCTAssertEqual(IphoneProofs.publicKeyPem(key), fixture["publicKeyPem"] as? String)
    let bind = fixture["bind"] as! [String: String]
    let leave = fixture["leave"] as! [String: String]
    let bindTranscript = try IphoneProofs.deviceSessionBindTranscript(deploymentId: bind["deploymentId"]!,
      runnerId: bind["runnerId"]!, sessionId: bind["sessionId"]!, issuedAt: bind["issuedAt"]!)
    let leaveTranscript = try IphoneProofs.deviceLeaveTranscript(deploymentId: leave["deploymentId"]!,
      runnerId: leave["runnerId"]!, issuedAt: leave["issuedAt"]!)
    XCTAssertTrue(key.publicKey.isValidSignature(try unbase64url(bind["signature"]!), for: bindTranscript))
    XCTAssertTrue(key.publicKey.isValidSignature(try unbase64url(leave["signature"]!), for: leaveTranscript))
    let ownBind = try IphoneProofs.deviceSessionBind(key, deploymentId: bind["deploymentId"]!,
      runnerId: bind["runnerId"]!, sessionId: bind["sessionId"]!, issuedAt: bind["issuedAt"]!)
    let ownLeave = try IphoneProofs.deviceLeave(key, deploymentId: leave["deploymentId"]!,
      runnerId: leave["runnerId"]!, issuedAt: leave["issuedAt"]!)
    XCTAssertTrue(ownBind.range(of: "^[A-Za-z0-9_-]{86}$", options: .regularExpression) != nil)
    XCTAssertTrue(key.publicKey.isValidSignature(try unbase64url(ownBind), for: bindTranscript))
    XCTAssertTrue(key.publicKey.isValidSignature(try unbase64url(ownLeave), for: leaveTranscript))
    // Domain separation: a bind signature never passes as a leave.
    XCTAssertFalse(key.publicKey.isValidSignature(try unbase64url(ownBind), for: leaveTranscript))
  }

  func testLeaveIsDurableBeforeTheKeyCanBeErased() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let leaveRecord = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record, leaveRecord: leaveRecord)
    let prepared = try store.prepare(deploymentId: "dep_one")
    XCTAssertNil(try store.persistLeave(issuedAt: "2026-11-12T18:30:00.000Z"), "A prepared identity has nothing on the Host to leave")
    try store.enroll(deploymentId: "dep_one", deploymentName: "Home", hostInstanceId: "hst_one",
      hostUrl: "https://home.example", enrollmentId: "ren_one", enrollmentToken: "token", expiresAt: "2030-01-01T00:00:00.000Z", name: "iPhone")
    try store.markEnrolled()
    let publicKey = try store.runnerKey().publicKey
    let obligation = try XCTUnwrap(try store.persistLeave(issuedAt: "2026-11-12T18:30:00.000Z"))
    XCTAssertEqual(obligation.runnerId, prepared.runnerId)
    XCTAssertEqual(obligation.hostUrl, "https://home.example")
    _ = try store.markBrowserErasurePending()
    try store.completeBrowserErasure(deploymentId: "dep_one", confirmed: true)
    XCTAssertNil(vault.get(.runnerKey))
    let restarted = IdentityStore(vault: vault, record: record, leaveRecord: leaveRecord)
    let survived = try XCTUnwrap(try restarted.pendingLeave())
    XCTAssertEqual(survived, obligation)
    XCTAssertTrue(publicKey.isValidSignature(try unbase64url(survived.signature),
      for: try IphoneProofs.deviceLeaveTranscript(deploymentId: "dep_one", runnerId: prepared.runnerId, issuedAt: survived.issuedAt)))
    try restarted.completeLeave(runnerId: "rnr_someone-else")
    XCTAssertNotNil(try restarted.pendingLeave(), "Another runner's confirmation never drops this obligation")
    try restarted.completeLeave(runnerId: prepared.runnerId)
    XCTAssertNil(try restarted.pendingLeave())
  }

  func testBindingNeedsTheEnrolledDeployment() throws {
    let store = IdentityStore(vault: MemoryIdentityVault(), record: MemoryRecordStore(), leaveRecord: MemoryRecordStore())
    _ = try store.prepare(deploymentId: "dep_one")
    XCTAssertThrowsError(try store.signSessionBinding(deploymentId: "dep_one", sessionId: "ses", issuedAt: "2026-11-12T18:30:00.000Z"))
    try store.enroll(deploymentId: "dep_one", deploymentName: "Home", hostInstanceId: "hst_one",
      hostUrl: "https://home.example", enrollmentId: "ren_one", enrollmentToken: "token", expiresAt: "2030-01-01T00:00:00.000Z", name: "iPhone")
    try store.markEnrolled()
    XCTAssertThrowsError(try store.signSessionBinding(deploymentId: "dep_two", sessionId: "ses", issuedAt: "2026-11-12T18:30:00.000Z"))
    let signed = try store.signSessionBinding(deploymentId: "dep_one", sessionId: "ses", issuedAt: "2026-11-12T18:30:00.000Z")
    XCTAssertTrue(try store.runnerKey().publicKey.isValidSignature(try unbase64url(signed.signature),
      for: try IphoneProofs.deviceSessionBindTranscript(deploymentId: "dep_one", runnerId: signed.runnerId, sessionId: "ses", issuedAt: "2026-11-12T18:30:00.000Z")))
  }

  private func vectors() throws -> [String: Any] {
    var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while root.path != "/" {
      let file = root.appendingPathComponent("packages/runner-auth/fixtures/device-proofs.v1.json")
      if FileManager.default.fileExists(atPath: file.path) {
        return try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
      }
      root.deleteLastPathComponent()
    }
    throw NSError(domain: "Missing device proof vectors", code: 1)
  }

  private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  private func bytes(_ hex: String) -> Data {
    let characters = Array(hex)
    return Data(stride(from: 0, to: characters.count, by: 2).map { UInt8(String(characters[$0...$0 + 1]), radix: 16)! })
  }

  private func unbase64url(_ text: String) throws -> Data {
    let standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let data = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)) else {
      throw NSError(domain: "Invalid base64url", code: 1)
    }
    return data
  }
}
