@preconcurrency import ApplicationServices
import Foundation

/// The per-app window observer: focused-window, miniaturized and restored,
/// activated and destroyed, and windows moving or resizing, which only the
/// drawn pointer and outline follow. Focus changes carry the exact callback window so
/// the monitor can distinguish a new window from focus moving between controls
/// inside the observed one.
///
/// Registering and unregistering are Accessibility messages to the app, which
/// block for as long as the app takes to answer, so neither ever runs on the
/// main thread: `start` runs on the work executor, and `stop` removes the
/// run-loop source on the main thread and unregisters on a utility queue. The
/// callbacks themselves are delivered on the main run loop.
final class AppAXObserver: @unchecked Sendable {
  enum EventKind: Sendable {
    case focusedWindowChanged(windowID: CGWindowID?)
    case miniaturized(element: AXUIElement)
    /// A minimized window came back. The observation it invalidated stays
    /// stale for the agent; only what a viewer is shown follows it.
    case deminiaturized(element: AXUIElement)
    case activated
    case destroyed(element: AXUIElement)
    /// A window moved or changed size. Coordinates are resolved against the
    /// window as it is when each action runs, so this invalidates nothing.
    case moved
    case created

    var notification: String {
      switch self {
      case .focusedWindowChanged: return kAXFocusedWindowChangedNotification
      case .miniaturized: return kAXWindowMiniaturizedNotification
      case .deminiaturized: return kAXWindowDeminiaturizedNotification
      case .activated: return kAXApplicationActivatedNotification
      case .destroyed: return kAXUIElementDestroyedNotification
      case .moved: return kAXWindowMovedNotification
      case .created: return kAXWindowCreatedNotification
      }
    }
  }

  private let processIdentifier: pid_t
  private let applicationElement: AXUIElement
  private let handler: @Sendable (pid_t, EventKind) -> Void
  private let onNotification: @Sendable (String) -> Void
  /// Written once by `start`, before the source reaches any run loop.
  private var observer: AXObserver?
  private let windows = Locked<[AXUIElement]>([])

  private static let notifications = [
    kAXFocusedWindowChangedNotification,
    kAXWindowMiniaturizedNotification,
    kAXWindowDeminiaturizedNotification,
    kAXApplicationActivatedNotification,
    kAXUIElementDestroyedNotification,
    kAXWindowMovedNotification,
    kAXWindowResizedNotification,
    kAXWindowCreatedNotification,
    kAXSheetCreatedNotification,
  ]

  init(
    processIdentifier: pid_t,
    onNotification: @escaping @Sendable (String) -> Void = { _ in },
    handler: @escaping @Sendable (pid_t, EventKind) -> Void
  ) {
    self.processIdentifier = processIdentifier
    self.handler = handler
    self.onNotification = onNotification
    applicationElement = AXUIElementCreateApplication(processIdentifier)
    AXUIElementSetMessagingTimeout(applicationElement, axMessagingTimeout)
  }

  @discardableResult
  func start() -> Bool {
    var created: AXObserver?
    guard AXObserverCreate(processIdentifier, axObserverCallback, &created) == .success,
      let created
    else {
      Log.focus.notice("No AX observer for \(self.processIdentifier, privacy: .public).")
      return false
    }
    observer = created
    let context = Unmanaged.passUnretained(self).toOpaque()
    for name in Self.notifications {
      let status = AXObserverAddNotification(created, applicationElement, name as CFString, context)
      if status != .success {
        Log.focus.notice(
          "AX notification registration failed: pid=\(self.processIdentifier, privacy: .public) notification=\(name, privacy: .public) status=\(status.rawValue, privacy: .public)"
        )
      }
    }
    CFRunLoopAddSource(
      CFRunLoopGetMain(),
      AXObserverGetRunLoopSource(created),
      .commonModes
    )
    return true
  }

  @WorkActor
  func watchWindow(_ window: AXUIElement) {
    guard let observer,
      windows.withLock({ values in
        guard !values.contains(where: { CFEqual($0, window) }) else { return false }
        values.append(window)
        return true
      })
    else { return }
    let context = Unmanaged.passUnretained(self).toOpaque()
    for name in Self.notifications {
      _ = AXObserverAddNotification(observer, window, name as CFString, context)
    }
  }

  @WorkActor
  func unwatchWindow(_ window: AXUIElement) {
    guard let observer else { return }
    windows.withLock { $0.removeAll { CFEqual($0, window) } }
    for name in Self.notifications {
      _ = AXObserverRemoveNotification(observer, window, name as CFString)
    }
  }

  /// The source leaves the main run loop on the main thread, so no callback
  /// can be running against this object when it goes; the closures keep it
  /// alive until the app has been told, however long that takes.
  func stop() {
    guard let observer else { return }
    let applicationElement = applicationElement
    let retainedWindows = windows.current
    DispatchQueue.main.async {
      CFRunLoopRemoveSource(
        CFRunLoopGetMain(),
        AXObserverGetRunLoopSource(observer),
        .commonModes
      )
      DispatchQueue.global(qos: .utility).async {
        for element in [applicationElement] + retainedWindows {
          for name in Self.notifications {
            AXObserverRemoveNotification(observer, element, name as CFString)
          }
        }
        withExtendedLifetime(self) {}
      }
    }
  }

  nonisolated fileprivate static func eventKind(
    element: AXUIElement,
    notification: String
  ) -> EventKind? {
    switch notification {
    case kAXFocusedWindowChangedNotification:
      // The notification names the window that became focused, including
      // when a targeted background click merely moves focus between controls
      // in the observed one; its exact identity tells the two apart.
      return .focusedWindowChanged(windowID: nil)
    case kAXWindowMiniaturizedNotification:
      return .miniaturized(element: element)
    case kAXWindowDeminiaturizedNotification:
      return .deminiaturized(element: element)
    case kAXApplicationActivatedNotification:
      return .activated
    case kAXUIElementDestroyedNotification:
      return .destroyed(element: element)
    case kAXWindowMovedNotification, kAXWindowResizedNotification:
      return .moved
    case kAXWindowCreatedNotification, kAXSheetCreatedNotification:
      return .created
    default:
      return nil
    }
  }

  fileprivate func deliver(_ kind: EventKind, notification: String) {
    onNotification(notification)
    handler(processIdentifier, kind)
  }
}

/// `AXObserver` callbacks are delivered on the run loop they were added to,
/// which here is the main one.
private func axObserverCallback(
  observer: AXObserver,
  element: AXUIElement,
  notification: CFString,
  userInfo: UnsafeMutableRawPointer?
) {
  guard let userInfo else { return }
  let target = Unmanaged<AppAXObserver>.fromOpaque(userInfo).takeUnretainedValue()
  let name = notification as String
  guard let kind = AppAXObserver.eventKind(element: element, notification: name) else { return }
  target.deliver(kind, notification: name)
}
