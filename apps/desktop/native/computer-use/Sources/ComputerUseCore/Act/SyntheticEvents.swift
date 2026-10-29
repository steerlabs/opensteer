import AppKit
import CoreGraphics
import Foundation

/// Where one synthetic event goes: the target process, the one window of it
/// the event is for, and — for pointer events — the point on screen and inside
/// that window.
public struct EventTarget: Sendable, Equatable {
  public let processIdentifier: pid_t
  public let windowID: CGWindowID
  public var screenPoint: CGPoint = .zero
  public var windowPoint: CGPoint = .zero

  public init(
    processIdentifier: pid_t, windowID: CGWindowID, screenPoint: CGPoint = .zero,
    windowPoint: CGPoint = .zero
  ) {
    self.processIdentifier = processIdentifier
    self.windowID = windowID
    self.screenPoint = screenPoint
    self.windowPoint = windowPoint
  }
}

/// Building and delivering the helper's synthetic input.
///
/// Invariant 4: input goes to the target process and never to the global event
/// stream, so nothing here uses `CGEventPost`. Every event — pointer and
/// keyboard alike — is stamped with the target window and addressed to the
/// target pid. Keys go to the window the app was told is key
/// (`FocusEnforcer`); naming it on each one keeps them there.
///
/// It is on the main actor because AppKit's event factory and `NSScreen` are;
/// the work executor awaits it, and nothing here waits on the target app.
@MainActor
public enum SyntheticEvents {
  private static var eventNumber: Int = 1
  /// Private CoreGraphics routing fields used by the process-addressed event
  /// path. They are deliberately centralized and covered by construction tests.
  nonisolated static let windowNumberField = CGEventField(rawValue: 51)!
  nonisolated static let clickGroupField = CGEventField(rawValue: 58)!

  private static func nextEventNumber() -> Int {
    eventNumber &+= 1
    return eventNumber
  }

  static func buttonNumber(_ button: MouseButton) -> Int64 {
    switch button {
    case .left: return 0
    case .right: return 1
    case .middle: return 2
    }
  }

  static func mouseTypes(_ button: MouseButton) -> (down: NSEvent.EventType, up: NSEvent.EventType)
  {
    switch button {
    case .left: return (.leftMouseDown, .leftMouseUp)
    case .right: return (.rightMouseDown, .rightMouseUp)
    case .middle: return (.otherMouseDown, .otherMouseUp)
    }
  }

  static let pointerUnsupported = HelperError(
    .unsupported,
    "This version of macOS does not let Opensteer place a click inside a background "
      + "window, so this app can only be observed."
  )

