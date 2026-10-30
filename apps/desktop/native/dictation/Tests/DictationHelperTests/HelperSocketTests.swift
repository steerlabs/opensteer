import Darwin
import Foundation
import XCTest
import MacOSSigning
import OpensteerDictation
@testable import DictationHelperKit

private actor FakeEngine: HelperEngine {
  let emit: @Sendable (DictationEvent) -> Void
  var calls: [String] = []
  init(emit: @escaping @Sendable (DictationEvent) -> Void) { self.emit = emit }
  func availability() async -> DictationAvailability { .unavailable(.os) }
  func start(session: String) async throws { calls.append("start:\(session)") }
  func download(session: String) async throws { calls.append("download:\(session)") }
  func stop(session: String) async { calls.append("stop:\(session)") }
  func cancel(session: String) async { calls.append("cancel:\(session)") }
  func interrupt() async { calls.append("interrupt") }
  func event(_ session: String, _ seq: Int, ended: Bool = false) {
    emit(DictationEvent(session: session, seq: seq, payload: ended ? .ended(.completed, nil) : .listening))
  }
}

@MainActor
private final class SocketClient {
  var fd: Int32
  var decoder = FrameDecoder()
  init(_ url: URL) throws {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(url.path.utf8)) }
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else { close(); throw TestFailure.socket }
    _ = fcntl(fd, F_SETFL, O_NONBLOCK)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }
  func close() { if fd >= 0 { Darwin.close(fd); fd = -1 } }
  func send(_ method: String, _ session: String) throws {
    let data = try JSONSerialization.data(withJSONObject: ["id": 1, "method": method, "params": ["session": session]])
    let framed = try Frame.encode(data)
    let count = framed.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
    XCTAssertEqual(count, framed.count)
  }
  func next() async throws -> [String: Any] {
    let deadline = ContinuousClock.now + .seconds(3)
    while ContinuousClock.now < deadline {
      if let data = try decoder.next() {
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      }
      var bytes = [UInt8](repeating: 0, count: 4096)
      let count = Darwin.read(fd, &bytes, bytes.count)
      if count > 0 { decoder.append(Data(bytes.prefix(count))) }
      else if count == 0 { throw TestFailure.closed }
      try await Task.sleep(for: .milliseconds(2))
    }
    throw TestFailure.timeout
  }
  func expectClosed() async throws {
    let deadline = ContinuousClock.now + .seconds(3)
    while ContinuousClock.now < deadline {
      var byte: UInt8 = 0
      if Darwin.read(fd, &byte, 1) == 0 { return }
      try await Task.sleep(for: .milliseconds(2))
    }
    XCTFail("Replay connection was not closed")
  }
  enum TestFailure: Error { case socket, closed, timeout }
}

@MainActor
final class HelperSocketTests: XCTestCase {
  let first = "00000000-0000-4000-8000-000000000001"
  let second = "00000000-0000-4000-8000-000000000002"

  func testReplacementWaitsForLockAndServes() async throws {
    let root = URL(fileURLWithPath: "/tmp/s4-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("helper.lock")
    let old = try Helper.acquireLock(at: lockURL, wait: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { Darwin.close(old) }
    let replacement = try Helper.acquireLock(at: lockURL, wait: 1)
    defer { Darwin.close(replacement) }
    let helper = Helper { emit in FakeEngine(emit: emit) }
    let server = IPCServer(socketURL: root.appendingPathComponent("ipc"), verifier: PeerVerifier(rule: .sameUser), delegate: helper)
    try server.start()
    defer { server.stop() }
    let client = try SocketClient(server.socketURL)
    defer { client.close() }
    try client.send("start", first)
    let response = try await client.next()
    XCTAssertNotNil(response["result"])
  }

  func testReplacementGivesUpWhenLockStaysHeld() throws {
    let root = URL(fileURLWithPath: "/tmp/s4-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let lockURL = root.appendingPathComponent("helper.lock")
    let old = try Helper.acquireLock(at: lockURL, wait: 0)
    defer { Darwin.close(old) }
    let start = ContinuousClock.now
    XCTAssertThrowsError(try Helper.acquireLock(at: lockURL, wait: 0.3))
    let elapsed = start.duration(to: .now)
    XCTAssertGreaterThanOrEqual(elapsed, .milliseconds(250))
    XCTAssertLessThan(elapsed, .seconds(2))
  }

  func testOwnershipDisconnectLateEventsAndReplay() async throws {
    for method in ["start", "download"] {
      var engine: FakeEngine!
      let helper = Helper { emit in engine = FakeEngine(emit: emit); return engine }
      let root = URL(fileURLWithPath: "/tmp/s4-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let server = IPCServer(socketURL: root.appendingPathComponent("ipc"), verifier: PeerVerifier(rule: .sameUser), delegate: helper)
      try server.start()
      defer { server.stop(); try? FileManager.default.removeItem(at: root) }
      let a = try SocketClient(server.socketURL)
      let b = try SocketClient(server.socketURL)
      defer { a.close(); b.close() }
      try a.send(method, first)
      _ = try await a.next()
      try b.send("stop", first); _ = try await b.next()
      try b.send("cancel", first); _ = try await b.next()
      let calls = await engine.calls
      XCTAssertEqual(calls, ["\(method):\(first)"])
      await engine.event(first, 1)
      let listening = try await a.next()
      XCTAssertEqual((listening["event"] as? [String: Any])?["type"] as? String, "listening")
      // A response acts as a FIFO barrier: no foreign event may precede it.
      try b.send("stop", first)
      let barrier = try await b.next()
      XCTAssertNil(barrier["event"])
      await engine.event(first, 2, ended: true)
      let ended = try await a.next()
      XCTAssertEqual((ended["event"] as? [String: Any])?["type"] as? String, "ended")
      await engine.event(first, 3)
      try a.send("stop", first)
      let lateBarrier = try await a.next()
      XCTAssertNil(lateBarrier["event"])
      try a.send(method, first)
      try await a.expectClosed()
      try b.send(method, second)
      _ = try await b.next()
      b.close()
      let deadline = ContinuousClock.now + .seconds(3)
      while !(await engine.calls).contains("cancel:\(second)"), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(2))
      }
      let final = await engine.calls
      XCTAssertEqual(final, ["\(method):\(first)", "\(method):\(second)", "cancel:\(second)"])
    }
  }
}
