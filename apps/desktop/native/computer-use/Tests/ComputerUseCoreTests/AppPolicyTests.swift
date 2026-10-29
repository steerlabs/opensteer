import XCTest

@testable import ComputerUseCore

final class AppPolicyTests: XCTestCase {
  func testPasswordManagersAreRefused() {
    for bundleIdentifier in [
      "com.1password.1password", "com.1password.safari", "com.bitwarden.desktop",
      "com.dashlane.dashlanephonefinal", "com.lastpass.LastPass", "com.nordsec.nordpass",
      "me.proton.pass.electron", "me.proton.pass.catalyst", "com.apple.Passwords",
      "com.apple.keychainaccess", "com.agilebits.onepassword7", "org.keepassxc.keepassxc",
      "com.opensteer.passwords", "com.opensteer.passwords.dev", "COM.OPENSTEER.PASSWORDS",
    ] {
      let verdict = AppPolicy.verdict(for: bundleIdentifier)
      XCTAssertFalse(verdict.allowed, bundleIdentifier)
      XCTAssertEqual(verdict.reason, "Opensteer does not operate password managers.")
    }
  }

  func testTerminalsAreRefused() {
    for bundleIdentifier in [
      "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
      "net.kovidgoyal.kitty", "com.github.wez.wezterm", "com.mitchellh.ghostty",
      "com.raphaelamorim.rio", "dev.commandline.waveterm", "org.alacritty", "co.zeit.hyper",
      "org.tabby",
    ] {
      XCTAssertFalse(AppPolicy.verdict(for: bundleIdentifier).allowed, bundleIdentifier)
    }
  }

  func testOpensteerAndSecuritySurfacesAreRefused() {
    for bundleIdentifier in [
      "com.opensteer.opensteer", "com.steerlabs.opensteer.beta", "com.opensteer.computer-use",
      "com.apple.SecurityAgent", "com.apple.LocalAuthentication.UIAgent",
      "com.apple.LocalAuthenticationRemoteService", "com.apple.UserNotificationCenter",
    ] {
      XCTAssertFalse(AppPolicy.verdict(for: bundleIdentifier).allowed, bundleIdentifier)
    }
  }

  func testBrowsersFinderMailAndSystemSettingsAreAllowedAtElevatedRisk() {
    for bundleIdentifier in [
      "com.apple.Safari", "com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser",
      "com.microsoft.edgemac", "org.mozilla.firefox", "company.thebrowser.Browser",
      "com.operasoftware.Opera", "com.vivaldi.Vivaldi", "com.apple.finder", "com.apple.mail",
      "com.apple.systempreferences", "com.apple.MobileSMS", "com.apple.SafariTechnologyPreview",
      "com.google.Chrome.canary", "company.thebrowser.dia", "net.imput.helium",
    ] {
      let verdict = AppPolicy.verdict(for: bundleIdentifier)
      XCTAssertTrue(verdict.allowed, bundleIdentifier)
      XCTAssertEqual(verdict.risk, .elevated, bundleIdentifier)
      XCTAssertFalse(verdict.reason.isEmpty)
    }
  }

  func testAnOrdinaryAppIsAllowedAtNormalRisk() {
    let verdict = AppPolicy.verdict(for: "com.apple.Notes")
    XCTAssertTrue(verdict.allowed)
    XCTAssertEqual(verdict.risk, .standard)
  }

  /// LaunchServices does not care about case, so neither may the deny list.
  func testTheDenyListIgnoresCase() {
    XCTAssertFalse(AppPolicy.verdict(for: "COM.APPLE.TERMINAL").allowed)
    XCTAssertFalse(AppPolicy.verdict(for: "Dev.Warp.Warp-Stable").allowed)
  }

  func testBrowsersAreTheOnesThatGetManualAccessibility() {
    XCTAssertTrue(AppPolicy.isBrowser("com.google.Chrome"))
    XCTAssertFalse(AppPolicy.isBrowser("com.apple.Notes"))
  }

