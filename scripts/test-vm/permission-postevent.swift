import AppKit
import ApplicationServices
import Darwin
let output = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 400, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Opensteer VM permission proof"
let field = NSTextField(frame: NSRect(x: 20, y: 60, width: 350, height: 30))
window.contentView?.addSubview(field)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(field)
Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in
    let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
    let chars = Array("VM-POSTEVENT-OK".utf16)
    event.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    event.postToPid(getpid())
}
Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in
    let value: [String: Any] = ["pid":getpid(),"text":field.stringValue,"accessibilityTrusted":AXIsProcessTrusted(),"postEventAllowed":CGPreflightPostEventAccess(),"screenCaptureAllowed":CGPreflightScreenCaptureAccess(),"windowId":window.windowNumber,"expected":"VM-POSTEVENT-OK"]
    try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: URL(fileURLWithPath: output))
    app.terminate(nil)
}
app.run()
