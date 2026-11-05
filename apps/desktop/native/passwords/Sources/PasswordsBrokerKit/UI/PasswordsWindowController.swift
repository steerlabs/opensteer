import AppKit
import SwiftUI

/// Opens the Passwords window; the window itself decides between setup,
/// the list and the other states.
@MainActor
public protocol PasswordsWindowPresenter: AnyObject {
  func openPasswordsWindow()
}

/// The one Passwords window. Closing it ends the visit, which hides the
/// saved logins again; it is created again lazily, never destroyed while the
/// broker runs.
@MainActor
public final class PasswordsWindowController: NSObject, PasswordsWindowPresenter, NSWindowDelegate {
  private let model: PasswordsWindowModel
  private var window: NSWindow?
  /// The app the person came from, which leaving the window returns them to.
  private var cameFrom: NSRunningApplication?

  public init(model: PasswordsWindowModel) {
    self.model = model
    super.init()
    model.leave = { [weak self] in self?.leave() }
  }

  public func openPasswordsWindow() {
    let window = self.window ?? makeWindow()
    self.window = window
    // A real app while its window is open: the Dock and Command-Tab are how the
    // person gets back from exporting, and macOS returns here after Touch ID.
    NSApplication.shared.setActivationPolicy(.regular)
    if !window.isVisible {
      window.center()
      cameFrom = NSWorkspace.shared.frontmostApplication.flatMap { $0 == .current ? nil : $0 }
    }
    window.makeKeyAndOrderFront(nil)
    // The person asked for it from Opensteer; macOS may still keep the
    // other app active, so the window is put in front either way.
    window.orderFrontRegardless()
    NSApplication.shared.activate()
  }

  private func leave() {
    if let cameFrom {
      NSApplication.shared.yieldActivation(to: cameFrom)
      cameFrom.activate(from: .current)
    }
    window?.close()
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    window.title = Copy.appName
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.sharingType = .none
    window.contentView = NSHostingView(rootView: PasswordsWindowView(model: model))
    window.setFrameAutosaveName("OpensteerPasswordsWindow")
    return window
  }

  public func windowWillClose(_ notification: Notification) {
    model.windowClosed()
    NSApplication.shared.setActivationPolicy(.accessory)
  }
}
