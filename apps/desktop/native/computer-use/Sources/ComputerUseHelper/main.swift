import AppKit
import ComputerUseCore
import Darwin
import Foundation

// A write to a peer socket or parent pipe that has already closed must return
// EPIPE for the code to handle, never terminate the helper mid-shutdown via
// SIGPIPE (signal 13).
signal(SIGPIPE, SIG_IGN)

/// `Opensteer Computer Use.app`.
///
/// An `LSUIElement` accessory app: no Dock tile, no menu bar, nothing that can
/// take the person's focus. It needs a real `NSApplication` and main run loop
/// all the same, because the overlay is AppKit, the `AXObserver` notifications
/// are run-loop sources, and `NSWorkspace` delivers its activation
/// notifications there.
if CommandLine.arguments.dropFirst() == ["--verify-peer"] {
  let verified = HelperPeerVerifier.verifyInheritedSocket()
  if !verified {
    try? FileHandle.standardError.write(
      contentsOf: Data("helper socket peer verification failed\n".utf8))
  }
  exit(verified ? EXIT_SUCCESS : EXIT_FAILURE)
}

// A fresh process's answer about Full Disk Access, for the running helper,
// which macOS keeps answering as of its own launch.
if CommandLine.arguments.dropFirst() == [FullDiskAccessProbes.argument] {
  try? FileHandle.standardOutput.write(
    contentsOf: Data("\(FullDiskAccessProbes().thisProcess().rawValue)\n".utf8))
  exit(EXIT_SUCCESS)
}

if CommandLine.arguments.dropFirst() == [HelperReplacement.argument] {
  let prepared = MainActor.assumeIsolated { HelperReplacement.prepare() }
  if !prepared {
    try? FileHandle.standardError.write(
      contentsOf: Data("helper replacement preparation failed\n".utf8))
  }
  exit(prepared ? EXIT_SUCCESS : EXIT_FAILURE)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let delegate = HelperAppDelegate()
application.delegate = delegate
application.run()

final class HelperAppDelegate: NSObject, NSApplicationDelegate {
  private var runtime: HelperRuntime?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let version =
      Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let requirement = PeerRequirement.label.rawValue
    Log.lifecycle.notice(
      "Opensteer Computer Use \(version, privacy: .public) starting; \(requirement, privacy: .public) peer requirement."
    )
    let runtime = HelperRuntime(
      helperVersion: version,
      peerRequirement: PeerRequirement.mode
    )
    do {
      try runtime.start()
      self.runtime = runtime
    } catch {
      Log.lifecycle.fault("The helper could not start its socket; quitting.")
      NSApplication.shared.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    runtime?.stop()
    runtime = nil
  }
}
