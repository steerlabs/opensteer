import AppKit

final class FixtureApplication: NSApplication {
  override func sendEvent(_ event: NSEvent) {
    if [.leftMouseDown, .leftMouseUp, .rightMouseDown, .keyDown, .keyUp, .flagsChanged, .scrollWheel].contains(event.type) {
      var row: [String: Any] = ["id": event.windowNumber, "title": event.window?.title ?? "", "type": event.type.rawValue, "x": event.locationInWindow.x, "y": event.locationInWindow.y,
        "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000]
      if [.keyDown, .keyUp, .flagsChanged].contains(event.type) {
        row["code"] = event.keyCode
        row["flags"] = event.modifierFlags.rawValue
        row["sourceStamp"] = event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0
      }
      if let data = try? JSONSerialization.data(withJSONObject: row), let file = try? FileHandle(forWritingTo: output.appendingPathComponent("dispatch.jsonl")) {
        defer { try? file.close() }; _ = try? file.seekToEnd(); try? file.write(contentsOf: data + Data([10]))
      }
    }
    super.sendEvent(event)
  }
}

class FixtureWindow: NSWindow {
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
/// Its accessibility role reads as a number, so a client cannot verify the window.
final class UnreadableWindow: FixtureWindow {
  override func accessibilityAttributeValue(_ attribute: NSAccessibility.Attribute) -> Any? {
    attribute == .role ? NSNumber(value: 1) : super.accessibilityAttributeValue(attribute)
  }
}
final class Receiver: NSView {
  let name: String
  let output: URL
  init(_ name: String, _ output: URL) {
    self.name = name
    self.output = output
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("WINDOW " + name)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    (name == "A" ? NSColor.systemRed : name == "B" ? .systemBlue : .systemGreen).setFill()
    bounds.fill()
    ("WINDOW " + name).draw(
      at: NSPoint(x: 30, y: 60),
      withAttributes: [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.white])
  }
  func record(_ event: NSEvent) {
    let row: [String: Any] = [
      "window": name, "id": window?.windowNumber ?? 0, "type": event.type.rawValue,
      "characters": (event.type == .keyDown || event.type == .keyUp) ? event.characters ?? "" : "",
      "x": event.locationInWindow.x, "y": event.locationInWindow.y,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: row),
      let file = try? FileHandle(forWritingTo: output.appendingPathComponent("events.jsonl"))
    else { return }
    defer { try? file.close() }
    try? file.seekToEnd()
    try? file.write(contentsOf: data + Data([10]))
  }
  override func mouseDown(with event: NSEvent) { record(event) }
  override func rightMouseDown(with event: NSEvent) {
    record(event)
    menuOwner = name
    fixtureMenu().popUp(positioning: nil, at: event.locationInWindow, in: self)
  }
  override func keyDown(with event: NSEvent) {
    record(event)
    if name == "A", moveOnKey {
      moveOnKey = false
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
        windows["A"]?.setFrameOrigin(NSPoint(x: 180, y: 230))
      }
    }
  }
}
var ownerSaveCount = 0
final class MenuReceiver: NSObject {
  @objc func saveOwnerNote(_ sender: Any?) {
    ownerSaveCount += 1
    try? ownerNote.string.write(to: output.appendingPathComponent("owner-saved.txt"), atomically: true, encoding: .utf8)
  }
  @objc func chooseControl(_ sender: NSButton) {
    try? JSONSerialization.data(withJSONObject: [
      "window": sender.window?.title ?? "", "control": sender.title,
    ]).write(to: output.appendingPathComponent("control-action.json"))
  }
  @objc func choose(_ sender: NSMenuItem) {
    let row = ["window": menuOwner, "command": sender.title]
    try? JSONSerialization.data(withJSONObject: row).write(to: output.appendingPathComponent("menu-action.json"))
  }
}
let menuReceiver = MenuReceiver()
var menuOwner = "A"
var trackedMenu: NSMenu?
func fixtureMenu() -> NSMenu {
  let menu = NSMenu(title: "Fixture menu")
  menu.addItem(
    withTitle: "Associated menu command", action: #selector(MenuReceiver.choose(_:)),
    keyEquivalent: "")
  menu.items.forEach { $0.target = menuReceiver }
  trackedMenu = menu
  return menu
}
let app = FixtureApplication.shared
app.setActivationPolicy(.regular)
let output = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : Bundle.main.object(forInfoDictionaryKey: "FixtureOutput") as! String)
if !FileManager.default.fileExists(atPath: output.appendingPathComponent("events.jsonl").path) {
  FileManager.default.createFile(atPath: output.appendingPathComponent("events.jsonl").path, contents: nil)
}
if !FileManager.default.fileExists(atPath: output.appendingPathComponent("dispatch.jsonl").path) {
  FileManager.default.createFile(atPath: output.appendingPathComponent("dispatch.jsonl").path, contents: nil)
}
try? JSONSerialization.data(withJSONObject: ["applicationClass": String(describing: type(of: app)), "pid": getpid()]).write(to: output.appendingPathComponent("receiver-metadata.json"))
var windows: [String: NSWindow] = [:]
var popover: NSPopover?
var moveOnKey = false
func make(
  _ name: String, _ rect: NSRect,
  _ style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable],
  unreadable: Bool = false
) -> NSWindow {
  let window =
    unreadable
    ? UnreadableWindow(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
    : FixtureWindow(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
  window.title = name
  window.isReleasedWhenClosed = false
  window.contentView = Receiver(name, output)
  window.makeFirstResponder(window.contentView)
  window.orderFrontRegardless()
  windows[name] = window
  return window
}
let a = make("A", NSRect(x: 120, y: 200, width: 460, height: 340))
let movable = NSButton(
  title: "Reparent me", target: menuReceiver, action: #selector(MenuReceiver.chooseControl(_:)))
movable.frame = NSRect(x: 180, y: 40, width: 120, height: 28)
a.contentView!.addSubview(movable)
let mutable = NSTextField(string: "seed")
mutable.setAccessibilityLabel("Mutable value")
mutable.frame = NSRect(x: 30, y: 130, width: 160, height: 28)
a.contentView!.addSubview(mutable)
final class CredentialDelegate: NSObject, NSTextFieldDelegate {
  var switchAfterFirst = false
  func controlTextDidChange(_ notification: Notification) {
    if switchAfterFirst, notification.object as? NSTextField === username {
      switchAfterFirst = false
      a.makeFirstResponder(password)
    }
  }
}
let credentialDelegate = CredentialDelegate()
let username = NSTextField(string: "")
username.setAccessibilityLabel("Fixture username")
username.frame = NSRect(x: 30, y: 200, width: 180, height: 28)
username.delegate = credentialDelegate
let password = NSSecureTextField(string: "")
password.setAccessibilityLabel("Fixture password")
password.frame = NSRect(x: 30, y: 245, width: 180, height: 28)
a.contentView!.addSubview(username)
a.contentView!.addSubview(password)
a.autorecalculatesKeyViewLoop = false
username.nextKeyView = password
password.nextKeyView = username
var ownerLatencyEnabled = false
var ownerLatencyCount = 0
final class OwnerLatencyPatch: NSView {
  override func draw(_ dirtyRect: NSRect) {
    (ownerLatencyCount % 2 == 0 ? NSColor.red : NSColor.green).setFill()
    bounds.fill()
  }
}
let ownerLatencyPatch = OwnerLatencyPatch(frame: NSRect(x: 30, y: 85, width: 64, height: 32))
a.contentView!.addSubview(ownerLatencyPatch)
final class OwnerNote: NSTextView {
  override func didChangeText() {
    super.didChangeText()
    if ownerLatencyEnabled {
      ownerLatencyCount += 1
      ownerLatencyPatch.needsDisplay = true
    }
  }
}
let ownerNote = OwnerNote(frame: NSRect(x: 260, y: 190, width: 180, height: 120))
ownerNote.setAccessibilityLabel("Owner input note")
ownerNote.isRichText = false
ownerNote.allowsUndo = true
ownerNote.font = .systemFont(ofSize: 18)
a.contentView!.addSubview(ownerNote)
let mainMenu = NSMenu()
let applicationItem = NSMenuItem(title: "Window Group Fixture", action: nil, keyEquivalent: "")
applicationItem.submenu = NSMenu(title: "Window Group Fixture")
mainMenu.addItem(applicationItem)
let fileItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
let fileMenu = NSMenu(title: "File")
let saveItem = NSMenuItem(title: "Save", action: #selector(MenuReceiver.saveOwnerNote(_:)), keyEquivalent: "s")
saveItem.target = menuReceiver
fileMenu.addItem(saveItem)
fileItem.submenu = fileMenu
mainMenu.addItem(fileItem)
let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")
editItem.submenu = editMenu
mainMenu.addItem(editItem)
app.mainMenu = mainMenu
let originalAID = a.windowNumber
let b = make("B", NSRect(x: 380, y: 260, width: 480, height: 350))
_ = make("C", NSRect(x: 900, y: 90, width: 260, height: 220))
let transparent = make("Transparent", NSRect(x: 50, y: 100, width: 800, height: 650))
transparent.alphaValue = 0
b.makeKeyAndOrderFront(nil)
func report() {
  let rows = windows.mapValues { window -> [String: Any] in
    ["id": window.windowNumber, "visible": window.isVisible, "minimized": window.isMiniaturized]
  }
  if let data = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]) {
    try? data.write(to: output.appendingPathComponent("windows.json"), options: .atomic)
  }
}
report()
var reportedWindows = Set<Int>()
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  for window in app.windows where reportedWindows.insert(window.windowNumber).inserted {
    let row: [String: Any] = ["id": window.windowNumber,
      "class": String(describing: type(of: window)), "frame": NSStringFromRect(window.frame),
      "level": window.level.rawValue, "visible": window.isVisible,
      "sharingType": window.sharingType.rawValue,
      "accessibilityElement": window.isAccessibilityElement(),
      "identifier": window.accessibilityIdentifier(),
      "windowServer": CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(window.windowNumber)) as? [[String: Any]] ?? [],
      "role": window.accessibilityRole()?.rawValue ?? "",
      "subrole": window.accessibilitySubrole()?.rawValue ?? "",
      "canBecomeKey": window.canBecomeKey, "canBecomeMain": window.canBecomeMain,
      "parent": window.parent?.windowNumber ?? 0]
    let path = output.appendingPathComponent("native-window-inventory.jsonl")
    if !FileManager.default.fileExists(atPath: path.path) {
      FileManager.default.createFile(atPath: path.path, contents: nil)
    }
    if let data = try? JSONSerialization.data(withJSONObject: row),
      let file = try? FileHandle(forWritingTo: path) {
      _ = try? file.seekToEnd(); try? file.write(contentsOf: data + Data([10])); try? file.close()
    }
  }
  let command = output.appendingPathComponent("command.json")
  guard let data = try? Data(contentsOf: command),
    let row = try? JSONSerialization.jsonObject(with: data) as? [String: String]
  else { return }
  try? FileManager.default.removeItem(at: command)
  let root = windows[row["window"] ?? "A"] ?? a
  let trace = output.appendingPathComponent("commands.jsonl")
  if !FileManager.default.fileExists(atPath: trace.path) { FileManager.default.createFile(atPath: trace.path, contents: nil) }
  if let file = try? FileHandle(forWritingTo: trace), let bytes = try? JSONSerialization.data(withJSONObject: row) {
    _ = try? file.seekToEnd(); try? file.write(contentsOf: bytes + Data([10])); try? file.close()
  }
  switch row["op"] {
  case "owner-note":
    ownerNote.string = ""
    a.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    a.makeFirstResponder(ownerNote)
  case "owner-clear":
    ownerNote.string = ""
    ownerNote.undoManager?.removeAllActions()
    a.makeFirstResponder(ownerNote)
  case "owner-select-all": ownerNote.selectAll(nil)
  case "owner-resume": a.makeFirstResponder(ownerNote)
  case "owner-end": ownerNote.setSelectedRange(NSRange(location: (ownerNote.string as NSString).length, length: 0))
  case "owner-middle": ownerNote.setSelectedRange(NSRange(location: 2, length: 0))
  case "owner-close-child":
    if let child = windows.removeValue(forKey: "Child") {
      child.parent?.removeChildWindow(child)
      child.close()
    }
    a.makeFirstResponder(ownerNote)
  case "owner-secure":
    password.stringValue = "owner-fixture-secret"
    a.makeFirstResponder(password)
  case "owner-state":
    try? JSONSerialization.data(withJSONObject: ["text": ownerNote.string, "saves": ownerSaveCount,
      "latencyChanges": ownerLatencyCount])
      .write(to: output.appendingPathComponent("owner-state.json"))
  case "owner-latency":
    ownerLatencyCount = 0
    ownerLatencyEnabled = true
    ownerLatencyPatch.needsDisplay = true
    a.makeFirstResponder(ownerNote)
    ownerNote.setSelectedRange(NSRange(location: (ownerNote.string as NSString).length, length: 0))
    let point = a.convertPoint(toScreen: ownerLatencyPatch.convert(NSPoint(x: 32, y: 16), to: nil))
    try? JSONSerialization.data(withJSONObject: ["x": point.x, "y": NSScreen.screens.first!.frame.maxY - point.y])
      .write(to: output.appendingPathComponent("owner-latency-point.json"))
  case "owner-latency-end": ownerLatencyEnabled = false
  case "credentials", "credentials-switch":
    a.makeFirstResponder(a.contentView)
    username.stringValue = ""
    password.stringValue = ""
    credentialDelegate.switchAfterFirst = row["op"] == "credentials-switch"
    a.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    a.makeFirstResponder(username)
  case "credentials-state":
    try? JSONSerialization.data(withJSONObject: [
      "username": username.currentEditor()?.string ?? username.stringValue,
      "password": password.currentEditor()?.string ?? password.stringValue,
    ]).write(to: output.appendingPathComponent("credentials-state.json"))
  case "lifetime-window":
    _ = make("Liveness", NSRect(x: 600, y: 100, width: 220, height: 160))
  case "unreadable-window":
    _ = make("Unreadable", NSRect(x: 620, y: 420, width: 200, height: 140), unreadable: true)
  case "move-on-key": moveOnKey = true
  case "move": root.setFrameOrigin(NSPoint(x: 850, y: 600))
  case "reset": root.setFrame(NSRect(x: 380, y: 260, width: 480, height: 382), display: true)
  case "raise": root.orderFrontRegardless()
  case "resize": root.setContentSize(NSSize(width: 520, height: 400))
  case "focus":
    root.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
  case "sheet":
    let sheet = make("Sheet", NSRect(x: 0, y: 0, width: 280, height: 160))
    root.beginSheet(sheet)
  case "child":
    let child = make(
      "Child", NSRect(x: root.frame.maxX - 70, y: root.frame.minY + 30, width: 240, height: 180))
    root.addChildWindow(child, ordered: .above)
    child.makeKeyAndOrderFront(nil)
    child.order(.above, relativeTo: root.windowNumber)
  case "small-child":
    let child = make("Child",
      NSRect(x: root.frame.minX + 80, y: root.frame.maxY - 70, width: 66, height: 20),
      .borderless)
    root.addChildWindow(child, ordered: .above)
    child.order(.above, relativeTo: root.windowNumber)
  case "reparent":
    movable.removeFromSuperview()
    b.contentView!.addSubview(movable)
  case "reparent-back":
    movable.removeFromSuperview()
    a.contentView!.addSubview(movable)
  case "clipped-child":
    let edge = root.screen!.frame.maxX
    let child = make("ClippedChild", NSRect(x: edge - 40, y: root.frame.minY + 30, width: 240, height: 180))
    root.addChildWindow(child, ordered: .above)
    child.order(.above, relativeTo: root.windowNumber)
  case "popover":
    let next = NSPopover()
    next.behavior = .applicationDefined
    let controller = NSViewController()
    controller.view = Receiver("Popover", output)
    controller.view.frame.size = NSSize(width: 220, height: 150)
    next.contentViewController = controller
    next.show(
      relativeTo: NSRect(x: 50, y: 50, width: 10, height: 10), of: root.contentView!,
      preferredEdge: .maxX)
    popover = next
  case "menu", "context":
    menuOwner = root.title
    DispatchQueue.main.async {
      if row["op"] == "context", let event = NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: 120, y: 180), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: root.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1) {
        NSMenu.popUpContextMenu(fixtureMenu(), with: event, for: root.contentView!)
      } else {
        fixtureMenu().popUp(positioning: nil, at: NSPoint(x: 120, y: 180), in: root.contentView)
      }
    }
  case "modal":
    DispatchQueue.main.async {
      let alert = NSAlert()
      alert.messageText = "App modal fixture"
      alert.addButton(withTitle: "Dismiss")
      alert.runModal()
    }
  case "dismiss":
    popover?.close()
    app.abortModal()
    for window in windows.values where window.sheetParent != nil {
      window.sheetParent?.endSheet(window)
      window.orderOut(nil)
    }
    trackedMenu?.cancelTrackingWithoutAnimation()
  case "fullscreen": root.toggleFullScreen(nil)
  case "minimize": root.miniaturize(nil)
  case "restore": root.deminiaturize(nil)
  case "close":
    if let name = row["window"], ["Liveness", "Unreadable"].contains(name) {
      windows.removeValue(forKey: name)?.close()
    } else {
      windows[row["window"] ?? "A"]?.close()
    }
  case "hide": app.hide(nil)
  case "show": app.unhideWithoutActivation()
  case "reuse":
    var ids: [Int] = []
    for _ in 0..<64 {
      autoreleasepool {
        let next = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
        next.isReleasedWhenClosed = false
        next.orderFrontRegardless()
        ids.append(next.windowNumber)
        next.close()
      }
    }
    try? JSONSerialization.data(withJSONObject: ["closedA": originalAID, "allocated": ids, "reused": ids.contains(originalAID)]).write(to: output.appendingPathComponent("N5-id-reuse.json"))
  case "quit": app.terminate(nil)
  default: break
  }
  report()
}
RunLoop.main.add(timer, forMode: .common)
app.run()
