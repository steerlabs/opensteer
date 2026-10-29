import Darwin
import Foundation
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// The socket itself, over a real Unix socket in a temporary directory. The
/// development peer requirement is a same-user check, which the test process
/// satisfies, so this exercises accept, framing, reply and close together.
final class IPCServerTests: XCTestCase {
  private var socketURL: URL!
  private var server: IPCServer!

  override func setUpWithError() throws {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("cu-\(UInt32.random(in: 0...UInt32.max))", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    socketURL = directory.appendingPathComponent("ipc.sock")
  }

  override func tearDown() {
    server?.stop()
    server = nil
    if let socketURL {
      try? FileManager.default.removeItem(at: socketURL.deletingLastPathComponent())
    }
  }

  /// The regression this exists for: an answer handed over immediately before
  /// `close()` — `incompatible-version`, or a first frame that is not `hello` —
  /// must still reach the peer.
  func testAnAnswerSentJustBeforeCloseStillArrives() throws {
    let received = expectation(description: "the helper answered")
    server = IPCServer(
      socketURL: socketURL,
      verifier: PeerVerifier(mode: .sameUser),
      onFrame: { connection, _ in
        connection.send(
          response: .failure(
            id: .number(1),
            error: HelperError(.incompatibleVersion, "Update Opensteer.")
          )
        )
        connection.close()
      },
      onConnectionClosed: { _ in }
    )
    try startIPCServer(server)

    let client = try connect()
    defer { Darwin.close(client) }
    try write(client, try Frame.encode(Data(#"{"id":1,"method":"hello"}"#.utf8)))

    let payload = try readFrame(client)
    let object = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: payload) as? [String: Any]
    )
    let error = try XCTUnwrap(object["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "incompatible-version")
    received.fulfill()
    wait(for: [received], timeout: 1)
  }

  func testEveryFrameOnOneConnectionIsAnsweredInOrder() throws {
    let answered = expectation(description: "three answers")
    answered.expectedFulfillmentCount = 1
    server = IPCServer(
      socketURL: socketURL,
      verifier: PeerVerifier(mode: .sameUser),
      onFrame: { connection, frame in
        guard
          let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
          let id = object["id"] as? Int
        else { return }
        connection.send(response: .success(id: .number(Double(id)), result: ["echo": id]))
      },
      onConnectionClosed: { _ in }
    )
    try startIPCServer(server)

    let client = try connect()
    defer { Darwin.close(client) }
    for id in 1...3 {
      try write(client, try Frame.encode(Data(#"{"id":\#(id)}"#.utf8)))
    }
    var ids: [Int] = []
    for _ in 1...3 {
      let object =
        try JSONSerialization.jsonObject(with: try readFrame(client)) as? [String: Any] ?? [:]
      ids.append(object["id"] as? Int ?? -1)
    }
    XCTAssertEqual(ids, [1, 2, 3])
    answered.fulfill()
    wait(for: [answered], timeout: 1)
  }

  func testAFrameOverFourMebibytesClosesTheConnectionWithoutAnAnswer() throws {
    let closed = expectation(description: "the helper closed the connection")
    server = IPCServer(
      socketURL: socketURL,
      verifier: PeerVerifier(mode: .sameUser),
      onFrame: { _, _ in XCTFail("An oversize frame must never reach a handler.") },
      onConnectionClosed: { _ in closed.fulfill() }
    )
    try startIPCServer(server)

    let client = try connect()
    defer { Darwin.close(client) }
    let length = Frame.maxBytes + 1
    try write(
      client,
      Data([
        UInt8(truncatingIfNeeded: length >> 24),
        UInt8(truncatingIfNeeded: length >> 16),
        UInt8(truncatingIfNeeded: length >> 8),
        UInt8(truncatingIfNeeded: length),
      ]))
    wait(for: [closed], timeout: 2)
  }

  func testTheSupportDirectoryIsPrivateAndTheStaleSocketIsReplaced() throws {
    try Data().write(to: socketURL)
    server = IPCServer(
      socketURL: socketURL,
      verifier: PeerVerifier(mode: .sameUser),
      onFrame: { _, _ in },
      onConnectionClosed: { _ in }
    )
    // A leftover file where the socket belongs must not stop the helper.
    try startIPCServer(server)
    let directory = socketURL.deletingLastPathComponent().path
    let mode = try FileManager.default.attributesOfItem(atPath: directory)[.posixPermissions]
    XCTAssertEqual(mode as? NSNumber, 0o700)
  }

  // MARK: - A small blocking client

  private func connect() throws -> Int32 {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(descriptor, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketURL.path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let status = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
        Darwin.connect(descriptor, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard status == 0 else {
      Darwin.close(descriptor)
      throw HelperError(.failed, "The test client could not connect.")
    }
    return descriptor
  }

  private func write(_ descriptor: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let written = Darwin.write(
          descriptor,
          raw.baseAddress?.advanced(by: offset),
          raw.count - offset
        )
        guard written > 0 else { throw HelperError(.failed, "The test client could not write.") }
        offset += written
      }
    }
  }

  private func readFrame(_ descriptor: Int32) throws -> Data {
    let header = try read(descriptor, count: 4)
    let length = header.withUnsafeBytes { raw -> Int in
      let base = raw.bindMemory(to: UInt8.self)
      return (Int(base[0]) << 24) | (Int(base[1]) << 16) | (Int(base[2]) << 8) | Int(base[3])
    }
    return try read(descriptor, count: length)
  }

  private func read(_ descriptor: Int32, count: Int) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: count)
    while data.count < count {
      let read = buffer.withUnsafeMutableBytes { raw in
        Darwin.read(descriptor, raw.baseAddress, count - data.count)
      }
      guard read > 0 else { throw HelperError(.failed, "The test client read nothing.") }
      data.append(contentsOf: buffer[0..<read])
    }
    return data
  }
}
