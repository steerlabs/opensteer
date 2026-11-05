# Opensteer Passwords broker

The Swift package for the macOS broker, the only owner of a person's saved-login vault and keys,
and its sandboxed import worker. The broker releases one saved field to desktop main under live
Workspace authorization, never directly to an agent. Its design, security properties and traps are
in [Passwords](../../../../docs/passwords.md); wire shapes are in
[passwords-broker.ts](../../../../packages/protocol/src/passwords-broker.ts), and release signing in
[Releases](../../../../docs/releases.md#signing).

## Testing

Use the [browser-and-passwords skill](../../../../.agents/skills/browser-and-passwords/SKILL.md).
