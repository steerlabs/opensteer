# Opensteer Passwords

The broker is the only vault/key owner for a macOS user. It releases one saved
field to desktop main under live Workspace authorization, never directly to an
agent. Product consent and transport authority live in
[Passwords](../../../../docs/passwords.md); wire shapes live in
[passwords-broker.ts](../../../../packages/protocol/src/passwords-broker.ts).

## Release and development

Release peers must be the signed Opensteer desktop (Stable or Beta) under the
Developer ID team requirement derived from the broker's own code signature, checked by audit token before
reading bytes. Refused peers receive no bytes. Desktop verifies the installed
broker signature and the live socket peer too. Development permits same-user
processes and uses separate bundle, socket, vault and protected files; it must
never touch release state. Development file protection cannot resist same-user
read/rollback and must never ship as production protection.

Build mode is compiled, not selected by an environment variable. The builder
derives the broker keychain group from its validated signing input. See
[desktop signing](../../SIGNING.md); do not duplicate its release procedure here.
A release keychain store needs the signed entitlement or Security returns
`errSecMissingEntitlement`.

The broker lifetime lock must precede touching the socket so a second instance
cannot unlink a live server. A broker whose socket was replaced must exit, or
replacement can deadlock on its lock. AppKit reopen must show the window only
for person activation, not background desktop launches.

## Secrets lifetime

Keep vault operations on one actor/queue. Close each unlocked vault immediately
after selection or commit, never across a user action. Account choosers retain
only descriptors, not passwords/seeds; re-read the selected revision at approval.
Import plans retain saved IDs, not saved secrets. A prepared import may hold an
unlock only while its broker-owned import ID and authenticated visit remain live.

Core wipes its key and item-plaintext Data copies; CryptoKit manages its own key
storage. Swift password Strings cannot be wiped: minimize their lifetime. TOTP
releases a current code, never its seed. No field value belongs in logs, errors,
activity or authorization descriptors. Activity masks usernames and excludes
agent reasons; only the first password release records use, never website success.

## Protected state and crash consistency

Production protected state uses the broker's data-protection keychain group.
Secure Enclave keys and protected values are AfterFirstUnlockThisDeviceOnly.
Owner keys use privateKeyUsage without presence; the broker enforces user
presence separately so remembered sign-ins can work while locked. Key operations
must use interactionNotAllowed to refuse unexpected prompts. Before first unlock,
report unavailable, never damage/reset. An old owner-key policy requires reset,
not migration. Keys cannot be backed up, migrated or recovered on another Mac. Setup refuses
Macs without a Secure Enclave.

Every open/unlock/commit verifies current history against the current protected
checkpoint, holding a kernel lock beside the vault folder across check and use.
A retained Vault or unlock cannot trust an earlier verification or overwrite a
newer head. Checkpoint writes compare against the pin just verified, including
writers not sharing the lock. Missing/forked/rolled-back history fails closed;
there is no automatic repair.

Writes publish objects, commit, checkpoint, then HEAD/in-memory head. Nothing may
release from a head not protected by the checkpoint. If a checkpoint write reports
an error, read it back: it may have landed. Do not remove the commit behind a new
pin. Open may adopt only a fully verified immediate child left by a crash; other
inconsistency is an error. File publication must be durable and atomic. Open
nonblocking and require regular files, so planted FIFOs cannot stall reads/locks.

Source: `Sources/PasswordsCore/Vault/`, `Sources/PasswordsCore/Storage/`,
`Sources/PasswordsBrokerKit/Broker/KeychainProtectedStore.swift`.

## Formats and cryptography

Canonical bytes are security relevant: reject duplicate keys, noncanonical vault
JSON, unsupported versions and ambiguous encodings rather than normalizing on
read. Domain-separate commit signatures; require low-S ECDSA. Sealed object AAD
binds vault, epoch, purpose and item/revision or manifest sequence. Fresh per-object
data keys wrap under the epoch key; owner agreement keys unwrap epoch envelopes.
Items and manifests are encrypted; commits expose public membership/history.

Genesis is authorized by its own membership; subsequent commits by the previous
membership. Removing an agreement key requires an epoch change. Envelopes must
match owner membership exactly. Unknown manifest versions must not be treated as
empty grants. Stored password/username bytes must survive without trimming or
Unicode normalization. Exact formats and limits: `Sources/PasswordsCore/Vault/`
and `Sources/PasswordsCore/Crypto/`.

