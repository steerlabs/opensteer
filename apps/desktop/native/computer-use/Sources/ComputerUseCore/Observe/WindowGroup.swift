import AppKit
import ApplicationServices
import CoreGraphics

/// One ownership decision shared by capture, tree, routing and video. Only
/// resolve reads AX; consumers carry this immutable value across their awaits.
struct WindowGroup: Sendable, Equatable {
  struct CaptureLayout: Sendable, Equatable {
    let root: ObservedWindow
    let members: [AppWindows.Entry]
    let crop: CGRect
    let displayID: CGDirectDisplayID?
    let nativeScale: CGFloat
    let alone: Bool
  }
  struct Signature: Sendable, Equatable {
    let associated: [CGWindowID]
    let windows: [AppWindows.Entry]
    let modalIDs: [CGWindowID]
    let blockers: [WindowBlocker]
    let focused: CGWindowID?
    let menuBarOpen: Bool
    let hidden: Bool
    let lifecycle: UInt64
  }
  let revision: UInt64
  let root: WindowIdentity
  let members: [AppWindows.Entry]
  let crop: CGRect
  let displayID: CGDirectDisplayID?
  let nativeScale: CGFloat
  let alone: Bool
  let blockedBy: [WindowBlocker]
  let signature: Signature

  var captureLayout: CaptureLayout {
    // Contained child content changes pixels, not the picture-to-window mapping.
    // Keep it in the group; ScreenCaptureKit includes child windows dynamically.
    CaptureLayout(root: ObservedWindow(windowID: root.windowID, frame: root.frame),
      members: members.filter { !root.frame.contains($0.window.frame) },
      crop: crop, displayID: displayID, nativeScale: nativeScale, alone: alone)
  }

  private static let revisions = Locked<UInt64>(0)

