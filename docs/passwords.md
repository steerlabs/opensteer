# Opensteer Passwords

Saved logins let agents fill websites or type into permitted Mac/Android apps
without returning field values in tool results. The Personal Mac owns the vault
and approvals. [Chrome sign-ins](browser-sources.md) owns cookie reuse;
[browser sessions](browser-sessions.md) owns the CDP boundary; surface control
belongs to [computer use](computer-use.md) and [Agent Phone](agent-phone.md).

Passkeys don't use Opensteer Passwords; they use the [OS passkey manager](browser-sessions.md#passkeys).

## Promise and limits

Authorization/input results contain metadata and status, never saved values.
The TOTP seed stays in the broker; release generates a current code. Agents must
never read back, copy or reveal saved fields. A successful input proves neither
website sign-in nor the intended account: the agent must confirm both.

After browser fill, page scripts and agent main-world JavaScript can read the
value; there is no CDP read filter. App delivery does not verify the app's
association with the site or require separate per-app approval. The agent must
judge package/bundle, publisher and install source. A tricked agent can expose
the password. Secure-field observations suppress text, but screenshots and
ordinary fields can reveal what an app displays. Revocation/off cannot recall
input, sign out a browser/app, clear profile cookies or undo actions.

## Authority

The broker owns keys/grants/release; desktop main owns approval, browser checks
and sealing; the Host owns Workspace admission and memory-only leases. Only the
Personal bridge exposes vault authority, and only Personal's local Host can name
its Workspace. The Host stores neither vault data nor released values.

## Choosing the method

Agents use one tool, `sign_in {site, reason, sessionId?}`. Without `sessionId`,
it authorizes Passwords for the calling Workspace directly; Chrome reuse has
no role. The probe never prompts and reports `has-login`, `no-login`, `off`,
`not-set-up` or `unavailable` independently of Workspace grants.

