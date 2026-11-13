import CryptoKit
import Foundation
import XCTest

@testable import IphoneAppsCore

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

  func testFailedLeavePersistenceNeverErasesTheKey() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let leaves = FailingLeaveRecord()
    let store = IdentityStore(vault: vault, record: record, leaveRecord: leaves)
    _ = try store.prepare(deploymentId: "dep_one")
    try store.enroll(deploymentId: "dep_one", deploymentName: "Home", hostInstanceId: "hst_one",
      hostUrl: "https://home.example", enrollmentId: "ren_one", enrollmentToken: "token", expiresAt: "2030-01-01T00:00:00.000Z", name: "iPhone")
    var fenced = false
    var erased = false
    XCTAssertThrowsError(try store.leave(issuedAt: "2026-11-12T18:30:00.000Z", fence: { fenced = true }, erase: { erased = true }))
    XCTAssertTrue(fenced)
    XCTAssertFalse(erased)
    XCTAssertNotNil(vault.get(.runnerKey))
    XCTAssertEqual(try store.load()?.state, .pending)
    XCTAssertEqual(try store.load()?.leaveRequested, true)
    let restarted = IdentityStore(vault: vault, record: record, leaveRecord: leaves)
    XCTAssertThrowsError(try restarted.prepare(deploymentId: "dep_one"), "A failed leave cannot restore admission after restart")
    leaves.fail = false
    vault.put(Data([1]), account: .runnerKey)
    XCTAssertThrowsError(try store.leave(issuedAt: "2026-11-12T18:30:00.000Z", fence: {}, erase: { erased = true }))
    XCTAssertFalse(erased, "Signing failure must preserve the identity too")
  }

  func testIssuanceAndSuccessiveLeavesSurviveRestart() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let leaves = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record, leaveRecord: leaves)
    _ = try store.prepare(deploymentId: "dep_one")
    XCTAssertNil(try store.persistLeave(issuedAt: "2026-11-12T18:30:00.000Z"))
    try store.beginIssuance(deploymentId: "dep_one", deploymentName: "Home", hostInstanceId: "hst_one", hostUrl: "https://home.example", devicesV1: true)
    let first = try XCTUnwrap(try store.persistLeave(issuedAt: "2026-11-12T18:30:00.000Z"))
    XCTAssertEqual(first.devicesV1, true)
    XCTAssertEqual(first.preparedIdentity?.runnerId, try store.load()?.runnerId)
    XCTAssertEqual(first.preparedIdentity?.publicKeyPem, IphoneProofs.publicKeyPem(try store.runnerKey()))
    XCTAssertEqual((first.publicSnapshot["preparedIdentity"] as? [String: String])?["publicKeyPem"], first.preparedIdentity?.publicKeyPem)
    try store.wipe()
    _ = try store.prepare(deploymentId: "dep_two")
    try store.beginIssuance(deploymentId: "dep_two", deploymentName: "Studio", hostInstanceId: "hst_two", hostUrl: "https://studio.example", devicesV1: false, name: "iPhone")
    let second = try XCTUnwrap(try store.persistLeave(issuedAt: "2026-11-12T18:31:00.000Z"))
    XCTAssertNil(second.preparedIdentity)
    XCTAssertEqual(second.mintKey, try store.load()?.mintKey)
    XCTAssertEqual(second.name, "iPhone")
    XCTAssertEqual(second.profile, "iphone")
    XCTAssertEqual(second.publicSnapshot["mintKey"] as? String, second.mintKey)
    XCTAssertEqual(second.publicSnapshot["name"] as? String, second.name)
    XCTAssertEqual(second.publicSnapshot["profile"] as? String, "iphone")
    try store.wipe()
    let restarted = IdentityStore(vault: vault, record: record, leaveRecord: leaves)
    XCTAssertEqual(try restarted.pendingLeaves(), [first, second])
    try restarted.completeLeave(runnerId: second.runnerId)
    XCTAssertEqual(try restarted.pendingLeaves(), [first])
  }

  func testRemovalIsDurableBeforeErasure() throws {
    let vault = MemoryIdentityVault()
    let record = MemoryRecordStore()
    let removed = MemoryRecordStore()
    let store = IdentityStore(vault: vault, record: record, removedRecord: removed)
    _ = try store.prepare(deploymentId: "dep_one")
    try store.enroll(deploymentId: "dep_one", deploymentName: "Home", hostInstanceId: "hst_one",
      hostUrl: "https://home.example", enrollmentId: "ren_one", enrollmentToken: "token", expiresAt: "2030-01-01T00:00:00.000Z", name: "iPhone")
    try store.markRemoved()
    try store.wipe()
    let restarted = IdentityStore(vault: vault, record: record, removedRecord: removed)
    XCTAssertEqual(try restarted.removedFrom()?.deploymentId, "dep_one")
    try restarted.clearRemoved()
    XCTAssertNil(try restarted.removedFrom())
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

private final class FailingLeaveRecord: IdentityRecordStore {
  var fail = true
  var bytes: Data?
  func read() throws -> Data? { bytes }
  func write(_ value: Data) throws {
    if fail { throw IdentityStoreError.invalidIdentity }
    bytes = value
  }
  func remove() throws { bytes = nil }
}
