# Opensteer Passwords broker

The Swift package for the macOS broker, the only owner of a person's saved-login and payment-card vault and keys,
and its sandboxed import worker. The broker releases one saved field to desktop main under live
Workspace authorization, never directly to an agent. Its design, security properties and traps are
in [Passwords](../../../../docs/passwords.md); wire shapes are in
[passwords-broker.ts](../../../../packages/protocol/src/passwords-broker.ts), and release signing in
[Releases](../../../../docs/releases.md#signing).

## Testing

Use the [browser-and-passwords skill](../../../../.agents/skills/browser-and-passwords/SKILL.md).

Cards use broker protocol 7; login calls on that connection keep their protocol 6 shapes.
Every card use needs approval and a later commit, with no remembered grant. Releases pin the
card revision, merchant site and connection for at most 30 minutes. The payment frame must have
an exact HTTPS origin; it may belong to a different site. Filled values can be read by page
scripts, so agents must never read back, print, log, copy or save them.

Card plaintext uses item version 3 inside the unchanged manifest. Older brokers skip and preserve
these objects. Card management stays in the authenticated native window; changing the number
requires fresh device-owner authentication. Imports and remembered grants remain login-only.
