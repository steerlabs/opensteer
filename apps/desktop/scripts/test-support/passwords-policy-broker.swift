import Foundation
import PasswordsCore
@testable import PasswordsBrokerKit

// E2E-only authentication. Grant lookup, approval, persistence, release and IPC
// are the production broker; software owner keys avoid Secure Enclave prompts.
final class JourneyPresence: PresenceChecker, @unchecked Sendable {
  private let lock = NSLock()
  private var asked: [String] = []
  var reasons: [String] { lock.withLock { asked } }
  func authenticate(reason: String) async throws -> Authentication {
    lock.withLock { asked.append(reason) }
    return Authentication(reason: reason)
  }
}

@main struct PolicyBrokerJourney {
  @MainActor static func main() async throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let seed = try JSONDecoder().decode(Seed.self, from: Data(contentsOf: root.appendingPathComponent("seed.json")))
    let paths = BrokerPaths(root: root)
    let protected = try FileProtectedStore(directory: paths.protectedFiles)
    let keys = SoftwareOwnerKeys()
    let presence = JourneyPresence()
    let activity = ActivityLog(url: paths.activity)
    let vault = VaultService(root: paths.vault, protectedStore: protected, keys: keys, deviceName: "Policy journey")
    let broker = Broker(configuration: BrokerConfiguration(development: true, brokerVersion: "1.0.0-journey"), vault: vault, presence: presence, activity: activity)
    await broker.load()
    try await broker.setUp()
    _ = try await broker.addLogin(ItemDraft(origins: [seed.site], loginURL: seed.site + "/login", username: seed.username, password: seed.password))
    broker.windowClosed()
    guard broker.condition == .ready else { throw JourneyError.notReady }
    let server = IPCServer(socketURL: paths.socket, verifier: PeerVerifier(rule: .sameUser), delegate: broker)
    try server.start()
    defer { server.stop() }
    try Data("ready".utf8).write(to: root.appendingPathComponent("ready"), options: .atomic)
    // Never block MainActor: the real IPC server delivers its frames there.
    while let filename = await Task.detached(operation: { readLine() }).value {
      guard filename == URL(fileURLWithPath: filename).lastPathComponent, filename.hasSuffix(".json") else { throw JourneyError.badSnapshotName }
      let owner = try keys.load(from: protected)
      let disk = try Vault.open(root: paths.vault, protectedStore: protected)
      let unlocked = try disk.unlock(owner: owner)
      let grants: [[String: Any]] = unlocked.grants.map { grant in [
        "deploymentId": grant.key.deploymentId, "workspaceId": grant.key.workspaceId,
        "site": grant.key.site, "permissionVersion": grant.permissionVersion,
        "revision": grant.revision ?? 0, "loginId": grant.loginId,
        "deploymentName": grant.deploymentName, "workspaceName": grant.workspaceName,
      ] }
      unlocked.close()
      let snapshot: [String: Any] = ["grants": grants, "presenceReasons": presence.reasons, "headSeq": disk.head.seq]
      try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]).write(to: root.appendingPathComponent(filename), options: .atomic)
    }
    await activity.flush()
  }
  struct Seed: Decodable { let site: String; let username: String; let password: String }
  enum JourneyError: Error { case notReady, badSnapshotName }
}
