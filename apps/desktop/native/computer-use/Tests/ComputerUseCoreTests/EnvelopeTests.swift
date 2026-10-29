import Foundation
import XCTest

@testable import ComputerUseCore

final class EnvelopeTests: XCTestCase {
  private func json(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONCoding.encoder.encode(value)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return object
  }

  func testDecodesARequest() throws {
    let data = Data(#"{"id":7,"method":"hello","params":{"protocolVersion":1}}"#.utf8)
    let envelope = try JSONCoding.decoder.decode(RequestEnvelope.self, from: data)
    XCTAssertEqual(envelope.method, "hello")
    XCTAssertEqual(envelope.id, .number(7))
    let params = try envelope.decodeParams(Wire.HelloParams.self, method: "hello")
    XCTAssertEqual(params.protocolVersion, 1)
  }

  func testEchoesAStringIdentifierVerbatim() throws {
    let data = Data(#"{"id":"cus_abc","method":"permissions.get"}"#.utf8)
    let envelope = try JSONCoding.decoder.decode(RequestEnvelope.self, from: data)
    let response = ResponseEnvelope.success(
      id: envelope.id,
      result: Wire.PermissionsResult(permissions: PermissionsState(accessibility: .granted, screenRecording: .granted))
    )
    XCTAssertEqual(try json(response)["id"] as? String, "cus_abc")
  }

  func testAResultEnvelopeCarriesNoErrorKey() throws {
    let response = ResponseEnvelope.success(
      id: .number(1),
      result: Wire.EmptyResult()
    )
    let object = try json(response)
    XCTAssertNotNil(object["result"])
    XCTAssertNil(object["error"])
  }

  func testAnErrorEnvelopeCarriesCodeAndMessage() throws {
    let response = ResponseEnvelope.failure(
      id: .number(2),
      error: HelperError(.busy, "This app is already being used by another task.")
    )
    let object = try json(response)
    XCTAssertNil(object["result"])
    let body = try XCTUnwrap(object["error"] as? [String: Any])
    XCTAssertEqual(body["code"] as? String, "busy")
    XCTAssertEqual(body["message"] as? String, "This app is already being used by another task.")
  }

  func testTheEventEnvelopeIsEventAndParams() throws {
    let event = EventEnvelope(
      event: HelperEvent.sessionStopped,
      params: SessionStoppedParams(reason: .appQuit, sessionId: "cus_1")
    )
    let object = try json(event)
    XCTAssertEqual(object["event"] as? String, "session.stopped")
    let params = try XCTUnwrap(object["params"] as? [String: Any])
    XCTAssertEqual(Set(params.keys), ["reason", "sessionId"])
    XCTAssertEqual(params["reason"] as? String, "app-quit")
    XCTAssertEqual(params["sessionId"] as? String, "cus_1")
  }

  func testEveryErrorCodeIsSpelledAsTheSpecificationSpellsIt() {
    XCTAssertEqual(
      Set(HelperErrorCode.allCases.map(\.rawValue)),
      [
        "permission-required", "app-not-allowed", "app-not-found", "app-not-running",
        "no-session", "busy", "owner-in-control", "stale-observation", "stopped-by-user",
        "unsupported", "failed", "outcome-unknown", "delivery-unconfirmed", "incompatible-version",
      ]
    )
  }

  func testDecodesActionsWithTypeDiscriminator() throws {
    let data = Data(
      """
      [{"type":"click","target":{"index":3},"button":"right","count":2},
       {"type":"type","text":"hello"},
       {"type":"key","keys":"cmd+s"}]
      """.utf8)
    let actions = try JSONCoding.decoder.decode([ActionRequest].self, from: data)
    guard case .click(_, let button, let count) = actions[0] else {
      return XCTFail("expected a click")
    }
    XCTAssertEqual(button, .right)
    XCTAssertEqual(count, 2)
    guard case .type("hello", nil) = actions[1] else { return XCTFail("expected typing") }
    XCTAssertEqual(actions[2].label, "key")
  }

  /// Protocol 3: every observe and act names its app as the Host resolved it,
  /// with the access the grant resolved.
  func testObserveAndActCarryTheirAppAndAccess() throws {
    let observe = try JSONCoding.decoder.decode(
      Wire.ObserveParams.self,
      from: Data(
        #"{"sessionId":"s","window":"ref-A","snapshot":null,"app":{"access":"read","identity":{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null}}}"#
          .utf8))
    XCTAssertEqual(
      observe.app,
      SessionApp(
        access: .read,
        identity: AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil)))
    // A bare bundle identifier was protocol 2; it is not a target any more.
    XCTAssertThrowsError(
      try JSONCoding.decoder.decode(
        Wire.ObserveParams.self,
        from: Data(
          #"{"sessionId":"s","window":"ref-A","snapshot":null,"app":"com.apple.Notes"}"#.utf8)))
    let open = try JSONCoding.decoder.decode(
      Wire.SessionOpenParams.self, from: Data(#"{"sessionId":"s","threadTitle":null}"#.utf8))
    XCTAssertEqual(open.sessionId, "s")
  }

  func testTypeMayNameATarget() throws {
    let actions = try JSONCoding.decoder.decode(
      [ActionRequest].self,
      from: Data(
        #"[{"type":"type","text":"a"},{"type":"type","text":"b","target":{"index":4}},{"type":"type","text":"c","target":{"x":3,"y":5}}]"#
          .utf8))
    guard case .type("a", nil) = actions[0] else { return XCTFail("expected an untargeted type") }
    guard case .type("b", .index(4)?) = actions[1] else { return XCTFail("expected an index") }
    guard case .type("c", .point(let point)?) = actions[2] else {
      return XCTFail("expected a point")
    }
    XCTAssertEqual(point, CGPoint(x: 3, y: 5))
  }

  /// `timeoutMs` counts from receipt; a value outside the protocol's range is
  /// refused with the request's own id rather than dropped with the frame.
  func testTheDeadlineCountsFromReceipt() throws {
    let received = Date(timeIntervalSince1970: 1_000)
    let envelope = try JSONCoding.decoder.decode(
      RequestEnvelope.self,
      from: Data(#"{"id":3,"method":"session.act","params":{},"timeoutMs":2500}"#.utf8))
    XCTAssertEqual(
      try envelope.deadline(receivedAt: received), received.addingTimeInterval(2.5))
    let none = try JSONCoding.decoder.decode(
      RequestEnvelope.self, from: Data(#"{"id":4,"method":"session.act","params":{}}"#.utf8))
    XCTAssertNil(try none.deadline(receivedAt: received))
    for bad in ["0", "120001", "1.5", "\"10\""] {
      let envelope = try JSONCoding.decoder.decode(
        RequestEnvelope.self,
        from: Data(#"{"id":5,"method":"session.act","params":{},"timeoutMs":\#(bad)}"#.utf8))
      XCTAssertThrowsError(try envelope.deadline(receivedAt: received), bad)
      XCTAssertEqual(envelope.id, .number(5))
    }
  }
}
