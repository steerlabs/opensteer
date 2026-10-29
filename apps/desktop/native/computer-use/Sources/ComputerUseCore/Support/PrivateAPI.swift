import ApplicationServices
import CoreGraphics
import Foundation

/// Every non-public symbol the helper uses, resolved once through `dlsym`, with
/// the reason it is needed and what happens when it is absent.
///
/// Nothing here has a fallback that would break invariant 4 ("Background means
/// the person's focus is untouched"). When a symbol is missing the operation
/// that needs it fails with a sentence; it never degrades into posting to the
/// person's own cursor or event stream.
public enum PrivateAPI {

  // MARK: - SLEventPostToPid

  /// SkyLight's process-addressed event delivery. Unlike the desktop-global
  /// event taps this does not move the system pointer or route through the
  /// frontmost application, and unlike an artificial Command modifier it does
  /// not change what an ordinary click means to the target.
  public typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void

  private nonisolated(unsafe) static let skyLightHandle: UnsafeMutableRawPointer? = dlopen(
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    RTLD_NOW | RTLD_LOCAL
  )

  public static let postToPid: PostToPid? = {
    guard let skyLightHandle,
      let symbol = dlsym(skyLightHandle, "SLEventPostToPid")
    else {
      Log.act.error("SLEventPostToPid is unavailable on this system.")
      return nil
    }
    return unsafeBitCast(symbol, to: PostToPid.self)
  }()

  public static var backgroundPointerDeliveryAvailable: Bool {
    postToPid != nil && setWindowLocation != nil
  }

  // SLSCopyAssociatedWindows is an ownership query, including cross-process
  // callers. Bounds and stacking alone never establish parentage.
  typealias CopyAssociatedWindows = @convention(c) (UInt32, CGWindowID) -> Unmanaged<CFArray>?
  static let copyAssociatedWindows = skyLightSymbol(
    "SLSCopyAssociatedWindows", as: CopyAssociatedWindows.self)
  static let associationConnection = skyLightSymbol("SLSMainConnectionID", as: MainConnection.self)
  static var windowGroupsAvailable: Bool {
    copyAssociatedWindows != nil && associationConnection != nil
  }

  static func associatedWindows(_ window: CGWindowID) throws -> [CGWindowID] {
    guard let copyAssociatedWindows, let associationConnection else {
      throw HelperError(.unsupported, "This version of macOS cannot identify window groups.")
    }
    guard
      let result = copyAssociatedWindows(associationConnection(), window)?.takeRetainedValue()
        as? [NSNumber]
    else {
      throw HelperError(.staleObservation, "This window's ownership changed; observe again.")
    }
    return result.map(\.uint32Value)
  }

  // MARK: - Focus

  typealias MainConnection = @convention(c) () -> UInt32
  typealias UpdateHold = @convention(c) (UInt32) -> Int32
  typealias ReleaseKeyFocus = @convention(c) (UInt32) -> Int32
  typealias GetKeyFocus = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
  typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
  typealias GetProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
  typealias CreatePidTap =
    @convention(c) (
      pid_t, UInt32, UInt32, CGEventMask, CGEventTapCallBack, UnsafeMutableRawPointer?
    ) -> Unmanaged<CFMachPort>?

  private static func skyLightSymbol<T>(_ name: String, as type: T.Type) -> T? {
    guard let skyLightHandle, let symbol = dlsym(skyLightHandle, name) else { return nil }
    return unsafeBitCast(symbol, to: type)
  }

  static let mainConnection = skyLightSymbol("CGSMainConnectionID", as: MainConnection.self)

  /// Holds the window server's screen updates while an app that came forward
  /// is sent back, so it is never drawn in front: `hold` returns the release,
  /// or nil when this Mac cannot both hold and release them.
  static func holdScreenUpdates() -> (() -> Void)? {
    guard let mainConnection, let disable = disableUpdate, let reenable = reenableUpdate else {
      return nil
    }
    let connection = mainConnection()
    guard disable(connection) == 0 else { return nil }
    return { _ = reenable(connection) }
  }

