# Agent Phone: an Android phone for agents

An agent phone is an Android 11 (API 30) or later phone running **Opensteer Agent Phone**
(`com.opensteer.agentphone`). It joins one Deployment as a user-owned computer whose only
Runner module is `integrations`. Agents use its whole screen through the integration gateway;
it neither runs agents nor offers SSH. Other Android apps supply the work agents do on it.
The separate [Opensteer mobile client](mobile.md) reads and steers work.

This document owns the phone-specific contract. [Computers](computers.md) owns membership;
[Computer use](computer-use.md#4-host) owns the shared session machinery and Mac approvals.
[The app README](../apps/agent-phone/README.md) owns build commands and artifact paths.

## 1. Model

The catalog entry `android-phone` has `adapter: "computer"`, `kind: "display"`, platform
`android`, name `Android phone` and auth label `This phone`. One connection per definition and
Runner names the entire display, with `app: null`. Its internal authority rows are:

| Operation | Access     | Effect                                                                               |
| --------- | ---------- | ------------------------------------------------------------------------------------ |
| `observe` | read       | Read screen state, accessibility tree and, when requested by the Host, a screenshot. |
| `act`     | read-write | Perform an action batch and return a fresh observation.                              |
| `release` | read       | End this Run's hold; succeed even if it holds no session.                            |

Agents use the Host's `computer` MCP tool through `phone(query)`; the integration rows
remain the access checks. `integration_call` refuses them with
`Use the computer tool to see and operate apps and phones.` See the shared
[REPL contract](computer-use.md#the-computer-repl).

Access labels are **Can see** and **Can see and control**. The connection caps Workspace
access; a Workspace grant cannot widen it. The owner decides access from any Opensteer app (§7).
That access covers the whole phone, including accounts in its apps. A USB phone without this app
remains a peripheral of its attached
computer, reachable through that computer's shell rather than this integration.

## 2. Setup over USB

**Add a phone** on Settings → Computers uses WebUSB in the desktop app or a Chromium browser
with WebUSB. Enable USB debugging and use a data cable. Safari and Firefox cannot run setup.
Only devices exposing an ADB interface appear in the chooser. Cancelling chooses nothing;
a missing phone can mean debugging is off or the cable only charges.

Chromium uses its browser chooser. In the desktop app, the trusted main frame requests the
ADB interface; a single matching device is selected automatically, while several require a
choice in the dialog. Desktop grants last for that app process, keyed by vendor, product and
serial when available, otherwise by connection. Replugging the selected, still-granted phone
resumes an interrupted dialog; setup also reads persisted state when run again.
[`DesktopUsbDeviceAccess`](../apps/desktop/src/app/usb-device-access.ts) answers each of
Electron's three USB questions with only the context Electron gives it: whether the app's
origin may request a device (asked without a window or frame), which device the requesting
frame gets, and whether the page may reach a device again.

[`webusb.ts`](../packages/agent-phone-setup/src/webusb.ts) stores the ADB RSA credentials in
the browser profile through Tango's `AdbWebCredentialStore("Opensteer")`. A trusted key
can authenticate silently; otherwise unlock the phone and answer **Allow USB debugging**.
The wait ends after 120 seconds as `unauthorized`. Only Tango's `DeviceBusyError` becomes
`busy` with advice to quit the other ADB program or run `adb kill-server`; other connection
errors surface as failures. No enrollment is minted during device selection or authentication.
A Personal Deployment needs remote access enabled before the Host will mint a phone token.

The shared [`setupAgentPhone`](../packages/agent-phone-setup/src/setup-agent-phone.ts) engine
uses injected ADB and owner-session Host ports. Product ADB uses WebUSB; device tests can use
the local ADB server. Its sequence is:

1. Validate the manifest, APK size and SHA-256 before inspecting the phone.
2. Inspect Android version, manufacturer, model and lock configuration. Require at least
   API 30 and the manifest's minimum SDK. Report the lock configuration; agents unlock through
   the phone tools (§3).
3. Keep an installed build at least as new as the artifact only if its APK signer matches:
   its signing block must carry a v2 or v3 signature, and every v2, v3 and v3.1 signer must
   name the artifact's certificate. Android verifies v3 or v2 and, from Android 13, v3.1, so
   whichever it verified names that certificate; a v1-only APK, or one with only a v3.1 block
   that Android 11 and 12 ignore, counts as foreign. Otherwise install with package-manager
   replacement, naming `com.opensteer.agentphone` as installer of record. Read that installer
   back; on Android 16 a fresh install can discard a not-yet-installed installer name, so repeat
   the same in-place install once when needed. A retained newer APK may be reinstalled to
   record its installer, without downgrading or erasing data. A foreign signer or `INSTALL_FAILED_UPDATE_INCOMPATIBLE` requires explicit
   confirmation before uninstalling, which erases the app's data. Verify the installed signer
   before configuring or pairing.
4. Add the accessibility service to `enabled_accessibility_services`, preserving other
   services, enable accessibility and read the settings back. Request battery-optimization
   exemption and grant `POST_NOTIFICATIONS` on API 33+. Grant
   `appops set com.opensteer.agentphone PROJECT_MEDIA allow` and verify it with `appops get`.
   Set and read back `REQUEST_INSTALL_PACKAGES` at both uid and package level, and keep
   Agent Phone as its own installer of record even when retaining an existing build.
   Poll for a bound service and exemption.
5. Read the pairing target with `agentPhone.target.get` first: a Personal Deployment with
   remote access off stops setup here, before anything is unpaired or minted. Then read
   `STATUS`. A pairing to another Deployment requires confirmation to unpair. An enrolled
   pairing to this Deployment keeps its identity; unless it is already online at the target's
   address and name, setup sends `RETARGET` and waits for it there. A pending pairing keeps
   its identity and token while its enrollment may still succeed; when the target's address
   has changed, setup first sends `RETARGET`, which moves that pending identity and its token
   to the new address. Otherwise mint with `runner.enrollment.createPhone`, send `PAIR`, and
   require the matching `enrollmentId` to reach `online` at the address it was sent, trying
   at most three enrollments per run.
6. Once the phone is online, create its connection at **Can see and control** (`read-write`)
   through the owner command in §7 if none exists. Re-running setup preserves an existing
   connection, including owner-lowered **Can see** access.

The emitted steps are `inspect → install → configure → pair → done`;
artifact verification precedes the first step. Unplugging does not roll back
completed changes. A dialog holds at most one usable enrollment. Its current slot keeps one
idempotency key, the name minted under it and the Host's answer: every run in the dialog, after
**Try again** or a replug, sends that enrollment again, and a lost mint answer is asked again
under the same key. Setup moves to the next slot only when the phone reports the enrollment
dead (expired or refused) or a different phone name needs one, and only after
`runner.enrollment.retire` answers `retired`, `consumed` or `expired` for it. A slot whose
mint answer was lost is minted again under its key before it is retired.

Setup issues are defined beside the engine rather than inferred from messages:

| Codes                                                             | Meaning                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `android-too-old`, `artifact-invalid`                             | Unsupported Android or an invalid artifact/installed signer.           |
| `signature-mismatch`, `install-failed`                            | Foreign-build removal declined, or package-manager refusal.            |
| `accessibility-failed`, `configure-failed`                        | Service/settings or battery exemption did not become usable.           |
| `paired-elsewhere`, `phone-app-refused`, `phone-app-unresponsive` | Pairing conflict, rejected receiver result, or missing/invalid status. |
| `pairing-timed-out`                                               | Enrollment did not finish.                                             |

Phone-reported issues pass through unchanged: `enrollment-expired`, `enrollment-refused`,
`host-unreachable`, `host-mismatch`, `remote-access-off`, `removed`, `accessibility-off`,
`protocol-error` (§4), `failed`. A build without the APK offers no setup; the dialog explains
that the build doesn't include Agent Phone.

## 3. The phone app

The Kotlin app uses plain Android Views, minSdk 30 and compile/target SDK 36. The
**accessibility service owns the runtime**: Runner connection, executor and
ongoing status notification. It tears them down on unbind or destruction. Live display
adds a `mediaProjection` foreground service only while streaming (§6). It holds a `PARTIAL_WAKE_LOCK` only while its connection is connecting,
serving or backing off, including while paused, so screen-off CPU sleep does not stop
heartbeats or retries. A connection that has stopped until setup acts, unpairing and runtime
teardown release it. This keeps the CPU awake, not the display.

**Pause** persists locally across reboots and works offline. It withdraws all running and
queued work and stops the task holding the phone as the owner's Stop does (§7), reports
`unavailable` with a paused detail and refuses `observe`/`act` as `stopped-by-user`.
The notification shows status and the holding task, with Stop while a task is active;
notification permission or channel settings can suppress it.
`MainActivity` shows the holding task, Stop, Pause and setup health, and warns when not charging.
Its light and dark themes follow the client's palette. Status and notifications name
**Opensteer on the Deployment's display name**; the Host
address remains a secondary detail on the main screen. Removing the phone asks for confirmation.

`WakeActivity` turns on the screen, attempts to dismiss a nonsecure keyguard and finishes
within three seconds. A PIN, pattern or password lock screen remains available through
the `computer` tool's phone handle: the agent wakes the phone, opens the keypad and enters the credential through
the controls it observes, then confirms the unlocked state. The
[computer-use skill](../apps/runner/agent-skills/skills/opensteer-computer-use/SKILL.md#phones)
owns missing/wrong-PIN guidance.

The Runner's Ed25519 key is its identity. The identity file, including its private
key, is AES-GCM encrypted under an Android Keystore key in no-backup storage; Android backup
and data extraction exclude it. Agents cannot launch this app or target its foreground UI
with gestures/text actions. They may navigate away, launch another app, wake or wait. When
this app is in front, observations retain its foreground identity but contain no tree or
screenshot and report `opensteer-app`.

## 4. The Runner

`runner.enrollment.createPhone {idempotencyKey, name}` creates a user-owned `local` Runner
grant of exactly `["integrations"]`; the Host's computer preset, which adds `messaging` and
`shell`, does not apply. The database accepts this exact grant in a Personal Deployment
alongside its reachable-computer grant, and still requires remote access at admission.
`runner.enrollment.retire {idempotencyKey, enrollmentId}` makes an enrollment its own user
owner minted unusable at once: under the locks redemption takes, it moves the expiry to now
and answers `retired`, or reports that a Runner already `consumed` it or that it had
`expired`. Retiring it again answers `expired`. Anyone else is told it does not exist.

The signed descriptor has `capabilities: []`, `device: {form: "phone", platform: "android"}`,
`runnerKind: "local"` and only
`modules.integrations: {platform: "android", protocolVersion: 4, loginText: 1}`.
Saved-login delivery is optional: only an auxiliary welcome with `loginText: 1`
creates a per-connection P-256 receiver and adds its public key to authenticated
`runner.integrations.status.loginText`. The key names the auxiliary stream and
primary connection generation; stream loss invalidates it, and reconnect creates a
fresh key. The private key stays on the phone. [Opensteer Passwords](passwords.md#sealed-delivery)
owns envelope binding, replay protection and the ciphertext relay contract.
Protocol 4 is the current phone contract. Authenticated status reports runtime H.264 encoder
availability as `displayAvailable`; human viewing uses live video without a picture fallback.
It also names its Runner, boot, Android device name and app `versionName` as `runtimeVersion`.
Setup and each signed hello use Android's `Settings.Global.DEVICE_NAME`, with manufacturer
and model only when the setting is empty. A setting observer reconnects after a rename;
the Host updates the phone's name on authenticated arrival. Other computers keep their
Opensteer-assigned names. There is no execution environment or shell module.

An incompatible phone receives `host.error` with `agent-phone-outdated`, then close 4003;
it is never registered and a pending enrollment is not consumed. For an enrolled phone,
the Host verifies its fresh challenge signature (including the retired branch-build
`displayStream` field) before recording the refusal. One nullable, fixed reason per
Runner survives Host restart; generation fencing prevents a delayed refusal overwriting
a newer connection, and a successful current connection clears it. Unauthenticated
claims and fresh enrollment proofs cannot mark an existing machine. Machine projection
reports `needs-update` and clients say **Update Agent Phone on <name>**. A current app
checks the paired Host's update channel before connecting and when refused as outdated.
An enrolled protocol-3 phone updates over that authenticated network channel (§10), independently
of integrations admission, then reconnects as protocol 4 with its identity migrated.
It reports `needs-update` locally if a verified update cannot complete, preserving its identity.
Phone machine projections carry `appApproval: null` and `approvalKeyId: null`.
The Host warns on refusal and logs one accepted/refused outcome for every auxiliary
upgrade, including authentication timeout, invalid proof, capacity refusal and early close.
Setup over USB installs the current app and enables subsequent network updates.

It uses the normal challenge/enroll-or-authenticate/welcome handshake and authenticated
auxiliary integrations stream. Host fences and leases apply; heartbeat intervals come from
the welcome. The phone carries the welcome's `serverTime` forward on its monotonic clock from
the frame's arrival and stamps strictly increasing heartbeats with it. Leases and all
connection timing are monotonic, so changing the phone's wall clock cannot lengthen or
shorten a lease. It reports `android-phone` operations, `captureSupported: false` and runtime `displayAvailable` on stream
attach, checks status every 30 seconds and sends changes, including Pause, promptly.

Admission refusals send `host.error` before closing, with a reason when available.
`runner-enrollment-expired` stops that token's attempts; `personal-remote-access-off` retries
and is the only reason the phone reports `remote-access-off`. A connection it cannot make
otherwise reports `host-unreachable`. Backoff grows with each failed attempt and starts over
only after a connection the Host renewed ends; a welcome alone resets nothing, so a Host that
admits the phone and then fails is retried at the 30-second cap. A re-pair or `RETARGET`
starts with neither the previous target's backoff nor its `protocol-error`. Revocation uses
bare close code 4010, without a preceding error: the phone wipes its identity and keys and
stops reconnecting. A reason the phone has no rule for shows the Host's message. Other
enrolled-identity refusals can retry slowly; see
[`ConnectionPolicy`](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/runner/ConnectionPolicy.kt).

Decoding stays strict, and no input ends the runtime. A frame the phone cannot read, anywhere
in the handshake, ticket, lease or stream, ends that attempt as a protocol violation, which is
retried; unreadable parameters in an otherwise valid request refuse only that request. Two
attempts in a row that end in a violation show `protocol-error` until an attempt ends another
way. The wording names neither side as outdated; adding the phone again over USB installs the
app the Host's Opensteer carries.

## 5. Pairing

The Host builds the response's `{deploymentId, deploymentName, hostInstanceId, hostUrl}` itself:
a server's canonical origin or the Personal Host's live remote-access route, with the
Deployment's display name. It refuses an absent route before minting;
`agentPhone.target.get` returns the same target, or refusal, without minting. The URL schema
permits HTTPS or HTTP to loopback only; a phone's loopback is its own network namespace, so
ordinary setup needs a phone-reachable HTTPS origin.
The enrollment token lasts 600 seconds.

Setup sends version-1 pairing JSON containing that target, `enrollmentId`, `enrollmentToken`,
`expiresAt` and `runnerName`, encoded as base64url:

```sh
am broadcast --include-stopped-packages \
  -n com.opensteer.agentphone/com.opensteer.agentphone.setup.SetupReceiver \
  -a com.opensteer.agentphone.action.PAIR --es payload '<base64url JSON>'
```

`RETARGET` uses the same component and a base64url Host target payload. It updates an
identity in the same Deployment, enrolled or still pending, and requires fresh discovery at
the new target before using it; a pending identity redeems its original token there. It
preserves the Runner, enrollment token and signing keys. `STATUS` and `UNPAIR` use the same
component and their respective action without `payload`.
`--include-stopped-packages` lets setup reach a fresh install. The exported receiver requires
`android.permission.DUMP`, normally held by the shell/system rather than ordinary apps.
It executes on the app's setup thread and returns ordered-broadcast results:

| Result                                | Code |
| ------------------------------------- | ---- |
| Applied or already applied            | `-1` |
| Invalid pairing payload               | `1`  |
| Already enrolled with another pairing | `2`  |
| Unknown command                       | `3`  |
| Failed to handle command              | `4`  |
| Retarget found no identity to move    | `5`  |

Successful command handling returns `AgentPhoneSetupStatus` JSON as result data; a caught
exception returns code 4 with no data. Status includes accessibility enabled/bound state,
app version, battery exemption, connection, issue, pairing summary and Pause. It never returns
enrollment tokens or private keys, because Android also logs broadcast result data. Acceptance of `PAIR`
means the pairing was stored, not that enrollment finished.

The phone stores its identity before enrollment, so a lost answer retries with the same
identity/token. Before redeeming it, `HostDiscovery` reads `/.well-known/opensteer` and compares
both `authority.document.deploymentId` and `hostInstanceId` to the USB pairing. A mismatch
stops enrollment without sending the token. **It does not verify the authority signature**:
TLS authenticates the configured origin; these identifiers check that it is the intended
Opensteer. The USB owner session supplies the trusted target. Release builds trust system CAs
only and disable redirects; debug-only trust is described in the README. This is not
certificate or authority-key pinning. The discovery check runs before enrollment, not before
every reconnect; retargeting requires a fresh discovery check before using the new target.

## 6. The agent contract

`integration_search` includes a `phones` block for `android-phone`, with `runnerId`, name,
state, approval, optional in-use status and holding thread title, access and `callable`.
Setup and recovery instructions appear once in `guidance.phones`. With the
`runnerId` of one of the requester's phones it lists the apps `launch` can open instead, as
`{apps: [{label, packageName}], total, nextOffset}`: one entry per package with a launcher
activity in the app's Android user, excluding Agent Phone, matched case-insensitively by
label or package and ordered by label, then package. Like a Mac's list it is the owner's
inventory: it needs no grant or session, never touches the display or the latest
observation, and answers while the phone is paused. Ask for a phone with
`integration_request {kind: "computer-app", runnerId, access, reason}` and no `app`.
The Host checks the requester's own phones and derives the definition; app-naming requests
for a phone fail. Its owner decides access from any Opensteer app (§7).

After approval, `const p = await phone("Pixel")` selects an exact phone name or the id
from `phones()`. `await p.observe()` returns and emits its current state. `p.act(actions)`
and `tap`, `longPress`, `swipe`, `drag`, `type`, `clear`, `navigate`, `launch`, `scroll` and
`wake` return and emit the new observation; `p.release()` ends the hold. Convenience
point targets accept `[x, y]`, and element targets accept an index. `act()` takes the full
wire actions below. The REPL retains the latest `observationId` internally and supplies
it at FIFO dispatch, including across aliases. Unlike Mac window actions, phone actions
keep their closing observation. The phone wire is unchanged.

The wire frame is `host.integrations.computer-use` with `definitionId: "android-phone"` and
`app: null`; absent `definitionId` retains the Mac contract. Phone wire operations are
`observe`, `act`, `close` and `installed_apps`; only observe/act carry non-null
access. The Host chooses `includeScreenshot`. Agent `release` forgets the hold immediately and
queues `close` on the same admission queue, before a later Run's work.

Actions use `{index}` from the cited observation or `{x, y}` in screenshot pixels:

| Action      | Fields and limits                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `tap`       | `target`, `count` 1 or 2 (default 1)                                                                 |
| `longPress` | `target`, `durationMs` 400–5000 (default 800)                                                        |
| `swipe`     | `from`, `to`, `durationMs` 50–5000 (default 300)                                                     |
| `drag`      | `from`, `to`, `holdMs` 400–3000 (default 600), `durationMs` 100–5000 (default 600)                   |
| `type`      | Literal `text` 1–5000 characters or `{loginRef, field}`, optional `target`, `submit` (default false) |
| `clear`     | `target`                                                                                             |
| `navigate`  | `to`: `back`, `home`, `recents`, `notifications`, `quickSettings`                                    |
| `launch`    | `packageName`                                                                                        |
| `scroll`    | `target`, `direction`, `amount` 1–20                                                                 |
| `wake`      | No fields                                                                                            |
| `wait`      | `ms` 1–5000                                                                                          |

A batch has 1–32 actions and at most 40 seconds of long presses, swipes, drags, waits and
scroll steps (350 ms each), leaving room within the Host's 60-second act deadline. The phone
settles for 250 ms after each completed action. `type` computes cursor/selection insertion
using `ACTION_SET_TEXT`; unsupported fields have no fallback. An existing masked password
must be cleared first. `submit` invokes the field's IME action; it can fail after text changed.
Gestures use Android's accessibility gesture dispatcher; cancellation cannot undo one
already dispatched.

For saved text, acquire a reference with `sign_in {site, reason}` and choose
`username`, `password` or `code` for `field`. Judge that the target is the site's
genuine app. The Host asks the vault Mac to seal the field to this connection's
receiver; the phone authenticates all saved actions before any batch input,
then decrypts again immediately before
`ACTION_SET_TEXT`, without reading the value back. Completed receipts are exactly
`Typed saved username`, `Typed saved password` or `Typed saved code`, without target
labels or lengths. Missing capability/key returns `unsupported` with no performed
actions. [Opensteer Passwords](passwords.md#typing-in-apps) owns consent and lease reuse.

Every change to the phone is admitted immediately before it happens, after its target is
resolved, Android state and gesture arguments are prepared, and any wait is over. The final
check rereads authority after the display and foreground reads: the request is not cancelled,
the phone is not paused, the Run is not stopped, the session has not ended,
the Opensteer app is not in front of a touch, and the time left covers what the change
takes. An action of several changes — `type`'s focus, text, cursor and submit, or each
scroll step — is admitted change by change, and one stopped partway says what already
happened. A drag's move is admitted on its own after the hold; anything that ends the drag
before the move lifts the finger where it pressed, so the finger is always lifted.

The phone enforces each request's `timeoutMs` itself, on its monotonic clock from the
frame's arrival, so queued time counts, and keeps the last 1,000 ms for its answer. A request
still queued when that time runs out is answered `failed` then, even while other work runs,
and never runs afterwards. In a batch, waits, settles, scroll steps and screenshots stop at
that point. A cut batch returns its completed actions with a `failed` error and an observation
only if one still fits; a gesture whose effect could not be confirmed in time is
`outcome-unknown`.

[`android-phone.ts`](../packages/protocol/src/android-phone.ts) owns the observation invariants:

- Every snapshot has a fresh `observationId`, timestamp, screen state, keyguard/secure-lock
  flags, foreground identity, geometry and rotation.
- Tree indices reset per observation. Trees have at most 1,500 elements and 32,000 UTF-8
  bytes, with a truncation flag. Points and element frames use screenshot coordinates.
- Secure (`isPassword`) nodes retain no text, content description or hint in refs
  or tree/field labels; they use the generic label `Password`. Screenshots are unchanged.
- A screenshot's size equals geometry. Exactly one of screenshot or an unavailable reason
  is present: `not-requested`, `screen-off`, `opensteer-app`, `failed`.
  The screenshot is whatever Android captured; the phone does not classify its content.
- A dark screen has no tree/elements or screenshot and is not truncated. Observing never
  wakes the phone.

Nothing collected across a protected interval is published. An observation, an act's final
observation or a Watch capture is discarded if Pause, a Stop, the Opensteer
app coming to the front, the session ending or the request's withdrawal happened while it was
collected, even if that protection has since lifted. An observation that starts replaces the
one an act may cite, so one that is discarded or runs out of time leaves nothing citable.

The Host emits receipts, then the observation header/tree and screen/lock/foreground
state, followed by an image when the engine/model accepts images. Each wire act cites
the session's latest observation, supplied internally by the REPL; rotation or size
changes also yield `stale-observation` before acting. The executor validates target ranges before the batch and resolves element nodes again before
using them. It stops on the first failure and reports completed actions with a resulting
observation when available. A lost act answer is `outcome-unknown` and is never retried.

The Host reserves the whole display under Runner admission, indexed by Runner and
`display:android-phone`; another Run gets `busy`. The phone also enforces one active session
and serial observe/act execution. The session belongs to one Run attempt
([Computer use](computer-use.md#4-host)): Run end, a revoked attempt grant (the Thread's
Stop, a restart, a cancelled Assignment or a background deadline), release, the owner's Stop,
access withdrawal, disconnect and removal end the hold, and its `close` stops a running batch
promptly. A periodic cleanup ends display sessions after at least three idle minutes, except
while a call is in flight; Mac sessions retain ten minutes.

`close` is answered as soon as it arrives, and its session is unusable from that moment: its
queued and running requests are withdrawn, and the cleanup that lets go of the phone follows
in its executor turn. Waits stop promptly and later actions do not run. A gesture already
dispatched to Android may finish; an interrupted batch reports its progress and an uncertain
outcome. A late close for an old session cannot stop its new holder.

### Live display

The wire contract lives in [`display-stream.ts`](../packages/protocol/src/display-stream.ts).
[Host compatibility](host-boundaries.md#compatibility) requires matching clients and current
phone protocol. Upgrade the Host before its phones. Web, Desktop and Expo use H.264 for
all human phone viewing. Agent observation screenshots keep their own observation IDs;
viewing never requests an accessibility screenshot or changes those observations.

One producer belongs to the authenticated phone connection/fence and `display: "main"`.
Task viewers use an exact held session and renewable Run grant. A person's own view uses
an exact `viewId`/`generation` from `ComputerViewService`, with no task, reservation or
observation. The first visible admitted socket starts the producer; all sockets share its
encoder and GOP. `display.demand` replaces its bounded, deduplicated authority set with an
increasing revision. Sources never renew from frames, acknowledgements or refresh requests.
Source-ended notifications remove only that authority. Task end/replacement leaves the
owner generation alive, and closing an owner generation leaves task viewers alive.
Empty demand closes publication immediately; the last socket's five-second grace retains
projection resources, then stops them. Phone connection replacement and Host shutdown stop
the producer. Disconnect/restart loses native owner leases and requires explicit reopening.

Task viewers connect at `/v1/computer-use/sessions/:sessionId/display`; independent owner
viewers connect at `/v1/computer-use/views/:viewId/:generation/display`. Both require the
ordinary login, effective owner and live source authorization, checked again every five
seconds and before media delivery using current in-memory authority. Owner-only views say
“View only.” Authorized task Watch accepts shared input directly; owner-view
sockets cannot control or silently follow a replacement task.

Host logs distinguish the gates before capture starts. `Phone display capability changed`
records the authenticated Android module's protocol/runtime version and `displayAvailable`:
`attached` has no status yet (`null`), `reported` carries the encoder capability, and
`detached` records the stream loss reason. Capability comes from the integrations status,
not a display field in the signed descriptor. `Phone owner view command` records open,
renew and close requests and their typed result, including the exact view generation,
expiry and refusal reason. `Computer owner view ended` records lease removal.
`Phone display state changed` records producer creation and state transitions without
tickets or media. A ready owner lease with no viewer request places the failure before
Android capture; it does not establish that Android is waiting for consent.

Capture uses MediaProjection after checking the setup-granted `PROJECT_MEDIA` app op.
A missing grant reports `failed/permission-required` without opening Android's permission
dialog. Each start obtains a fresh token through a transparent `ProjectionActivity`, starts
`ProjectionService` in the foreground with type `mediaProjection`, then obtains the projection,
registers its callback, starts the H.264 encoder and creates one VirtualDisplay. Acquisition
runs in one executor turn behind current agent work. The transparent helper stays until the
initial Surface is attached, then finishes; the foreground is revalidated before that turn
ends. This ordering gives a static display its initial composition. Generation reset replaces the encoder
and Surface on that VirtualDisplay, resizing for geometry changes; it never creates a second
VirtualDisplay from the token. The initial encoder starts generation 1. Only protection lift,
rotation/size change and encoder error reset the generation; encoder error permits one recovery
before `failed/encoder-failed`. Screen-off and locked-screen suppression retire the current
publication generation, clear queued media and client pixels, and reset input. Local
wake/unlock resumes with a fresh generation/keyframe on the same VirtualDisplay. Viewing
never wakes or unlocks the phone; a configured PIN on an unlocked phone does not suppress it. Refresh requests `PARAMETER_KEY_REQUEST_SYNC_FRAME` on the current encoder,
so the next encoded picture is an IDR. Publication discards already queued deltas until that
IDR arrives. The periodic I-frame interval is 10 seconds. The input surface repeats a still
picture every 250 ms at most ten times to refine it, so a still screen settles within 2.5 seconds
of its last change and then sends nothing; where the status bar shows a screen-sharing timer
(Android 16), each tick is a small change. Static
projection start must deliver a keyframe within 1000 ms; a replacement Surface on a static
screen must produce a fresh keyframe before viewing resumes. The static-screen wake
acceptance must pass on the actual APK/device; a prior cached picture is not wake evidence.

The Host starts demand with `host.integrations.display.start`, naming `main`, the stream,
authority references and demand revision,
one-use data ticket and explicit size/rate limits (defaults 1280 long side and 30 fps;
allowed 320–1920 and 1–60). The phone presents that ticket as a Bearer credential on
`/internal/v1/computer-use/display`; its signed claims bind the full integrations auxiliary
fence, display and stream for 60 seconds. Failure of this separate data socket reports
`failed/data-socket-failed` without ending the Runner attempt. Whether the Host detects the loss
or receives that phone state first, it closes viewers with 1013 to retry without relaying a
failed state; other failed/stopped reasons remain terminal. The Host ends a stream by sending
`display.stop` and closing the data socket, which arrive in either order, so a close the Host
chose (1000 demand ended, 1001 Host stopping, 4003 authority ended) reports `stopped`.

Binary frames use a four-byte big-endian JSON-header length, UTF-8 header and one nonempty
Annex B access unit, at most 4 MiB. Phone headers contain `streamId`, `generation`, `sequence`,
`ptsUs`, `key`, `width`, `height`, and an `avc1.XXXXXX` codec exactly on keys; every keyframe
prepends SPS/PPS before IDR. The stream is Baseline or Constrained Baseline H.264, with no B-frames and no
frame reordering, so every frame can be shown as soon as it is decoded. Sequence increases
across the stream, including resets. Control state and media travel on unordered sockets, so the Host
never waits for one to publish the other. The phone ends a generation whenever it closes
publication and resumes only in a new one: the Host withholds (and acknowledges) media of any
generation the phone declared protected or ended, and of any generation older than the newest
it knows, publishes a newer generation's media on arrival, and makes the stream live from that
generation's first frame. A late `starting` for a generation whose media already arrived is
ignored; `starting` for a newer generation still clears the cache and makes viewers wait for
its keyframe. A media generation below the last media generation received is a
protocol violation. Every phone socket sets TCP_NODELAY, as the Host and Cloudflare's edge do,
so small frames and owner input are never held back by Nagle's algorithm.
The Host acknowledges accepted frames with `display.ack {sequence}`. The phone bounds
unacknowledged media to 1 MiB and 500 ms; overflow drops until drained, then requests a sync
frame on the current encoder and skips deltas until it arrives. The phone alone adapts bitrate:
start at 2.5 Mb/s within 1–4 Mb/s, reduce by 25% on sustained delay or drops, and increase by
10% after eight healthy seconds with flowing frames. Static silence earns no increase.

Each authorized viewer socket reports
`display.state` and editing JSON and forwards the same payload under a header
without `streamId`. Viewers acknowledge each frame with `display.ack` when the decoder takes
it off its queue or the viewer drops it; each has credits
of four frames and 1 MiB, admitting one larger frame when none is outstanding. Socket
writes have an independent 8 MiB buffer limit, and only outstanding sent sequences return
credit. A phone admits up to eight viewers across task and owner sources. After ten seconds over budget the Host closes
a viewer; returning within budget clears that timer. The Host caches the latest keyframe and
following frames of the current generation, bounded to 4 MiB including viewer framing and
600 frames to bound metadata and replay work. New keys restart the cache; generation changes
and protected or screen-off states clear it; overflow invalidates it until a key arrives. A join receives
state first, then the cached GOP in order, paced by its credits, followed by live frames.
An empty or invalid cache requests refresh only while live and waits for the next key,
coalesced to once per 500 ms per stream. A skipped viewer that drains its outstanding credit
restarts from a valid cached keyframe, paced by credit, even on a static screen. Last-viewer
departure leaves a five-second demand grace before stop. Session end closes that task's sockets and resets input;
owner-generation closure ends only its owner sockets. Integrations detach closes every socket.
Watching never extends the session's hold; accepted owner input does. Authority is checked
at admission, every five seconds and on login expiry. Each input checks only the held session
and phone-confirmed lease in memory, then updates idle activity synchronously; acknowledgements
never wait behind an authority read. Lost acquire/release answers expire after five seconds:
the Host reports `released/timed-out` (“The phone didn’t respond in time”) and sends a release
to the phone before another acquisition. `stream-lost` remains the connection-loss reason.

The publication rule also covers streamed frames. Under the stream lock, closing protection
detaches the Surface, retires the encoder and drops queued media; its drain thread alone releases the codec; drain output may enqueue
only while its encoder is current and unprotected under that same lock. Pause,
the Opensteer app coming forward, sleep and keyguard close this common gate. Task Stop or
withdrawal removes only task demand; an independent owner source keeps viewing. Lifting protection
requires a fresh generation. `MainActivity` uses `FLAG_SECURE` so its
pixels stay black even before protection closes; `WakeActivity` and the contentless
`ProjectionActivity` do not.

A viewer with shared input clicks, drags, scrolls and types directly while the agent keeps
running. The person’s press waits for the agent gesture to finish or cancels it with an honest
interrupted result. An agent gesture during a held person contact fails with
“A person is touching the screen; try again.”, and an agent gesture or text edit while the
person holds a key fails with “A person is holding a key; try again.” A withdrawn agent
gesture sends no further strokes. Two viewers share one person lane: while one holds a touch
or key, another viewer’s batch receives `contended`.

Blur, hide, F6 and leaving send `display.input-reset` and cancel local composition. Reset is
an ordered barrier: discard queued person work, end strokes and release keys before admitting
the next batch. Generation changes, Pause, lock, protected screens, stream end, disconnect and
Stop perform the same cleanup. Person input never invalidates agent observations. Text edits
serialize with agent edits; an intervening edit rotates the editing context and stale edits
resync rather than retrying an uncertain mutation.

Viewer `display.input` and relayed `host.integrations.display.input` name the
`geometry` generation and increasing input sequence, carrying 1–64 events. Pointer coordinates
use [0, 1] in the stream picture and `t` uses nonnegative viewer-monotonic milliseconds;
scroll deltas use [-1, 1] picture units per event. Navigation names back, home, recents or
notifications. Each strict text variant inserts 1–1000 characters, deletes 1–100 characters
backward, or submits. The phone rechecks generation and input authority and never
retries uncertain input. All owner events run in wire order on a separate serial lane, so
agent observations do not delay them. The first text after a tap waits for that editor to receive
focus, so a completed gesture cannot send text into the previous field. Window and power events update cached input admission;
a one-second safety poll catches missed changes. Frames schedule their own media pump.
API 33+ owner edits use the focused editor's `AccessibilityInputConnection` for ordinary
and secret fields, without a whole-field text rewrite. The connection binds to the editor's
accessibility identity when Android starts input, including editors without resource IDs.
The active accessibility window must contain exactly one focused editable node; this includes
virtual editors inside a focused container. Missing or ambiguous editor identity refuses input.
A tap records the editor identity before the keyboard can move it; the next text consumes
that expectation even when focus fails. Failed edits return a refusal on negotiated sockets.

#### Negotiated owner editing

Android integrations advertise `editing: 1` independently of protocol version 4. A supporting
Host confirms it with `editingVersion: 1` in `host.integrations.display.start`. Without that
confirmation a new phone emits only baseline frames, so it remains readable by an older Host.
Viewers opt in with `?editing=1`. Only opted-in viewers of a capable phone receive
`editingVersion: 1` in `display.state`; baseline sockets keep the baseline wire.
Every authorized shared-input opted-in socket can send `key`, `command`, `edit`, `copy` or text `paste`.
Cut additionally requires integrations `displayCut: 1`, Host confirmation `displayCut: 1` in
`display.start`, and viewer `?editing=1&displayCut=1`. Only their intersection receives
`display.state.displayCut` and may send `cut {contextId}`. Older phones, Hosts and viewers
retain their existing wire. Mac targets never negotiate or forward Cut.
A phone refuses Mac `mouse` input. Independent owner views remain view-only.

A text-bearing key commits its text once on key down. Other keys use Android key events with
modifier state; commands use Android chords (including undo/redo) or the editor's select-all
menu action.
The phone reports `display.input.result` once per batch: `dispatched`, `refused` with a reason,
or `stale`. Dispatch is not evidence that an application accepted the edit. Batches stop at
first refusal; earlier dispatched events are not rolled back or retried.

`edit` verifies its context ID, exact `before`/`after` strings and collapsed caret for range
replacements against `getSurroundingText`, selects the verified range, then commits through
the editor. Focus, selection, input restarts and window changes rotate the editor context;
stale edits rotate it again. `display.editing` contains field kind, multiline/sensitive/input
mode and a normalized picture caret from character locations or node bounds. It contains no
field values, selection text, offsets or surrounding text.

Copy reads only selected non-secret text from that input connection, without reading the
phone clipboard, and returns `display.clipboard` to the initiating controller. Empty, secret,
unsupported and oversized copies have explicit outcomes. Cut checks the context, rechecks the
selected non-secret text on the same bound input connection, and commits an empty string
once over that exact selection. Its private `display.clipboard` result has outcome `cut`;
empty and oversized selections are left untouched. The web viewer arms its clipboard port
from the Cut menu/chord and consumes only the pending controller result. Paste commits literal text, including
newlines and Unicode. The phone transport commits text only; rich paste carries bounded item metadata and is
refused with `unsupported` before uploading image or file bytes.
Undo, redo and the platform's available editing commands remain application-dependent; commands
without an Android equivalent are refused as `unsupported`.

On API 30–32, only refreshed-text insertion and deletion at a collapsed caret are supported.
The accessibility action updates the field and cursor; it is not equivalent to native editor
transactions. Printable key text, Enter and Backspace use that same limited path;
Enter inserts a literal newline, while the separate submit operation invokes the editor action.
Range edits, selected-range changes, other non-text keys, commands, copy and Cut refuse as `unsupported`.
A phone-only password shadow is usable only for a field the owner began empty
in the current lease; unknown nonempty secrets refuse. API 33+ does not fall back to this mode.
The canonical focus resolver admits a unique refreshed focused editable node, including
WebView virtual editors. API 30 WebView focus, short Unicode input, Enter/Backspace and
limited-mode refusals qualify. Its 30,000-unit paste and the sensitive fixture's initial
paste still refuse `unsupported`, so the complete API 30 journey remains failed and its
sensitive Copy/Cut assertions did not run. Native EditText, resource-less EditText and Compose
passed the other limited-mode cases. API 33 and 36 passed the full native editing journey.

The shared transport packs at most 64 events and 256 KiB of serialized UTF-8 per input frame,
including JSON escapes. A text paste event contains at most 30,000 UTF-16 units. It preserves
whole events and order across batches and never replays input after reconnect. The phone bounds
queued owner input to 512 events and 1 MiB of retained input; overflow refuses `too-large`.
Per-viewer diagnostic counters record operation kinds, refusal reasons, context updates and
clipboard outcomes on `computer.display.viewer-removed`, without text, keys or content hashes.

One gesture scheduler serves agent drags and owner pointer streams. It buffers moves for
32–64 ms into approximately 32 ms polyline segments, dispatches one at a time and rechecks
authority in each completion callback. Continuations start at the prior endpoint; stationary
contact stays held. Up includes buffered moves and their elapsed duration (at least 32 ms), preserving release velocity.
Wheel deltas accumulate into 300 ms swipes with a 100 ms still hold before lift, preventing flings.
Every accepted owner message renews the contact watchdog. The wire has no still-pointer keepalive,
so its phone-side bound is five seconds, allowing long-press-then-drag. Lease or stream loss cancels
immediately. Accessibility exposes no cancel operation: [dispatching a fresh stroke](<https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#dispatchGesture(android.accessibilityservice.GestureDescription,android.accessibilityservice.AccessibilityService.GestureResultCallback,android.os.Handler)>) cancels the
continued contact (`ACTION_CANCEL`); the replacement stroke lands outside the display, then lifts,
so neither contact clicks its former target. Cleanup barriers wait for that release to complete.
Gesture callbacks run off the executor; release-only cleanup remains allowed after authority
ends.

## 7. Access and Stop

The owner sets **Off / Can see / Can see and control** from any Opensteer client. Off dispatches
`integration.disconnect {connectionId}`; the other choices dispatch
`integration.computer.setup.set` with
`{kind: "app", definitionId: "android-phone", runnerId, app: null, access: "read" | "read-write"}`.
The session-derived owner may create, widen or lower that phone's connection. Off ends agents'
sessions and the owner's views; lowering to **Can see** ends agents' sessions and keeps the owner's
own view. Old sessions and tickets cannot revive.

An agent's ask for a missing or wider connection creates a pending `computer.app.access` Request
and its linked setup request. It never creates or widens a connection. The owner allows or declines
it from any client; nothing is sent to the phone. Allow uses the owner command above and atomically
settles covered Requests, grants their Workspaces, materializes tools and schedules continuations
once. Requests beyond that access stay pending. If the connection already covers the ask, only an
ordinary `integration.access` Workspace Request is needed.

The Host refuses phone approval-key nomination, Runner-signed phone answers and supplied signed
approvals on phone mutations. Mac signed approvals and automatic app policy keep their own
contract. The migration removes phone approval-key rows and rewrites pending phone Request
presentation for client approval, preserving connections, grants, pending requests and settlement
links. A previously declined phone gains no connection during migration.

The phone's Stop button and notification bind to the session the owner saw. A delayed Stop
for an old holder cannot stop the next task. Stop withdraws that session's running and queued
work at once, and the phone refuses the stopped Run's later sessions. The accepted Stop
captures the holder and the identity's module that admitted it; queued cleanup or a pairing
change cannot discard it or report it through the replacement identity. The phone reports it as
`session.stopped` naming the Run (`runId`) and repeats it on each new stream until the Host
answers `host.integrations.computer-use-stop-recorded` naming that Run and session, after
durably recording the Stop. Unrelated frames and cleanup `close` messages do not acknowledge
it. Until then the Stop is also kept on disk for the identity that accepted it, written before
it is reported, and a write the disk refused is tried again on the next Stop, stream and
status: after the app restarts or the phone reboots, the phone refuses that Run again and
reports the Stop on its next stream. The refusal belongs to that identity: a kept Stop of
another identity is dropped, never replayed, and a new pairing refuses none of the previous
pairing's Runs. The Host retains failed writes for its periodic cleanup, including Stops for
sessions it has already forgotten. A Stop whose Run or computer no longer exists is already in
effect: the Host records nothing and acknowledges it, so it is never retried. It also sends a
matching `close` to drain old queued work so an observe in transit during the Stop cannot
leave an orphaned hold.

## 8. Security boundaries

Use a dedicated phone and accounts: read-write access reaches the whole screen, not a selected
app sandbox. Locking the phone no longer stops agents; Pause and Stop do. A PIN given to an
agent lives in its transcript and, when the person asks it to remember the PIN, its Workspace.
The [skill credential rules](../apps/runner/agent-skills/skills/opensteer-integrations/SKILL.md#boundaries)
limit that exception to the phone's lock screen and one memory file. For saved site
credentials, use [Opensteer Passwords](passwords.md#promise-and-limits): the agent gets
an opaque reference, and Host/Runner/tunnel relay encrypted fields to the phone.
The agent judges the genuine app; Opensteer does not verify its association with the
site. A tricked agent could expose the password. Secure-node observations omit text,
but Android still determines screenshots and an app can display a value as ordinary
text. The own-app action guard (§3) protects the phone's local controls.

The Host resolves scope/access from the connection under admission; agent arguments cannot
choose broader authority. USB setup runs in the renderer with the selected ADB device's full
shell authority. Desktop permits USB only for its trusted main frame and selected devices;
its fixed artifact bridge only reads bounded regular files. The browser fetches the artifact
from its own origin. Either way the shared engine verifies the manifest, size and digest.
The DUMP receiver limits local pairing commands; signed Runner proofs protect Host admission,
and authenticated owner commands decide access (§7).

## 9. Reliability

Keep the phone charging and network-connected. The bound service and battery exemption help
it stay available, but OEM power management can still kill or disable it; check those settings
on real hardware. The runtime holds its partial wake lock while connecting, serving or backing
off (§3), including on battery. A Personal Host must remain awake with remote access on.

| Disruption                                  | Recovery                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wi-Fi change, DNS/TLS/network failure       | Retry with jittered exponential backoff, capped at 30 seconds. A lost act answer stays unknown.                                                                  |
| Host restart or expired lease               | Drop streams/sessions and authenticate again under a fresh fence.                                                                                                |
| Remote access off / route generation change | Retry. Only the Host's explicit refusal reports `remote-access-off`; a failed connection otherwise reports `host-unreachable`.                                   |
| Host origin changes                         | Run USB setup again. It reads the current target and retargets the phone, enrolled or pending, without unpairing or minting again.                               |
| Reboot                                      | With a screen lock, the person must unlock once by hand before Opensteer reconnects. The app is not direct-boot aware. With no lock it can reconnect unattended. |
| Process death                               | Android can rebind the service, rebuilding the runtime from stored identity. OEM disabling of the service requires a person.                                     |
| Accessibility disabled                      | No runtime; re-enable in Android settings and check setup status.                                                                                                |
| Force-stop                                  | Requires a person to reopen/re-enable the app; unattended recovery is not guaranteed.                                                                            |
| Removal from Computers                      | Close 4010 wipes identity/keys; setup is needed to add it again.                                                                                                 |

On Android versions whose [Advanced Protection restricts accessibility to verified tools](https://support.google.com/android/answer/16339980?hl=en),
this service cannot run: it does not declare itself an accessibility tool. This is an Android
restriction, not a reconnect failure.

## 10. Distribution

Setup sideloads the APK over USB. Agent Phone's autonomous screen control conflicts with
[Google Play's AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en),
so it uses this distribution path. The mobile client neither installs nor prompts installation
of Agent Phone.

The [release builder](releases.md) builds one signed APK from frozen
source and records a receipt binding its source revision, version, APK digest and size,
manifest digest and signer. The Mac package and the Host and gateway images carry exactly
those bytes and verify them against the receipt; release verification refuses a missing APK,
a debug build or another signer. The signer's certificate digest is pinned as
`agentPhoneReleaseSignerSha256` from [the shared release pin](../packages/protocol/src/agent-phone-release.json),
used by [`release-agent-phone.cjs`](../scripts/release-agent-phone.cjs) and the Android build;
configuration chooses only where the key is kept. Release builders consume the verified artifact and its receipt hash. Development packages may carry a debug build or none, and the
normal pnpm build does not build the APK. [Build instructions](../apps/agent-phone/README.md)
list debug/release commands and outputs. The artifact manifest caps the APK at 24 MiB and
names its digest, size, package, SDK, version, build type and signing certificate.

`versionName` follows root `package.json`; `versionCode` is
`major * 1,000,000 + minor * 1,000 + patch`, with minor/patch below 1000. Release signing
fails without the required environment inputs and never falls back to the debug key.
The signing key is permanent: Android updates an installed app only from the same signer, so
another signer means uninstalling the app and losing its data. The next USB setup grants
Agent Phone permission to install updates and makes it its own installer of record. Existing
phones need that setup once; later updates preserve app data, pairing and keys in place.

Runner enrollment, authentication and the update channel use proof format 2:
the phone serializes its descriptor once and signs the complete JSON value with
the v2 challenge-bound signature domain. The Host verifies that raw descriptor
before reading its supported advertisements. Proof format is explicit in both
handshake directions and is independent of the integrations protocol (§4) and the client
Host API epoch. A mismatch refuses with an update instruction. **Update pre-v2
phones over USB once** through the existing same-signer setup path; pairing and
identity keys remain installed. A pre-v2 phone cannot fetch its replacement through
the v2 authenticated update channel. Subsequent v2-baseline updates use the network
path below, including when integrations admission refuses an outdated phone.

The phone checks `/internal/v1/runners/agent-phone-update` on its paired Host. Update protocol 1
uses a fresh Runner challenge and the enrolled phone's signature independently of integrations
admission, so an incompatible phone can update without being admitted. A phone older than
the bundled release receives the same outdated refusal even when its integrations protocol is
still compatible, which bypasses the phone’s normal update-check cooldown. Enrollment tokens cannot
download a release. The Host reads only its immutable, startup-verified Web distribution:
release APK, manifest and receipt must agree in size, SHA-256, version and permanent signer.
Development/debug artifacts without a release receipt are never offered. The fixed WebSocket
path transfers bounded 64 KiB chunks with backpressure; no message can choose a download origin
or redirect. The self-hosted gateway and Personal Connect carry the same route.

The phone independently checks the receipt's manifest digest, APK size and digest, package,
newer version code, minimum SDK, nondebuggable flag and actual signing certificate against its
compiled permanent signer. Android's PackageInstaller performs signature verification before
replacing the app. Equal versions are retained and downgrades are refused. The update journal
is committed before installation; per-release attempts are capped at three across process
restarts. A failed check stops that connection with an honest USB recovery line. A normal
reconnect checks at most once per six hours; an outdated refusal bypasses that delay.

On Android 12 and later the installer requests `USER_ACTION_NOT_REQUIRED` and declares
`UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Android still decides whether consent is required;
its target-SDK recency and installer/update-owner rules apply. Setup does not claim Android 14
update ownership: the platform only allows claiming it on initial installation. A different
existing update owner still requires system confirmation, including for a self-update on
Android 16; the pending-user-action path handles it. Android 11 and any required-consent case open the system
Update prompt and keep an update notification. Clients say **Tap Update on <phone name>**;
a silent download/install says **Updating Agent Phone on <phone name>…**. A ten-minute deadline
ends abandoned work. Successful replacement uses `MY_PACKAGE_REPLACED` and Android's enabled
accessibility-service rebinding to reconnect the saved identity; only the live connection clears
the Host's progress. The web page retains **Update over USB** as recovery.

## 11. Verification

Follow the [test design policy](testing.md#how-to-test): use the
cheapest regression check and keep one journey per user-facing flow. The commands
here are available checks, not a requirement to run every device/API/engine
combination before submitting. GitHub `Check` validates pull requests.

For Host display fan-out and teardown, use the module test with real WebSockets
and a fake integrations peer. It does not prove Android encoding or client
decoding:

```sh
pnpm exec vitest run apps/host/src/computer-use/display-stream-hub.test.ts
```

Wire regressions belong in the [TypeScript vectors](../packages/runner-auth/src/agent-phone-vectors.test.ts),
[Host parser](../packages/runner-auth/src/agent-phone-wire.test.ts), Kotlin
`HostFramesTest`/`WireFixtureTest`, or the
[action-schema guard](../tests/computer-use-action-schema.test.ts).
[Enrollment tests](../apps/host/src/runtime/agent-phone-enrollment.integration.test.ts)
cover PostgreSQL admission. The fixture app uses real Android Views and SQLite;
its receipt commands and identity instrumentation live in the
[app README](../apps/agent-phone/README.md#wire-fixtures-and-device-receipts).
Only intentional protocol changes regenerate vectors with
`OPENSTEER_WRITE_AGENT_PHONE_VECTORS=1` or Kotlin fixtures with
`OPENSTEER_WRITE_WIRE_FIXTURE=1`. The Android CI lane runs Gradle lint, JVM tests, debug app/fixture builds,
both fixture directions and TypeScript consumers, rejecting fixture drift. See
[the public CI workflow](../.github/workflows/ci.yml).

Select the existing device file for the affected flow:

| User-facing flow                  | File under `apps/host/src/agent-phone/`                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| USB setup and task control        | `agent-phone.device.test.ts`                                                       |
| Live owner/task display           | `agent-phone-display.device.test.ts`                                               |
| Saved-login delivery              | `agent-phone-passwords.device.test.ts`                                             |
| Real agent unlock/task completion | `agent-phone-agent.device.test.ts`                                                 |
| Network self-update               | `agent-phone-update.device.test.ts` (enable `OPENSTEER_AGENT_PHONE_SELF_UPDATE=1`) |

The same display file has an independent `native phone editing` case for
EditText, resource-less EditText, Compose and WebView. It checks exact text,
replacement/stale refusal, commands, selected copy/Cut, receipts, sensitive refusal
and 30,000-unit paste, with API 30–32 limited-mode refusals. Select the API levels
whose behavior is affected; API 33+ exercises the full editing connection:

```sh
OPENSTEER_AGENT_PHONE_API=33 pnpm test:agent-phone \
  apps/host/src/agent-phone/agent-phone-display.device.test.ts -t 'native phone editing'
```

Reserve one emulator owner at a time. With the SDK and named AVD installed on the
Mac, `pnpm test:agent-phone` starts it headless with `-no-window`; the Mac screen
is untouched. Editing case phases, receipts and screenshots remain in the selected
journey's artifact directory. Unrun, blocked and skipped cases are not passes.

Run one selected file with PostgreSQL, the Android SDK and an AVD named
`opensteer-agent-phone-30`, `opensteer-agent-phone-33` or `opensteer-agent-phone-36`:

```sh
OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone -- apps/host/src/agent-phone/agent-phone.device.test.ts
```

The suite builds a test-CA APK and uses the production setup engine and MCP
gateway against a real Host. Fixture receipts establish Android effects;
module/wire checks handle edge cases. `OPENSTEER_AGENT_PHONE_REBOOTS` defaults
to 1; use 10 for release qualification, not for every local change. The native
[live-display runner](../apps/agent-phone/README.md#live-display-emulator-acceptance)
is a focused encoding/lifecycle check, not another required journey. Pinned
Electron decoding is part of the `remote-input` [VM journey](testing.md#gui-test-vms).

The real-agent file runs when `OPENSTEER_AGENT_PHONE_AGENT_ENGINE` is `claude` or
`codex`, using that engine's sign-in. It requires a non-loopback IPv4 origin
reachable from both emulator and Runner; emulator `10.0.2.2` is not a shared
public origin. An unavailable engine is skipped, not passed. The
[self-update instructions](../apps/agent-phone/README.md#self-update-emulator-journey)
own its baseline APK and explicit-serial setup.

ADB device tests do not verify Electron WebUSB; the `electron`
[VM journey](testing.md#gui-test-vms) runs the Electron selection smoke
(`test:electron-usb`). Without a phone, it only verifies device selection and an immediate answer.
The smoke accepts `OPENSTEER_USB_SMOKE_PHONE_SERIAL` for a task-granted phone
reachable inside its test environment; host USB access is not supplied by this
VM command. Reboot, force-stop, OEM suspension and Advanced Protection behavior still need hardware
checks when those requirements change; this work provisions no hardware.

The long soak is background/release diagnostics, not a submission check. It
starts a Run every five minutes, reboots every two hours and cuts TLS at seeded
intervals. Its hours-long duration needs the stated soak purpose as its budget
exception:

```sh
OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone:soak
```

`OPENSTEER_AGENT_PHONE_SOAK_HOURS` (24),
`OPENSTEER_AGENT_PHONE_SOAK_CYCLE_MINUTES` (5),
`OPENSTEER_AGENT_PHONE_SOAK_REBOOT_HOURS` (2) and
`OPENSTEER_AGENT_PHONE_SOAK_SEED` configure it. Its acceptance remains at least
99% successful scheduled cycles and no duplicate fixture effects; missed cycles
are failures.

Preserve artifacts only for manual acceptance or release checks. Set
`OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR` outside the checkout, separately for each
suite/API/engine because a suite may clear it. Device/soak results include APK
digests, receipts, timings and redacted logs; verify `summary.sha256` with
`shasum -a 256 -c summary.sha256`. Real-agent results use `SHA256SUMS`; redact PIN
digits. These outputs do not require a new artifact for every regression test.

Run device and database suites sequentially. `ANDROID_SERIAL` selects an existing
dedicated device; the suites uninstall packages and change settings. Stop every
emulator, server, capture loop and ADB server the run starts. An explicitly
selected device remains caller-owned.

## Independent owner views

`host.integrations.computer-view` opens, renews or closes an independent, connection-bound
lease for the exact `main` display. These operations carry no Run/session; phone capture
is removed. The shared lifecycle envelope remains version 1, as used by Mac leases; phones
have no owner-view version capability marker. The current signed phone descriptor and
its authenticated runtime encoder status establish support.

The phone measures each bounded `leaseDurationMs` from receipt on its monotonic clock,
with a three-minute maximum. Visible clients renew every 30 seconds. Hiding/unmounting
releases that client's socket and retention; explicit close removes the owner generation
across clients. Expired, revoked or disconnected generations require explicit reopening.
A native monotonic expiry alarm withdraws demand even if the Host is late. Queued pictures
and old command responses cannot revive a removed generation.

Pause and the Opensteer app synchronously close the common publication
gate and reset input. Pause ends the task but preserves an independent unexpired owner
lease; local resume may resume that view with fresh media. Task withdrawal alone never
closes the owner's publication gate. Locked/sleeping screens clear all retained pixels.
Android redacts `FLAG_SECURE` surfaces in MediaProjection; accessibility cannot reliably
identify every secure window. Verify redaction by independently decoding the actual stream.

Expo uses the shared transport with local native H.264 surfaces: AVSampleBufferDisplayLayer
on iOS and MediaCodec/Surface on Android. Both release on visibility/background changes,
acknowledge decode/drop work and clear pending/painted pixels on authority or protection
loss. Expo retains its existing task viewing scope; it has no owner-view launcher.
See [the owner-view contract](computer-use.md#owner-view-wire).
