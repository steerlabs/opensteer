# Opensteer Passwords broker

The Swift package for the macOS broker, the only owner of a person's saved-login and payment-card vault and keys,
and its sandboxed import worker. The broker releases one saved field to desktop main under live
personal Deployment authorization or a person’s confirmed browser fill, never directly to an agent. Its design, security properties and traps are
in [Passwords](../../../../docs/passwords.md); wire shapes are in
[passwords-broker.ts](../../../../packages/protocol/src/passwords-broker.ts), and release signing in
[Releases](../../../../docs/releases.md#signing).

## Testing

Use the [browser-and-passwords skill](../../../../.agents/skills/browser-and-passwords/SKILL.md).

Every card use needs approval and a later commit, with no remembered grant. Filled values can
be read by page scripts, so agents must never read back, print, log, copy or save them.

Native fills on the vault Mac require the broker's own device-owner check; another viewer owns
its device check. A person transaction never grants agent access. Saving a login the person
typed cannot edit, delete or grant anything. The current contracts and strict decoder live in
[the TypeScript wire](../../../../packages/protocol/src/passwords-broker.ts) and
[Swift Wire.swift](Sources/PasswordsBrokerKit/Wire/Wire.swift).
