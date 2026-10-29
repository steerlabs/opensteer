import CryptoKit
import Darwin
import Foundation
import XCTest

@testable import ComputerUseCore

final class LoginReceiverTests: XCTestCase {
  private let runId = "run_00000000-0000-4000-8000-000000000002"
  private let sessionId = "cus_00000000-0000-4000-8000-000000000003"
  private let clock = Locked<Double>(1_800_000_000_000)

  private func receiver() -> LoginTextReceiver {
    LoginTextReceiver(now: { [clock] in clock.current })
  }

  private func action(
    _ receiver: LoginTextReceiver, text: String = "synthetic", field: LoginField = .password,
    act: String = "act-1", index: Int = 0, expires: Double = 1_800_000_045_000
  ) throws -> ActionRequest {
    let key = receiver.key
    let binding = try JSONDecoder().decode(
      LoginEnvelopeBinding.self,
      from: JSONSerialization.data(withJSONObject: [
        "version": 1, "connectionId": key.connectionId,
        "connectionGeneration": key.connectionGeneration,
        "runId": runId, "sessionId": sessionId, "actId": act, "actionIndex": index,
        "field": field.rawValue, "expiresAt": expires,
      ]))
    let sender = P256.KeyAgreement.PrivateKey()
    let remote = try P256.KeyAgreement.PublicKey(
      x963Representation: LoginEnvelopeCrypto.binary(key.publicKey))
    let salt = Data(repeating: 3, count: 32)
    let nonce = Data(repeating: 4, count: 12)
    let shared = try sender.sharedSecretFromKeyAgreement(with: remote)
    let symmetric = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: salt,
      sharedInfo: Data("opensteer/login-text/v1".utf8), outputByteCount: 32)
    let box = try AES.GCM.seal(
      Data(text.utf8), using: symmetric, nonce: AES.GCM.Nonce(data: nonce),
      authenticating: binding.aad())
    let object: [String: Any] = [
      "binding": try JSONSerialization.jsonObject(with: JSONEncoder().encode(binding)),
      "senderPublicKey": LoginEnvelopeCrypto.base64(sender.publicKey.x963Representation),
      "salt": LoginEnvelopeCrypto.base64(salt), "nonce": LoginEnvelopeCrypto.base64(nonce),
      "ciphertext": LoginEnvelopeCrypto.base64(box.ciphertext),
      "tag": LoginEnvelopeCrypto.base64(box.tag),
    ]
    return try JSONDecoder().decode(
      ActionRequest.self,
      from: JSONSerialization.data(withJSONObject: [
        "type": "type", "text": ["sealed": object],
      ]))
  }

  private func prepare(
    _ receiver: LoginTextReceiver, _ actions: [ActionRequest], run: String? = nil,
    context: LoginActContext? = nil
  ) throws -> PreparedLoginBatch {
    try receiver.prepare(
      actions: actions, context: context ?? LoginActContext(runId: runId, actId: "act-1"),
      sessionId: sessionId, runId: run ?? runId)
  }

  // The issuer caps lifetime; the receiver checks whether that expiry has passed.
  func testIssuerCappedEnvelopeSurvivesReceiverClockDifference() throws {
    let receiver = receiver()
    let input = try action(receiver, expires: clock.current + 60_001)
    let prepared = try prepare(receiver, [input])
    XCTAssertEqual(try prepared.open(index: 0).text, "synthetic")
  }

  func testFreshKeysGenerationsAndClosedReceiver() throws {
    let first = receiver()
    let second = receiver()
    XCTAssertNotEqual(first.key.connectionId, second.key.connectionId)
    XCTAssertNotEqual(first.key.publicKey, second.key.publicKey)
    XCTAssertGreaterThan(second.key.connectionGeneration, first.key.connectionGeneration)
    let input = try action(first)
    let prepared = try prepare(first, [input])
    first.invalidate()
    XCTAssertThrowsError(try prepared.open(index: 0))
    XCTAssertThrowsError(try prepare(first, [input]))
    XCTAssertThrowsError(try prepare(second, [input]))
  }

  func testPinContextAndWholeBatchPreflight() throws {
    let receiver = receiver()
    let input = try action(receiver)
    XCTAssertThrowsError(
      try prepare(receiver, [input], run: "run_00000000-0000-4000-8000-000000000009"))
    XCTAssertThrowsError(
      try receiver.prepare(actions: [input], context: nil, sessionId: sessionId, runId: runId))
    XCTAssertThrowsError(
      try receiver.prepare(
        actions: [input], context: LoginActContext(runId: runId, actId: "act-1"),
        sessionId: sessionId, runId: nil))
    XCTAssertThrowsError(try prepare(receiver, [.key(keys: "Escape"), input]))
    let prepared = try prepare(receiver, [input])
    XCTAssertEqual(try prepared.open(index: 0).text, "synthetic")
    XCTAssertThrowsError(try prepared.open(index: 0))
    XCTAssertThrowsError(try prepare(receiver, [input]))
  }

  func testReplayIdentityExcludesFieldAndExpiryAndNeverRevivesOnRollback() throws {
    let receiver = receiver()
    _ = try prepare(receiver, [action(receiver)])
    XCTAssertThrowsError(
      try prepare(receiver, [action(receiver, field: .username, expires: 1_800_000_050_000)]))
    clock.withLock { $0 = 1_800_000_045_000 }
    XCTAssertThrowsError(try prepare(receiver, [action(receiver)]))
    clock.withLock { $0 = 1_800_000_000_000 }
    XCTAssertThrowsError(try prepare(receiver, [action(receiver)]))
  }

  func testConcurrentReplayClaimsHaveExactlyOneWinner() throws {
    let receiver = receiver()
    let input = try action(receiver)
    let winners = Locked<Int>(0)
    let context = LoginActContext(runId: runId, actId: "act-1")
    let sessionId = sessionId
    let runId = runId
    DispatchQueue.concurrentPerform(iterations: 16) { _ in
      if (try? receiver.prepare(
        actions: [input], context: context, sessionId: sessionId, runId: runId)) != nil
      {
        winners.withLock { $0 += 1 }
      }
    }
    XCTAssertEqual(winners.current, 1)
  }

  func testControlCharactersRefuseAndDelayedBatchExpires() throws {
    for text in ["a\rb", "a\nb", "a\tb"] {
      let receiver = receiver()
      XCTAssertThrowsError(
        try prepare(receiver, [.key(keys: "Escape"), action(receiver, text: text, index: 1)]))
    }
    let receiver = receiver()
    let prepared = try prepare(receiver, [action(receiver)])
    clock.withLock { $0 = 1_800_000_045_000 }
    XCTAssertThrowsError(try prepared.open(index: 0))
  }

  func testNegotiationIsOptionalAndSocketCloseInvalidates() throws {
    let connection = IPCConnection(
      id: 1, fileDescriptor: -1, onFrame: { _, _ in }, onClose: { _ in })
    XCTAssertNil(connection.loginReceiver)
    connection.markGreeted(protocolVersion: 10, loginText: 1)
    let receiver = try XCTUnwrap(connection.loginReceiver)
    connection.close()
    XCTAssertNil(connection.loginReceiver)
    XCTAssertThrowsError(try prepare(receiver, [action(receiver)]))
    let hello = try JSONDecoder().decode(
      Wire.HelloParams.self,
      from: Data(#"{"protocolVersion":10,"futureExtension":1}"#.utf8))
    XCTAssertNil(hello.loginText)
  }
}
