import Foundation

/// How much an approval of this app is worth naming out loud (§2 "Deny list").
public enum AppRisk: String, Codable, Sendable {
  case standard
  case elevated
}

/// The helper's verdict on one bundle identifier.
public struct AppVerdict: Sendable, Equatable {
  public let allowed: Bool
  public let risk: AppRisk
  /// One sentence the approval panel and the model can both read. Never a path.
  public let reason: String
}

/// The deny list and the elevated-risk list of docs/computer-use.md §2.
///
/// This is the helper's own floor, not an approval list: the Host is the
/// authority for approvals (invariant 3), and nothing a Host says makes a
/// denied app operable.
///
/// An entry is either one exact bundle identifier or a **family**: a vendor's
/// identifier and every variant build of it, which vendors name by appending
/// `.something` or `-something` (`-setapp`, `.beta`, `-Preview`, `-3`). A
/// family never matches a longer word, so `com.raycast` would not catch
/// `com.raycastle`.
public enum AppPolicy {

  /// Why an app is refused. The category decides the sentence, so a new entry
  /// cannot arrive without one.
  public enum DenyCategory: Sendable, Equatable {
    case passwordManager
    case terminal
    case automation
    case opensteer
    case securitySurface

    var reason: String {
      switch self {
      case .passwordManager:
        return "Opensteer does not operate password managers."
      case .terminal:
        return "Opensteer does not operate terminal apps; ask for a command instead."
      case .automation:
        return "Opensteer does not operate script and automation tools, because they can "
          + "run anything on this Mac; ask for a command instead."
      case .opensteer:
        return "Opensteer does not operate itself."
      case .securitySurface:
        return "Opensteer does not operate macOS security prompts."
      }
    }
  }

  /// Why an approval of this app is worth naming.
  public enum ElevatedCategory: Sendable, Equatable {
    case browser
    case files
    case mail
    case messages
    case systemSettings
    case developerTools

    var reason: String {
      switch self {
      case .browser:
        return "A browser can reach every site this Mac is signed in to."
      case .files:
        return "Finder can move, rename and delete files on this Mac."
      case .mail:
        return "Mail can read and send messages as you."
      case .messages:
        return "Messages can read and send messages as you."
      case .systemSettings:
        return "System Settings can change how this Mac works."
      case .developerTools:
        return "This app has a built-in terminal, so it can run commands on this Mac."
      }
    }
  }

  static let denied: [String: DenyCategory] = [
    // Password managers.
    "com.apple.passwords": .passwordManager,
    "com.apple.keychainaccess": .passwordManager,
    "com.bitwarden.desktop": .passwordManager,
    "com.dashlane.dashlanephonefinal": .passwordManager,
    "com.nordsec.nordpass": .passwordManager,
    "com.hicknhacksoftware.macpass": .passwordManager,
    // Opensteer Passwords holds the person's vault and draws its own approvals,
    // so no agent may drive it, whichever build is installed.
    "com.opensteer.passwords": .passwordManager,
    "com.opensteer.passwords.dev": .passwordManager,
    // Terminals.
    "com.apple.terminal": .terminal,
    "com.googlecode.iterm2": .terminal,
    "net.kovidgoyal.kitty": .terminal,
    "com.github.wez.wezterm": .terminal,
    "com.mitchellh.ghostty": .terminal,
    "com.raphaelamorim.rio": .terminal,
    "dev.commandline.waveterm": .terminal,
    "org.alacritty": .terminal,
    "co.zeit.hyper": .terminal,
    "org.tabby": .terminal,
    // Script and automation tools, which run anything the person could.
    "com.apple.scripteditor2": .automation,
    "com.apple.automator": .automation,
    "com.apple.shortcuts": .automation,
    "org.hammerspoon.hammerspoon": .automation,
    // Opensteer itself, in every shape it ships.
    "com.opensteer.opensteer": .opensteer,
    "com.steerlabs.opensteer.beta": .opensteer,
    "com.opensteer.computer-use": .opensteer,
    // macOS security surfaces.
    "com.apple.securityagent": .securitySurface,
    "com.apple.localauthentication.uiagent": .securitySurface,
    "com.apple.localauthenticationremoteservice": .securitySurface,
    "com.apple.usernotificationcenter": .securitySurface,
  ]

