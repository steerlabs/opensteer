# Opensteer Passwords

Opensteer lets an agent use a saved login without returning its value to the
agent. A person authorizes an account for a Workspace on the vault Mac; the
agent can then fill browser fields or type into apps on an enrolled Android
phone or Mac it has permission to control. No Browser Session needs to be open
for app sign-in. The vault and approval authority remain on the Personal Mac.

This page owns the saved-login contract. [Chrome sign-ins](browser-sources.md)
owns cookie reuse, [browser sessions](browser-sessions.md) owns the CDP boundary,
and [computer use](computer-use.md) and [Agent Phone](agent-phone.md) own input
and surface access.

## Promise and limits

Authorization and input results carry metadata and statuses, never saved field
values. The TOTP seed stays in the broker; `code` uses a current generated code.
The agent must never read back, copy or reveal a saved field.

Websites keep the committed-origin check described below. After a fill, page
scripts and an agent running main-world JavaScript can read the value; there
is no CDP read filter. In apps, the agent judges whether it is using the site's
genuine app, considering its package or bundle, publisher and install source.
Opensteer does not verify an app's association with the site or ask for a
separate per-app Passwords approval. A tricked agent could expose the password.
Secure-field observations suppress text, but screenshots and ordinary fields
can still expose what an app displays.

A successful fill or type proves input only. The agent submits the form,
handles verification and confirms the intended signed-in account. It reads
SMS/email codes where they arrive (Messages on a phone it controls, or an
integration) and types them as ordinary text; CAPTCHA and push approvals may
need the person. Add, edit and import saved logins in the native Passwords window.
Revocation or turning Passwords off cannot recall delivered input, sign out an
app or browser, clear a profile's cookies, or undo an agent's actions.

## Owners

| Part                                                                                                         | Owns                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Native broker](../apps/desktop/native/passwords/README.md)                                                  | Vault, keys, versioned grants, authentication, account selection, individual field release, TOTP and Activity. One per macOS user.                                                         |
| [Desktop authority](../apps/desktop/src/passwords/login-authority.ts)                                        | Desktop-lifetime broker transactions, approval cards, serialized releases, browser origin/input checks and sealing to app receivers. Only the Personal bridge exposes the vault authority. |
| [Host](../apps/host/src/browser/password-sign-in-service.ts)                                                 | Calling-Workspace admission, method routing, in-memory login references, Requests and continuations.                                                                                       |
| [Browser runtime](../packages/browser-runtime-core/src/browser/host-sign-ins.ts)                             | Page dispatch to the shared authority; the session-bound adapter for previous-release Hosts.                                                                                               |
| [Runner](../apps/runner/src/computer-apps/computer-use-handler.ts)                                           | Authenticated control, public-key and ciphertext relay through the existing desktop bridge.                                                                                                |
| [Phone executor](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/control/PhoneDesk.kt)      | Connection receiver key, envelope validation and literal Android input.                                                                                                                    |
| [Signed Mac helper](../apps/desktop/native/computer-use/Sources/ComputerUseCore/IPC/LoginTextReceiver.swift) | Connection receiver key, envelope validation and target-only Mac input.                                                                                                                    |
| [Clients](../apps/web/src/components/thread-password-sign-in-action.tsx)                                     | Approval card, Settings and transcript wording from [shared copy](../packages/client/src/host/passwords.ts).                                                                               |

The Host stores no vault data or released values. App dispatch carries sealed
text through the Host, Runner and any Personal Connect tunnel; only the vault
Mac's broker/desktop authority and the final receiver handle plaintext.

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

The Host mints an opaque `lgn_` reference and binds it to the calling Workspace,
site and live broker operation. The authority pins the login ID and revision.
Any Run in that Workspace can reuse it, including delegated Threads, while
retaining its own surface access. Another Workspace cannot use it.

One absolute deadline, `passwordLoginLifetimeMs` (60 minutes from authorization
start), covers approval and the lease. Approval and reuse never extend it.
Repeated `sign_in` calls for that Workspace/site reuse the live reference;
username, password and code share it across supported surfaces. Closing a
Browser Session does not end the lease.

Expiry, cancellation, authority loss, off/reset, or a release refusing a changed
login/grant ends it. References live only in memory and cannot survive a Host
or vault-authority restart. Reacquiring a current remembered grant needs no
prompt. The Host serializes starts per Workspace/site and joins pending work;
another Run gets `busy` once the operation needs a person. Delegated and trigger
Threads can use existing access but receive `needs-approval` when a new decision
is required. A call waits at most 45 seconds for an operation's initial answer;
approval can remain pending until the original deadline. A terminal call that
opened no Request keeps its replay identity only until that original deadline;
repeating it cannot restart the Mac authorization, while a fresh call ID can
start new work. Expiry bounds this retention window, and newly created
operations still pass the existing per-Run start limit.

## Filling a field

Focus the real browser field, then call Browser Harness
`await fillLogin(loginRef, "username" | "password" | "code")`. On an
identifier-first form, fill username and choose Next before focusing password.
The helper sends page-bound `Opensteer.fillLogin {loginRef, field}` and returns
`"filled"`; other statuses throw `fillLogin <status>: <plain sentence>`.
Never automatically retry a fill whose answer was lost.

