// Process-addressed activation and keyboard-focus notifications used by this helper.
// For deactivate-before-activate ordering, see yabai's
// window_manager_focus_window_without_raise:
// https://github.com/koekeishiya/yabai/blob/491ed8d95cd9bcd3e8550dc6d5dc167852fec2f3/src/window_manager.c#L1293-L1322
// The private notification fields below are not a public macOS API contract.
import AppKit
import CoreGraphics
import Foundation

/// The notifications that tell an app it is active, or that its window has the
/// keyboard again, sent to that app alone.
///
/// An app keeps its own idea of whether it is active from the activation
/// notifications the window server sends it. Sent to the app's process only,
/// they change that idea and nothing else: the person's app stays in front
/// and keeps the keyboard, and the app handles a posted key the way it would
/// in front — its key window takes it, and a command that would bring a
/// window forward finds its app already active.
@MainActor
enum FocusEvents {
  /// AppKit-defined events carry their subtype in field 83; process
  /// notifications carry theirs in field 64.
  nonisolated static let appKitDefined: UInt32 = 13
  nonisolated static let appDeactivated: UInt32 = 19
  nonisolated static let appActivated: UInt32 = 20
  nonisolated static let processNotification: UInt32 = 21
  nonisolated static let appKitSubtypeField = CGEventField(rawValue: 83)!
  nonisolated static let notificationSubtypeField = CGEventField(rawValue: 64)!
  nonisolated static let notificationPIDField = CGEventField(rawValue: 73)!
  nonisolated static let keyFocusIDField = CGEventField(rawValue: 71)!
  nonisolated static let sourcePIDField = CGEventField(rawValue: 41)!
  nonisolated static let targetPIDField = CGEventField(rawValue: 40)!
  nonisolated static let windowNumberField = CGEventField(rawValue: 51)!

  /// AppKit subtypes of an AppKit-defined event.
  nonisolated static let activated: Int64 = 1
  nonisolated static let deactivated: Int64 = 2
  nonisolated static let resignedKey: Int64 = 22
  nonisolated static let resignedMain: Int64 = 23

  nonisolated static func isActivation(_ kind: UInt32, _ subtype: Int64) -> Bool {
    kind == appActivated || (kind == appKitDefined && subtype == activated)
  }

  nonisolated static func isDeactivation(_ kind: UInt32, _ subtype: Int64) -> Bool {
    kind == appDeactivated || (kind == appKitDefined && subtype == deactivated)
  }

  nonisolated static func isResign(_ kind: UInt32, _ subtype: Int64) -> Bool {
    kind == appKitDefined && (subtype == resignedKey || subtype == resignedMain)
  }

  /// Process notification subtypes.
  nonisolated static let newFront: Int64 = 2
  nonisolated static let keyFocusTaken: Int64 = 0x4000
  nonisolated static let keyFocusReturned: Int64 = 0x8000
  nonisolated static let keyFocusChanged: Int64 = 0xF102

  /// The app's window has the keyboard again. False when it was not sent;
  /// `gate`, run just before posting, can refuse it.
  static func sendKeyFocusReturned(to pid: pid_t, gate: @Sendable () throws -> Void) throws
    -> Bool
  {
    try send(
      other(processNotification, subtype: Int16(bitPattern: 0x8000)).map { [$0] } ?? [], to: pid,
      gate: gate)
  }

  /// The app is no longer active.
  @discardableResult
  static func sendDeactivated(to pid: pid_t) -> Bool {
    (try? send(other(appKitDefined, subtype: Int16(deactivated)).map { [$0] } ?? [], to: pid))
      ?? false
  }

  /// An app already active is first sent a deactivation for its previous key
  /// window. yabai also posts deactivation before activation when changing
  /// windows within its focused process; see the source link above.
  static func sendActivated(
    to pid: pid_t, resigning: CGWindowID? = nil, window: CGWindowID, frame: CGRect?,
    activationPoint: CGPoint?, gate: @Sendable () throws -> Void
  ) throws -> Bool {
    var events = activationEvents(window: window, frame: frame, activationPoint: activationPoint)
    if let resigning, !events.isEmpty {
      guard let resign = other(appKitDefined, subtype: Int16(deactivated), window: resigning)
      else { return false }
      events.insert(resign, at: 0)
    }
    return try send(events, to: pid, gate: gate)
  }

  /// Activation naming the window that becomes key, then — when the window
  /// says where a click activates it — the click that would have done so. Apps
  /// put that point where a click changes nothing else: the title bar margin,
  /// or outside the window altogether, as Chromium does.
  private static func activationEvents(
    window: CGWindowID, frame: CGRect?, activationPoint: CGPoint?
  ) -> [CGEvent] {
    guard
      let activation = other(
        appKitDefined, subtype: Int16(activated), window: window,
        flags: window == 0 ? 0 : 0x000C_0000)
    else { return [] }
    guard window != 0, let frame, let activationPoint else { return [activation] }
    // An activation that needs its click is not sent without it.
    guard let down = activationClick(.leftMouseDown, number: 1, window, frame, activationPoint),
      let up = activationClick(.leftMouseUp, number: 2, window, frame, activationPoint)
    else { return [] }
    return [activation, down, up]
  }

  /// Each event is timestamped as it goes, in order, with nothing between,
  /// once `gate` has had the last word.
  private static func send(
    _ events: [CGEvent], to processIdentifier: pid_t, gate: @Sendable () throws -> Void = {}
  ) throws -> Bool {
    guard !events.isEmpty, let postToPid = PrivateAPI.postToPid else { return false }
    try gate()
    for event in events {
      event.timestamp = CGEventTimestamp(DispatchTime.now().uptimeNanoseconds)
      postToPid(processIdentifier, event)
    }
    return true
  }

  private static func other(
    _ type: UInt32, subtype: Int16, window: CGWindowID = 0, flags: UInt = 0
  ) -> CGEvent? {
    guard let kind = NSEvent.EventType(rawValue: UInt(type)) else { return nil }
    return NSEvent.otherEvent(
      with: kind, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: flags),
      timestamp: 0, windowNumber: Int(window), context: nil, subtype: subtype,
      data1: 0, data2: 0)?.cgEvent
  }

  private static func activationClick(
    _ type: NSEvent.EventType, number: Int, _ window: CGWindowID, _ frame: CGRect,
    _ point: CGPoint
  ) -> CGEvent? {
    guard let setWindowLocation = PrivateAPI.setWindowLocation,
      let event = NSEvent.mouseEvent(
        with: type, location: point, modifierFlags: [], timestamp: 0,
        windowNumber: Int(window), context: nil, eventNumber: number, clickCount: 1,
        pressure: 1)?.cgEvent
    else { return nil }
    event.flags = []
    event.location = point
    event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
    return event
  }
}
