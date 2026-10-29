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

  public init(model: PasswordsWindowModel) {
    self.model = model
  }

  public func openPasswordsWindow() {
    let window = self.window ?? makeWindow()
    self.window = window
    if !window.isVisible { window.center() }
    window.makeKeyAndOrderFront(nil)
    // The person asked for it from Opensteer; macOS may still keep the
    // other app active, so the window is put in front either way.
    window.orderFrontRegardless()
    NSApplication.shared.activate()
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
  }
}
