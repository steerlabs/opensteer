import Darwin
import Foundation
import PasswordsCore
@testable import PasswordsBrokerKit

/// The desktop's side of the socket, for tests: a real Unix-socket client that
/// frames JSON the way `broker-client.ts` does and reads every frame back.
/// Every frame both ways goes to the run's artifact.
final class TestClient: @unchecked Sendable {
  let name: String
  private let descriptor: Int32
  private let lock = NSLock()
  private var frames: [JSONValue] = []
  private var answered: [Int64] = []
  private var closed = false
  private var nextID: Int64 = 1

  init(socket: URL, name: String = "desktop") throws {
    self.name = name
    descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let path = Array(socket.path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else {
      Darwin.close(descriptor)
      throw POSIXError(.ECONNREFUSED)
    }
    var one: Int32 = 1
    setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    let thread = Thread { [self] in readLoop() }
    thread.start()
  }

  deinit {
    Darwin.close(descriptor)
  }

  // MARK: Sending

  func sendRaw(_ bytes: Data) {
    _ = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
  }

  func sendFrame(_ payload: Data) {
    var framed = Data()
    let length = UInt32(payload.count)
    framed.append(contentsOf: [UInt8(length >> 24 & 0xFF), UInt8(length >> 16 & 0xFF), UInt8(length >> 8 & 0xFF), UInt8(length & 0xFF)])
    framed.append(payload)
    sendRaw(framed)
  }

  /// Sends `{id, method, params}`; returns the id.
  @discardableResult
  func send(_ method: String, _ params: JSONValue = .object([:])) -> Int64 {
    let id = lock.withLock { () -> Int64 in
      defer { nextID += 1 }
      return nextID
    }
    let request = JSONValue.object(["id": .integer(id), "method": .string(method), "params": params])
    Artifact.record(client: name, direction: "out", frame: request)
    sendFrame(try! CanonicalJSON.encode(request))
    return id
  }

  /// Sends and waits for the answer to it.
  func call(_ method: String, _ params: JSONValue = .object([:]), timeout: TimeInterval = 5) async throws -> Reply {
    let id = send(method, params)
    return try await reply(to: id, timeout: timeout)
  }

  func hello(version: Int64 = Wire.protocolVersion) async throws -> Reply {
    try await call("hello", .object(["client": .object(["version": .string("test")]), "protocolVersion": .integer(version)]))
  }

  func close() {
    Darwin.shutdown(descriptor, SHUT_RDWR)
  }

  // MARK: Reading

  enum Reply: Equatable {
    case result(JSONValue)
    case error(code: String, message: String)

    var result: JSONValue? {
      if case .result(let value) = self { return value }
      return nil
    }

    var errorCode: String? {
      if case .error(let code, _) = self { return code }
      return nil
    }
  }

  struct Timeout: Error {}

  func reply(to id: Int64, timeout: TimeInterval = 5) async throws -> Reply {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let reply = takeReply(id) { return reply }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    throw Timeout()
  }

  /// The answer to `id` if it already came.
  func takeReply(_ id: Int64) -> Reply? {
    lock.withLock {
      for (index, frame) in frames.enumerated() {
        guard case .object(let fields) = frame, fields["id"] == .integer(id) else { continue }
        frames.remove(at: index)
        if case .object(let error)? = fields["error"], case .string(let code)? = error["code"],
          case .string(let message)? = error["message"]
        {
          return .error(code: code, message: message)
        }
        return .result(fields["result"] ?? .null)
      }
      return nil
    }
  }

  /// Every `name` event received so far (`status.changed` unless named), taken.
  func takeEvents(_ name: String = "status.changed") -> [JSONValue] {
    lock.withLock {
      let events = frames.filter {
        if case .object(let fields) = $0, fields["event"] == .string(name) { return true }
        return false
      }
      frames.removeAll { frame in events.contains(frame) }
      return events.map {
        guard case .object(let fields) = $0 else { return .null }
        return fields["params"] ?? .null
      }
    }
  }

  /// The IDs of the calls answered so far, in the order their answers came.
  var answerOrder: [Int64] { lock.withLock { answered } }

  var isClosed: Bool { lock.withLock { closed } }
  var pendingFrameCount: Int { lock.withLock { frames.count } }

  func waitUntilClosed(timeout: TimeInterval = 5) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if isClosed { return }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    throw Timeout()
  }

  private func readLoop() {
    var decoder = FrameDecoder()
    var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
      if count <= 0 {
        if count < 0, errno == EINTR { continue }
        lock.withLock { closed = true }
        return
      }
      decoder.append(Data(buffer[0..<count]))
      while let frame = try? decoder.next() {
        guard let value = try? CanonicalJSON.parse(frame) else { continue }
        Artifact.record(client: name, direction: "in", frame: value)
        lock.withLock {
          frames.append(value)
          if case .object(let fields) = value, case .integer(let id)? = fields["id"] { answered.append(id) }
        }
      }
    }
  }
}

/// Every frame of every scenario, written after each test so a run can be
/// compared with the last: `$TMPDIR/opensteer-passwords-broker-swift-e2e.json`,
/// or `OPENSTEER_PASSWORDS_BROKER_ARTIFACT`.
enum Artifact {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var scenarios: [(String, [JSONValue])] = []
  nonisolated(unsafe) private static var current: String = "unnamed"

  static var url: URL {
    if let path = ProcessInfo.processInfo.environment["OPENSTEER_PASSWORDS_BROKER_ARTIFACT"] {
      return URL(fileURLWithPath: path)
    }
    return FileManager.default.temporaryDirectory.appendingPathComponent("opensteer-passwords-broker-swift-e2e.json")
  }

  static func begin(_ scenario: String) {
    lock.withLock {
      current = scenario
      scenarios.append((scenario, []))
    }
  }

  static func record(client: String, direction: String, frame: JSONValue) {
    lock.withLock {
      guard !scenarios.isEmpty else { return }
      scenarios[scenarios.count - 1].1.append(
        .object(["client": .string(client), "direction": .string(direction), "frame": frame]))
    }
  }

  static func write() {
    let value = lock.withLock {
      JSONValue.object([
        "artifact": .string("opensteer-passwords-broker-swift-e2e"),
        "scenarios": .array(scenarios.map { .object(["frames": .array($0.1), "name": .string($0.0)]) }),
      ])
    }
    try? CanonicalJSON.encode(value).write(to: url)
  }
}
