import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The key window an observation is about, and everything an action needs to
/// aim into it.
public struct WindowIdentity: Sendable, Equatable {
  public let windowID: CGWindowID
  public let title: String?
  /// Screen points, top-left origin (CoreGraphics space).
  public let frame: CGRect
}

/// Accessibility reads of an app's windows. Each is a message to the app, so
/// these run on the work executor, never on the main thread.
public enum KeyWindow {
  /// `AXFocusedWindow`, else `AXMainWindow`, else the first window (§2).
  ///
  /// A minimized window is `unsupported` with a sentence that says what to
  /// ask the person: restoring it would take their screen. A window on another
  /// Space or full screen is observed and acted on where it is.
  public static func resolve(applicationElement: AXUIElement) throws -> AXUIElement {
    var pid: pid_t = 0
    guard AXUIElementGetPid(applicationElement, &pid) == .success else {
      throw SessionWindows.closed
    }
    let valid = Set(AppWindows.all(processIdentifier: pid).map(\.window.windowID))
    func eligible(_ element: AXUIElement) -> Bool {
      windowID(of: element).map(valid.contains) == true
    }
    for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      if let element = AXValueReader.copyElement(applicationElement, attribute), eligible(element) {
        return element
      }
    }
    guard
      let first = AXValueReader.copyElements(applicationElement, kAXWindowsAttribute).first(
        where: eligible)
    else {
      throw HelperError(.unsupported, "This app has no open window; ask the person to open one.")
    }
    return first
  }

  public static func identity(
    of window: AXUIElement,
    processIdentifier: pid_t
  ) throws -> WindowIdentity {
    AXUIElementSetMessagingTimeout(window, axMessagingTimeout)
    if AXValueReader.copyBool(window, kAXMinimizedAttribute) == true {
      throw HelperError(.unsupported, "The window is minimized; ask the person to restore it.")
    }
    guard let frame = AXValueReader.copyFrame(window), frame.width > 0, frame.height > 0 else {
      throw HelperError(
        .unsupported,
        "This app's window does not report a position; ask the person to bring it on screen."
      )
    }
    guard let identifier = windowID(of: window) else {
      throw HelperError(
        .unsupported,
        PrivateAPI.axUIElementGetWindow == nil
          ? "This version of macOS cannot bind accessibility to an exact window."
          : "This app's exact window could not be identified.")
    }
    return WindowIdentity(
      windowID: identifier,
      title: AXValueReader.copyString(window, kAXTitleAttribute).map { ActionDescription.clip($0, to: 1024) },
      frame: frame
    )
  }

  /// The exact window server identity of an Accessibility window element. The
  /// helper never guesses one from matching bounds.
  public static func windowID(of window: AXUIElement) -> CGWindowID? {
    guard let resolve = PrivateAPI.axUIElementGetWindow else { return nil }
    var identifier = CGWindowID(0)
    guard resolve(window, &identifier) == .success, identifier != 0 else { return nil }
    return identifier
  }
}

extension KeyWindow {
  /// Whether the window is on the Space the person is looking at. The drawn
  /// pointer only makes sense there: anywhere else it would float over the
  /// person's own work, pointing at nothing of the app's.
  public static func isOnScreen(_ windowID: CGWindowID) -> Bool {
    guard let window = info(windowID) else { return false }
    return (window[kCGWindowIsOnscreen as String] as? Bool) == true
  }

  struct CaptureState: Sendable, Equatable {
    let frame: CGRect
    let isOnScreen: Bool
  }

  /// One WindowServer read binds geometry and visibility to the exact owner.
  static func captureState(_ windowID: CGWindowID, processIdentifier: pid_t) -> CaptureState? {
    guard let server = serverState(windowID), server.processIdentifier == processIdentifier,
      server.entry.alpha > 0, server.entry.window.frame.width > 0,
      server.entry.window.frame.height > 0
    else { return nil }
    return CaptureState(frame: server.entry.window.frame, isOnScreen: server.entry.onScreen)
  }

  struct ServerState: Sendable {
    let processIdentifier: pid_t
    let entry: AppWindows.Entry
  }

  static func serverState(_ windowID: CGWindowID) -> ServerState? { try? readServerState(windowID) }

