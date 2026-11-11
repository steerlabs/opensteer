# Opensteer Passwords broker

The Swift package for the macOS broker, the only owner of a person's saved-login and payment-card vault and keys,
and its sandboxed import worker. The broker releases one saved field to desktop main under live
Workspace authorization or a person’s confirmed browser fill, never directly to an agent. Its design, security properties and traps are
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

Person fills require protocol 8; earlier connections retain their status shape and cannot start one.
Their setting and activity use separate stores so downgrading preserves agent settings and person
history. Native fills on the vault Mac require the broker’s own device-owner check; another viewer
owns its device check. A person transaction never grants agent access and lasts at most five minutes.

Saving a login a person typed requires protocol 9. The broker holds it in memory for its connection
for at most two minutes, never prompts, and on commit adds exactly that login with no grant; this path
cannot edit, delete or grant anything. Its setting and activity use their own stores, like person fill's.
