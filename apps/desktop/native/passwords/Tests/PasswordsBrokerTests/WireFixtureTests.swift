import Foundation
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// `Tests/Fixtures/passwords-wire.json`: at least one request and one result
/// per method, the error reply and the event, **encoded by the broker's own
/// wire types**. `packages/protocol/src/passwords-broker-wire.test.ts` parses
/// every entry with the matching zod schema, so the two ends of the socket
/// are pinned to each other. Regenerate with:
///
///     OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --filter WireFixtureTests
final class WireFixtureTests: XCTestCase {
  private static let transactionId = "6f1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071"
  private static let loginId = "8d1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071"
  private static let workspaceId = "wsp_00000000-0000-4000-8000-000000000003"

  static var fixtureURL: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/passwords-wire.json")
  }

  /// Built from JSON the desktop would send, read by the broker's decoder,
  /// then written by the type's own encoder.
  private static func requests() throws -> [String: [JSONValue]] {
    let request = try Wire.SignInRequestParams(
      json: .object([
        "deploymentId": .string("dep_personal"),
        "deploymentName": .string("Personal"),
        "expiresAt": .string("2026-10-11T17:00:00.000Z"),
        "reason": .string("Check the latest invoice"),
        "runtimeId": .string("desktop-browser"),
        "sessionId": .string("bsn_00000000-0000-4000-8000-000000000007"),
        "site": .string("https://github.com"),
        "threadTitle": .string("Invoices"),
        "transactionId": .string(transactionId),
        "workspaceId": .string(workspaceId),
        "workspaceName": .string("Main"),
      ]))
    guard case .object(var modernFields) = request.json else { preconditionFailure("request") }
    modernFields.removeValue(forKey: "runtimeId")
    modernFields.removeValue(forKey: "sessionId")
    modernFields["protocolVersion"] = .integer(5)
    modernFields["permissionVersion"] = .integer(5)
    let modern = try Wire.SignInRequestParams(json: .object(modernFields))
    let modernReleases = try Wire.ReleaseField.allCases.flatMap { field -> [JSONValue] in
      try [
        Wire.ReleaseParams(json: .object([
          "transactionId": .string(transactionId), "field": .string(field.rawValue),
          "kind": .string("app"),
        ])).json,
        Wire.ReleaseParams(json: .object([
          "transactionId": .string(transactionId), "field": .string(field.rawValue),
          "kind": .string("browser"), "origin": .string("https://github.com"),
        ])).json,
      ]
    }
    let transaction = Wire.TransactionParams(transactionId: transactionId)
    return [
      Wire.Method.hello.rawValue: [
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 4).json,
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 5).json,
      ],
      Wire.Method.status.rawValue: [.object([:])],
      Wire.Method.windowOpen.rawValue: [.object([:])],
      Wire.Method.signInProbe.rawValue: [Wire.ProbeParams(site: "https://github.com").json],
      Wire.Method.signInRequest.rawValue: [request.json, modern.json],
      Wire.Method.signInApprove.rawValue: [true, false].map {
        Wire.ApproveParams(
          loginId: loginId, remember: $0, revision: 3, transactionId: transactionId
        ).json
      },
      Wire.Method.signInRelease.rawValue: Wire.ReleaseField.allCases.map {
        Wire.ReleaseParams(transactionId: transactionId, field: $0, origin: "https://github.com")
          .json
      } + modernReleases,
      Wire.Method.signInCancel.rawValue: [transaction.json],
    ]
  }

  private static func results() -> [String: [JSONValue]] {
    let login = Wire.Login(id: loginId, revision: 3, account: "s•••@example.com", hasTOTP: true)
    let accounts = [
      Wire.Account(
        host: "github.com", onPage: true, updatedAt: "2026-10-13T00:00:00.000Z", id: loginId,
        revision: 3, username: "sam@example.com", label: "Work"),
      Wire.Account(
        host: "github.com", onPage: true, updatedAt: "2026-10-13T00:00:00.000Z",
        id: "9e2d3b5c-6e7f-4a91-8b2c-3d4e5f607182", revision: 0, username: "alex-personal",
        label: nil),
    ]
    return [
      Wire.Method.hello.rawValue: [
        Wire.HelloResult(brokerVersion: "0.1.117", development: false, protocolVersion: 4).json,
        Wire.HelloResult(brokerVersion: "0.1.117", development: false, protocolVersion: 5).json,
        Wire.HelloResult(brokerVersion: "0.1.117", development: true).json,
      ],
      Wire.Method.status.rawValue: [
        Wire.Status(vault: .ready, agentSignIns: true).json,
        Wire.Status(vault: .notSetUp, agentSignIns: false).json,
        Wire.Status(vault: .unsupported, agentSignIns: false).json,
        Wire.Status(vault: .needsReset, agentSignIns: false).json,
      ],
      Wire.Method.windowOpen.rawValue: [Wire.emptyResult],
      Wire.Method.signInProbe.rawValue: Wire.Availability.allCases.map(\.json),
      Wire.Method.signInRequest.rawValue: [
        Wire.Decision.authorized(login).json, Wire.Decision.approve(accounts).json,
        Wire.Decision.approve([]).json,
        Wire.Decision.unavailable(.passwordsOff).json, Wire.Decision.unavailable(.notSetUp).json,
        Wire.Decision.unavailable(.busy).json,
      ],
      Wire.Method.signInApprove.rawValue: [
        Wire.Decision.authorized(login).json,
        Wire.Decision.approve(accounts, message: Copy.accountChanged).json,
        Wire.Decision.approve([], message: Copy.accountGone).json,
        Wire.Decision.unavailable(.passwordsOff).json,
        Wire.Decision.unavailable(.notSetUp).json,
      ],
      Wire.Method.signInRelease.rawValue: [
        Wire.ReleaseResult.released("synthetic-password-7c1a").json
      ]
        + Wire.ReleaseReason.allCases.map { Wire.ReleaseResult.refused($0).json },
      Wire.Method.signInCancel.rawValue: [Wire.emptyResult],
    ]
  }

  private static func text() throws -> String {
    let error = try CanonicalJSON.parse(
      Wire.error(id: 7, Wire.Failure(.invalid, "There is no open sign-in with that ID.")))
    let event = try CanonicalJSON.parse(
      Wire.statusChanged(Wire.Status(vault: .ready, agentSignIns: true)))
    let fixture = JSONValue.object([
      "error": error,
      "event": event,
      "requests": .object(try requests().mapValues(JSONValue.array)),
      "results": .object(results().mapValues(JSONValue.array)),
    ])
    let compact = try CanonicalJSON.encode(fixture)
    let object = try JSONSerialization.jsonObject(with: compact)
    let pretty = try JSONSerialization.data(
      withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    return String(decoding: pretty, as: UTF8.self) + "\n"
  }

  func testTheWireFixtureMatchesWhatTheBrokerEncodes() throws {
    let text = try Self.text()
    let url = Self.fixtureURL
    if ProcessInfo.processInfo.environment["OPENSTEER_WRITE_WIRE_FIXTURE"] != nil
      || !FileManager.default.fileExists(atPath: url.path)
    {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try text.write(to: url, atomically: true, encoding: .utf8)
    }
    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8), text,
      "Tests/Fixtures/passwords-wire.json is out of date. Regenerate it with "
        + "OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --filter WireFixtureTests")
  }

  func testTheFixtureCoversEveryMethod() throws {
    let methods = Set(Wire.Method.allCases.map(\.rawValue))
    XCTAssertEqual(Set(try Self.requests().keys), methods)
    XCTAssertEqual(Set(Self.results().keys), methods)
    XCTAssertTrue(try Self.requests().values.allSatisfy { !$0.isEmpty })
    XCTAssertTrue(Self.results().values.allSatisfy { !$0.isEmpty })
  }

  /// C2: what the file says the desktop sends, the broker reads.
  func testTheBrokerReadsEveryFixtureRequest() throws {
    let fixture = try CanonicalJSON.parse(try Data(contentsOf: Self.fixtureURL))
    guard case .object(let requests)? = fixture["requests"] else { return XCTFail("no requests") }
    for (method, list) in requests {
      guard case .array(let entries) = list, let known = Wire.Method(rawValue: method) else {
        return XCTFail(method)
      }
      for params in entries {
        switch known {
        case .hello:
          XCTAssertTrue([4, 5].contains(try Wire.HelloParams(json: params).protocolVersion))
        case .status, .windowOpen: XCTAssertNoThrow(try Wire.empty(params))
        case .signInProbe:
          XCTAssertEqual(try Wire.ProbeParams(json: params).site, "https://github.com")
        case .signInRequest:
          XCTAssertEqual(try Wire.SignInRequestParams(json: params).siteHost, "github.com")
        case .signInApprove: XCTAssertNoThrow(try Wire.ApproveParams(json: params))
        case .signInCancel: XCTAssertNoThrow(try Wire.TransactionParams(json: params))
        case .signInRelease: XCTAssertNoThrow(try Wire.ReleaseParams(json: params))
        }
      }
    }
  }
}