## Sites and import traps

HTTPS DNS origins only: reject localhost, IPs, public suffixes, userinfo, trailing
dots and Foundation/WHATWG parser differentials. IDN must strictly round-trip,
including ACE labels. Site membership uses registrable domains with private PSL
rules, ignoring ports. Read-time item validity must not depend on the current
suffix/IDNA list; normalize writes and recheck site membership at use instead.

The compiled suffix list and Host tldts must move together. Shared origin/site
fixtures and `packages/browser-profile/src/password-site-parity.test.ts` fence
parity. Swift deliberately follows PSL wildcard rules where tldts differs and
refuses those hosts; do not loosen it merely to match tldts.

A bare TOTP secret is base32, never guessed as hex. Fold parser case in ASCII
only. Bitwarden CSV commas split only before a scheme, split tails never gain
HTTPS, and a cell spanning sites is refused in favor of JSON export. Regex and
Never-fill Bitwarden URIs are excluded and shown; unknown match policies refuse.
Invalid TOTP must not silently disappear. Different seeds are conflicts, even
with the same password. Never silently merge conflicting accounts or let a row
selection select an unseen duplicate source row. Imports require unencrypted
UTF-8 exports and preserve credential bytes.

The broker passes the open export to a sandboxed worker's stdin; it does not parse
the export itself. Worker output remains untrusted and strictly revalidated before
one atomic vault commit. Parsing limits must apply during parsing, not only after
allocation. Sandbox command-line workers need a bundle identifier embedded in the
binary; the suffix list is embedded too so hand-built apps need no resource bundle.
Source: `Sources/PasswordsCore/Import/`, `Sources/PasswordsBrokerKit/UI/`,
`../../scripts/build-passwords-broker.ts`.

## The broker

Protocol 4 and 5 are negotiated per connection and echoed, never silently upgraded.
Requests/releases must match that connection's selected version. Version 4 is
session-bound and origin-only. Version 5 is Workspace-scoped with pinned version-5
consent even for Only this time; app release requires explicit app kind. A missing
origin must never imply app scope. Browser release always requires an exact HTTPS
origin covered by the saved site's registrable domain. Version-4 grants may serve
legacy browser releases, never apps; version-5 grants may serve legacy clients
without broadening their transactions. Preserve both versions through commits;
unversioned grants cannot authorize and disappear on the next commit.

Transactions belong to their connection. Cancel, loss and absolute expiry end
authority; queued work rechecks after waits and cannot release or write a grant
later. Serialize release checks with vault writes. Each release rechecks the
pinned login revision, current remembered grant/scope, site and off switch.
Only-this-time still pins revision. Edits require new approval; destination or
username changes/deletion remove grants. Remove must target the exact displayed
grant so it cannot remove a newer approval. Screen lock ends the window visit,
not an already authorized transaction. Sealing is desktop main's responsibility.

Setup, Start Fresh, each Allow/Only this time, opening saved logins and each
websites/login-page/username change require fresh deviceOwnerAuthentication
(Touch ID or Mac password); never reuse a previous unlock for these decisions.
Remembered use, probe, grant removal and code generation do not prompt. Broker
prompts use its own reason and cleaned display names, never agent-authored consent;
the person sees whole usernames while agents receive masked accounts.

A broker-enforced authenticated window visit covers add, password/TOTP/label edit,
delete and import without another prompt. Window close, lock, sleep or idle expiry
ends it. Every list/change checks the live visit regardless of UI flags. Cancel,
visit end or quitting invalidates prepared imports and late file-read/authentication
results. Start Fresh is authenticated, available only for needs-reset, and deletes
vault/grants/protected state irreversibly; it is not a recovery operation.

Unreadable settings fail off. Setup is opt-in, so absent settings mean on. Neither
can make a non-ready vault usable. Sources: `Sources/PasswordsBrokerKit/Broker/`,
`Sources/PasswordsBrokerKit/Wire/`, `Sources/PasswordsCore/Vault/Grant.swift`.

## Testing

Use [broker checks](../../../../.agents/skills/verify-passwords-broker/SKILL.md).
[Failure coverage](Tests/FAILURES.md) points to executable tests. Signed release
keychain behavior cannot be established by development software-key tests.
