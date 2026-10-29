import AppKit
import PasswordsCore
import SwiftUI
import XCTest
@testable import PasswordsBrokerKit

/// U9: every state of the window, rendered offscreen to PNG files as the
/// run's artifact (`$TMPDIR/opensteer-passwords-ui/`, or
/// `OPENSTEER_PASSWORDS_UI_ARTIFACTS`). Nothing is shown on screen: the
/// windows are never ordered in.
@MainActor
final class SnapshotTests: BrokerTestCase {
  static var directory: URL {
    if let path = ProcessInfo.processInfo.environment["OPENSTEER_PASSWORDS_UI_ARTIFACTS"] {
      return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default.temporaryDirectory.appendingPathComponent("opensteer-passwords-ui", isDirectory: true)
  }

  /// On the window's background, as a window or sheet shows it. The
  /// background is added after capture: an opaque SwiftUI root background
  /// stops offscreen capture of views that contain a scroll view.
  private func render<Content: View>(_ view: Content, _ name: String, size: NSSize? = nil) throws {
    // As the person sees it: the window in front, its controls active.
    let host = NSHostingView(rootView: view.environment(\.colorScheme, .light).environment(\.controlActiveState, .key))
    let fitting = size ?? host.fittingSize
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: fitting), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = host
    host.frame = NSRect(origin: .zero, size: fitting)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let png = try XCTUnwrap(Self.onWindowBackground(bitmap).representation(using: .png, properties: [:]))
    try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
    try png.write(to: Self.directory.appendingPathComponent("\(name).png"))
    XCTAssertGreaterThan(fitting.width, 100, name)
    XCTAssertGreaterThan(fitting.height, 40, name)
  }

  private static func onWindowBackground(_ bitmap: NSBitmapImageRep) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: bitmap.pixelsWide, pixelsHigh: bitmap.pixelsHigh, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = bitmap.size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let bounds = NSRect(origin: .zero, size: bitmap.size)
    NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance {
      NSColor.windowBackgroundColor.setFill()
      bounds.fill()
    }
    bitmap.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
    return rep
  }

  func testWindowStates() async throws {
    let size = NSSize(width: 560, height: 640)
    let model = PasswordsWindowModel(broker: broker, activityLog: harness.activity, runner: ImportRunner(worker: builtWorker))
    try render(PasswordsWindowView(model: model), "window-1-set-up", size: size)
    await model.setUp()
    try render(PasswordsWindowView(model: model), "window-2-set-up-done", size: size)
    model.finishSetup()
    _ = try await broker.addLogin(Fixtures.login("github.com", username: "sam@example.com", label: "Work"))
    _ = try await broker.addLogin(Fixtures.login("example.com", username: "alex.doe"))
    model.windowClosed()
    let desktop = try await harness.client()
    // Allowed for two Workspaces on github.com, then once more automatically.
    for workspace in [Fixtures.workspace, Fixtures.otherWorkspace] {
      let id = UUID().uuidString.lowercased()
      let account = try unwrap(
        try await request(desktop, id, site: "https://github.com", workspace: workspace)["accounts"]?[0])
      _ = try await desktop.call("signin.approve", Fixtures.approve(id, account, remember: true))
      _ = try await desktop.call("signin.release", Fixtures.release(id, origin: "https://github.com"))
      _ = try await desktop.call("signin.cancel", Fixtures.transaction(id))
    }
    let automatic = UUID().uuidString.lowercased()
    _ = try await request(desktop, automatic, site: "https://github.com")
    _ = try await desktop.call(
      "signin.release", Fixtures.release(automatic, origin: "https://github.com"))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(automatic))
    let refused = UUID().uuidString.lowercased()
    let account = try unwrap(try await request(desktop, refused)["accounts"]?[0])
    _ = try await desktop.call("signin.approve", Fixtures.approve(refused, account, remember: false))
    _ = try await desktop.call("signin.cancel", Fixtures.transaction(refused))
    await harness.activity.flush()
    await model.loadActivity()
    try render(PasswordsWindowView(model: model), "window-3-ready-hidden", size: size)
    await model.showPasswords()
    try render(PasswordsWindowView(model: model), "window-4-ready-shown", size: size)

    model.startImport()
    let flow = try XCTUnwrap(model.importFlow)
    try render(ImportSheet(flow: flow), "import-1-where")
    flow.choose(.chrome)
    try render(ImportSheet(flow: flow), "import-2-steps")
    let export = harness.directory.appendingPathComponent("export.csv")
    try Data(contentsOf: coreFixtures.appendingPathComponent("chrome.csv")).write(to: export)
    await flow.read(export, from: .chrome)
    try render(ImportSheet(flow: flow), "import-3-preview")
    await flow.importNow()
    try render(ImportSheet(flow: flow), "import-4-done")
    flow.close()

    try harness.protected.delete(.ownerKeyPolicy)
    await broker.reload()
    try render(PasswordsWindowView(model: model), "window-5-older-version", size: size)
    try harness.protected.write(.ownerKeyPolicy, try OwnerKeyPolicy.record())
    try harness.protected.delete(.ownerSigningKey)
    await broker.reload()
    try render(PasswordsWindowView(model: model), "window-5b-other-mac", size: size)
    let unsupported = try BrokerHarness(secureEnclave: false)
    try await unsupported.start()
    let other = PasswordsWindowModel(
      broker: unsupported.broker, activityLog: unsupported.activity, runner: ImportRunner(worker: builtWorker))
    try render(PasswordsWindowView(model: other), "window-6-unsupported", size: size)
    await unsupported.stop()

    let locked = try BrokerHarness(controlledStore: true)
    try await locked.start()
    try await locked.ready()
    locked.controlled?.notUnlockedSinceRestart = true
    await locked.broker.reload()
    let notUnlocked = PasswordsWindowModel(broker: locked.broker, activityLog: locked.activity, runner: ImportRunner(worker: builtWorker))
    try render(PasswordsWindowView(model: notUnlocked), "window-7-not-unlocked-since-restart", size: size)
    await locked.stop()
  }
}
