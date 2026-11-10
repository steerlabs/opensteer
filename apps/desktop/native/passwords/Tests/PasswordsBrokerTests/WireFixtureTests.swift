import Foundation
@testable import PasswordsCore
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
  private static var card: Wire.CardChoice {
    Wire.CardChoice(CardItem(id: loginId,
      draft: CardDraft(number: "4242424242424242", expiryMonth: 3, expiryYear: 2030, cvc: "123", label: "Test card"),
      createdAt: 0, updatedAt: 0, revision: 3))
  }

  private static var cardRequest: JSONValue {
    Fixtures.request(transactionId, site: "https://github.com", expiresAt: "2026-10-11T17:00:00.000Z",
      extra: ["protocolVersion": .integer(7), "permissionVersion": .integer(7)])
  }
  private static var cardApproval: JSONValue {
    .object(["transactionId": .string(transactionId), "cardId": .string(loginId),
      "revision": .integer(3), "permissionVersion": .integer(7)])
  }
  private static func cardRelease(_ field: Wire.CardField) -> JSONValue {
    .object(["transactionId": .string(transactionId), "topOrigin": .string("https://github.com"),
      "frameOrigin": .string("https://js.stripe.com"), "field": .string(field.rawValue)])
  }

  private static func fillBegin(_ presence: Wire.FillPresence) throws -> Wire.FillBeginParams {
    try Wire.FillBeginParams(json: .object(["transactionId": .string(transactionId),
      "loginId": .string(loginId), "revision": .integer(3), "origin": .string("https://github.com"),
      "presence": .string(presence.rawValue)]))
  }

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
    modernFields["protocolVersion"] = .integer(6)
    modernFields["permissionVersion"] = .integer(5)
    let modern = try Wire.SignInRequestParams(json: .object(modernFields), protocolVersion: 6)
    let modernReleases = try Wire.ReleaseField.allCases.flatMap { field -> [JSONValue] in
      try [
        Wire.ReleaseParams(
          json: .object([
            "transactionId": .string(transactionId), "field": .string(field.rawValue),
            "kind": .string("app"),
          ])
        ).json,
        Wire.ReleaseParams(
          json: .object([
            "transactionId": .string(transactionId), "field": .string(field.rawValue),
            "kind": .string("browser"), "origin": .string("https://github.com"),
          ])
        ).json,
      ]
    }
    let transaction = Wire.TransactionParams(transactionId: transactionId)
    return [
      Wire.Method.hello.rawValue: [
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 4).json,
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 5).json,
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 6).json,
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 7).json,
        Wire.HelloParams(clientVersion: "0.1.117", protocolVersion: 8).json,
      ],
      Wire.Method.fillAccounts.rawValue: [try Wire.FillAccountsParams(json: .object(["origin": .string("https://github.com")])).json],
      Wire.Method.fillBegin.rawValue: [try fillBegin(.here).json, try fillBegin(.elsewhere).json],
      Wire.Method.cardProbe.rawValue: [.object([:])],
      Wire.Method.cardRequest.rawValue: [try Wire.CardRequestParams(json: cardRequest).json],
      Wire.Method.cardApprove.rawValue: [cardApproval],
      Wire.Method.cardRelease.rawValue: Wire.CardField.allCases.map(cardRelease),
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
      Wire.Method.signInCommit.rawValue: [transaction.json],
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
        Wire.HelloResult(brokerVersion: "0.1.117", development: false, protocolVersion: 6).json,
        Wire.HelloResult(brokerVersion: "0.1.117", development: true).json,
        Wire.HelloResult(brokerVersion: "0.1.117", development: false, protocolVersion: 7).json,
        Wire.HelloResult(brokerVersion: "0.1.117", development: false, protocolVersion: 8).json,
      ],
      Wire.Method.fillAccounts.rawValue: [
        Wire.fillAccounts(.on, [Wire.FillAccount(id: loginId, revision: 3, username: "sam@example.com", label: "Work", hasCode: true)]),
        Wire.fillAccounts(.on), Wire.fillAccounts(.off), Wire.fillAccounts(.notSetUp)],
      Wire.Method.fillBegin.rawValue: [Wire.FillDecision.authorized(Date(timeIntervalSince1970: 1_800_000_000)).json,
        Wire.FillDecision.changed.json, Wire.FillDecision.cancelled.json,
        Wire.FillDecision.unavailable(.off).json, Wire.FillDecision.unavailable(.notSetUp).json,
        Wire.FillDecision.unavailable(.busy).json],
      Wire.Method.cardProbe.rawValue: ["has-card", "no-card", "off", "not-set-up", "unavailable"].map { .object(["cards": .string($0)]) },
      Wire.Method.cardRequest.rawValue: [Wire.cardChoices([card]), Wire.cardChoices([]), Wire.Decision.unavailable(.busy).json],
      Wire.Method.cardApprove.rawValue: [
        .object(["decision": .string("authorized"), "card": card.descriptor]),
        Wire.cardChoices([], message: Copy.accountGone), Wire.Decision.unavailable(.passwordsOff).json],
      Wire.Method.cardRelease.rawValue: [Wire.ReleaseResult.released("4242424242424242").json] +
        ["ended", "revoked", "wrong-site", "passwords-off", "no-field"].map(Wire.cardRefused),
      Wire.Method.status.rawValue: [
        Wire.Status(vault: .ready, agentSignIns: true).json,
        Wire.Status(vault: .notSetUp, agentSignIns: false).json,
        Wire.Status(vault: .unsupported, agentSignIns: false).json,
        Wire.Status(vault: .needsReset, agentSignIns: false).json,
        Wire.Status(vault: .ready, agentSignIns: true, personFill: true).json(protocolVersion: 8),
        Wire.Status(vault: .ready, agentSignIns: false, personFill: false).json(protocolVersion: 8),
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
      Wire.Method.signInCommit.rawValue: [
        .object(["committed": .bool(true)]), .object(["committed": .bool(false)]),
      ],
    ]
  }

  private static func text() throws -> String {
    let error = try CanonicalJSON.parse(
      Wire.error(id: 7, Wire.Failure(.invalid, "There is no open sign-in with that ID.")))
    let event = try CanonicalJSON.parse(
      Wire.statusChanged(Wire.Status(vault: .ready, agentSignIns: true)))
    let fixture = JSONValue.object([
      "rejected": .array([
        .object(["method": .string("fill.begin"), "params": cardApproval]),
        .object(["method": .string("fill.accounts"), "params": Fixtures.probe()]),
        .object(["method": .string("signin.approve"), "params": try fillBegin(.here).json]),
        .object(["method": .string("card.approve"), "params": try fillBegin(.elsewhere).json]),
        .object(["method": .string("card.approve"), "params": Fixtures.approve(transactionId, .object(["id": .string(loginId), "revision": .integer(3)]), remember: true)]),
        .object(["method": .string("card.release"), "params": Fixtures.release(transactionId)]),
        .object(["method": .string("signin.release"), "params": cardRelease(.number)]),
      ]),
      "error": error,
      "event": event,
      "eventV8": try CanonicalJSON.parse(Wire.statusChanged(Wire.Status(vault: .ready, agentSignIns: false, personFill: true), protocolVersion: 8)),
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

  func testRejectedCrossKindSamples() throws {
    let fixture = try CanonicalJSON.parse(try Data(contentsOf: Self.fixtureURL))
    guard case .array(let rejected)? = fixture["rejected"] else { return XCTFail("missing rejections") }
    for sample in rejected {
      let params = try XCTUnwrap(sample["params"])
      switch sample["method"]?.string {
      case "card.approve": XCTAssertThrowsError(try Wire.CardApproveParams(json: params))
      case "card.release": XCTAssertThrowsError(try Wire.CardReleaseParams(json: params))
      case "signin.release":
        for version: Int64 in [4, 5, 6, 7, 8] { XCTAssertThrowsError(try Wire.ReleaseParams(json: params, protocolVersion: version)) }
      case "signin.approve": XCTAssertThrowsError(try Wire.ApproveParams(json: params))
      case "fill.begin": XCTAssertThrowsError(try Wire.FillBeginParams(json: params))
      case "fill.accounts": XCTAssertThrowsError(try Wire.FillAccountsParams(json: params))
      default: XCTFail("unknown rejection")
      }
    }
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
        case .fillAccounts: XCTAssertNoThrow(try Wire.FillAccountsParams(json: params))
        case .fillBegin: XCTAssertNoThrow(try Wire.FillBeginParams(json: params))
        case .cardProbe: XCTAssertNoThrow(try Wire.empty(params))
        case .cardRequest: XCTAssertNoThrow(try Wire.CardRequestParams(json: params))
        case .cardApprove: XCTAssertNoThrow(try Wire.CardApproveParams(json: params))
        case .cardRelease: XCTAssertNoThrow(try Wire.CardReleaseParams(json: params))
        case .hello:
          XCTAssertTrue([4, 5, 6, 7, 8].contains(try Wire.HelloParams(json: params).protocolVersion))
        case .status, .windowOpen: XCTAssertNoThrow(try Wire.empty(params))
        case .signInProbe:
          XCTAssertEqual(try Wire.ProbeParams(json: params).site, "https://github.com")
        case .signInRequest:
          if params["protocolVersion"] == .integer(6) {
            for version: Int64 in [6, 7, 8] { XCTAssertNoThrow(try Wire.SignInRequestParams(json: params, protocolVersion: version)) }
          }
          XCTAssertEqual(try Wire.SignInRequestParams(json: params).siteHost, "github.com")
        case .signInApprove: XCTAssertNoThrow(try Wire.ApproveParams(json: params))
        case .signInCancel, .signInCommit:
          XCTAssertNoThrow(try Wire.TransactionParams(json: params))
        case .signInRelease: XCTAssertNoThrow(try Wire.ReleaseParams(json: params))
        }
      }
    }
  }
}
