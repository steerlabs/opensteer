import CryptoKit
import XCTest

@testable import NotificationPreview

final class PreviewTests: XCTestCase {
  func fixture() throws -> [String: String] {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
      "../../../../../../../packages/core/src/fixtures/notification-preview-v1.json"
    ).standardized
    return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: root))
  }
  func testSharedVectorAndRejections() throws {
    var f = try fixture()
    let key = f["key"]!
    let keyId = f["keyId"]!
    f["threadId"] = "thr_00000000-0000-4000-8000-000000000003"
    f["messageId"] = "msg_00000000-0000-4000-8000-000000000004"
    let env: [String: Any] = [
      "version": 1, "keyId": keyId, "nonce": f["nonce"]!, "ciphertext": f["ciphertext"]!,
    ]
    f["preview"] = String(data: try Preview.json(env), encoding: .utf8)!
    let now = Date(timeIntervalSince1970: 0)
    func open(_ fields: [String: String], _ k: String? = key, _ marker: String = "install") throws
      -> PreviewText
    {
      try Preview.open(fields, key: k, marker: "install", recordMarker: marker, now: now)
    }
    XCTAssertEqual(try open(f).body, "Build passed. You can review it.")
    let box = try AES.GCM.seal(
      Data(f["plaintext"]!.utf8), using: SymmetricKey(data: Preview.decode(key, count: 32...32)),
      nonce: AES.GCM.Nonce(data: Preview.decode(f["nonce"]!, count: 12...12)),
      authenticating: Preview.aad(f, keyId: keyId))
    XCTAssertEqual(Preview.encode(box.ciphertext + box.tag), f["ciphertext"])
    for field in [
      "deploymentId", "notificationId", "installationId", "kind", "deepLink", "expiresAt",
    ] {
      var changed = f
      changed[field] = f[field]! + "x"
      XCTAssertThrowsError(try open(changed), field)
    }
    var altered = env
    altered["keyId"] = "BAECAwQFBgcICQoLDA0ODw"
    var bad = f
    bad["preview"] = String(data: try Preview.json(altered), encoding: .utf8)!
    XCTAssertThrowsError(try open(bad))
    altered = env
    altered["ciphertext"] = "A" + String(f["ciphertext"]!.dropFirst())
    bad["preview"] = String(data: try Preview.json(altered), encoding: .utf8)!
    XCTAssertThrowsError(try open(bad))
    XCTAssertThrowsError(try open(f, nil))
    XCTAssertThrowsError(try open(f, key, "old"))
    XCTAssertThrowsError(
      try Preview.open(
        f, key: key, marker: "install", recordMarker: "install", now: Date.distantFuture))
  }
}
