import Darwin
import PasswordsCore
import XCTest

@testable import PasswordsBrokerKit

/// Section 9 of FAILURES.md: the socket, `hello`, framing and validation.
@MainActor
final class IPCTests: BrokerTestCase {
  func testHelloAndStatus() async throws {
    let desktop = try await harness.client(greet: false)
    same(
      try await desktop.hello(),
      .result(
        .object([
          "brokerVersion": .string("9.9.9-test"), "development": .bool(true),
          "protocolVersion": .integer(Wire.protocolVersion),
        ])))
    same(
      try await desktop.call("status").result,
      .object(["agentSignIns": .string("off"), "vault": .string("not-set-up")]))
  }

  func testFirstFrameMustBeHello() async throws {
    let desktop = try await harness.client(greet: false)
    same(try await desktop.call("status").errorCode, "invalid")
    try await desktop.waitUntilClosed()
  }

  func testHelloWithAnotherVersionIsAnsweredAndClosed() async throws {
    let desktop = try await harness.client(greet: false)
    same(
      try await desktop.hello(version: 1).result?["protocolVersion"],
      .integer(Wire.latestProtocolVersion), "the broker says its latest version")
    try await desktop.waitUntilClosed()
  }

  func testMalformedHelloClosesAndSecondHelloIsRefused() async throws {
    for params: JSONValue in [
      .object(["protocolVersion": .integer(1)]),
      .object(["client": .object(["version": .string("")]), "protocolVersion": .integer(1)]),
      .object([
        "client": .object(["version": .string("x")]), "protocolVersion": .integer(1),
        "extra": .null,
      ]),
      .object(["client": .object(["version": .string("x")]), "protocolVersion": .string("1")]),
    ] {
      let desktop = try await harness.client(greet: false)
      same(try await desktop.call("hello", params).errorCode, "invalid")
      try await desktop.waitUntilClosed()
    }
    let desktop = try await harness.client()
    same(try await desktop.hello().errorCode, "invalid")
    XCTAssertFalse(desktop.isClosed)
  }

  func testOversizeFrameClosesTheConnection() async throws {
    let desktop = try await harness.client()
    let length = UInt32(Frame.maxBytes + 1)
    desktop.sendRaw(
      Data([
        UInt8(length >> 24), UInt8(length >> 16 & 0xFF), UInt8(length >> 8 & 0xFF),
        UInt8(length & 0xFF),
      ]))
    try await desktop.waitUntilClosed()
    XCTAssertEqual(desktop.pendingFrameCount, 0, "closed without an answer")
  }

  func testUnreadableFramesCloseOrAreRefused() async throws {
    for frame in [
      "not json", #"{"id":1,"method":"status","params":{},"extra":1}"#,
      #"{"id":0,"method":"status","params":{}}"#,
      #"{"id":1.5,"method":"status","params":{}}"#,
      #"{"id":1,"id":2,"method":"status","params":{}}"#,
      #"{"id":1,"method":"status","params":[]}"#, #"[1]"#, #"{"id":1,"method":"status"}"#,
    ] {
      let desktop = try await harness.client()
      desktop.sendFrame(Data(frame.utf8))
      try await desktop.waitUntilClosed()
    }
    let desktop = try await harness.client()
    same(
      try await desktop.call("vault.export").errorCode, "invalid",
      "an unknown method is refused, not dropped")
    XCTAssertFalse(desktop.isClosed)
  }

