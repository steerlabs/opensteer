import AppKit
import ApplicationServices
import Foundation

// This driver is compiled and executed only by the disposable guest journey.
guard FileManager.default.fileExists(atPath: "/Volumes/My Shared Files/inputs") else { fatalError("Guest only") }
guard AXIsProcessTrusted() else { fatalError("Guest Accessibility permission missing") }
guard let application = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == (ProcessInfo.processInfo.environment["OPENSTEER_JOURNEY_BUNDLE_ID"] ?? "com.opensteer.opensteer") }) else { fatalError("Update app is not running") }
let target = AXUIElementCreateApplication(application.processIdentifier)
AXUIElementSetMessagingTimeout(target, 3)
AXUIElementSetAttributeValue(target, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(target, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func elements(_ element: AXUIElement, _ depth: Int = 0) -> [AXUIElement] {
    if depth > 40 { return [] }
    let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    return [element] + children.flatMap { elements($0, depth + 1) }
}
let args = CommandLine.arguments
let command = args[1]
let all = elements(target)
func info(_ element: AXUIElement) -> [String:String] {
    ["role":text(element,kAXRoleAttribute),"title":text(element,kAXTitleAttribute),"description":text(element,kAXDescriptionAttribute),"value":text(element,kAXValueAttribute),"help":text(element,kAXHelpAttribute)]
}
func emit(_ value: Any) {
    let bytes = try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])
    print(String(data:bytes,encoding:.utf8)!)
}
if command == "dump" { emit(all.map(info)); exit(0) }
if command == "window" {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    guard let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == application.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }) else { fatalError("No update app window") }
    emit(["id":window[kCGWindowNumber as String]!,"pid":application.processIdentifier]);exit(0)
}
let query = args[2]
let roles = ["AXButton","AXRadioButton","AXLink","AXMenuItem","AXCheckBox","AXPopUpButton"]
let matches = all.filter { element in
    guard roles.contains(text(element,kAXRoleAttribute)) else { return false }
    let labels = [text(element,kAXTitleAttribute),text(element,kAXDescriptionAttribute),text(element,kAXValueAttribute)]
    return labels.contains(where: { $0.localizedCaseInsensitiveContains(query) })
}
guard let element = matches.first else { emit(["error":"No matching control","query":query,"elements":all.map(info)]); exit(3) }
application.activate(options:[])
RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    var point=CGPoint.zero, size=CGSize.zero
    guard let position=attribute(element,kAXPositionAttribute), let dimensions=attribute(element,kAXSizeAttribute),
          CFGetTypeID(position)==AXValueGetTypeID(), CFGetTypeID(dimensions)==AXValueGetTypeID(),
          AXValueGetValue(position as! AXValue,.cgPoint,&point), AXValueGetValue(dimensions as! AXValue,.cgSize,&size) else { fatalError("Control has no screen bounds") }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else { fatalError("Update app must own guest focus") }
    let center=CGPoint(x:point.x+size.width/2,y:point.y+size.height/2)
    for type in [CGEventType.mouseMoved,.leftMouseDown,.leftMouseUp] {
        let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:center,mouseButton:.left)!
        event.setIntegerValueField(.mouseEventClickState,value:1);event.post(tap:.cghidEventTap);usleep(30000)
    }
emit(["pressed":query,"role":text(element,kAXRoleAttribute)])
