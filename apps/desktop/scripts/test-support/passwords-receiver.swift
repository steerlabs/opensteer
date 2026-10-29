import AppKit
import CryptoKit
import Foundation

// Arguments contain only an evidence path and hashes, never saved text.
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let expectedUsername = CommandLine.arguments[2]
var expectedPassword = CommandLine.arguments[3]
let expectedCode = CommandLine.arguments[4]
func digest(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 100, y: 120, width: 500, height: 360),
  styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Passwords acceptance fixture"
let username = NSTextField(frame: NSRect(x: 30, y: 260, width: 400, height: 28))
username.placeholderString = "Username"
username.setAccessibilityLabel("Username")
let password = NSSecureTextField(frame: NSRect(x: 30, y: 200, width: 400, height: 28))
password.placeholderString = "Password"
let code = NSSecureTextField(frame: NSRect(x: 30, y: 140, width: 400, height: 28))
code.placeholderString = "Code"
let status = NSTextField(labelWithString: "Signed out")
status.frame = NSRect(x: 30, y: 30, width: 450, height: 28)
final class Receipts: NSObject, NSTextFieldDelegate {
  var returns = 0, tabs = 0, changes = 0, submits = 0, authenticated = false
  @objc func submit(_ sender: Any?) {
    submits += 1
    authenticated = digest(username.stringValue) == expectedUsername && digest(password.stringValue) == expectedPassword
    status.stringValue = authenticated ? "Signed in as synthetic.person@passwords-fixture.test" : "Sign in failed"
  }
  func controlTextDidChange(_ notification: Notification) { changes += 1 }
}
let receipts = Receipts()
for field in [username, password, code] { field.delegate = receipts; window.contentView!.addSubview(field) }
let button = NSButton(title: "Sign in", target: receipts, action: #selector(Receipts.submit(_:)))
button.frame = NSRect(x: 30, y: 75, width: 180, height: 32)
window.contentView!.addSubview(button)
window.contentView!.addSubview(status)
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
  if event.keyCode == 36 || event.keyCode == 76 { receipts.returns += 1 }
  if event.keyCode == 48 { receipts.tabs += 1 }
  return event
}
window.orderFront(nil)
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  if let data = try? Data(contentsOf: output.appendingPathComponent("expected-password.sha256")),
     let value = String(data: data, encoding: .utf8) { expectedPassword = value.trimmingCharacters(in: .whitespacesAndNewlines) }
  let state: [String: Any] = [
    "usernameMatches": digest(username.stringValue) == expectedUsername,
    "passwordMatches": digest(password.stringValue) == expectedPassword,
    "codeMatches": digest(code.stringValue) == expectedCode,
    "passwordEmpty": password.stringValue.isEmpty,
    "authenticated": receipts.authenticated,
    "submitAttempts": receipts.submits,
    "changeEvents": receipts.changes,
    "returnKeys": receipts.returns,
    "tabKeys": receipts.tabs,
    "active": application.isActive,
    "pid": ProcessInfo.processInfo.processIdentifier,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
    try? data.write(to: output.appendingPathComponent("fixture-state.json"), options: [.atomic])
  }
}
application.run()
timer.invalidate()
