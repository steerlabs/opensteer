import AppKit
import Carbon

// Native events are permitted only in a disposable test:vm guest.
guard FileManager.default.currentDirectoryPath.hasSuffix("/opensteer-job/src/apps/desktop") else {
  fatalError("Run native tracing only through pnpm test:vm")
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
func pump(_ seconds: TimeInterval) {
  RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
}
func property(_ source: TISInputSource, _ key: CFString) -> Any? {
  guard let value = TISGetInputSourceProperty(source, key) else { return nil }
  return Unmanaged<AnyObject>.fromOpaque(value).takeUnretainedValue()
}
func identifier(_ source: TISInputSource) -> String {
  return property(source, kTISPropertyInputSourceID) as? String ?? ""
}
func description(_ source: TISInputSource) -> [String: Any] {
  return [
    "id": identifier(source),
    "bundleId": property(source, kTISPropertyBundleID) as? String ?? "",
    "type": property(source, kTISPropertyInputSourceType) as? String ?? "",
    "enabled": property(source, kTISPropertyInputSourceIsEnabled) as? Bool ?? false,
    "selectable": property(source, kTISPropertyInputSourceIsSelectCapable) as? Bool ?? false,
    "selected": property(source, kTISPropertyInputSourceIsSelected) as? Bool ?? false,
  ]
}
func json(_ value: Any) {
  let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(data: bytes, encoding: .utf8)!)
}
let arguments = CommandLine.arguments
let mode = arguments[1]
let sources = TISCreateInputSourceList(nil, true).takeRetainedValue() as! [TISInputSource]
if mode == "sources" {
  json(sources.map(description))
  exit(0)
}
if mode == "source" {
  let requested = arguments[2]
  guard let source = sources.first(where: { identifier($0) == requested }) else {
    json(["requested": requested, "error": "unavailable"])
    exit(2)
  }
  var statuses: [[String: Any]] = []
  // Input modes cannot be enabled or selected until their parent method is enabled.
  if property(source, kTISPropertyInputSourceType) as? String == kTISTypeKeyboardInputMode as String {
    let bundle = property(source, kTISPropertyBundleID) as? String
    if let bundle, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = false
      var opened = false
      var launchError = ""
      NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
        launchError = error.map(String.init(describing:)) ?? ""
        opened = true
      }
      let deadline = Date(timeIntervalSinceNow: 5)
      while !opened && Date() < deadline { pump(0.05) }
      statuses.append(["launch": url.path, "completed": opened, "error": launchError])
    }
    for parent in sources where
      property(parent, kTISPropertyBundleID) as? String == bundle &&
      property(parent, kTISPropertyInputSourceType) as? String == kTISTypeKeyboardInputMethodModeEnabled as String {
      statuses.append(["id": identifier(parent), "enable": TISEnableInputSource(parent)])
    }
  }
  statuses.append(["id": identifier(source), "enable": TISEnableInputSource(source)])
  pump(0.2)
  let selected = TISSelectInputSource(source)
  pump(0.4)
  let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  json(["requested": requested, "statuses": statuses, "select": selected, "current": description(current)])
  exit(selected == noErr && identifier(current) == requested ? 0 : 3)
}
if mode == "apps" {
  json(NSWorkspace.shared.runningApplications.map { app in
    ["pid": app.processIdentifier, "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""] as [String: Any]
  })
  exit(0)
}
let pid = pid_t(arguments[2])!
if pid > 0 { NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows]) }
pump(0.2)
if mode == "button" {
  let titles = Array(arguments.dropFirst(3))
  var visited = 0
  var buttons: [[String: Any]] = []
  func find(_ element: AXUIElement) -> AXUIElement? {
    visited += 1
    if visited > 2000 { return nil }
    var role: CFTypeRef?, children: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
    let names = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap { attribute -> String? in
      var value: CFTypeRef?
      AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
      return (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
    var actions: CFArray?
    AXUIElementCopyActionNames(element, &actions)
    let pressable = (actions as? [String] ?? []).contains(kAXPressAction as String)
    if pressable && buttons.count < 40 { buttons.append(["role": role as? String ?? "", "names": names]) }
    if pressable && names.contains(where: { name in titles.contains(where: { name.caseInsensitiveCompare($0) == .orderedSame }) }) { return element }
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
    for child in children as? [AXUIElement] ?? [] {
      if let found = find(child) { return found }
    }
    return nil
  }
  let root = AXUIElementCreateApplication(pid)
  let enhanced = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  var button: AXUIElement?
  let deadline = Date(timeIntervalSinceNow: 5)
  repeat {
    visited = 0
    buttons = []
    button = find(root)
    if button == nil { pump(0.1) }
  } while button == nil && Date() < deadline
  let status = button.map { AXUIElementPerformAction($0, kAXPressAction as CFString).rawValue }
  json(["button": titles.joined(separator: " / "), "found": button != nil, "pressStatus": status ?? -1,
        "accessibilityTrusted": AXIsProcessTrusted(), "enhancedAccessibilityStatus": enhanced.rawValue,
        "visited": visited, "nativeButtons": buttons])
  exit(0)
}
if mode == "click" {
  let point = CGPoint(x: Double(arguments[3])!, y: Double(arguments[4])!)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
    pump(0.06)
  }
  exit(0)
}
for argument in arguments.dropFirst(3) {
  let parts = argument.split(separator: ":").map(String.init)
  let code = CGKeyCode(parts[0])!
  var flags: CGEventFlags = []
  var modifiers: [(CGKeyCode, CGEventFlags)] = []
  for (name, key, flag) in [("alt", CGKeyCode(58), CGEventFlags.maskAlternate),
                            ("control", CGKeyCode(59), CGEventFlags.maskControl),
                            ("meta", CGKeyCode(55), CGEventFlags.maskCommand),
                            ("shift", CGKeyCode(56), CGEventFlags.maskShift)] where parts.contains(name) {
    modifiers.append((key, flag))
    flags.insert(flag)
    let modifier = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)!
    modifier.type = .flagsChanged
    modifier.flags = flags
    modifier.post(tap: .cghidEventTap)
    pump(0.04)
  }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
  down.flags = flags
  down.post(tap: .cghidEventTap)
  if parts.contains("hold") {
    pump(0.5)
    for _ in 0..<10 {
      let repeated = down.copy()!
      repeated.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
      repeated.post(tap: .cghidEventTap)
      pump(0.08)
    }
  } else { pump(0.06) }
  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
  up.flags = flags
  up.post(tap: .cghidEventTap)
  for (key, flag) in modifiers.reversed() {
    flags.remove(flag)
    let modifier = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)!
    modifier.type = .flagsChanged
    modifier.flags = flags
    modifier.post(tap: .cghidEventTap)
    pump(0.04)
  }
  pump(0.15)
}
json(["current": description(TISCopyCurrentKeyboardInputSource().takeRetainedValue()),
      "frontPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0])
