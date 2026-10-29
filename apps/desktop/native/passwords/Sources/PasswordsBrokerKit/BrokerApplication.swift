import AppKit
import Foundation
import PasswordsCore
import SystemConfiguration

/// Peer authority comes from this process’s signature; development trust is compiled in.
public struct BrokerBuild: Sendable {
  public let development: Bool
  /// Who may connect: the Opensteer desktop app (release) or this user (development).
  public let desktopRule: PeerRule
  /// What `--verify-peer` and `--prepare-replacement` hold the running broker to.
  public let brokerRule: PeerRule
  /// `<TeamID>.com.opensteer.passwords` in a release build; nil uses the
  /// development file store.
  public let keychainAccessGroup: String?

  public init(development: Bool, desktopRule: PeerRule, brokerRule: PeerRule, keychainAccessGroup: String?) {
    self.development = development
    self.desktopRule = desktopRule
    self.brokerRule = brokerRule
    self.keychainAccessGroup = keychainAccessGroup
  }
}

/// `Opensteer Passwords.app`: an accessory app (no Dock tile, no menu bar)
/// that serves one socket and draws its own window. The person approves
/// sign-ins in the Opensteer window; the broker shows only the system
/// authentication prompt it asks for and the Passwords window.
@MainActor
public final class BrokerApplication: NSObject, NSApplicationDelegate {
  /// How long a new instance waits for one that is quitting to let go.
  static let lockWait: TimeInterval = 5
  static let socketCheckInterval: TimeInterval = 2

  private let build: BrokerBuild
  private var lock: InstanceLock?
  private var server: IPCServer?
  private var broker: Broker?
  private var windows: PasswordsWindowController?
  private var socketWatch: Timer?
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []

  public init(build: BrokerBuild) {
    self.build = build
  }

  public func applicationDidFinishLaunching(_ notification: Notification) {
    NSApplication.shared.mainMenu = Self.menu()
    // Opened by the person (Finder, Spotlight) rather than by Opensteer's
    // `open -g`: show the window they came for.
    let openedByPerson = NSApplication.shared.isActive
    Task {
      await start()
      if openedByPerson { windows?.openPasswordsWindow() }
    }
  }

  /// Opensteer's `open -g -a` also reopens a running broker without
  /// activating it; only a reopen the person made (which activates) shows
  /// the window.
  public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if sender.isActive { windows?.openPasswordsWindow() }
    return false
  }

  public func applicationWillTerminate(_ notification: Notification) {
    broker?.stop()
    socketWatch?.invalidate()
    server?.stop()
    for (center, token) in observers { center.removeObserver(token) }
    lock?.release()
  }

  private func start() async {
    let paths = BrokerPaths.canonical(development: build.development)
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    Log.lifecycle.notice(
      "Opensteer Passwords \(version, privacy: .public) starting (\(self.build.development ? "development" : "release", privacy: .public)).")
    do {
      try Self.privateDirectory(paths.root)
      lock = try InstanceLock.acquire(at: paths.instanceLock, wait: Self.lockWait)
    } catch {
      Log.lifecycle.error("Another Opensteer Passwords is running; quitting.")
      return quit()
    }
    let store: any ProtectedStore
    do {
      store = try build.keychainAccessGroup.map(KeychainProtectedStore.init(accessGroup:))
        ?? FileProtectedStore(directory: paths.protectedFiles)
    } catch {
      Log.lifecycle.fault("The protected store could not be opened; quitting.")
      return quit()
    }
    let vault = VaultService(
      root: paths.vault, protectedStore: store, keys: SecureEnclaveOwnerKeys(), deviceName: Self.deviceName())
    let activity = ActivityLog(url: paths.activity)
    let broker = Broker(
      configuration: BrokerConfiguration(development: build.development, brokerVersion: version), vault: vault,
      presence: LocalAuthenticationPresence(), activity: activity)
    await broker.load()
    let windows = PasswordsWindowController(
      model: PasswordsWindowModel(broker: broker, activityLog: activity, runner: ImportRunner.bundled()))
    broker.windows = windows
    self.broker = broker
    self.windows = windows

    let server = IPCServer(socketURL: paths.socket, verifier: PeerVerifier(rule: build.desktopRule), delegate: broker)
    do {
      try server.start()
    } catch {
      Log.lifecycle.fault("The socket could not be opened; quitting.")
      return quit()
    }
    self.server = server

    let distributed = DistributedNotificationCenter.default()
    let workspace = NSWorkspace.shared.notificationCenter
    let events: [(NotificationCenter, Notification.Name, @MainActor @Sendable (Broker) -> Void)] = [
      (distributed, Notification.Name("com.apple.screenIsLocked"), { $0.screenLocked() }),
      (distributed, Notification.Name("com.apple.screenIsUnlocked"), { $0.screenUnlocked() }),
      (workspace, NSWorkspace.willSleepNotification, { $0.willSleep() }),
      (workspace, NSWorkspace.didWakeNotification, { $0.sweepExpired() }),
    ]
    for (center, name, handle) in events {
      let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak broker] _ in
        MainActor.assumeIsolated {
          if let broker { handle(broker) }
        }
      }
      observers.append((center, token))
    }
    let timer = Timer(timeInterval: Self.socketCheckInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, let server = self.server, !server.ownsSocketPath() else { return }
        // The desktop launched a fresh instance, which owns the path now.
        Log.lifecycle.notice("The socket was taken over; quitting.")
        self.quit()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    socketWatch = timer
  }

  private func quit() {
    NSApplication.shared.terminate(nil)
  }

  static func privateDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // An existing folder keeps whatever mode it had.
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
  }

  /// "Alex’s MacBook Pro", recorded in the vault's owner list. Read from
  /// System Configuration, which is local; `Host.current()` may wait on DNS.
  static func deviceName() -> String {
    let name = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ""
    let cleaned = Display.clean(name, limit: 100)
    return cleaned.isEmpty ? "Mac" : cleaned
  }

  /// Edit commands, so text fields take paste, and Close Window. No Quit:
  /// Opensteer starts the broker when it needs it.
  static func menu() -> NSMenu {
    let main = NSMenu()
    let appItem = NSMenuItem()
    appItem.submenu = NSMenu(title: Copy.appName)
    main.addItem(appItem)
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)
    let windowItem = NSMenuItem()
    let window = NSMenu(title: "Window")
    window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = window
    main.addItem(windowItem)
    return main
  }
}
