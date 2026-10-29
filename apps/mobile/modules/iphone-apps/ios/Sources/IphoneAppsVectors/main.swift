import CryptoKit
import Foundation
import IphoneAppsCore

// This process links the production signing and wire sources. Its input is a
// TypeScript-generated vector; its output is checked by the Host's real parsers
// and verifiers. No identity or OS port is substituted into the signing path.
func object(_ value: Any?, _ name: String) throws -> [String: Any] {
  guard let value = value as? [String: Any] else { throw IphoneWireError.missing(name) }
  return value
}
func string(_ value: Any?, _ name: String) throws -> String {
  guard let value = value as? String else { throw IphoneWireError.missing(name) }
  return value
}
func bytes(_ hex: String) throws -> Data {
  guard hex.count == 64 else { throw IphoneWireError.invalid("seed") }
  let characters = Array(hex)
  return try Data(stride(from: 0, to: 64, by: 2).map { offset in
    guard let value = UInt8(String(characters[offset...offset + 1]), radix: 16) else {
      throw IphoneWireError.invalid("seed")
    }
    return value
  })
}
func challenge(_ frame: [String: Any]) throws -> ProofChallenge {
  ProofChallenge(challengeId: try string(frame["challengeId"], "challengeId"),
    nonce: try string(frame["nonce"], "nonce"),
    hostSessionId: try string(frame["hostSessionId"], "hostSessionId"),
    expiresAt: try string(frame["expiresAt"], "expiresAt"))
}

