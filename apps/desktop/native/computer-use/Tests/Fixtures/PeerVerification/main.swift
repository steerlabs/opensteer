// Test-only process: injects the expected team into the real audit-token verifier.
// This target is never included in a helper/app distribution.
import ComputerUseCore
import Darwin
import MacOSSigning

guard CommandLine.arguments.count == 2,
  let requirement = MacCodeIdentity.requirement(teamId: CommandLine.arguments[1], identifiers: ["com.opensteer.computer-use"])
else { exit(EX_USAGE) }
exit(PeerVerifier(mode: .codeRequirement(requirement)).verify(fileDescriptor: 3) ? EXIT_SUCCESS : EXIT_FAILURE)
