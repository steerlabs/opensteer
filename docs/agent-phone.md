# Agent Phone: an Android phone for agents

Agent Phone is a dedicated Android 11+ phone, not the [mobile client](mobile.md).
Its whole display is one computer integration; it never runs agents or offers SSH.
[Computers](computers.md) owns membership. Procedures live in the
[setup skill](../.agents/skills/setup-agent-phone/SKILL.md),
[build skill](../.agents/skills/build-agent-phone/SKILL.md) and
[test skill](../.agents/skills/test-agent-phone/SKILL.md).

## 1. Model

The connection caps Workspace access. A Workspace grant cannot widen it. Read-write
access reaches every app and account on the phone, not an app sandbox. Use dedicated
hardware and accounts. A USB phone without Agent Phone remains a peripheral reachable
through its attached computer's shell.

## 2. Setup over USB

Setup has the selected ADB device's full shell authority. Desktop permits USB only
from its trusted main frame and selected devices; browser setup needs Chromium WebUSB,
a data cable and USB debugging. Desktop shares an existing local ADB server when it owns
the selected phone; otherwise setup opens USB directly. Browser pages cannot share that
native server.
Trusted ADB keys persist in the browser profile and may authenticate silently.
See [webusb.ts](../packages/agent-phone-setup/src/webusb.ts) and
[desktop USB access](../apps/desktop/src/app/usb-device-access.ts).

[setup-agent-phone.ts](../packages/agent-phone-setup/src/setup-agent-phone.ts) owns the
sequence. Verify artifact bytes before touching the phone and the installed signer
before pairing. Keeping a newer installed version requires the same signer. A foreign
signer requires explicit consent to uninstall and erase app data. Android 11/12 ignore
v3.1-only signing blocks; accept a v2/v3 signature and require every signer to agree.
Android 16 can discard a fresh install's not-yet-installed installer name; repeat the
in-place install when readback requires it. Preserve other accessibility services.

Resolve a usable Host target before unpairing or minting. Another Deployment requires
confirmation to unpair. Retarget a same-Deployment identity, including a pending identity,
without replacing its token or keys. Retry a lost mint answer under the same idempotency
key; retire that slot before advancing it. A replug must not mint duplicate enrollments.
Rerunning setup preserves an existing connection and owner-lowered access.

## 3. The phone app

The accessibility service owns the runtime. Its partial wake lock keeps the CPU awake
while connecting, serving or backing off, including Pause; it does not keep the screen on.
Pause persists across reboot, works offline and withdraws running and queued task work.
Notification permission can hide the status/Stop notification.

The Runner key is the identity. Store it encrypted with Android Keystore in no-backup
storage, excluded from backup and extraction. Identity migration must preserve keys and
pairing; stale revocation must never erase a replacement identity. See
[runner](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/runner).

