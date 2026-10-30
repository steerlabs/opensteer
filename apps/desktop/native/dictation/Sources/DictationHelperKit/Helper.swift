import AppKit
import Darwin
import Foundation
import MacOSSigning
import OpensteerDictation

public struct HelperRequest: Codable {
  public let id: Int
  public let method: String
  public let params: Params
  public struct Params: Codable { public let session: String? }
  public static func decode(_ data: Data) throws -> HelperRequest {
    let request = try JSONDecoder().decode(Self.self, from: data)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let params = object?["params"] as? [String: Any]
    let methods = ["availability", "start", "download", "stop", "cancel", "interrupt"]
    guard Set(object?.keys.map { $0 } ?? []) == Set(["id", "method", "params"]),
      request.id > 0, methods.contains(request.method), let params
    else { throw WireFailure.invalid }
    let needsSession = ["start", "download", "stop", "cancel"].contains(request.method)
    if needsSession {
      guard Set(params.keys) == Set(["session"]), let session = request.params.session,
        session.range(
          of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          options: .regularExpression) != nil
      else { throw WireFailure.invalid }
    } else if !params.isEmpty {
      throw WireFailure.invalid
    }
    return request
  }
  enum WireFailure: Error { case invalid }
}

protocol HelperEngine: Sendable {
  func availability() async -> DictationAvailability
  func start(session: String) async throws
  func download(session: String) async throws
  func stop(session: String) async
  func cancel(session: String) async
  func interrupt() async
}
extension DictationService: HelperEngine {}

@MainActor
public final class Helper: NSObject, NSApplicationDelegate, IPCServerDelegate {
  private var server: IPCServer?
  private var connections: [Int: IPCConnection] = [:]
  private var owner = SessionOwner()
  private var instance: Int32 = -1
  private var monitor: Timer?
  private var usedSessions = Set<String>()
  private let makeEngine: (@escaping @Sendable (DictationEvent) -> Void) -> any HelperEngine
  private lazy var engine = makeEngine { [weak self] event in
    DispatchQueue.main.async { MainActor.assumeIsolated { self?.emit(event) } }
  }
  public static var development: Bool {
    #if OPENSTEER_DEV_TRUST
      true
    #else
      false
    #endif
  }
  public static var root: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      "Library/Application Support/Opensteer/"
        + (development ? "Dictation (Development)" : "Dictation"))
  }
  public static var identifier: String {
    development ? "com.opensteer.dictation.dev" : "com.opensteer.dictation"
  }
  public static func rule(desktop: Bool) -> PeerRule? {
    #if OPENSTEER_DEV_TRUST
      return .sameUser
    #else
      guard
        let text = MacCodeIdentity.requirement(
          teamId: MacCodeIdentity.ownTeamId(),
          identifiers: desktop
            ? ["com.opensteer.opensteer", "com.steerlabs.opensteer.beta"] : [identifier])
      else { return nil }
      return .codeRequirement(text)
    #endif
  }
  public override init() {
    makeEngine = { DictationService(emit: $0) }
    super.init()
  }
  init(makeEngine: @escaping (@escaping @Sendable (DictationEvent) -> Void) -> any HelperEngine) {
    self.makeEngine = makeEngine
    super.init()
  }
  public func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      try FileManager.default.createDirectory(
        at: Self.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      guard chmod(Self.root.path, 0o700) == 0, let rule = Self.rule(desktop: true) else {
        throw Failure.start
      }
      instance = Darwin.open(
        Self.root.appendingPathComponent("helper.lock").path,
        O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard instance >= 0, flock(instance, LOCK_EX | LOCK_NB) == 0 else { throw Failure.start }
      let server = IPCServer(
        socketURL: Self.root.appendingPathComponent("ipc.sock"), verifier: PeerVerifier(rule: rule, subsystem: "com.opensteer.dictation"),
        delegate: self, subsystem: "com.opensteer.dictation")
      try server.start()
      self.server = server
      monitor = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated {
          if self?.server?.ownsSocketPath() == false { NSApplication.shared.terminate(nil) }
        }
      }
    } catch { NSApplication.shared.terminate(nil) }
  }
  public func applicationWillTerminate(_ notification: Notification) {
    monitor?.invalidate()
    server?.stop()
    // Process exit closes capture; no recognition finalization delays quit.
    if instance >= 0 { Darwin.close(instance) }
  }
  public func connectionOpened(_ connection: IPCConnection) {
    connections[connection.id] = connection
  }
  public func connectionClosed(_ connection: IPCConnection) {
    connections[connection.id] = nil
    if let session = owner.disconnected(connection.id) {
      Task { await engine.cancel(session: session) }
    }
  }
  public func connection(_ connection: IPCConnection, received frame: Data) {
    guard let request = try? HelperRequest.decode(frame) else {
      connection.close()
      return
    }
    Task {
      guard connections[connection.id] === connection else { return }
      if request.method == "availability" {
        let availability = await engine.availability()
        guard connections[connection.id] === connection else { return }
        reply(connection, id: request.id, result: availability)
        return
      }
      if let session = request.params.session,
        request.method == "start" || request.method == "download" {
        if owner.owns(session: session, connection: connection.id) {
          send(connection, ["id": request.id, "result": NSNull()])
          return
        }
        // A reused ID cannot produce another terminal event (§3).
        guard usedSessions.insert(session).inserted else {
          connection.close()
          return
        }
      }
      send(connection, ["id": request.id, "result": NSNull()])
      if request.method == "interrupt" {
        if owner.connection == connection.id { await engine.interrupt() }
      } else if let session = request.params.session {
        if request.method == "start" || request.method == "download" {
          if owner.claim(session: session, connection: connection.id) {
            do {
              if request.method == "start" {
                try await engine.start(session: session)
              } else {
                try await engine.download(session: session)
              }
            } catch { connection.close() }
          } else if !owner.owns(session: session, connection: connection.id) {
            send(
              connection,
              [
                "event": [
                  "type": "ended", "session": session, "seq": 1, "reason": "failed",
                  "error": "busy",
                ]
              ])
          }
        } else if owner.owns(session: session, connection: connection.id) {
          if request.method == "stop" {
            await engine.stop(session: session)
          } else {
            await engine.cancel(session: session)
          }
        }
      }
    }
  }
  private func emit(_ event: DictationEvent) {
    guard let data = try? JSONEncoder().encode(event),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let session = object["session"] as? String,
      owner.session == session, let connectionID = owner.connection,
      let connection = connections[connectionID]
    else { return }
    send(connection, ["event": object])
    if object["type"] as? String == "ended" { owner.release(session: session) }
  }
  private func reply<T: Encodable>(_ connection: IPCConnection, id: Int, result: T) {
    guard let data = try? JSONEncoder().encode(result),
      let object = try? JSONSerialization.jsonObject(with: data)
    else {
      connection.close()
      return
    }
    send(connection, ["id": id, "result": object])
  }
  private func send(_ connection: IPCConnection, _ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else {
      connection.close()
      return
    }
    connection.send(data)
  }
  enum Failure: Error { case start }
}
