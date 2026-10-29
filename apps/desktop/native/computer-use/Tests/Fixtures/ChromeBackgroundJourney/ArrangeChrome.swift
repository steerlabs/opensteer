// VM journey inputs only: arrange Chrome and answer this helper's capture consent.
import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "consent" {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  print(String(data: try! JSONSerialization.data(withJSONObject: windows), encoding: .utf8)!)
  var pressed = false
  for pid in Set(windows.compactMap { $0[kCGWindowOwnerPID as String] as? Int32 }) {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.15)
    for window in attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
      var queue = [window], text: [String] = [], allow: AXUIElement?
      var cursor = 0
      while cursor < queue.count && cursor < 250 {
        let element = queue[cursor]; cursor += 1
        let title = attribute(element, kAXTitleAttribute) as? String ?? ""
        let value = attribute(element, kAXValueAttribute) as? String ?? ""
        text.append(title); text.append(value)
        if title == "Allow", attribute(element, kAXRoleAttribute) as? String == kAXButtonRole { allow = element }
        queue.append(contentsOf: attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [])
      }
      let message = text.joined(separator: " ")
      if message.contains("Opensteer Computer Use"), message.contains("requesting to bypass"), let allow {
        let result = AXUIElementPerformAction(allow, kAXPressAction as CFString)
        guard result == .success else { fatalError("Capture consent refused: \(result)") }
        pressed = true
      }
    }
  }
  print("Capture consent pressed=\(pressed)")
} else {
  let args = arguments.compactMap(Double.init)
  guard args.count == 2,
    let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first
  else { fatalError("Expected running Chrome and x y") }
  let target = AXUIElementCreateApplication(app.processIdentifier)
  guard let windows = attribute(target, kAXWindowsAttribute) as? [AXUIElement], let window = windows.first
  else { fatalError("Chrome has no accessible window") }
  var point = CGPoint(x: args[0], y: args[1])
  let moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &point)!)
  guard moved == .success else { fatalError("Chrome position refused: \(moved)") }
  app.activate(options: [.activateIgnoringOtherApps])
  print("Arranged Chrome pid=\(app.processIdentifier) x=\(point.x) y=\(point.y)")
}