With `sessionId`, the Host first checks access to that live Browser Session.
It joins existing Passwords work or a live Workspace/site lease before choosing
a new method. A Chrome grant for the session's Workspace takes precedence;
otherwise a `has-login` Passwords probe selects Passwords. A connected Chrome
reporting `available` can supply a Chrome Request when Passwords has no login.
If neither has a login, the result is `unavailable: no-saved-login`; other
cases follow [Chrome admission](browser-sources.md#signing-in).
Both forms refuse loopback and the Deployment's own sites before creating a
Request. A login reference never grants access to a browser, phone or Mac app;
each use still needs the Run's current authority over that surface.

## Grants and consent

A remembered grant maps `(deploymentId, workspaceId, site)` to a login ID and
revision. Allow for another account replaces that key's grant. The encrypted,
signed vault holds grants; Deployment and Workspace names are display context.
The calling Workspace owns this consent, including when it uses a Browser
Session belonging to another Workspace.

Current **permissionVersion 5** consent covers “on websites and in apps your
agents use” and warns that a tricked agent could expose the password.
**Allow** remembers access after Touch ID or the Mac's password;
**Only this time** creates no grant. Both pin the selected login ID, revision
and permission version on the broker transaction. The person's chooser shows
the full username; the agent receives a masked account.

Version-4 grants remain valid for legacy origin-only transactions and survive
vault commits. They do not authorize app release: a modern version-5 request
requires new approval, and Allow replaces that grant with version 5. A legacy
version-4 transaction can use a version-5 grant but remains origin-only.
Earlier unversioned grants cannot authorize use and disappear on the next
vault commit. The [broker README](../apps/desktop/native/passwords/README.md#the-broker)
owns lookup, release and authentication details.

Each release checks the pinned login revision and, for remembered access, the
current grant. Editing even a password or label requires approval again.
Deleting a login or changing its websites, login page or username removes its
grants. Grant removals and login edits have no push notification: `sign_in`
can still return `ready` until a release detects the change and ends the lease.
Off/reset and broker connection loss abort the authority.

## The login lease

A memory-only opaque reference binds the calling Workspace/site to a live broker
operation with pinned login ID/revision. Any Run there, including delegated work,
can reuse it with its own surface authority; other Workspaces cannot. One absolute
deadline covers approval and lease, without extension on reuse. Browser closure
does not end it. Host/authority restart, cancellation, expiry, off/reset, lost
connection or changed login/grant ends it. Reacquiring an unchanged remembered
grant needs no prompt.

Starts serialize per Workspace/site. New delegated/trigger decisions return
needs-approval; they can use existing access. Shared pending work must not turn
another Run into the approving caller. Replay of a terminal no-Request call cannot
restart authorization until its original deadline; new calls still face rate
limits. See `apps/host/src/browser/password-sign-in-service.ts`.

## Filling a field

Browser fills must bind the real focused field before release and never retry
an unknown input outcome automatically. The supported fields and result shapes
live in `packages/protocol/src/password-sign-in.ts` and the Browser Harness.

Open shadow roots work; contenteditable/custom editors and closed roots do not.
An out-of-process focused frame must itself have a committed HTTPS origin on the
approved registrable site and a saved website there. Sibling subdomains can match;
a foreign embedded login needs its own authorization.

Desktop main captures the focused frame's committed origin and binds the exact
document/input before release. It rechecks authority, focus and origin before
dispatch; the main-world setter rechecks document and element identity and
removes the temporary binding. Background pages need no OS window focus.
The Host checks Workspace lease ownership and Browser Session access on every
fill; the CDP method never reaches Chromium.

## Typing in apps

The Host resolves saved references for the calling Workspace and seals all fields
before any action in a batch. Unsupported receivers perform no actions. Agents
cannot supply sealed envelopes. Android uses ACTION_SET_TEXT without readback;
Mac uses AXSelectedText or Unicode-only keystrokes and refuses CR/LF/tab before
that saved type action. Literal text retains ordinary control-key behavior.
Receipts identify only the saved field kind, never its value, label or length.

Secure Mac fields omit value and label candidates from accessibility reads;
secure Android nodes omit text, description and hint, using generic labels.
This does not mask screenshots or detect an app that presents a password as
ordinary text.

## Sealed delivery

Each authenticated receiver connection creates an ephemeral P-256 key and
announces its public key with a connection ID/generation. Reconnect discards
the private key and replay state. Desktop main serializes all releases for an
operation, including browser fills, and seals app fields immediately after
broker release using P-256 ECDH, HKDF-SHA256 and AES-256-GCM.

The envelope authenticates the connection, Run, computer-use session, act ID,
action index, field and expiry. The Host and desktop authority cap that expiry
at the earliest of the lease deadline, act deadline and 60 seconds from their
current time. Receivers independently check that the envelope has not expired
and that the act still has work budget. They do not compare those deadlines or
reapply the issuer's lifetime cap using another clock. Receivers check dispatch
context, authenticate the whole batch before input and atomically claim replay
identities; they decrypt again immediately before typing. Stop, cancellation,
session/connection replacement and expiry remain authoritative during waits.
A lost act answer is never automatically retried.

The [wire schemas](../packages/protocol/src/password-sign-in.ts) own the exact
bindings and limits; [the sealer](../apps/desktop/src/passwords/login-envelope.ts)
owns the encoding and cryptography. Host, intermediate Runners, a receiving
Mac's desktop main and tunnels carry ciphertext and public metadata, never the
released app field value. No new pairing ceremony or persistent receiver key
is involved.

## Requests and results

Modern Workspace-scoped Requests retain their durable kind and consent version;
only the vault Mac's desktop app can approve through its broker. Other clients may
decline; generic request.respond refuses this kind. Names/reasons are display
context, never authority. Settlement is durable once, retrying failed writes;
a continuation gets its loginRef only from the live registry, never Request data.
Settlement does not itself end an authorized lease. After restart, lost modern
Requests settle interrupted; historical session-bound ones settle session-closed.
See `packages/protocol/src/password-sign-in.ts` and
`apps/host/src/browser/password-sign-in-service.ts`.

## Runtime and compatibility

[Host API epoch 48](host-boundaries.md#compatibility) requires matching clients
because older clients cannot read Workspace-scoped Requests or describe the
new consent. Historical Request/result variants remain readable and never
create a live lease.

Modern authority commands (`signin.probe`, `login.authorize`, `login.seal`,
`login.cancel`) and events use the Personal Runner's existing integrations
stream and desktop computer-use bridge, independently of browser/helper
sessions. `modules.integrations.passwordSignIn: 1` plus live status confirms
the vault authority; `modules.integrations.loginText: 1` plus a current receiver
key confirms saved-text delivery. The Host opts in through the auxiliary
welcome before either optional status extension is sent. Unknown versions or
a missing hop/key disable that feature; discovery does not start a helper.

Mac helper hello requests `loginText: 1`; only a helper supporting that opt-in
returns a receiver key. Its session pins the Run and sealed acts carry
independent `loginContext`. Phone integrations protocol stays 4; Mac integrations
stays 5. Browser fills retain `modules.browser.signIn: {version: 3}` and the
calling agent Runner's `modules.agents.loginFill: 1` admission. Previous-release
browser control remains an origin-only, session-bound adapter.
The Host still serves `browser_sign_in` with its required session ID for
previous-release Runners' exact tool inventories, only to Runners without
`browser-profile-create-v1` ([Host compatibility](host-boundaries.md#compatibility)).
Current Runner profiles offer only `sign_in`.

Desktop main negotiates broker protocol **5** for modern sessionless
transactions and **4** for the legacy adapter. The broker echoes the selected
version per connection; app release never downgrades to 4. Protocol 5 separates
`kind: "app"` release from `kind: "browser"` with an exact HTTPS origin.
The [broker README](../apps/desktop/native/passwords/README.md#the-broker) and
[broker wire](../packages/protocol/src/passwords-broker.ts) own those contracts.

## The vault

One vault belongs to the macOS user. Device-only Secure Enclave owner keys in
the broker's protected keychain group wrap item keys; signed commits and a
protected checkpoint refuse rollback. Desktop verifies the installed broker's
Developer ID signature and live peer identity; the release broker accepts only
the signed Opensteer desktop. Development has a separate broker/socket/vault.

Keys stay on the vault Mac. Restarts and updates preserve them; losing,
replacing or erasing the Mac does not. There is no backup or sync, and Time
Machine or Migration Assistant cannot supply the keys. Start Fresh deletes
the vault and grants. An older owner-key policy needs reset; before the first
unlock after restart the broker reports unavailable. Only Personal's local
Host can name the Workspace for the vault authority.

## Verification

A saved secret must reach only its intended field and appear nowhere in observations,
logs or artifacts. Receiver unit checks do not establish a real device sign-in.
Use the [saved-login checks](../.agents/skills/verify-saved-logins/SKILL.md).