  private static let disableUpdate = skyLightSymbol("SLSDisableUpdate", as: UpdateHold.self)
  private static let reenableUpdate = skyLightSymbol("SLSReenableUpdate", as: UpdateHold.self)
  /// Ends a key focus theft by the id its notification carries.
  static let releaseKeyFocus: ReleaseKeyFocus? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CPSReleaseKeyFocusWithID")
    else { return nil }
    return unsafeBitCast(symbol, to: ReleaseKeyFocus.self)
  }()
  static let getKeyFocus = skyLightSymbol("SLPSGetKeyFocusProcess", as: GetKeyFocus.self)
  /// An event tap on what one process receives.
  static let createPidTap: CreatePidTap? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventTapCreateForPid")
    else { return nil }
    return unsafeBitCast(symbol, to: CreatePidTap.self)
  }()
  private static let getFrontProcess: GetFrontProcess? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "GetFrontProcess")
    else { return nil }
    return unsafeBitCast(symbol, to: GetFrontProcess.self)
  }()
  private static let getProcessPID: GetProcessPID? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "GetProcessPID")
    else { return nil }
    return unsafeBitCast(symbol, to: GetProcessPID.self)
  }()

  static func focusPID(front: Bool) -> pid_t? {
    guard let getProcessPID else { return nil }
    var psn: [UInt32] = [0, 0]
    var connection: [UInt64] = [0, 0]
    let status: Int32 = psn.withUnsafeMutableBytes { serial in
      if front { return getFrontProcess?(serial.baseAddress!) ?? -1 }
      return connection.withUnsafeMutableBytes {
        getKeyFocus?(serial.baseAddress!, $0.baseAddress!) ?? -1
      }
    }
    var pid: pid_t = 0
    guard status == 0, psn != [0, 0],
      psn.withUnsafeBytes({ getProcessPID($0.baseAddress!, &pid) }) == 0, pid > 0
    else { return nil }
    return pid
  }

  // MARK: - CGEventSetWindowLocation

  /// `void CGEventSetWindowLocation(CGEventRef, CGPoint)`
  ///
  /// Why: an event posted with `CGEventPostToPid` arrives at the target process
  /// without ever passing through the window server, so the process has no way
  /// to convert the global location into a point inside its own window. AppKit
  /// reads the window-local location straight off the event. Without it the
  /// target app receives the click at the wrong place — usually (0,0) — which
  /// is worse than not clicking at all.
  ///
  /// Absent: `click` and `scroll` fail with `unsupported` and a sentence. There
  /// is deliberately no fallback to `CGEventPost`, which would move the
  /// person's own pointer and deliver to whatever is frontmost.
  public typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void

  public static let setWindowLocation: SetWindowLocation? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation")
    else {
      Log.act.error("CGEventSetWindowLocation is unavailable on this system.")
      return nil
    }
    return unsafeBitCast(symbol, to: SetWindowLocation.self)
  }()

  // MARK: - _AXUIElementGetWindow

  /// `AXError _AXUIElementGetWindow(AXUIElementRef, CGWindowID *)`
  ///
  /// Why: the Accessibility API hands out window elements but no public call
  /// turns one into the `CGWindowID` that ScreenCaptureKit's
  /// `desktopIndependentWindow` filter and the synthetic-event window stamping
  /// both need. This is the only way to be certain the window we observed is
  /// the window we captured and the window we are clicking into.
  ///
  /// Absent: observation and input report `unsupported`. Matching only by
  /// bounds is not an identity and could silently bind the wrong window.
  public typealias GetWindowID =
    @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) ->
    AXError

  public static let axUIElementGetWindow: GetWindowID? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
    else {
      Log.observe.notice(
        "_AXUIElementGetWindow is unavailable; exact window identity is unsupported.")
      return nil
    }
    return unsafeBitCast(symbol, to: GetWindowID.self)
  }()
}
