import AppKit
import Foundation

// A regular app, launched in the background and never activated: like any app
// the person is not using right now, it is not active and none of its windows
// is key. Nothing here makes a window key or main, because a real background
// app has neither, and that is exactly what background input has to survive.

// A bundled default lets the cold-observe journey exercise the real no-argument launch.
let bundled = Bundle.main.url(forResource: "journey", withExtension: "json")
  .flatMap { try? Data(contentsOf: $0) }
  .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
guard (2...3).contains(CommandLine.arguments.count) || bundled != nil else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1] : bundled!["output"]!, isDirectory: true)
let mode = CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : bundled?["mode"] ?? ""
let onAnotherSpace = mode == "other-space"

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(
  contentRect: NSRect(x: 80, y: 80, width: 320, height: 220),
  styleMask: [.titled, .closable, .miniaturizable],
  backing: .buffered,
  defer: false
)
window.title = "Opensteer Background Input Fixture"

let first = NSTextField(frame: NSRect(x: 40, y: 140, width: 220, height: 28))
first.identifier = NSUserInterfaceItemIdentifier("field-a")
first.stringValue = ""
first.placeholderString = "Field A"
let second = NSTextField(frame: NSRect(x: 40, y: 80, width: 220, height: 28))
second.identifier = NSUserInterfaceItemIdentifier("field-b")
second.stringValue = ""
second.placeholderString = "Field B"
let secure = NSSecureTextField(frame: NSRect(x: 170, y: 20, width: 110, height: 26))
secure.identifier = NSUserInterfaceItemIdentifier("secure-field")
secure.placeholderString = "Secret"
/// Other fixture modes close their menu automatically. Journey mode keeps
/// it open so the production Escape action must prove dismissal.
final class MenuWatch: NSObject, NSMenuDelegate {
  var opened = false, open = false
  func menuWillOpen(_ menu: NSMenu) {
    opened = true; open = true
    if mode != "journey" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { menu.cancelTracking() }
    }
  }
  func menuDidClose(_ menu: NSMenu) { open = false }
}
let menuWatch = MenuWatch()
let popUp = NSPopUpButton(frame: NSRect(x: 40, y: 20, width: 160, height: 26), pullsDown: false)
popUp.addItems(withTitles: ["One", "Two"])
popUp.menu?.delegate = menuWatch
let content = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 220))
content.addSubview(first)
content.addSubview(second)
content.addSubview(popUp)
if mode == "secure" { content.addSubview(secure) }
final class JourneyCounter: NSObject, NSTextFieldDelegate {
  var count = 0
  var clicks = 0, shortcuts = 0, scrolls = 0, inputEvents = 0, changeEvents = 0
  let button = NSButton(title: "Counter 0", target: nil, action: nil)
  @objc func increment(_ sender: Any?) {
    count += 1
    button.title = "Counter \(count)"
    button.layer?.backgroundColor = (count % 2 == 0 ? NSColor.cyan : NSColor.orange).cgColor
  }
  @objc func click(_ sender: Any?) {
    clicks += 1; increment(sender)
    _ = window.makeFirstResponder(first)
  }
  func controlTextDidChange(_ notification: Notification) { inputEvents += 1; increment(nil) }
  func controlTextDidEndEditing(_ notification: Notification) { changeEvents += 1 }
}
let journeyCounter = JourneyCounter()
if mode == "journey" {
  window.setContentSize(NSSize(width: 800, height: 550))
  content.setFrameSize(NSSize(width: 800, height: 550))
  journeyCounter.button.frame = NSRect(x: 40, y: 280, width: 500, height: 160)
  journeyCounter.button.font = .systemFont(ofSize: 50)
  journeyCounter.button.isBordered = false
  journeyCounter.button.wantsLayer = true
  journeyCounter.button.layer?.backgroundColor = NSColor.cyan.cgColor
  first.delegate = journeyCounter
  second.delegate = journeyCounter
  NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .scrollWheel]) { event in
    if event.type == .scrollWheel { journeyCounter.scrolls += 1 }
    if event.type == .keyDown && event.modifierFlags.contains([.control, .option]) && event.charactersIgnoringModifiers?.lowercased() == "j" { journeyCounter.shortcuts += 1 }
    journeyCounter.increment(nil)
    return event
  }
  journeyCounter.button.target = journeyCounter
  journeyCounter.button.action = #selector(JourneyCounter.click(_:))
  content.addSubview(journeyCounter.button)
  let clock = NSTextField(labelWithString: "Clock 0")
  clock.frame = NSRect(x: 40, y: 480, width: 500, height: 40)
  content.addSubview(clock)
  Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    clock.stringValue = "Clock \(Date().timeIntervalSince1970)"
  }
}
window.contentView = content
// The key view loop a window builds when it first becomes key, which this
// one never does.
first.nextKeyView = second
second.nextKeyView = first
window.initialFirstResponder = first
_ = window.makeFirstResponder(first)
window.orderFrontRegardless()