  @WorkActor
  static func resolve(
    window: AXUIElement, process: ProcessStamp, lifecycleRevision: UInt64,
    previous: WindowGroup? = nil, liveness: WindowLiveness? = nil, check: () throws -> Void = {}
  ) throws -> WindowGroup {
    try check()
    try requireAvailable()
    let lifetime: WindowLiveness
    if let liveness {
      lifetime = liveness
    } else {
      guard let id = KeyWindow.windowID(of: window) else {
        throw HelperError(.unsupported, "This app's exact window could not be identified.")
      }
      lifetime = WindowLiveness(process: process, element: window, windowID: id)
    }
    // A retained identity must see definitive lifetime loss before optional
    // metadata can fail. Missing destroy notifications cannot keep video alive.
    let live = try lifetime.read()
    if live.minimized {
      throw HelperError(.unsupported, "The window is minimized; ask the person to restore it.")
    }
    guard live.hidden || live.entry.alpha > 0 else {
      throw HelperError(.unsupported, "This window is transparent; ask the person to show it.")
    }
    let root = WindowIdentity(
      windowID: lifetime.windowID,
      title: AXValueReader.copyString(window, kAXTitleAttribute).map {
        ActionDescription.clip($0, to: 1024)
      },
      frame: live.entry.window.frame)
    let pid = process.processIdentifier
    let hidden = live.hidden
    var all = AppWindows.all(processIdentifier: pid)
    let rootEntry = live.entry
    if !all.contains(where: { $0.window.windowID == root.windowID }) { all.append(rootEntry) }
    let associated = try PrivateAPI.associatedWindows(root.windowID)
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    let axWindows = AXValueReader.copyElements(app, kAXWindowsAttribute)
    let focused = AXValueReader.copyElement(app, kAXFocusedWindowAttribute).flatMap(
      KeyWindow.windowID)
    let barMenus = TreeRoots.menuBarMenus(of: app)
    let alone = hidden || !rootEntry.onScreen
    var modalWindows: [AXUIElement] = []
    for candidate in axWindows {
      try check()
      if AXValueReader.copyBool(candidate, kAXModalAttribute) == true { modalWindows.append(candidate) }
    }
    let modalIDs = modalWindows.compactMap(KeyWindow.windowID).sorted()
    var allowed = Set(associated)
    allowed.insert(root.windowID)
    // The selected menu-bar item's ownership is the focused window's. Context
    // and pop-up menus have WindowServer associations instead.
    if !alone, focused == root.windowID, !barMenus.isEmpty {
      let frames = barMenus.compactMap(AXValueReader.copyFrame)
      for entry in all where entry.onScreen && entry.layer >= AppWindows.popUpMenuLevel {
        if frames.contains(where: { $0.intersects(entry.window.frame) }) {
          allowed.insert(entry.window.windowID)
        }
      }
    }
    let members =
      alone
      ? [rootEntry]
      : all.filter {
        allowed.contains($0.window.windowID) && $0.onScreen
      }
    var blockers: [WindowBlocker] = []
    for modal in modalWindows {
      try check()
      guard let id = KeyWindow.windowID(of: modal), id != root.windowID, !allowed.contains(id),
        all.contains(where: { $0.window.windowID == id })
      else { continue }
      blockers.append(WindowBlocker(id: id, title: title(modal), kind: .dialog))
    }
    let menus = all.filter {
      $0.onScreen && $0.layer >= AppWindows.popUpMenuLevel && !allowed.contains($0.window.windowID)
    }
    if !menus.isEmpty {
      for sibling in axWindows {
        try check()
        guard let id = KeyWindow.windowID(of: sibling), id != root.windowID,
          !allowed.contains(id)
        else { continue }
        let siblingMembers = Set(try PrivateAPI.associatedWindows(id))
        let ownsMenu =
          menus.contains { siblingMembers.contains($0.window.windowID) }
          || (focused == id && !barMenus.isEmpty)
        if ownsMenu { blockers.append(WindowBlocker(id: id, title: title(sibling), kind: .menu)) }
      }
    }
    blockers = Array(blockers.prefix(8))
    let displays = displays()
    let display = displays.max {
      CGDisplayBounds($0).intersection(root.frame).area
        < CGDisplayBounds($1).intersection(root.frame).area
    }.flatMap { CGDisplayBounds($0).intersection(root.frame).area > 0 ? $0 : nil }
    guard alone || display != nil else {
      throw HelperError(
        .unsupported,
        "The window is not on a display this Mac can capture; ask the person to move it.")
    }
    let crop =
      alone
      ? root.frame
      : WindowCapture.captureRect(
        keyWindowFrame: root.frame, appWindowFrames: members.map(\.window.frame),
        displayFrame: display.map(CGDisplayBounds) ?? root.frame)
    // Include every app popup and modal, even if it is not a member. A blocker
    // opening/closing must retire a composition assembled before it existed.
    let signatureWindows = all.filter {
      allowed.contains($0.window.windowID)
        || $0.layer >= AppWindows.popUpMenuLevel || modalIDs.contains($0.window.windowID)
    }
    let signature = Signature(
      associated: associated.sorted(), windows: signatureWindows,
      modalIDs: modalIDs, blockers: blockers, focused: focused, menuBarOpen: !barMenus.isEmpty,
      hidden: hidden, lifecycle: lifecycleRevision)
    let revision: UInt64
    if let previous, previous.signature == signature { revision = previous.revision }
    else { revision = revisions.withLock { $0 &+= 1; return $0 } }
    return WindowGroup(
      revision: revision, root: root, members: members, crop: crop,
      displayID: alone ? nil : display,
      nativeScale: display.flatMap(CGDisplayCopyDisplayMode).map {
        CGFloat($0.pixelWidth) / CGFloat(max(1, $0.width))
      } ?? 1,
      alone: alone, blockedBy: blockers, signature: signature)
  }

  static func requireAvailable() throws {
    guard PrivateAPI.windowGroupsAvailable else {
      throw HelperError(.unsupported, "This version of macOS cannot identify window groups.")
    }
  }

  @WorkActor private static func title(_ window: AXUIElement) -> String {
    ActionDescription.clip(AXValueReader.copyString(window, kAXTitleAttribute) ?? "", to: 1024)
  }
  private static func displays() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
  }
}