| Status        | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `filled`      | The native input setter wrote the field and dispatched bubbling, composed `input` and `change` events.  |
| `no-field`    | No focused, connected, enabled, writable input of the requested kind.                                   |
| `wrong-site`  | The focused frame's committed origin is outside the approved HTTPS site, loopback/Opensteer, or opaque. |
| `stale`       | Document, element, frame or focus changed, or the page context failed. Inspect before retrying.         |
| `expired`     | Unknown, ended or expired reference, or wrong Workspace. Call `sign_in` again.                          |
| `denied`      | A release found a revoked/changed login or grant, or Passwords off. Later calls return `expired`.       |
| `unavailable` | The field is absent, such as no TOTP, or the broker could not release it.                               |

Username accepts input types `text`, `email`, `tel` or empty; password accepts
`password`; code accepts `text`, `tel`, `number` or `password`. Open shadow
roots work; contenteditable, custom editors and closed shadow roots do not.
A focused out-of-process iframe must itself have an HTTPS origin on the
approved registrable site, covered by a saved website there. A login saved for
`www.example.com` can fill on `login.example.com`; authorize another site's
embedded login separately.

Desktop main captures the focused frame's committed origin and binds the exact
document/input before release. It rechecks authority, focus and origin before
dispatch; the main-world setter rechecks document and element identity and
removes the temporary binding. Background pages need no OS window focus.
The Host checks Workspace lease ownership and Browser Session access on every
fill; the CDP method never reaches Chromium.

## Typing in apps

Phone and Mac `type` actions accept `text: {loginRef, field}`, where `field` is
`username`, `password` or `code`, in place of literal text. The Host resolves
the reference for the calling Workspace and seals every saved field before
sending any action in the batch. Unsupported receivers return `unsupported`
with an update instruction and no performed actions. Agents cannot submit a
sealed envelope themselves.

The phone uses `ACTION_SET_TEXT` without reading back the inserted value.
The Mac uses `AXSelectedText` or Unicode-only keystrokes; saved values containing
CR, LF or tab are refused before that type action performs input. Literal Mac
text keeps its ordinary Return/Tab behavior. Completed saved-field receipts
are exactly `Typed saved username`, `Typed saved password` or `Typed saved code`,
without labels, values or lengths. See the surface docs for
[Mac input](computer-use.md) and [phone input](agent-phone.md#6-the-agent-contract).

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

Passwords returns `ready {site, loginRef, account}` (masked account),
`pending {requestId, replayed}`, `declined {requestId}`, `resolved {requestId}`
or `unavailable {site, reason}`. Chrome retains its own results, including
`applied`, when a Browser Session is supplied. Reasons distinguish admission,
missing login, off/setup state, unsupported/outdated runtime, expiry and
interruption; the [result schemas](../packages/protocol/src/agent-control.ts)
define them.

The durable Request keeps kind `browser.password-sign-in`, but modern payloads
have `scope: "workspace"`, `permissionVersion: 5` and no session ID. They name
the site, agent's reason, vault Mac Runner, operation and absolute deadline.
Only that Mac's desktop app approves through the local broker; any client can
decline using `browser.password-sign-in.decline`. Generic `request.respond`
refuses this kind. Other devices name the Mac where approval is needed.

The Host records the first settlement once and retries failed writes.
Authorization settles with masked account metadata; the continuation obtains
`loginRef` from the live registry, never persisted Request data. It tells the
agent to use reference typing or browser `fillLogin`, then confirm the account.
Expiry settles `expired`, lost authority/cancellation settles `interrupted`,
and broker unavailability settles `unavailable`; decline stays declined.
After restart, lost modern Requests settle `interrupted`; historical
session-bound Requests settle `session-closed`. Settlement alone does not end
an authorized lease.

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

Use the cheapest layer that catches the bug ([How to test](testing.md#how-to-test)).
[Host lease checks](../apps/host/src/browser/password-sign-in-service.test.ts)
and [desktop authority checks](../apps/desktop/src/passwords/login-authority.test.ts)
cover scope, cancellation and secret-safe refusals.
[Shared envelope vectors](../packages/protocol/src/login-envelope.test.ts),
[Node crypto checks](../apps/desktop/src/passwords/login-envelope.test.ts),
[Android receiver checks](../apps/agent-phone/app/src/test/kotlin/com/opensteer/agentphone/wire/LoginTextTest.kt)
and [Mac receiver checks](../apps/desktop/native/computer-use/Tests/ComputerUseCoreTests/LoginReceiverTests.swift)
hold the cross-language contracts. The broker's Swift tests run on the host
([broker README](../apps/desktop/native/passwords/README.md#testing)). Use the
[Host tool integration](../apps/host/src/browser/browser-sign-in-tool.integration.test.ts)
or [routing integration](../apps/host/src/browser/browser-source-service.integration.test.ts)
only for a Host/database boundary that cheaper checks cannot show.

The security property that matters most is that a saved secret reaches only the
field it was meant for and appears nowhere else. On a real Mac, the
`saved-password` [VM journey](testing.md#gui-test-vms) proves it with a
zero-match leak scan over observations, logs and artifacts. It is also release
gate (b) ([Releases](releases.md#release-gates)). The browser smoke,
`pnpm test:vm -- pnpm test:electron-passwords`, and the
[phone saved-login file](agent-phone.md#11-verification) cover the other
surfaces on demand. A receiver test does not establish that a real device
completed a sign-in.