  /// Script and automation tools can run anything the person can, so they are
  /// refused like terminals — every build of each.
  func testScriptAndAutomationToolsAreRefused() {
    for bundleIdentifier in [
      "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts",
      "com.stairways.keyboardmaestro.editor", "com.stairways.keyboardmaestro.engine",
      "org.hammerspoon.Hammerspoon", "com.hegenberg.BetterTouchTool",
      "com.hegenberg.BetterTouchTool-setapp", "com.raycast.macos",
      "com.runningwithcrayons.Alfred", "com.runningwithcrayons.Alfred-3",
      "com.runningwithcrayons.Alfred-Preferences", "com.latenightsw.ScriptDebugger8",
    ] {
      let verdict = AppPolicy.verdict(for: bundleIdentifier)
      XCTAssertFalse(verdict.allowed, bundleIdentifier)
      XCTAssertTrue(verdict.reason.contains("automation tools"), bundleIdentifier)
    }
  }

  func testMorePasswordManagersAndTheirVariantBuildsAreRefused() {
    for bundleIdentifier in [
      "in.sinew.Enpass-Desktop", "in.sinew.Walletx", "com.markmcguill.strongbox.mac",
      "com.markmcguill.strongbox.mac.pro", "com.hicknhacksoftware.MacPass",
      "com.keepersecurity.passwordmanager", "com.callpod.keepermac.lite", "com.siber.RoboForm",
      "com.1password.1password-beta", "com.agilebits.onepassword-osx",
    ] {
      let verdict = AppPolicy.verdict(for: bundleIdentifier)
      XCTAssertFalse(verdict.allowed, bundleIdentifier)
      XCTAssertEqual(verdict.reason, "Opensteer does not operate password managers.")
    }
  }

  /// An editor with a built-in terminal is allowed, and named for what it is.
  func testEditorsWithABuiltInTerminalAreElevated() {
    for bundleIdentifier in [
      "com.apple.dt.Xcode", "com.microsoft.VSCode", "com.microsoft.VSCodeInsiders",
      "com.todesktop.230313mzl4w4u92", "dev.zed.Zed", "dev.zed.Zed-Preview",
      "com.jetbrains.intellij", "com.jetbrains.pycharm.ce", "com.google.android.studio",
    ] {
      let verdict = AppPolicy.verdict(for: bundleIdentifier)
      XCTAssertTrue(verdict.allowed, bundleIdentifier)
      XCTAssertEqual(verdict.risk, .elevated, bundleIdentifier)
      XCTAssertTrue(verdict.reason.contains("built-in terminal"), bundleIdentifier)
    }
  }

  /// A family is the vendor's identifier and its variants, never a longer word.
  func testAFamilyNeverMatchesALongerWord() {
    XCTAssertTrue(AppPolicy.verdict(for: "com.raycastle.app").allowed)
    XCTAssertTrue(AppPolicy.verdict(for: "com.jetbrainsfan.tool").allowed)
    XCTAssertFalse(AppPolicy.verdict(for: "com.raycast").allowed)
  }

  func testNoBundleIdentifierIsOnBothLists() {
    let denied = Set(AppPolicy.denied.keys).union(AppPolicy.deniedFamilies.keys)
    let elevated = Set(AppPolicy.elevated.keys).union(AppPolicy.elevatedFamilies.keys)
    XCTAssertTrue(denied.isDisjoint(with: elevated))
    for key in elevated { XCTAssertTrue(AppPolicy.verdict(for: key).allowed, key) }
  }

  func testEveryListedIdentifierIsAlreadyLowercased() {
    for key in AppPolicy.denied.keys { XCTAssertEqual(key, key.lowercased()) }
    for key in AppPolicy.elevated.keys { XCTAssertEqual(key, key.lowercased()) }
    for key in AppPolicy.deniedFamilies.keys { XCTAssertEqual(key, key.lowercased()) }
    for key in AppPolicy.elevatedFamilies.keys { XCTAssertEqual(key, key.lowercased()) }
  }
}
