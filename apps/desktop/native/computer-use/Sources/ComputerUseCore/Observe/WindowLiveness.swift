import AppKit
import ApplicationServices
import CoreGraphics

/// One retained AX identity, never repaired from a later numeric window ID.
/// AXWindows is a discovery list: macOS omits live windows on other Spaces.
final class WindowLiveness: @unchecked Sendable {
  struct State {
    let entry: AppWindows.Entry
    let hidden: Bool
    let minimized: Bool
  }

  let process: ProcessStamp
  let element: AXUIElement
  let windowID: CGWindowID
  private let ended = Locked(false)
  @WorkActor var copyAttribute:
    (AXUIElement, CFString, UnsafeMutablePointer<CFTypeRef?>) -> AXError =
      AXUIElementCopyAttributeValue

  @WorkActor var readPID: (AXUIElement, UnsafeMutablePointer<pid_t>) -> AXError = AXUIElementGetPid
  @WorkActor var readWindowID: (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError = {
    element, id in
    guard let resolve = PrivateAPI.axUIElementGetWindow else { return .notImplemented }
    return resolve(element, id)
  }
  @WorkActor var readServer = KeyWindow.readServerState
  @WorkActor var isHidden: (pid_t) -> Bool = {
    NSRunningApplication(processIdentifier: $0)?.isHidden == true
  }

  init(process: ProcessStamp, element: AXUIElement, windowID: CGWindowID) {
    self.process = process
    self.element = element
    self.windowID = windowID
  }

  var isClosed: Bool {
    if !process.isCurrent { close() }
    return ended.current
  }

  func close() { ended.withLock { $0 = true } }

  @WorkActor
  func read() throws -> State {
    guard !isClosed else { throw SessionWindows.closed }
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    func checked(_ status: AXError) throws {
      if status == .invalidUIElement {
        close()
        throw SessionWindows.closed
      }
      guard status == .success else {
        throw HelperError(.failed, "This app's window could not be checked; try again.")
      }
    }
    // Role is a remote validity read; AXUIElementGetPid alone can return the
    // proxy's cached pid even after its remote element has been destroyed.
    var role: CFTypeRef?
    try checked(copyAttribute(element, kAXRoleAttribute as CFString, &role))
    guard let role, CFGetTypeID(role) == CFStringGetTypeID() else {
      throw HelperError(.failed, "This app's window could not be checked; try again.")
    }
    var pid: pid_t = 0
    try checked(readPID(element, &pid))
    guard PrivateAPI.axUIElementGetWindow != nil else {
      throw HelperError(.unsupported, "This version of macOS cannot identify exact windows.")
    }
    var id: CGWindowID = 0
    try checked(readWindowID(element, &id))
    guard id != 0 else {
      throw HelperError(.failed, "This app's window identity is changing; try again.")
    }
    guard pid == process.processIdentifier, id == windowID, process.isCurrent else {
      close()
      throw SessionWindows.closed
    }
    let hidden = isHidden(pid)
    var minimizedValue: CFTypeRef?
    let minimizedStatus = copyAttribute(
      element, kAXMinimizedAttribute as CFString, &minimizedValue)
    if minimizedStatus != .attributeUnsupported && minimizedStatus != .noValue {
      try checked(minimizedStatus)
    }
    let minimized = AXValueReader.bool(minimizedValue) == true
    let entry: AppWindows.Entry
    let server = try readServer(windowID)
    if let server, server.processIdentifier != pid {
      close()
      throw SessionWindows.closed
    }
    if let server, server.entry.window.frame.width > 0, server.entry.window.frame.height > 0 {
      entry = server.entry
    } else if hidden || minimized {
      // A hidden/minimized retained element can outlive its capturable entry.
      // This root-only value never admits a discovery candidate or a member.
      guard let frame = AXValueReader.copyFrame(element), frame.width > 0, frame.height > 0 else {
        throw HelperError(.failed, "This app's window could not be checked; try again.")
      }
      entry = AppWindows.Entry(
        window: ObservedWindow(windowID: windowID, frame: frame), layer: 0,
        onScreen: false, alpha: 0)
    } else if server == nil {
      close()
      throw SessionWindows.closed
    } else {
      throw HelperError(.failed, "This app's window geometry is changing; try again.")
    }
    guard !isClosed else { throw SessionWindows.closed }
    return State(entry: entry, hidden: hidden, minimized: minimized)
  }
}