  static func readServerState(_ windowID: CGWindowID) throws -> ServerState? {
    guard
      let rows = CGWindowListCopyWindowInfo(
        [.optionIncludingWindow, .excludeDesktopElements], windowID) as? [[String: Any]]
    else {
      throw HelperError(.failed, "WindowServer could not check this window; try again.")
    }
    guard
      let row = rows.first(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
      })
    else { return nil }
    guard let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else {
      throw HelperError(.failed, "WindowServer could not check this window's owner; try again.")
    }
    let entry = AppWindows.Entry(
      window: ObservedWindow(windowID: windowID, frame: AppWindows.bounds(row) ?? .zero),
      layer: (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
      onScreen: (row[kCGWindowIsOnscreen as String] as? Bool) == true,
      alpha: (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    return ServerState(processIdentifier: pid, entry: entry)
  }

  /// Where the window server has one window now, or nil when it is gone.
  public static func currentFrame(_ windowID: CGWindowID) -> CGRect? {
    info(windowID).flatMap(AppWindows.bounds)
  }

  private static func info(_ windowID: CGWindowID) -> [String: Any]? {
    (CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], windowID)
      as? [[String: Any]])?.first {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
      }
  }
}

/// The app's windows as the window server stacks them. Bounds, owner and
/// order are readable without Screen Recording, and reading them sends the
/// app nothing.
public enum AppWindows {
  /// Menus, pop-up menus and the like sit at this level or above.
  static let popUpMenuLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))

  public struct Entry: Sendable, Equatable {
    public let window: ObservedWindow
    public let layer: Int
    var onScreen = true
    var alpha: Double = 1
  }

  /// A running app has a real window, even when AX has not listed it or it
  /// lives on another Space. A reopen would move that window onto the
  /// person's current screen. `onThisSpace` counts only windows on the current
  /// Space (covered or not).
  static func hasWindow(processIdentifier: pid_t, onThisSpace: Bool = false) -> Bool {
    let options: CGWindowListOption =
      onThisSpace
      ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
    guard
      let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        as? [[String: Any]]
    else { return false }
    return list.contains { info in
      (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier
        && (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        && ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0
        && AppWindows.bounds(info).map { $0.width > 1 && $0.height > 1 } == true
    }
  }

  static func all(processIdentifier: pid_t) -> [Entry] {
    let rows =
      CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    return rows.compactMap { row in
      guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier,
        let value = entry(row), value.alpha > 0
      else { return nil }
      return value
    }
  }

  static func entry(_ row: [String: Any]) -> Entry? {
    guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
      let frame = bounds(row), frame.width > 0, frame.height > 0
    else { return nil }
    return Entry(
      window: ObservedWindow(windowID: id, frame: frame),
      layer: (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
      onScreen: (row[kCGWindowIsOnscreen as String] as? Bool) == true,
      alpha: (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
  }

  public static func onScreen(processIdentifier: pid_t, within bounds: CGRect) -> [Entry] {
    all(processIdentifier: processIdentifier).filter {
      $0.onScreen && $0.window.frame.intersects(bounds)
    }
  }

  static func bounds(_ info: [String: Any]) -> CGRect? {
    guard let dictionary = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
  }

  /// The window a point lands in: the frontmost of the observed windows that
  /// contains it, else the key window. Screen points throughout.
  public static func window(
    at screenPoint: CGPoint,
    among windows: [ObservedWindow],
    keyWindow: ObservedWindow
  ) -> ObservedWindow {
    windows.first { $0.frame.contains(screenPoint) } ?? keyWindow
  }
}

extension CGRect {
  var area: CGFloat { isNull || isEmpty ? 0 : width * height }
}

/// CoreGraphics puts the origin at the top left of the primary display and
/// counts y downwards; AppKit puts it at the bottom left and counts upwards.
/// Every conversion in the helper goes through here so the flip is written
/// exactly once.
public enum ScreenGeometry {
  @MainActor
  public static var primaryHeight: CGFloat {
    NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
  }

  @MainActor
  public static func appKitPoint(fromCoreGraphics point: CGPoint) -> CGPoint {
    CGPoint(x: point.x, y: primaryHeight - point.y)
  }
}