do {
  let source = FileHandle.standardInput.readDataToEndOfFile()
  let input = try object(JSONSerialization.jsonObject(with: source), "input")
  let runner = try Curve25519.Signing.PrivateKey(rawRepresentation: bytes(string(input["runnerSeed"], "runnerSeed")))
  let approval = try Curve25519.Signing.PrivateKey(rawRepresentation: bytes(string(input["approvalSeed"], "approvalSeed")))
  let descriptor = try object(input["descriptor"], "descriptor")
  let mainChallenge = try challenge(object(input["challenge"], "challenge"))
  let auxChallenge = try challenge(object(input["auxiliaryChallenge"], "auxiliaryChallenge"))
  let token = try string(input["token"], "token")
  let ticket = try string(input["ticket"], "ticket")
  let request = try object(input["approvalRequest"], "approvalRequest")
  let answerExpiresAt = try string(input["answerExpiresAt"], "answerExpiresAt")
  let keyChallenge = try object(input["keyChallenge"], "keyChallenge")
  let fence = try AuxiliaryFence(object(input["fence"], "fence"))
  let runnerId = try string(descriptor["runnerId"], "runnerId")
  let bootId = try string(descriptor["bootId"], "bootId")
  let actual: [String: Any] = [
    "publicKeyPem": IphoneProofs.publicKeyPem(runner),
    "keyId": IphoneProofs.keyId(runner),
    "approvalPublicKeyPem": IphoneProofs.publicKeyPem(approval),
    "approvalKeyId": IphoneProofs.keyId(approval),
    "authentication": try IphoneProofs.authenticate(runner, challenge: mainChallenge, descriptor: descriptor),
    "enrollment": try IphoneProofs.enroll(runner, challenge: mainChallenge, descriptor: descriptor, token: token),
    "auxiliary": try IphoneProofs.auxiliary(runner, challenge: auxChallenge, runnerId: runnerId, bootId: bootId, ticket: ticket),
    "allow": try IphoneProofs.approval(approval, request: request, decision: "allow", expiresAt: answerExpiresAt),
    "deny": try IphoneProofs.approval(approval, request: request, decision: "deny", expiresAt: answerExpiresAt),
    "keyProof": try IphoneProofs.keyChallenge(approval, challenge: keyChallenge),
  ]
  let expected = try object(input["expected"], "expected")
  let challengeFields: [Any] = ["challengeId", mainChallenge.challengeId,
    "challengeNonce", mainChallenge.nonce, "hostSessionId", mainChallenge.hostSessionId,
    "challengeExpiresAt", mainChallenge.expiresAt, "descriptor", descriptor]
  let transcripts: [String: Data] = [
    "authentication": try IphoneProofs.canonicalJSON(["opensteer-runner-auth-v2"] + challengeFields),
    "enrollment": try IphoneProofs.canonicalJSON(["opensteer-runner-enroll-v2"] + challengeFields +
      ["publicKeyFingerprint", IphoneProofs.keyId(runner), "enrollmentTokenHash", IphoneProofs.tokenDigest(token)]),
    "auxiliary": try IphoneProofs.canonicalJSON(["opensteer-runner-auxiliary-v1",
      "challengeId", auxChallenge.challengeId, "challengeNonce", auxChallenge.nonce,
      "hostSessionId", auxChallenge.hostSessionId, "challengeExpiresAt", auxChallenge.expiresAt,
      "challengeModule", "integrations", "runnerId", runnerId, "bootId", bootId,
      "module", "integrations", "ticketDigest", IphoneProofs.tokenDigest(ticket)]),
    "allow": try IphoneProofs.approvalTranscript(request: request, decision: "allow", expiresAt: answerExpiresAt),
    "deny": try IphoneProofs.approvalTranscript(request: request, decision: "deny", expiresAt: answerExpiresAt),
    "keyProof": try IphoneProofs.canonicalJSON([
      "opensteer-computer-app-approval-key-registration-v1", "challenge", keyChallenge]),
  ]
  var matches: [String: Bool] = [:]
  for name in ["publicKeyPem", "keyId", "approvalPublicKeyPem", "approvalKeyId"] {
    matches[name] = actual[name] as? String == expected[name] as? String
  }
  var rejectsTampering: [String: [String: Bool]] = [:]
  // CryptoKit intentionally randomizes Ed25519 signatures. Verify the other
  // implementation's signatures over the exact transcript, not byte equality.
  // https://developer.apple.com/documentation/cryptokit/curve25519/signing/privatekey/signature(for:)
  for (name, transcript) in transcripts {
    let encoded = try string(expected[name], name)
      .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let signature = Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)),
      signature.count == 64 else { throw IphoneWireError.invalid(name) }
    let approvalProof = ["allow", "deny", "keyProof"].contains(name)
    let publicKey = approvalProof ? approval.publicKey : runner.publicKey
    let wrongKey = approvalProof ? runner.publicKey : approval.publicKey
    var changedSignature = signature
    changedSignature[0] ^= 1
    matches[name] = publicKey.isValidSignature(signature, for: transcript)
    rejectsTampering[name] = [
      "wrongKey": !wrongKey.isValidSignature(signature, for: transcript),
      "changedData": !publicKey.isValidSignature(signature, for: transcript + Data([0])),
      "changedSignature": !publicKey.isValidSignature(changedSignature, for: transcript),
    ]
  }
  let frames: [String: Any] = [
    "enroll": try IphoneWire.authenticateFrame(challenge: mainChallenge, descriptor: descriptor, key: runner, token: token),
    "authenticate": try IphoneWire.authenticateFrame(challenge: mainChallenge, descriptor: descriptor, key: runner, token: nil),
    "auxiliary": try IphoneWire.auxiliaryAuthenticateFrame(challenge: auxChallenge, key: runner,
      runnerId: runnerId, bootId: bootId, ticket: ticket),
    "heartbeat": IphoneWire.heartbeat(fence.primary, sentAt: try string(input["sentAt"], "sentAt")),
    "modules": IphoneWire.modulesReport(fence.primary, checkedAt: try string(input["sentAt"], "sentAt")),
    "status": IphoneWire.status(fence, permissions: ["apple-calendar": .granted,
      "apple-contacts": .limited, "apple-reminders": .denied]),
  ]
  let keyTranscript = try IphoneProofs.canonicalJSON([
    "opensteer-computer-app-approval-key-registration-v1", "challenge", keyChallenge,
  ])
  let result = ["actual": actual, "matches": matches, "frames": frames, "rejectsTampering": rejectsTampering,
    "keyTranscript": String(decoding: keyTranscript, as: UTF8.self)] as [String: Any]
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
  FileHandle.standardError.write(Data("iPhone vector failure: \(error)\n".utf8))
  exit(1)
}