  /// B8, X4, X30: every v2 method's parameters are a closed object, and the
  /// v1 surface is gone.
  func testEveryMethodValidatesItsParameters() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    let asked = presence.askCount
    let id = UUID().uuidString.lowercased()
    let login = UUID().uuidString.lowercased()
    func approve(_ fields: [String: JSONValue]) -> JSONValue {
      var base: [String: JSONValue] = [
        "loginId": .string(login), "remember": .bool(true), "revision": .integer(1),
        "transactionId": .string(id),
      ]
      for (key, value) in fields { base[key] = value }
      return .object(base)
    }
    var cases: [(String, JSONValue, String)] = [
      ("status", .object(["x": .null]), "status takes nothing"),
      ("window.open", .object(["view": .string("passwords")]), "v1's view"),
      (
        "window.open", .object(["transactionId": .string(id), "view": .string("requests")]),
        "v1's request view"
      ),
      (
        "signin.release",
        .object([
          "transactionId": .string("not-a-uuid"), "field": .string("password"),
          "origin": .string("https://example.com"),
        ]), "transaction ID"
      ),
      ("signin.release", Fixtures.release(id, field: "seed"), "no TOTP seed release"),
      ("signin.release", Fixtures.release(id, origin: "https://example.com/path"), "exact origin"),
      ("signin.cancel", .object(["transactionId": .integer(1)]), "transaction ID type"),
      ("signin.approve", approve(["loginId": .string("not-a-uuid")]), "login ID"),
      ("signin.approve", approve(["revision": .integer(-1)]), "negative revision"),
      ("signin.approve", approve(["revision": .string("1")]), "revision type"),
      ("signin.approve", approve(["remember": .string("yes")]), "remember type"),
      ("signin.approve", approve(["remember": .null]), "remember missing"),
      ("signin.approve", approve(["extra": .null]), "extra key"),
      (
        "signin.probe",
        .object([
          "deploymentId": .string(Fixtures.deployment.0), "site": .string("https://example.com"),
          "workspaceId": .string(Fixtures.workspace.0),
        ]), "the probe carries only the site"
      ),
      ("signin.probe", .object(["site": .string("http://example.com")]), "probe site"),
      ("signin.probe", .object([:]), "probe without a site"),
      ("signin.cancelAll", .object([:]), "cancelAll is gone"),
    ]
    for method in ["signin.problem", "signin.offerSave", "signin.stop"] {
      cases.append((method, .object(["transactionId": .string(id)]), "the v1 method \(method)"))
    }
    for site in [
      "http://example.com", "https://www.example.com", "https://EXAMPLE.com",
      "https://example.com:8443",
      "https://127.0.0.1", "https://localhost", "https://github.io", "https://co.uk",
      "https://example.com/",
      "example.com",
    ] {
      cases.append(("signin.request", Fixtures.request(site: site), "site \(site)"))
    }
    for (key, value) in [
      ("transactionId", JSONValue.string("6F1C2A4B-5D6E-1F80-CA1B-2C3D4E5F6071")),
      ("runtimeId", .string("")),
      ("sessionId", .string(String(repeating: "s", count: 129))),
      ("deploymentId", .string("")),
      ("deploymentName", .string(" Personal")),
      ("workspaceName", .string("Main ")),
      ("workspaceId", .string("wsp_00000000-0000-0000-0000-000000000000")),
      ("workspaceId", .string("ws_00000000-0000-4000-8000-000000000003")),
      ("workspaceId", .integer(3)),
      ("reason", .string("")),
      ("reason", .string(String(repeating: "r", count: 501))),
      ("threadTitle", .string(String(repeating: "t", count: 201))),
      ("deployment", .object(["id": .string("d"), "name": .string("Personal")])),
      ("extra", .null),
    ] {
      cases.append(("signin.request", Fixtures.request(extra: [key: value]), "\(key) \(value)"))
    }
    for (method, params, why) in cases {
      same(try await desktop.call(method, params).errorCode, "invalid", why)
    }
    let upperWorkspace = try await desktop.call(
      "signin.request",
      Fixtures.request(workspace: ("WSP_00000000-0000-4000-8000-00000000000A", "Main")))
    XCTAssertNotNil(
      upperWorkspace.result, "Workspace IDs match case-insensitively, as the Host's schema does")
    XCTAssertEqual(presence.askCount, asked, "no refusal asked for anyone")
    XCTAssertFalse(desktop.isClosed, "refusals keep the connection")
  }

  func testRefusedPeerIsClosedUnanswered() async throws {
    let socket = harness.directory.appendingPathComponent("refusing.sock")
    // A requirement this test runner cannot satisfy: only the Opensteer desktop app.
    let refusing = IPCServer(
      socketURL: socket,
      verifier: PeerVerifier(rule: .codeRequirement(#"identifier "com.opensteer.opensteer""#)),
      delegate: broker)
    try refusing.start()
    defer { refusing.stop() }
    let stranger = try TestClient(socket: socket, name: "stranger")
    stranger.send(
      "hello",
      .object(["client": .object(["version": .string("x")]), "protocolVersion": .integer(1)]))
    try await stranger.waitUntilClosed()
    XCTAssertEqual(stranger.pendingFrameCount, 0, "not a byte back")
  }

  func testEventsReachGreetedConnectionsOnly() async throws {
    let greeted = try await harness.client("greeted")
    let silent = try await harness.client("silent", greet: false)
    try await harness.ready()
    try await harness.eventually("an event") { !greeted.takeEvents().isEmpty }
    XCTAssertTrue(silent.takeEvents().isEmpty)
    _ = try await silent.hello()
    try await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertTrue(silent.takeEvents().isEmpty, "no stale event after hello")
    // A peer that went away without reading does not take the broker down.
    greeted.close()
    try await broker.setAgentSignIns(false)
    same(try await silent.call("status").result?["agentSignIns"], .string("off"))
  }

  func testSecondInstanceCannotTakeTheLock() throws {
    let url = harness.directory.appendingPathComponent("broker.lock")
    let first = try InstanceLock.acquire(at: url, wait: 0)
    let started = Date()
    XCTAssertThrowsError(try InstanceLock.acquire(at: url, wait: 0.3)) {
      XCTAssertEqual($0 as? InstanceLock.Failure, .held)
    }
    XCTAssertGreaterThanOrEqual(
      Date().timeIntervalSince(started), 0.3, "it waited before giving up")
    first.release()
    XCTAssertNoThrow(try InstanceLock.acquire(at: url, wait: 0))
  }

  func testLockWaitIsBounded() throws {
    let url = harness.directory.appendingPathComponent("broker.lock")
    let first = try InstanceLock.acquire(at: url, wait: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { first.release() }
    XCTAssertNoThrow(
      try InstanceLock.acquire(at: url, wait: 3), "the instance that was quitting let go in time")
  }

  func testStaleSocketIsReplacedUnderTheLock() async throws {
    harness.server.stop()
    // A socket file nobody listens on, as a killed broker leaves it.
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let path = Array(harness.paths.socket.path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path) }
    _ = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    Darwin.close(descriptor)
    XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.socket.path))
    let server = IPCServer(
      socketURL: harness.paths.socket, verifier: PeerVerifier(rule: .sameUser), delegate: broker)
    try server.start()
    defer { server.stop() }
    let desktop = try TestClient(socket: harness.paths.socket)
    same(try await desktop.hello().result?["protocolVersion"], .integer(Wire.protocolVersion))
  }

  func testSocketAndFolderArePrivate() throws {
    var information = stat()
    XCTAssertEqual(lstat(harness.paths.socket.path, &information), 0)
    XCTAssertEqual(information.st_mode & 0o777, 0o600)
    let root = harness.directory.appendingPathComponent("Root")
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
    try BrokerApplication.privateDirectory(root)
    XCTAssertEqual(lstat(root.path, &information), 0)
    XCTAssertEqual(information.st_mode & 0o777, 0o700, "an existing folder is made private too")
  }

  func testBrokerNoticesItsSocketWasTaken() throws {
    XCTAssertTrue(harness.server.ownsSocketPath())
    unlink(harness.paths.socket.path)
    XCTAssertFalse(harness.server.ownsSocketPath(), "unlinked by a desktop launching afresh")
    let replacement = IPCServer(
      socketURL: harness.paths.socket, verifier: PeerVerifier(rule: .sameUser), delegate: broker)
    try replacement.start()
    defer { replacement.stop() }
    XCTAssertFalse(harness.server.ownsSocketPath(), "another instance's socket")
    harness.server.stop()
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: harness.paths.socket.path),
      "stopping never removes another's socket")
    XCTAssertTrue(replacement.ownsSocketPath())
  }

  func testOverlongSocketPathIsRefused() {
    let long = URL(fileURLWithPath: "/tmp/" + String(repeating: "x", count: 120) + "/ipc.sock")
    let server = IPCServer(
      socketURL: long, verifier: PeerVerifier(rule: .sameUser), delegate: broker)
    XCTAssertThrowsError(try server.start()) { XCTAssertEqual($0 as? IPCServerError, .pathTooLong) }
  }

  func testWindowOpen() async throws {
    try await harness.ready(items: [Fixtures.login()])
    let desktop = try await harness.client()
    same(try await desktop.call("window.open").result, .object([:]))
    try await harness.eventually("the window") { harness.windows.opened == 1 }
    _ = try await request(desktop, UUID().uuidString.lowercased())
    same(try await desktop.call("window.open").result, .object([:]))
    try await harness.eventually("the window again, whatever waits") { harness.windows.opened == 2 }
  }
}

final class FrameTests: XCTestCase {
  func testDecoderRefusesOversizeAtOnce() throws {
    var decoder = FrameDecoder()
    decoder.append(Data([0x00, 0x04, 0x00, 0x01]))
    XCTAssertThrowsError(try decoder.next())
    decoder.append(Data(repeating: 0, count: 10))
    XCTAssertThrowsError(try decoder.next(), "stays failed")
  }

  func testFramesSplitAndJoined() throws {
    var decoder = FrameDecoder()
    let one = try Frame.encode(Data("{}".utf8))
    let two = try Frame.encode(Data("[1]".utf8))
    let joined = one + two
    decoder.append(joined.prefix(3))
    XCTAssertNil(try decoder.next())
    decoder.append(joined.dropFirst(3))
    XCTAssertEqual(try decoder.next(), Data("{}".utf8))
    XCTAssertEqual(try decoder.next(), Data("[1]".utf8))
    XCTAssertNil(try decoder.next())
    XCTAssertThrowsError(try Frame.encode(Data(count: Frame.maxBytes + 1)))
  }
}
