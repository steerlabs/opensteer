import AppKit

/// Makes this test process an app connected to the window server, once.
///
/// Tests whose target is this process go through the focus guard, which taps
/// the target's own event stream. A command-line xctest process has none until
/// it is an app, and macOS refuses those taps however the process is trusted,
/// so without this every press route fails as unguarded.
@MainActor
enum TestProcessApp {
  private static var connected = false

  static func connect() {
    guard !connected else { return }
    connected = true
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
  }
}
