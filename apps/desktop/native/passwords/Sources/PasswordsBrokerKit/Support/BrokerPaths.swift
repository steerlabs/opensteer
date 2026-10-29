import Foundation

/// Names the desktop app also uses (`apps/desktop/src/passwords/paths.ts`);
/// they must stay identical on both sides.
public enum BrokerIdentity {
  public static let appName = "Opensteer Passwords.app"
  public static let executableName = "Opensteer Passwords"
  public static let releaseBundleIdentifier = "com.opensteer.passwords"
  public static let developmentBundleIdentifier = "com.opensteer.passwords.dev"
  /// The sandboxed parser, at `Contents/Helpers/` inside the app.
  public static let importWorkerName = "Opensteer Passwords Import"

  public static func bundleIdentifier(development: Bool) -> String {
    development ? developmentBundleIdentifier : releaseBundleIdentifier
  }
}

/// Where one build of the broker keeps everything. The release and
/// development brokers never share a byte: separate roots, sockets, locks,
/// vaults and protected stores.
public struct BrokerPaths: Sendable, Equatable {
  /// `~/Library/Application Support/Opensteer/Passwords[ (Development)]`, 0700.
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  /// The root this build serves, under the person's real home folder.
  public static func canonical(development: Bool) -> BrokerPaths {
    BrokerPaths(
      root: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        .appendingPathComponent("Library/Application Support/Opensteer", isDirectory: true)
        .appendingPathComponent(development ? "Passwords (Development)" : "Passwords", isDirectory: true)
    )
  }

  public var socket: URL { root.appendingPathComponent("ipc.sock", isDirectory: false) }
  /// Held by the running broker for its whole life; never the desktop's `lifecycle.lock`.
  public var instanceLock: URL { root.appendingPathComponent("broker.lock", isDirectory: false) }
  public var vault: URL { root.appendingPathComponent("Vault", isDirectory: true) }
  /// The development build's `FileProtectedStore`; a release build uses the keychain.
  public var protectedFiles: URL { root.appendingPathComponent("Protected", isDirectory: true) }
  public var activity: URL { root.appendingPathComponent("activity.jsonl", isDirectory: false) }
  public var application: URL { root.appendingPathComponent(BrokerIdentity.appName, isDirectory: true) }
  public var executable: URL {
    application.appendingPathComponent("Contents/MacOS/\(BrokerIdentity.executableName)", isDirectory: false)
  }
}
