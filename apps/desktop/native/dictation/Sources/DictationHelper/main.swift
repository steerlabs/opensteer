import AppKit
import Darwin
import DictationHelperKit
import MacOSSigning

MainActor.assumeIsolated {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let rule = Helper.rule(desktop: false) else { exit(EX_NOPERM) }
  if arguments == [InheritedSocketVerifier.argument] {
    exit(InheritedSocketVerifier.verify(rule: rule, subsystem: "com.opensteer.dictation") ? 0 : 1)
  }
  if arguments == [SignedHelperReplacement.argument] {
    let prepared = SignedHelperReplacement.prepare(
      bundleIdentifier: Helper.identifier,
      canonicalBundle: Helper.root.appendingPathComponent("Opensteer Dictation.app"),
      executableName: "Opensteer Dictation", rule: rule)
    exit(prepared ? 0 : 1)
  }
  guard arguments.isEmpty else { exit(EX_USAGE) }
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let helper = Helper()
  app.delegate = helper
  app.run()

}
