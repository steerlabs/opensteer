import AppKit
import Darwin
import Foundation
import PasswordsBrokerKit

guard let build = BrokerBuild.current else {
  FileHandle.standardError.write(Data("Opensteer Passwords requires its own valid team signature\n".utf8))
  exit(EX_NOPERM)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == [InheritedSocketVerifier.argument] {
  let verified = InheritedSocketVerifier.verify(rule: build.brokerRule)
  if !verified { FileHandle.standardError.write(Data("Opensteer Passwords peer verification failed\n".utf8)) }
  exit(verified ? EXIT_SUCCESS : EXIT_FAILURE)
}
if arguments == [BrokerReplacement.argument] {
  let prepared = MainActor.assumeIsolated { BrokerReplacement.prepare(development: build.development, rule: build.brokerRule) }
  if !prepared { FileHandle.standardError.write(Data("Opensteer Passwords replacement preparation failed\n".utf8)) }
  exit(prepared ? EXIT_SUCCESS : EXIT_FAILURE)
}
// LaunchServices passes nothing. Arguments would also reach AppKit as user
// defaults, so the broker refuses any rather than interpret them.
guard arguments.isEmpty else {
  FileHandle.standardError.write(Data("Opensteer Passwords takes no arguments\n".utf8))
  exit(EX_USAGE)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = MainActor.assumeIsolated { BrokerApplication(build: build) }
application.delegate = delegate
application.run()
