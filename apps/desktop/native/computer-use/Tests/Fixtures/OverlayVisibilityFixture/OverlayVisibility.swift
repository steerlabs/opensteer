import AppKit
import CoreGraphics
import Foundation

// This accessory app has the overlay's window behavior without opening the
// installed helper or asking macOS for either computer-use grant.
final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// An app, and whether it is this one. Safari reports a process identifier
/// of -1 here on some macOS releases, so the identifier is never an app's
/// identity on its own.
func identity(_ app: NSRunningApplication?) -> Any {
  guard let app else { return NSNull() }
  return [
    "bundleIdentifier": app.bundleIdentifier ?? NSNull(),
    "isSelf": app.processIdentifier == ProcessInfo.processInfo.processIdentifier,
    "name": app.localizedName ?? NSNull(),
    "processIdentifier": app.processIdentifier,
  ] as [String: Any]
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
  /// Apps that came to the front while this one ran, in order. Somebody else
  /// can switch apps meanwhile; only this app being among them is its doing.
  private var activations: [Any] = []
  private var becameActive = false
  private var frontmostAtLaunch: Any = NSNull()
  private var panel: OverlayPanel?

  func applicationDidBecomeActive(_ notification: Notification) {
    becameActive = true
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    frontmostAtLaunch = identity(NSWorkspace.shared.frontmostApplication)
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [self] notification in
      activations.append(
        identity(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication))
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(4) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
      let created = OverlayPanel(
        contentRect: NSRect(x: 100, y: 100, width: 272, height: 44),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false)
      created.isOpaque = false
      created.backgroundColor = .red
      created.hasShadow = false
      created.ignoresMouseEvents = false
      created.hidesOnDeactivate = false
      created.isReleasedWhenClosed = false
      created.isFloatingPanel = true
      created.becomesKeyOnlyIfNeeded = true
      created.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
      created.animationBehavior = .none
      created.level = .statusBar
      panel = created
      created.orderFrontRegardless()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [self] in reportAndExit() }
    }
  }

  private func reportAndExit() {
    guard let panel else { exit(2) }
    let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    let ownWindow = windows.first {
      ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == panel.windowNumber
    }
    let result: [String: Any] = [
      "pid": getpid(),
      "frontmostAtLaunch": frontmostAtLaunch,
      "frontmostAfterShow": identity(NSWorkspace.shared.frontmostApplication),
      "activations": activations,
      "becameActive": becameActive,
      "isActive": NSApp.isActive,
      "isHidden": NSApp.isHidden,
      "panelIsVisible": panel.isVisible,
      "panelIsOnScreen": (ownWindow?[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
    ]
    let destination = Bundle.main.bundleURL.appendingPathComponent("visibility.json")
    do {
      try JSONSerialization.data(withJSONObject: result).write(to: destination, options: .atomic)
    } catch {
      exit(3)
    }
    exit(0)
  }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = FixtureDelegate()
application.delegate = delegate
application.run()
