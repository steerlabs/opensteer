import Foundation
import LocalAuthentication
import PasswordsCore
import PasswordsTestSupport
import XCTest

@testable import PasswordsBrokerKit

/// Authentication the test decides: confirm, cancel, fail, or wait until the
/// action is withdrawn. It never touches LocalAuthentication, so no test can
/// show a prompt.
final class ScriptedPresence: PresenceChecker, @unchecked Sendable {
  enum Outcome {
    case confirm
    case cancel
    case fail
    case unavailable
    /// Waits until the asking task is cancelled, then reports it cancelled, as
    /// LocalAuthentication does when its context is invalidated mid-prompt.
    case holdUntilWithdrawn
    /// Waits for `releaseHeld()`, then succeeds even if the asking task was
    /// cancelled meanwhile: a Touch ID that finished as the action ended.
    case holdThenConfirm
  }

  private let lock = NSLock()
  private var outcomes: [Outcome] = []
  private var asked: [String] = []
  private var confirmations = 0
  private var holding = 0
  private var released = false

  /// Outcomes for the next checks, in order; once used up, checks confirm.
  func next(_ outcome: Outcome...) {
    lock.withLock { outcomes.append(contentsOf: outcome) }
  }

  /// Every reason asked for, in order.
  var reasons: [String] { lock.withLock { asked } }
  var lastReason: String? { lock.withLock { asked.last } }
  var askCount: Int { lock.withLock { asked.count } }
  var confirmCount: Int { lock.withLock { confirmations } }
  /// Checks waiting now.
  var holdingCount: Int { lock.withLock { holding } }

  func releaseHeld() {
    lock.withLock { released = true }
  }

  func authenticate(reason: String) async throws -> Authentication {
    let outcome = lock.withLock { () -> Outcome in
      asked.append(reason)
      return outcomes.isEmpty ? .confirm : outcomes.removeFirst()
    }
    switch outcome {
    case .confirm:
      if Task.isCancelled { throw PresenceError.cancelled }
    case .cancel:
      throw PresenceError.cancelled
    case .fail:
      throw PresenceError.failed
    case .unavailable:
      throw PresenceError.unavailable
    case .holdUntilWithdrawn:
      lock.withLock { holding += 1 }
      defer { lock.withLock { holding -= 1 } }
      while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000) }
      throw PresenceError.cancelled
    case .holdThenConfirm:
      lock.withLock { holding += 1 }
      defer { lock.withLock { holding -= 1 } }
      while !lock.withLock({ released }) { try? await Task.sleep(nanoseconds: 5_000_000) }
    }
    lock.withLock { confirmations += 1 }
    return Authentication(reason: reason)
  }
}

@MainActor
final class RecordingWindows: PasswordsWindowPresenter {
  private(set) var opened = 0
  func openPasswordsWindow() { opened += 1 }
}

/// One broker on a real socket in a fresh folder, with software owner keys
/// and scripted authentication.
@MainActor
final class BrokerHarness {
  let directory: URL
  let paths: BrokerPaths
  let protected: FileProtectedStore
  let keys: SoftwareOwnerKeys
  let presence = ScriptedPresence()
  let windows = RecordingWindows()
  let activity: ActivityLog
  let vault: VaultService
  let broker: Broker
  private(set) var server: IPCServer!
  private var clients: [TestClient] = []

  /// `/tmp` keeps the socket path well inside `sun_path`.
  /// The store the broker's vault uses, when the test controls it.
  let controlled: ControlledStore?