  /// One mouse event, built by AppKit's factory so it carries the fields only
  /// that factory fills in, then re-stamped for delivery to one process.
  static func makeMouseEvent(
    type: NSEvent.EventType,
    target: EventTarget,
    button: MouseButton,
    clickCount: Int,
    pressure: Float,
    flags: CGEventFlags = []
  ) throws -> CGEvent {
    guard let setWindowLocation = PrivateAPI.setWindowLocation,
      PrivateAPI.postToPid != nil
    else { throw pointerUnsupported }

    let number = nextEventNumber()
    guard
      let nsEvent = NSEvent.mouseEvent(
        with: type,
        location: ScreenGeometry.appKitPoint(fromCoreGraphics: target.screenPoint),
        modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)),
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: Int(target.windowID),
        context: nil,
        eventNumber: number,
        clickCount: clickCount,
        pressure: pressure
      ), let event = nsEvent.cgEvent
    else {
      throw HelperError(.failed, "This Mac could not build a click for that app.")
    }

    event.location = target.screenPoint
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowID))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
      value: Int64(target.windowID)
    )
    // Subtype 3 is what AppKit expects on a mouse event that names a window.
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventButtonNumber, value: buttonNumber(button))
    event.setIntegerValueField(clickGroupField, value: Int64(number))
    stamp(event, for: target)
    setWindowLocation(event, target.windowPoint)
    return event
  }

  static func postMouse(
    type: NSEvent.EventType, target: EventTarget, button: MouseButton, clickCount: Int,
    pressure: Float, flags: CGEventFlags = [], gate: @Sendable () throws -> Void = {}
  ) throws {
    let event = try makeMouseEvent(
      type: type, target: target, button: button, clickCount: clickCount, pressure: pressure, flags: flags)
    try gate()
    try post(event, to: target.processIdentifier)
  }

  static func makeScrollEvent(
    direction: ScrollDirection,
    amount: Int,
    target: EventTarget
  ) throws -> CGEvent {
    guard let setWindowLocation = PrivateAPI.setWindowLocation,
      PrivateAPI.postToPid != nil
    else {
      throw HelperError(
        .unsupported,
        "This version of macOS does not let Opensteer scroll a background window, so this app "
          + "can only be observed."
      )
    }
    let lines = Int32(amount * 3)
    let vertical: Int32
    let horizontal: Int32
    switch direction {
    case .up: (vertical, horizontal) = (lines, 0)
    case .down: (vertical, horizontal) = (-lines, 0)
    case .left: (vertical, horizontal) = (0, lines)
    case .right: (vertical, horizontal) = (0, -lines)
    }
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 2,
        wheel1: vertical,
        wheel2: horizontal,
        wheel3: 0
      )
    else {
      throw HelperError(.failed, "This Mac could not build a scroll for that app.")
    }
    event.location = target.screenPoint
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowID))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
      value: Int64(target.windowID)
    )
    stamp(event, for: target)
    setWindowLocation(event, target.windowPoint)
    return event
  }

  static func postScroll(
    direction: ScrollDirection, amount: Int, target: EventTarget,
    gate: @Sendable () throws -> Void = {}
  ) throws {
    let event = try makeScrollEvent(direction: direction, amount: amount, target: target)
    try gate()
    try post(event, to: target.processIdentifier)
  }

  /// One key the way Codex's helper presses it: when the modifiers it needs
  /// differ from those held, a flags change to them first and back to the held
  /// ones last, with no separate modifier key events; the key down and up
  /// carry what the key types (`VirtualKeys.characters`), because an event
  /// posted to a process is never translated by the window server — without
  /// them a field ignores Tab and a key equivalent never matches.
  static func keyEvents(
    virtualKey: CGKeyCode, flags: CGEventFlags, characters: String?, target: EventTarget
  ) throws -> [CGEvent] {
    guard PrivateAPI.postToPid != nil else {
      throw HelperError(.unsupported, "This version of macOS cannot address input to one app.")
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let held = CGEventSource.flagsState(.combinedSessionState)
    let modifiers: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand]
    let changes = held.intersection(modifiers) != flags.intersection(modifiers)
    func flagsChange(_ value: CGEventFlags) throws -> CGEvent {
      guard let event = CGEvent(source: source) else { throw unbuiltKey }
      event.type = .flagsChanged
      event.flags = value
      stamp(event, for: target)
      return event
    }
    func key(_ down: Bool) throws -> CGEvent {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: down)
      else { throw unbuiltKey }
      event.flags = flags
      if let characters {
        var units = Array(characters.utf16)
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      }
      stamp(event, for: target)
      return event
    }
    return (changes ? [try flagsChange(flags)] : []) + [try key(true), try key(false)]
      + (changes ? [try flagsChange(held)] : [])
  }

  /// One key, pressed and released (`keyEvents`).
  static func press(
    virtualKey: CGKeyCode, flags: CGEventFlags, characters: String?, target: EventTarget,
    pacing: UInt64? = nil, gate: @Sendable () throws -> Void = {}
  ) async throws {
    try await post(
      keyEvents(virtualKey: virtualKey, flags: flags, characters: characters, target: target),
      to: target, pacing: pacing, gate: gate)
  }

  /// A run of text as one key down and up carrying it as a unicode payload
  /// and nothing else: no layout key's modifiers, so no character of it can
  /// be taken for a shortcut. The key named is the one the layout types the
  /// run's first character with, so an app that reads key codes sees a real
  /// key rather than `A` for everything.
  static func unicodeEvents(_ chunk: String, target: EventTarget) throws -> [CGEvent] {
    guard PrivateAPI.postToPid != nil else {
      throw HelperError(.unsupported, "This version of macOS cannot address input to one app.")
    }
    let virtualKey =
      chunk.first.flatMap {
        VirtualKeys.code(for: KeyCombo(modifiers: [], key: String($0).lowercased()))
      } ?? 0
    return try [true, false].map { down in
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: down)
      else { throw unbuiltKey }
      var units = Array(chunk.utf16)
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      event.flags = []
      stamp(event, for: target)
      return event
    }
  }

  static func typeUnicode(
    _ chunk: String, target: EventTarget, pacing: UInt64? = nil,
    gate: @Sendable () throws -> Void = {}
  )
    async throws
  {
    try await post(unicodeEvents(chunk, target: target), to: target, pacing: pacing, gate: gate)
  }

  private static let unbuiltKey = HelperError(
    .failed, "This Mac could not build a keystroke for that app.")

  /// Each event is timestamped as it goes; text is paced a quarter of a
  /// millisecond per event, a shortcut not at all.
  private static func post(
    _ events: [CGEvent], to target: EventTarget, pacing: UInt64?, gate: @Sendable () throws -> Void
  )
    async throws
  {
    let process = ProcessStamp.of(target.processIdentifier)
    var sent = 0
    do {
      for event in events {
        try gate()
        event.timestamp = CGEventTimestamp(DispatchTime.now().uptimeNanoseconds)
        try post(event, to: target.processIdentifier)
        sent += 1
        if let pacing { try? await Task.sleep(nanoseconds: pacing) }
      }
    } catch {
      // Stop starts no new press, but releases a down/modifier already sent.
      // Never send that cleanup to a replacement process that reused the pid.
      if sent > 0, process?.isCurrent == true {
        for event in events.dropFirst(sent)
        where event.type == .keyUp || event.type == .flagsChanged {
          try? post(event, to: target.processIdentifier)
        }
      }
      throw error
    }
  }

  /// A person's key has one producer and explicit modifiers. In particular
  /// it never inherits the local person's physical modifier state.
  static func ownerKey(down: Bool, virtualKey: CGKeyCode, flags: CGEventFlags,
                       text: String?, repeatKey: Bool, target: EventTarget, modifier: Bool = false,
                       gate: @Sendable () throws -> Void = {}) throws {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: down)
    else { throw unbuiltKey }
    event.flags = flags
    if modifier { event.type = .flagsChanged }
    event.setIntegerValueField(.keyboardEventAutorepeat, value: repeatKey ? 1 : 0)
    if let text {
      var units = Array(text.utf16)
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
    }
    stamp(event, for: target)
    try gate()
    try post(event, to: target.processIdentifier)
  }

  static func ownerScroll(dx: Double, dy: Double, target: EventTarget,
                          gate: @Sendable () throws -> Void = {}) throws {
    guard let setWindowLocation = PrivateAPI.setWindowLocation,
      let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
        wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0)
    else { throw pointerUnsupported }
    event.flags = []
    event.location = target.screenPoint
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.windowID))
    stamp(event, for: target)
    setWindowLocation(event, target.windowPoint)
    try gate()
    try post(event, to: target.processIdentifier)
  }

  /// The process and window every event names.
  static func stamp(_ event: CGEvent, for target: EventTarget) {
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.processIdentifier))
    event.setIntegerValueField(windowNumberField, value: Int64(target.windowID))
  }

  static func post(_ event: CGEvent, to processIdentifier: pid_t) throws {
    // Event creation already proved this route exists. There is no second
    // delivery path: posting twice could perform the action twice.
    guard let postToPid = PrivateAPI.postToPid else {
      throw HelperError(.unsupported, "This version of macOS cannot address input to one app.")
    }
    postToPid(processIdentifier, event)
  }
}
