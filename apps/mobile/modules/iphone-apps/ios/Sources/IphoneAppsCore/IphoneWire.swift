import Foundation
import CryptoKit
import CoreFoundation

import OpensteerAppleData

public enum IphoneWireError: Error { case missing(String), invalid(String), unexpected(String), staleFence }

public struct PrimaryFence: Equatable {
  public let runnerId: String
  public let bootId: String
  public let connectionId: String
  public let connectionLeaseId: String
  public let connectionGeneration: Int
  public init(_ frame: [String: Any]) throws {
    runnerId = try WireField.string(frame, "runnerId")
    bootId = try WireField.string(frame, "bootId")
    connectionId = try WireField.string(frame, "connectionId")
    connectionLeaseId = try WireField.string(frame, "connectionLeaseId")
    connectionGeneration = try WireField.int(frame, "connectionGeneration", range: 1...Int.max)
  }
  public var fields: [String: Any] {
    ["runnerId": runnerId, "bootId": bootId, "connectionId": connectionId,
     "connectionLeaseId": connectionLeaseId, "connectionGeneration": connectionGeneration]
  }
  public var tag: String {
    "\(connectionId):\(connectionLeaseId):\(connectionGeneration)"
  }
}

public struct AuxiliaryFence: Equatable {
  public let primary: PrimaryFence
  public let streamId: String
  public init(_ frame: [String: Any]) throws {
    primary = try PrimaryFence(frame)
    streamId = try WireField.string(frame, "auxiliaryStreamId")
    guard try WireField.string(frame, "module") == "integrations" else {
      throw IphoneWireError.invalid("module")
    }
  }
  public var fields: [String: Any] {
    primary.fields.merging(["auxiliaryStreamId": streamId, "module": "integrations"]) { _, new in new }
  }
  public var tag: String { primary.tag + ":" + streamId }
}

public struct PrimaryWelcome {
  public let fence: PrimaryFence
  public let serverTime: Date
  public let leaseExpiresAt: Date
  public let heartbeatIntervalMs: Int
}
public struct AuxiliaryWelcome {
  public let fence: AuxiliaryFence
  public let serverTime: Date
  public let leaseExpiresAt: Date
  public let heartbeatIntervalMs: Int
}
public struct IphoneInvoke {
  public let fence: AuxiliaryFence
  public let requestId: String
  public let definitionId: String
  public let operation: String
  public let contract: String
  public let effect: DataEffect
  public let access: DataAccess
  public let arguments: [String: JSONValue]
  public let timeoutMs: Int
}

public enum WireField {
  public static func string(_ frame: [String: Any], _ name: String) throws -> String {
    guard let value = frame[name] as? String, !value.isEmpty else { throw IphoneWireError.missing(name) }
    return value
  }
  public static func int(_ frame: [String: Any], _ name: String, range: ClosedRange<Int>) throws -> Int {
    guard let value = frame[name] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
      value.doubleValue == Double(value.intValue), range.contains(value.intValue) else {
      throw IphoneWireError.invalid(name)
    }
    return value.intValue
  }
  public static func date(_ frame: [String: Any], _ name: String) throws -> Date {
    let text = try string(frame, name)
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = parser.date(from: text) else { throw IphoneWireError.invalid(name) }
    return date
  }
  public static func object(_ frame: [String: Any], _ name: String) throws -> [String: Any] {
    guard let value = frame[name] as? [String: Any] else { throw IphoneWireError.invalid(name) }
    return value
  }
  public static func type(_ frame: [String: Any], _ expected: String) throws {
    guard try string(frame, "type") == expected else { throw IphoneWireError.unexpected(expected) }
  }
}

public enum IphoneWire {
  public static func challenge(_ frame: [String: Any], auxiliary: Bool = false) throws -> ProofChallenge {
    try WireField.type(frame, auxiliary ? "host.auxiliary.challenge" : "host.challenge")
    if auxiliary {
      guard try WireField.string(frame, "module") == "integrations" else { throw IphoneWireError.invalid("module") }
    } else {
      guard try WireField.int(frame, "proofFormatVersion", range: 2...2) == 2 else {
        throw IphoneWireError.invalid("proofFormatVersion")
      }
    }
    _ = try WireField.date(frame, "expiresAt")
    return ProofChallenge(challengeId: try WireField.string(frame, "challengeId"),
      nonce: try WireField.string(frame, "nonce"),
      hostSessionId: try WireField.string(frame, "hostSessionId"),
      expiresAt: try WireField.string(frame, "expiresAt"))
  }

  public static func primaryWelcome(_ frame: [String: Any], runnerId: String, bootId: String) throws -> PrimaryWelcome {
    try WireField.type(frame, "host.welcome")
    let fence = try PrimaryFence(frame)
    guard fence.runnerId == runnerId, fence.bootId == bootId,
      let modules = frame["allowedModules"] as? [String], modules == ["integrations"] else {
      throw IphoneWireError.invalid("allowedModules")
    }
    return PrimaryWelcome(fence: fence, serverTime: try WireField.date(frame, "serverTime"),
      leaseExpiresAt: try WireField.date(frame, "connectionLeaseExpiresAt"),
      heartbeatIntervalMs: try WireField.int(frame, "heartbeatIntervalMs", range: 1_000...300_000))
  }

  public static func auxiliaryWelcome(_ frame: [String: Any], primary: PrimaryFence) throws -> AuxiliaryWelcome {
    try WireField.type(frame, "host.auxiliary.welcome")
    let fence = try AuxiliaryFence(frame)
    guard fence.primary == primary else { throw IphoneWireError.staleFence }
    return AuxiliaryWelcome(fence: fence, serverTime: try WireField.date(frame, "serverTime"),
      leaseExpiresAt: try WireField.date(frame, "streamLeaseExpiresAt"),
      heartbeatIntervalMs: try WireField.int(frame, "heartbeatIntervalMs", range: 1_000...300_000))
  }