  init(
    secureEnclave: Bool = true, windowIdleLimit: TimeInterval = 5 * 60,
    controlledStore: Bool = false
  ) throws {
    directory = URL(fileURLWithPath: "/tmp", isDirectory: true)
      .appendingPathComponent("pwb-\(UUID().uuidString.prefix(8))", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    paths = BrokerPaths(root: directory)
    protected = try FileProtectedStore(directory: paths.protectedFiles)
    keys = SoftwareOwnerKeys(isAvailable: secureEnclave)
    activity = ActivityLog(url: paths.activity)
    controlled = controlledStore ? try ControlledStore(directory: paths.protectedFiles) : nil
    vault = VaultService(
      root: paths.vault, protectedStore: controlled ?? protected, keys: keys, deviceName: "Test Mac"
    )
    broker = Broker(
      configuration: BrokerConfiguration(
        development: true, brokerVersion: "9.9.9-test", windowIdleLimit: windowIdleLimit),
      vault: vault, presence: presence, activity: activity)
    broker.windows = windows
  }

  func start() async throws {
    await broker.load()
    server = IPCServer(
      socketURL: paths.socket, verifier: PeerVerifier(rule: .sameUser), delegate: broker)
    try server.start()
  }

  /// Set up, with agent sign-ins on (the default after setup), and `items`
  /// saved in setup's visit, which then ends as if the window closed.
  func ready(items: [ItemDraft] = []) async throws {
    try await broker.setUp()
    for item in items { _ = try await broker.addLogin(item) }
    broker.windowClosed()
    XCTAssertEqual(broker.condition, .ready)
  }

  func client(_ name: String = "desktop", greet: Bool = true) async throws -> TestClient {
    let client = try TestClient(socket: paths.socket, name: name)
    clients.append(client)
    if greet {
      let hello = try await client.hello()
      XCTAssertNotNil(hello.result)
    }
    return client
  }

  func stop() async {
    server?.stop()
    for client in clients { client.close() }
    await activity.flush()
    try? FileManager.default.removeItem(at: directory)
  }

  /// The vault as it is on disk, opened afresh.
  func headSeq() throws -> Int64 {
    try Vault.open(root: paths.vault, protectedStore: protected).head.seq
  }

  func savedItems() async throws -> [Item] {
    let owner = try keys.load(from: protected)
    let vault = try Vault.open(root: paths.vault, protectedStore: protected)
    let unlocked = try vault.unlock(owner: owner)
    defer { unlocked.close() }
    return try unlocked.items()
  }

  /// The grants as they are on disk.
  func savedGrants() throws -> [Grant] {
    let owner = try keys.load(from: protected)
    let unlocked = try Vault.open(root: paths.vault, protectedStore: protected).unlock(owner: owner)
    defer { unlocked.close() }
    return unlocked.grants
  }

  /// Waits for `condition`, letting the broker's main-actor work run.
  func eventually(
    _ what: String = "condition", timeout: TimeInterval = 5, file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("Timed out waiting for \(what).", file: file, line: line)
    throw TestClient.Timeout()
  }
}

// MARK: Requests

enum Fixtures {
  static let deployment = ("dep_personal", "Personal")
  static let workspace = ("wsp_00000000-0000-4000-8000-000000000003", "Main")
  static let otherWorkspace = ("wsp_00000000-0000-4000-8000-000000000009", "Side projects")
  static let session = "bsn_00000000-0000-4000-8000-000000000007"

  static func request(
    _ transactionId: String = UUID().uuidString.lowercased(), site: String = "https://example.com",
    session: String = session, expiresIn: TimeInterval = 600,
    expiresAt: String? = nil, deploymentId: String = deployment.0,
    workspace: (String, String) = workspace,
    extra: [String: JSONValue] = [:]
  ) -> JSONValue {
    var fields: [String: JSONValue] = [
      "deploymentId": .string(deploymentId),
      "deploymentName": .string(deployment.1),
      "expiresAt": .string(expiresAt ?? iso(Date().addingTimeInterval(expiresIn))),
      "reason": .string("Check the invoice"),
      "runtimeId": .string("desktop-browser"),
      "sessionId": .string(session),
      "site": .string(site),
      "threadTitle": .string("Invoices"),
      "transactionId": .string(transactionId),
      "workspaceId": .string(workspace.0),
      "workspaceName": .string(workspace.1),
    ]
    for (key, value) in extra { fields[key] = value }
    return .object(fields)
  }

  static func probe(site: String = "https://example.com") -> JSONValue {
    .object(["site": .string(site)])
  }

  static func approve(_ transactionId: String, _ account: JSONValue?, remember: Bool) -> JSONValue {
    .object([
      "loginId": account?["id"] ?? .null, "remember": .bool(remember),
      "revision": account?["revision"] ?? .null,
      "transactionId": .string(transactionId),
    ])
  }

  static func release(
    _ transactionId: String, field: String = "password", origin: String = "https://example.com"
  ) -> JSONValue {
    .object([
      "transactionId": .string(transactionId), "field": .string(field), "origin": .string(origin),
    ])
  }

  /// The grant key a default request uses.
  static func grantKey(site: String = "https://example.com", workspace: String = workspace.0)
    -> GrantKey
  {
    GrantKey(deploymentId: deployment.0, workspaceId: workspace, site: site)
  }

  static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  static func transaction(_ id: String) -> JSONValue { .object(["transactionId": .string(id)]) }

  static func login(
    _ host: String = "example.com", username: String = "alice@example.com",
    password: String = "synthetic-password-1",
    totp: TOTPParameters? = nil, label: String? = nil, origins: [String]? = nil,
    loginURL: String? = nil
  ) -> ItemDraft {
    let origins = origins ?? ["https://\(host)"]
    return ItemDraft(
      origins: origins, loginURL: loginURL ?? origins[0] + "/login", username: username,
      password: password, totp: totp,
      label: label)
  }
}

extension JSONValue {
  subscript(_ key: String) -> JSONValue? {
    guard case .object(let fields) = self else { return nil }
    return fields[key]
  }

  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  subscript(_ index: Int) -> JSONValue? {
    guard case .array(let values) = self, values.indices.contains(index) else { return nil }
    return values[index]
  }

  var count: Int? {
    if case .array(let values) = self { return values.count }
    return nil
  }
}
