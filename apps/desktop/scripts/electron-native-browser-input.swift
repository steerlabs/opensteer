import AppKit
import ApplicationServices
import Darwin

func emit(_ value: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!)
    fflush(stdout)
}
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "status"
if mode == "status" {
    let frontmost = NSWorkspace.shared.frontmostApplication
    let cursor = CGEvent(source: nil)!.location
    emit(["accessibilityTrusted": AXIsProcessTrusted(), "screenCaptureAllowed": CGPreflightScreenCaptureAccess(), "frontmostPid": frontmost?.processIdentifier ?? -1, "frontmostExecutable": frontmost?.executableURL?.path ?? "", "cursor": ["x": cursor.x, "y": cursor.y], "os": ProcessInfo.processInfo.operatingSystemVersionString])
    exit(0)
}
if mode == "sentinel" {
    let application = NSApplication.shared
    application.setActivationPolicy(.regular)
    let file = args[2]
    let forbidden = Int32(args[3])!
    var forbiddenCount = 0
    var events: [[String: Any]] = []
    let field = NSTextField(frame: NSRect(x: 20, y: 30, width: 300, height: 24))
    let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 350, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Native browser smoke focus sentinel"
    func record() {
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        if pid == forbidden { forbiddenCount += 1 }
        events.append(["uptime": ProcessInfo.processInfo.systemUptime, "frontmostPid": pid])
        // A window can rise above the person's app without activating its own.
        let stack = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
            .filter { [getpid(), forbidden].contains($0[kCGWindowOwnerPID as String] as? Int32 ?? -1) }
            .compactMap { $0[kCGWindowNumber as String] as? Int }
        let bytes = try! JSONSerialization.data(withJSONObject: ["pid": getpid(), "frontmostPid": pid, "forbiddenCount": forbiddenCount, "text": field.stringValue, "events": events, "window": window.windowNumber, "stack": stack], options: [.sortedKeys])
        try! bytes.write(to: URL(fileURLWithPath: file), options: .atomic)
    }
    let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in record() }
    window.contentView?.addSubview(field)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(field)
    application.activate(ignoringOtherApps: true)
    record()
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in record() }
    application.run()
    NSWorkspace.shared.notificationCenter.removeObserver(observer)
    exit(0)
}
// The Node parent can inspect its Electron child's capture target without
// giving that process permission to send input to an unrelated application.
let captureInventory = mode == "capture-window"
let sentinelInput = mode == "sentinel-key"
guard args.count >= 3, let pid = Int32(args[2]) else { exit(2) }
var sentinelInfo = proc_bsdinfo()
let parentBytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &sentinelInfo, Int32(MemoryLayout<proc_bsdinfo>.size))
let executable = UnsafeMutablePointer<CChar>.allocate(capacity: Int(4 * MAXPATHLEN))
defer { executable.deallocate() }
let pathBytes = proc_pidpath(pid, executable, UInt32(4 * MAXPATHLEN))
let ownExecutable = URL(fileURLWithPath: args[0]).standardizedFileURL.resolvingSymlinksInPath().path
let targetExecutable = pathBytes > 0 ? URL(fileURLWithPath: String(cString: executable)).standardizedFileURL.resolvingSymlinksInPath().path : ""
let sentinelPredicates: [String: Bool] = ["sentinelMode": sentinelInput, "differentFromParent": pid != getppid(), "processInfoRead": parentBytes == MemoryLayout<proc_bsdinfo>.size, "ownedParent": sentinelInfo.pbi_ppid == UInt32(getppid()), "processPathRead": pathBytes > 0, "sameCanonicalExecutable": targetExecutable == ownExecutable]
let ownedSentinel = sentinelPredicates.values.allSatisfy { $0 }
let ownedElectron = (pid == getppid() || captureInventory) && NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.github.Electron"
guard sentinelInput ? ownedSentinel : ownedElectron else {
    let diagnostic: [String: Any] = ["ownershipGuardFailed": true, "pid": pid, "parentPid": getppid(), "targetParentPid": sentinelInfo.pbi_ppid, "ownExecutable": ownExecutable, "targetExecutable": targetExecutable, "failedPredicates": sentinelPredicates.filter { !$0.value }.map { $0.key }.sorted()]
    emit(diagnostic)
    let diagnosticBytes = try! JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys])
    fputs(String(data: diagnosticBytes, encoding: .utf8)! + "\n", stderr)
    fputs("Refusing input/inventory outside the invoking smoke Electron or its exact owned sentinel executable\n", stderr)
    exit(2)
}
let windows = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
if captureInventory {
    guard args.count == 4, let wid = Int64(args[3]), let window = windows.first(where: { ($0[kCGWindowNumber as String] as? Int64) == wid }) else { emit(["error": "Capture window is not owned by the smoke Electron PID", "pid": pid]); exit(4) }
    emit(["pid": pid, "window": window])
    exit(0)
}
if mode == "windows" { emit(["pid": pid, "windows": windows]); exit(0) }
if mode == "clipboard-save" || mode == "clipboard-restore" {
    guard args.count == 4 else { exit(2) }
    let file = URL(fileURLWithPath: args[3])
    let pasteboard = NSPasteboard.general
    do {
        if mode == "clipboard-save" {
            let items = (pasteboard.pasteboardItems ?? []).map { item in
                Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                    item.data(forType: type).map { (type.rawValue, $0.base64EncodedString()) }
                })
            }
            try JSONSerialization.data(withJSONObject: items).write(to: file, options: .atomic)
            guard chmod(file.path, 0o600) == 0 else { exit(6) }
            emit(["saved": true, "items": items.count])
        } else {
            let bytes = try Data(contentsOf: file)
            guard let values = try JSONSerialization.jsonObject(with: bytes) as? [[String: String]] else { exit(6) }
            let items = try values.map { value in
                let item = NSPasteboardItem()
                for (type, encoded) in value {
                    guard let data = Data(base64Encoded: encoded), item.setData(data, forType: NSPasteboard.PasteboardType(type)) else { throw CocoaError(.fileReadCorruptFile) }
                }
                return item
            }
            pasteboard.clearContents()
            guard items.isEmpty || pasteboard.writeObjects(items) else { exit(6) }
            emit(["restored": true, "items": items.count])
        }
    } catch {
        fputs("Pasteboard preservation failed: \(error)\n", stderr)
        exit(6)
    }
    exit(0)
}
if mode == "input-ready" {
    guard args.count == 3, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        emit(["ready": false, "reason": "Owned Electron is not foreground"]); exit(4)
    }
    var previous = CGEvent(source: nil)!.location
    var stableSamples = 0
    for _ in 0..<40 {
        usleep(30000)
        let current = CGEvent(source: nil)!.location
        stableSamples = current == previous ? stableSamples + 1 : 0
        previous = current
        if stableSamples >= 5 {
            let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
            emit(["ready": foreground, "cursorStable": true, "stableSamples": stableSamples, "pid": pid])
            exit(foreground ? 0 : 4)
        }
    }
    emit(["ready": false, "reason": "Cursor did not settle before exclusive input"]); exit(5)
}
guard AXIsProcessTrusted() else { emit(["posted": false, "reason": "Accessibility permission missing"]); exit(3) }
let before = CGEvent(source: nil)!.location
let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
if mode == "key" || sentinelInput {
    guard args.count == 5, let code = UInt16(args[3]), let flags = UInt64(args[4]) else { exit(2) }
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
        event.flags = CGEventFlags(rawValue: flags)
        event.postToPid(pid)
        usleep(30000)
    }
} else if mode == "mouse" {
    guard args.count == 7, let wid = Int64(args[3]), let x = Double(args[4]), let y = Double(args[5]), let own = windows.first(where: { ($0[kCGWindowNumber as String] as? Int64) == wid }), let bounds = own[kCGWindowBounds as String] as? [String: Double], let bx = bounds["X"], let by = bounds["Y"] else { exit(4) }
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { emit(["posted": false, "reason": "window-local setter unavailable"]); exit(4) }
    let setWindowLocation = unsafeBitCast(symbol, to: SetWindowLocation.self)
    let right = args[6] == "right"
    for type in right ? [CGEventType.rightMouseDown, .rightMouseUp] : [CGEventType.leftMouseDown, .leftMouseUp] {
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: right ? .right : .left)!
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: wid)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: wid)
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: wid)
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        setWindowLocation(event, CGPoint(x: x-bx, y: y-by))
        event.postToPid(pid)
        usleep(30000)
    }
} else { exit(2) }
let after = CGEvent(source: nil)!.location
emit(["posted": true, "cursorUnchanged": before == after, "pid": pid, "cursorBefore": ["x": before.x, "y": before.y], "cursorAfter": ["x": after.x, "y": after.y], "frontmostBefore": frontmostBefore, "frontmostAfter": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1])
if before != after { exit(5) }
