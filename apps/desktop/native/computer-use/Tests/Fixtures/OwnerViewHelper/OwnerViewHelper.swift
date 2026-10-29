import AppKit
@testable import ComputerUseCore
import Foundation

// A real AppKit lifecycle for ScreenCaptureKit, on a disposable IPC socket.
// No install, permission request, task session or canonical helper path.
guard CommandLine.arguments.count >= 5 else { exit(2) }
let socketURL = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let roots = CommandLine.arguments.dropFirst(3).map { URL(fileURLWithPath: $0, isDirectory: true) }
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

@MainActor
final class OwnerHelperDelegate: NSObject, NSApplicationDelegate {
  private let socketURL: URL
  private let output: URL
  private let roots: [URL]
  private var runtime: HelperRuntime?

  init(socketURL: URL, output: URL, roots: [URL]) {
    self.socketURL = socketURL
    self.output = output
    self.roots = roots
  }
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let permissions = Permissions.current()
      try JSONEncoder().encode(permissions).write(to: output.appendingPathComponent("helper-permissions.json"))
      guard permissions.bothGranted else { NSApplication.shared.terminate(nil); return }
      let runtime = HelperRuntime(helperVersion: "test", peerRequirement: .sameUser, catalog: AppCatalog(roots: roots))
      try runtime.start(socketURL: socketURL)
      self.runtime = runtime
      try Data("ready".utf8).write(to: output.appendingPathComponent("helper-listening"))
      let deadline = Date().addingTimeInterval(300)
      timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        MainActor.assumeIsolated {
          if Date() >= deadline || FileManager.default.fileExists(atPath: self.output.appendingPathComponent("stop").path) {
            NSApplication.shared.terminate(nil)
          }
        }
      }
    } catch {
      try? Data(String(describing: error).utf8).write(to: output.appendingPathComponent("helper-error.txt"))
      NSApplication.shared.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
    runtime?.stop()
  }
}
let delegate = MainActor.assumeIsolated { OwnerHelperDelegate(socketURL: socketURL, output: output, roots: roots) }
application.delegate = delegate
application.run()