final class NonKeyChildWindow: NSWindow {
  override var canBecomeKey: Bool { false }
}
let child = NonKeyChildWindow(
  contentRect: NSRect(x: 120, y: 170, width: 180, height: 72),
  styleMask: [.titled], backing: .buffered, defer: false)
child.title = "Fixture child"
let childField = NSTextField(frame: NSRect(x: 16, y: 18, width: 148, height: 28))
childField.identifier = NSUserInterfaceItemIdentifier("child-field")
child.contentView?.addSubview(childField)
if mode == "child" {
  window.addChildWindow(child, ordered: .above)
  child.orderFrontRegardless()
}

/// Whether this app ever became active, or its window ever key, while the
/// test ran: background input must cause neither.
final class FocusWatch: NSObject {
  var everActive = false
  var everKey = false

  @objc func becameActive(_ notification: Notification) { everActive = true }
  @objc func becameKey(_ notification: Notification) { everKey = true }
}
let focusWatch = FocusWatch()
NotificationCenter.default.addObserver(
  focusWatch, selector: #selector(FocusWatch.becameActive(_:)),
  name: NSApplication.didBecomeActiveNotification, object: nil)
NotificationCenter.default.addObserver(
  focusWatch, selector: #selector(FocusWatch.becameKey(_:)),
  name: NSWindow.didBecomeKeyNotification, object: nil)

func write(_ name: String, _ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  try! data.write(to: output.appendingPathComponent(name), options: .atomic)
}

/// Moves this fixture's own window to a desktop Space the person is not
/// looking at, so a test can act on a window that is off the shown Space
/// without switching the person's screen. Returns the Space, or 0 when this
/// Mac has no other desktop Space.
func moveToAnotherSpace(_ window: NSWindow) -> UInt64 {
  guard
    let skyLight = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
    let mainSymbol = dlsym(skyLight, "SLSMainConnectionID"),
    let spacesSymbol = dlsym(skyLight, "SLSCopyManagedDisplaySpaces"),
    let activeSymbol = dlsym(skyLight, "SLSGetActiveSpace"),
    let moveSymbol = dlsym(skyLight, "SLSMoveWindowsToManagedSpace")
  else { return 0 }
  typealias Main = @convention(c) () -> Int32
  typealias Spaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
  typealias Active = @convention(c) (Int32) -> UInt64
  typealias Move = @convention(c) (Int32, CFArray, UInt64) -> Void
  let connection = unsafeBitCast(mainSymbol, to: Main.self)()
  let active = unsafeBitCast(activeSymbol, to: Active.self)(connection)
  guard
    let displays = unsafeBitCast(spacesSymbol, to: Spaces.self)(connection)?
      .takeRetainedValue() as? [[String: Any]]
  else { return 0 }
  let desktops = displays.flatMap { ($0["Spaces"] as? [[String: Any]]) ?? [] }
    .filter { ($0["type"] as? Int) == 0 }
    .compactMap { ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value }
  guard let other = desktops.first(where: { $0 != active }) else { return 0 }
  unsafeBitCast(moveSymbol, to: Move.self)(
    connection, [NSNumber(value: window.windowNumber)] as CFArray, other)
  return other
}

let space = onAnotherSpace ? moveToAnotherSpace(window) : 0
// Once the app has finished launching, which a hide before it would not
// survive.
DispatchQueue.main.async {
  if mode == "hidden" {
    // What Command-H does to an app the person wants out of the way.
    application.hide(nil)
  }
  write(
    "metadata.json", ["pid": getpid(), "windowID": window.windowNumber, "space": space])
}
var blockFinished = false
let telemetryTimer = Timer(timeInterval: 0.025, repeats: true) { _ in
  if mode == "slow" && FileManager.default.fileExists(
    atPath: output.appendingPathComponent("block.flag").path)
  {
    write("blocked.json", ["blocked": true])
    // A bounded unresponsive app: the test cancels while AX is waiting, and
    // this disposable process resumes so it can report whether input landed.
    Thread.sleep(forTimeInterval: 4)
    try? FileManager.default.removeItem(at: output.appendingPathComponent("block.flag"))
    blockFinished = true
  }
  let responder = window.firstResponder
  write(
    "state.json",
    [
      "counter": journeyCounter.count,
      "clicks": journeyCounter.clicks, "shortcuts": journeyCounter.shortcuts, "scrolls": journeyCounter.scrolls,
      "inputEvents": journeyCounter.inputEvents, "changeEvents": journeyCounter.changeEvents,
      "a": first.stringValue,
      "b": second.stringValue,
      "blockFinished": blockFinished,
      "secure": secure.stringValue,
      "child": childField.stringValue,
      "childWindowID": child.windowNumber,
      "menuOpened": menuWatch.opened, "menuOpen": menuWatch.open,
      "focus": responder === first.currentEditor() || responder === first
        ? "A"
        : responder === second.currentEditor() || responder === second ? "B" : "none",
      "active": application.isActive,
      "key": window.isKeyWindow,
      "everActive": focusWatch.everActive,
      "everKey": focusWatch.everKey,
    ]
  )
}
RunLoop.main.add(telemetryTimer, forMode: .common)
application.run()