  public static func authenticateFrame(challenge: ProofChallenge, descriptor: [String: Any], key: Curve25519.Signing.PrivateKey,
    token: String?) throws -> [String: Any] {
    var frame: [String: Any] = ["challengeId": challenge.challengeId,
      "descriptor": descriptor, "proofFormatVersion": 2]
    if let token {
      frame["type"] = "runner.enroll"
      frame["credential"] = ["kind": "host-enrollment-token", "enrollmentToken": token]
      frame["publicKeyPem"] = IphoneProofs.publicKeyPem(key)
      frame["signature"] = try IphoneProofs.enroll(key, challenge: challenge, descriptor: descriptor, token: token)
    } else {
      frame["type"] = "runner.authenticate"
      frame["signature"] = try IphoneProofs.authenticate(key, challenge: challenge, descriptor: descriptor)
    }
    return frame
  }

  public static func auxiliaryAuthenticateFrame(challenge: ProofChallenge, key: Curve25519.Signing.PrivateKey,
    runnerId: String, bootId: String, ticket: String) throws -> [String: Any] {
    ["type": "runner.auxiliary.authenticate", "challengeId": challenge.challengeId,
     "runnerId": runnerId, "bootId": bootId, "module": "integrations", "ticket": ticket,
     "signature": try IphoneProofs.auxiliary(key, challenge: challenge, runnerId: runnerId, bootId: bootId, ticket: ticket)]
  }

  public static func heartbeat(_ fence: PrimaryFence, sentAt: String) -> [String: Any] {
    fence.fields.merging(["type": "runner.heartbeat", "sentAt": sentAt,
      "activeRunIds": [String](), "activeTriggerOccurrenceIds": [String](),
      "activeWatchActivationIds": [String]()]) { _, new in new }
  }

  public static func modulesReport(_ fence: PrimaryFence, checkedAt: String) -> [String: Any] {
    fence.fields.merging(["type": "runner.modules.report", "modules": [[
      "module": "integrations", "readiness": "ready", "detail": NSNull(), "checkedAt": checkedAt]]]) { _, new in new }
  }

  public static func ticketRequest(_ fence: PrimaryFence, requestId: String) -> [String: Any] {
    fence.fields.merging(["type": "runner.auxiliary.ticket-request", "module": "integrations", "requestId": requestId]) { _, new in new }
  }

  public static func auxiliaryHeartbeat(_ fence: AuxiliaryFence, sentAt: String) -> [String: Any] {
    fence.fields.merging(["type": "runner.auxiliary.heartbeat", "sentAt": sentAt]) { _, new in new }
  }

  public static func status(_ fence: AuxiliaryFence, permissions: [String: IphonePermission], locationAccuracy: String? = nil) -> [String: Any] {
    let apps: [[String: Any]] = InvokeRules.apps.map { app in
      let state = InvokeRules.permissionStatus(permissions[app] ?? .notDetermined, app: app)
      let detail = app == "iphone-location" && state.ready && locationAccuracy == "approximate"
        ? "Approximate location only (Precise Location is off in iPhone Settings)." : state.detail
      let operations: [[String: Any]] = InvokeRules.operations(app).keys.sorted().map { operation in
        ["operation": operation, "state": state.ready ? "ready" : "permission-required",
         "detail": detail ?? NSNull(), "remedy": state.remedy ?? NSNull()]
      }
      return ["definitionId": app, "operations": operations]
    }
    return fence.fields.merging(["type": "runner.integrations.status", "apps": apps]) { _, new in new }
  }

  public static func invoke(_ frame: [String: Any], expected: AuxiliaryFence) throws -> IphoneInvoke {
    try WireField.type(frame, "host.integrations.invoke")
    let fence = try AuxiliaryFence(frame)
    guard fence == expected else { throw IphoneWireError.staleFence }
    let definitionId = try WireField.string(frame, "definitionId")
    let operation = try WireField.string(frame, "operation")
    let arguments = try WireField.object(frame, "arguments")
    let args = try JSONDecoder().decode([String: JSONValue].self,
      from: JSONSerialization.data(withJSONObject: arguments))
    let access = try WireField.string(frame, "access")
    guard let parsedAccess = DataAccess(rawValue: access) else { throw IphoneWireError.invalid("access") }
    let effect = InvokeRules.effect(definitionId, operation) ?? .read
    return IphoneInvoke(fence: fence, requestId: try WireField.string(frame, "requestId"),
      definitionId: definitionId, operation: operation, contract: try WireField.string(frame, "contract"),
      effect: effect, access: parsedAccess, arguments: args,
      timeoutMs: try WireField.int(frame, "timeoutMs", range: 1...60_000))
  }

  public static func result(_ fence: AuxiliaryFence, requestId: String, value: JSONValue) -> [String: Any] {
    let valueAny = (try? JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(value), options: .fragmentsAllowed)) ?? NSNull()
    return fence.fields.merging(["type": "runner.integrations.result", "requestId": requestId,
      "result": ["kind": "ok", "value": valueAny]]) { _, new in new }
  }

  public static func error(_ fence: AuxiliaryFence, requestId: String, code: String, message: String) -> [String: Any] {
    fence.fields.merging(["type": "runner.integrations.result", "requestId": requestId,
      "result": ["kind": "error", "code": code, "message": message]]) { _, new in new }
  }
}