  /// Vendors whose every build is refused.
  static let deniedFamilies: [String: DenyCategory] = [
    "com.1password": .passwordManager,
    "com.agilebits.onepassword": .passwordManager,
    "com.agilebits.onepassword7": .passwordManager,
    "com.lastpass": .passwordManager,
    "me.proton.pass": .passwordManager,
    "org.keepassxc": .passwordManager,
    "in.sinew.enpass": .passwordManager,
    "in.sinew.walletx": .passwordManager,
    "com.markmcguill.strongbox": .passwordManager,
    "com.keepersecurity": .passwordManager,
    "com.callpod.keepermac": .passwordManager,
    "com.siber.roboform": .passwordManager,
    "com.keepassium": .passwordManager,
    "dev.warp.warp": .terminal,
    "com.stairways.keyboardmaestro": .automation,
    "com.hegenberg.bettertouchtool": .automation,
    "com.raycast": .automation,
    "com.runningwithcrayons.alfred": .automation,
    "com.latenightsw": .automation,
  ]

  static let elevated: [String: ElevatedCategory] = [
    "com.apple.safari": .browser,
    "com.google.chrome": .browser,
    "org.chromium.chromium": .browser,
    "com.brave.browser": .browser,
    "com.microsoft.edgemac": .browser,
    "org.mozilla.firefox": .browser,
    "company.thebrowser.browser": .browser,
    "com.operasoftware.opera": .browser,
    "com.vivaldi.vivaldi": .browser,
    "com.apple.safaritechnologypreview": .browser,
    "com.google.chrome.beta": .browser,
    "com.google.chrome.dev": .browser,
    "com.google.chrome.canary": .browser,
    "org.mozilla.firefoxdeveloperedition": .browser,
    "org.mozilla.nightly": .browser,
    "company.thebrowser.dia": .browser,
    "net.imput.helium": .browser,
    "com.apple.finder": .files,
    "com.apple.mail": .mail,
    "com.apple.mobilesms": .messages,
    "com.apple.systempreferences": .systemSettings,
    // Editors with a built-in terminal.
    "com.apple.dt.xcode": .developerTools,
    "com.microsoft.vscode": .developerTools,
    "com.microsoft.vscodeinsiders": .developerTools,
    "com.vscodium": .developerTools,
    "com.todesktop.230313mzl4w4u92": .developerTools,
    "com.exafunction.windsurf": .developerTools,
    "com.panic.nova": .developerTools,
  ]

  static let elevatedFamilies: [String: ElevatedCategory] = [
    "dev.zed.zed": .developerTools,
    "com.jetbrains": .developerTools,
    "com.google.android.studio": .developerTools,
  ]

  /// The bundle identifiers of browsers, which also decide where
  /// `AXManualAccessibility` is worth setting (§2 "Observation").
  public static let browserBundleIdentifiers: Set<String> = Set(
    elevated.filter { $0.value == .browser }.keys
  )

  public static func verdict(for bundleIdentifier: String) -> AppVerdict {
    // LaunchServices treats bundle identifiers case-insensitively, so the lists
    // are matched that way; an app cannot slip past by changing its case.
    let key = bundleIdentifier.lowercased()
    if let denied = denied[key] ?? family(of: key, in: deniedFamilies) {
      return AppVerdict(allowed: false, risk: .elevated, reason: denied.reason)
    }
    if let elevated = elevated[key] ?? family(of: key, in: elevatedFamilies) {
      return AppVerdict(allowed: true, risk: .elevated, reason: elevated.reason)
    }
    return AppVerdict(
      allowed: true,
      risk: .standard,
      reason: "An agent can do anything in this app that you can."
    )
  }

  /// The category of the family `key` belongs to: the family's own
  /// identifier, or it followed by `.` or `-` and anything.
  static func family<Category>(of key: String, in families: [String: Category]) -> Category? {
    for (prefix, category) in families
    where key == prefix || key.hasPrefix(prefix + ".") || key.hasPrefix(prefix + "-") {
      return category
    }
    return nil
  }

  public static func isBrowser(_ bundleIdentifier: String) -> Bool {
    browserBundleIdentifiers.contains(bundleIdentifier.lowercased())
  }
}