Agents cannot launch or operate Agent Phone's own foreground UI. Observations retain
foreground identity but expose neither tree nor pixels. Agents may navigate away or wake.
Agents can operate a secure keyguard with observed controls. The live display keeps it
protected: Android 13+ hides the bouncer from MediaProjection, so wake dismisses only a
keyguard that needs no credential and otherwise the person unlocks on the phone. Lock is
not Stop. Any PIN supplied to an agent enters its transcript and, if remembered, the
Workspace; follow the existing
[credential boundaries](../apps/runner/agent-skills/skills/opensteer-integrations/SKILL.md#boundaries).

## 4. The Runner

The phone grant is exactly `integrations`; ordinary computer presets must not add shell
or messaging. Admission still requires Personal remote access. Protocol 4 is the current
phone contract. Runtime encoder availability is authenticated status, not a signed device
presentation field. Phones have no Mac approval key. See
[Runner wire](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/wire/RunnerWire.kt).

An outdated phone is refused before registration or enrollment consumption. Only a fresh
signature from an enrolled identity may mark that machine as needing an update; generation
fencing prevents a delayed refusal overwriting a newer connection. A compatible connection
clears the refusal. The independent authenticated update channel must remain usable when
integrations admission fails.

Carry server time forward using a monotonic clock; wall-clock changes must not alter leases.
A welcome alone must not reset retry backoff. Bare close 4010 revokes identity and keys and
stops reconnecting. Unreadable frames end the attempt, not the runtime; invalid request
parameters refuse only that request. See
[ConnectionPolicy.kt](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/runner/ConnectionPolicy.kt).

## 5. Pairing

The owner-session Host supplies the trusted target. Personal issuance requires its live
remote route. A phone's loopback is its own namespace; ordinary setup needs reachable HTTPS.
Before sending an enrollment token, discovery must match Deployment and Host instance IDs.
TLS authenticates the configured origin; discovery does **not** verify the authority signature
or pin its key/certificate. Reconnects do not repeat discovery; retargeting must.
Release builds trust system CAs and disable redirects.

The DUMP-protected exported receiver admits shell/system setup, not ordinary apps.
Pairing acceptance means stored, not enrolled. Store identity before redemption so a lost
answer reuses its key/token. Never return secrets in status: Android logs broadcast results.
See [SetupReceiver.kt](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/setup/SetupReceiver.kt).

## 6. The agent contract

[android-phone.ts](../packages/protocol/src/android-phone.ts) owns actions and observations;
[control](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/control) owns execution.
The Host derives scope and access from admission, never agent arguments. Reserve the whole
display for one Run attempt; release, grant withdrawal, disconnect and removal end that hold.
A late close must not affect a replacement holder. Owner app inventory needs no grant or
session and must not touch the display, including while paused.

Actions cite the latest observation; starting a new observation invalidates the old one,
even if collection fails. Rotation or geometry change makes actions stale. Observe never
wakes. Password nodes omit text, descriptions and hints; Android still controls screenshot
redaction. Discard anything collected across a protected interval even if protection lifted.

Recheck authority immediately before each mutation, including individual scroll steps and
focus/text/submit changes. Queued time counts against the monotonic request deadline.
Close withdraws work immediately, before executor cleanup. Already dispatched gestures may
finish; lift every held finger. Report partial effects honestly and never retry a lost act
answer. Saved credentials use [sealed delivery](passwords.md#sealed-delivery); the agent
must judge the genuine app, whose association Opensteer cannot verify.

### Live display

Upgrade the Host before its phones. Human viewing uses H.264, independently of agent
screenshots and observation IDs. Viewing never wakes or extends the task hold. Explicit
Open arms one wake on the first authorized attachment; restore, reconnect and foregrounding
never rearm it. Person power controls can wake or lock without a picture. Viewing does not
keep the screen on or undo its timeout. Accepted task-view input extends only its task hold. See [display-stream.ts](../packages/protocol/src/display-stream.ts),
[display](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/display) and
[Host hub](../apps/host/src/computer-use/display-stream-hub.ts).

Both viewer routes require an authenticated owner session, effective ownership of the
computer and current source authorization. Task viewers require the exact held session
and renewable Run grant. Independent owner
views require their exact lease generation. Input additionally requires current read-write
approval and a negotiated input-authorized source; a live read-only lease grants no input
or power authority. Neither authority may
revive or follow a replacement. Demand replaces the authority set; frames/acks cannot renew
it. Task withdrawal removes only task demand; owner closure removes only owner demand.
Phone connection replacement invalidates both. Recheck authority before media delivery.

MediaProjection needs the setup-granted app op; do not open consent dialogs on demand.
Obtain a fresh token per start and create only one VirtualDisplay from it. Replace its
Surface/encoder for a new generation. Attach the initial Surface before finishing the
transparent helper so a static screen composes. A static start or wake needs a fresh
keyframe; cached pixels are not evidence of recovery.

Protection must close publication atomically with enqueueing: detach the Surface, retire
its encoder and discard queued media. Pause, Agent Phone foreground, sleep and keyguard
clear publication and input; protection lift requires a fresh generation. Agent Phone's
main activity also uses FLAG_SECURE. Control and media sockets are unordered: late state
must not blank already-arrived media of the same generation or revive an ended generation.
H.264 must have no B-frames or reordering so clients can display decoded frames immediately.
Backpressure must recover at a keyframe, including on static screens. Negotiated visible
viewers share the slowest viewer's bitrate cap; the phone uses the lower of that cap
and its own estimate. Only a Host cap allows bitrate below the local 1 Mbps floor.
Closing a viewer releases its cap; silent screens do not justify increasing bitrate.
Data-socket failure must not kill the Runner attempt.

Person input shares one lane across viewers and arbitrates with agent gestures. Held keys
or touches block conflicting agent input. Reset is an ordered barrier that releases contacts
and keys before later work. Lock uses the same barrier, drops queued input, and releases
contacts before asking Android to lock. Power receipts survive the protected transition.
Android has no accessibility cancel operation: a fresh stroke
cancels continued contact; release outside the display to avoid an accidental click.
Person input does not invalidate agent observations. Never replay uncertain input after reconnect.
Text edits serialize with agent edits;
stale editing contexts resync instead of retrying mutations.

#### Negotiated owner editing

Editing and Cut negotiate separately across phone, Host and viewer. A new phone without
Host confirmation emits baseline frames; non-opted-in viewers keep the old wire. Mac targets
never negotiate Cut. See [DisplayWire.kt](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/wire/DisplayWire.kt).

Bind API 33+ editing to one uniquely identified focused editor, including virtual editors.
Do not fall back to whole-field rewriting. Context changes invalidate replacements; verify
the exact surrounding text before mutation. Editing metadata must contain no values,
selection text, offsets or surrounding text. Copy/Cut read selected non-secret text from
the bound connection, never the phone clipboard, and return it only to the initiating
controller. Cut must recheck that exact selection before deleting. Rich paste refuses
before image/file upload. Dispatch is not proof the app accepted an edit. Editing diagnostics contain operation
kinds, refusal reasons and counters only, never text, keys or content hashes.

API 30–32 support only refreshed insertion/deletion at a collapsed caret; Enter inserts a
newline and submit is separate. Native commands, range edits, Copy and Cut are unsupported.
A password shadow is valid only for a field begun empty in the current lease; unknown
nonempty secrets refuse. WebView large/sensitive paste remains a platform trap; do not
claim full native editing acceptance from passing other editors.

## 7. Access and Stop

The owner may create, widen, lower or disable phone access from any Opensteer client.
Agents only request it. Allow settles covered Requests/grants and continuations atomically;
wider Requests stay pending. There is no phone-side approval prompt or signed phone answer.
Migration must preserve declines, existing grants and pending settlement links.
See [computer setup](../apps/host/src/computer-apps).

Off ends task sessions and owner views; lowering to read ends task sessions but keeps the
owner view while withdrawing its input immediately. Old sessions/tickets cannot revive. Local Stop binds to the holder the person
saw, withdraws queued/running work, and refuses later sessions from that Run. A delayed Stop
must not hit the next holder. Pause stops task work locally, even offline.

Persist Stop under the admitting identity before reporting it. Retry failed persistence and
reporting across stream loss/reboot until the Host explicitly acknowledges durable recording
for that Run/session; cleanup close is not acknowledgement. Pairing changes must neither
lose an accepted Stop nor replay it under another identity. The Host retries failed writes,
acknowledges already-absent Runs/computers and drains in-flight work with matching close.

## 8. Security boundaries

USB setup is full shell authority, independent of subsequent connection grants.
The Desktop ADB path trusts a server owned by the same computer account, not a loopback
address alone. Setup sessions bind the selected USB transport and server lifetime; they
cannot operate other devices or survive a replug, server replacement or withdrawn USB
permission. Opensteer never starts, restarts or kills the person's ADB server. Artifact
bridges must read bounded regular files; browser artifacts come from the same origin and
all setup paths verify the manifest, size and digest. Signed Runner proofs protect Host
admission; authenticated owner commands authorize phone access.

Secure-node redaction is not a guarantee about screen pixels or text an app renders as
ordinary content. [Passwords](passwords.md#promise-and-limits) owns sealed credential limits.
A tricked agent can still type into the wrong app.

## 9. Reliability

Keep hardware charging and online. OEM power management can disable the service despite
battery exemption. After a locked reboot a person must unlock once: the app is not
direct-boot aware. Force-stop or disabled accessibility can require human reopening/settings.
A Personal Host must remain awake with remote access on. Only explicit Host refusal means
remote access is off; network failure alone cannot establish that.

Android Advanced Protection can prohibit this service because it does not declare itself
an accessibility tool. This is a platform restriction, not a reconnect fault. Hardware checks
remain necessary when changing reboot, OEM suspension or Advanced Protection requirements.

## 10. Distribution

Agent Phone is sideloaded: autonomous control conflicts with Play's AccessibilityService
policy. The mobile client does not install it. Normal pnpm builds do not invoke Gradle.
See [release evidence](releases.md) for release packaging.

The permanent signer is pinned in [agent-phone-release.json](../packages/protocol/src/agent-phone-release.json).
Release signing must fail closed without credentials; changing signer requires uninstalling
and losing data. Desktop and images consume the same verified APK/manifest/receipt bytes.
Debug artifacts must never be offered through the release update channel.

Proof format 2 signs the complete serialized descriptor before capability interpretation;
it is independent of integrations protocol and Host API epoch. Pre-v2 phones need one
same-signer USB update: they cannot authenticate to the v2 update channel. Preserve their
pairing and keys, including identity-v1 migration. Later enrolled phones can update even
when integrations refuses them; enrollment tokens cannot download releases.

The paired Host serves only its immutable startup-verified distribution, with no selectable
origin or redirect. The phone independently verifies receipt/manifest/APK agreement,
package, SDK, newer version, nondebuggability and actual permanent signer; Android verifies
replacement signatures. Journal attempts before install and bound retries across restarts.
Equal versions remain installed; downgrades refuse. A committed Android install session
outlives a network attempt; waiting for the person's confirmation is not an install failure.
Pending consent keeps the phone retrying its update status without admitting the old app.
An Android result wakes that loop; declining consent does not consume a failed-install attempt. See
[update](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/update).

USB setup grants install permission and records self as installer, including retained
builds. Android still decides consent: Android 11 needs a system Update prompt, and Android
12+ silent requests may also need consent. Setup cannot claim Android 14 update ownership
on an existing install; another update owner can force consent even on Android 16. Preserve
the pending-user-action path and USB recovery. Only a live reconnection clears Host progress.

## 11. Verification

Use the [test-agent-phone skill](../.agents/skills/test-agent-phone/SKILL.md).
Wire/JVM tests cannot prove Android effects; receipt-backed device tests cannot prove
Electron WebUSB. Native software-encoder measurements do not prove OEM encoding or client
decoding. Electron GUI journeys belong in the [VM](testing.md#gui-test-vms).

## Independent owner views

Owner lifecycle retains its version-1 envelope. Phone owner input and power negotiate
`phoneOwnerControl: 1` independently across producer, Host and viewer. Unconfirmed peers
keep baseline task envelopes and owner views remain view-only. Demand carries write
authority separately from viewing authority; the phone rechecks both before each effect.
Owner leases are connection-bound and expire on the phone's monotonic clock even if the
Host is late. No frame or old response may revive a removed generation. Disconnect/restart
requires explicit reopening. Pause closes publication and task work but preserves an
unexpired owner lease; local resume can restore it with fresh media.

Android redacts FLAG_SECURE surfaces; accessibility cannot identify every secure window.
Verify actual stream pixels by independent decoding. Native viewers must clear queued and
painted pixels on protection/authority loss and release on hide/background. See
[owner-view wire](computer-use.md#owner-view-wire).
