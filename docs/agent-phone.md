# Agent Phone

Agent Phone is a dedicated Android 11+ phone whose whole display is one computer integration. It is
not the [mobile client](mobile.md), never runs agents and offers no SSH. [Computers](computers.md)
owns membership. Procedures are in the [agent-phone skill](../.agents/skills/agent-phone/SKILL.md).

An Android phone running the mobile client is not an Agent Phone: it declares `device.app:
"opensteer"` in its signed descriptor. The Host retains that identity across reconnects, independent
of live modules. Unmarked Android devices keep the Agent Phone meaning so existing phones need no
update; older descriptor and machine readers ignore the optional marker.

The connection caps Run access; a task cannot widen it. Read-write access reaches
every app and account on the phone, not an app sandbox, so use dedicated hardware and accounts. A
USB phone without Agent Phone stays a peripheral reachable through its attached computer's shell.

## Setup over USB

Setup has the selected ADB device's full shell authority, independent of later grants. Desktop
allows USB only from its trusted main frame and selected devices; browser setup needs Chromium
WebUSB. Desktop shares a local ADB server only when the same computer account owns it, not because
it listens on loopback; otherwise setup opens USB directly. Opensteer never starts, restarts or
kills the person's ADB server. A setup session binds the selected transport and server lifetime and
cannot survive a replug, server replacement or withdrawn USB permission. Trusted ADB keys persist in
the browser profile and may authenticate silently.

OEM builds and device policy can withhold that authority: some OnePlus, OPPO and realme versions
refuse the shell's settings and app-op writes until Developer options → Disable permission
monitoring is on, and Xiaomi needs Install via USB and USB debugging (Security settings). So setup
writes only what does not already hold, which keeps a phone set up before an OEM update passing,
and names those options when Android refuses.

[Setup](../packages/agent-phone-setup/src/setup-agent-phone.ts) verifies the artifact and installed
signer before pairing. A foreign signer needs explicit consent to uninstall and erase app data.
Resolve a usable Host before unpairing; changing Deployments needs confirmation. Retrying setup
must preserve same-Deployment identity and owner-lowered access, and a lost enrollment answer must
reuse its idempotency key.

## Pairing

The owner's Host session supplies the target. On a Personal Deployment that target is the live
remote route, and admission needs remote access on; a phone's loopback is its own. Before sending an
enrollment token, discovery must match the Deployment and Host instance IDs. TLS authenticates the
origin; discovery does **not** verify the authority signature or pin a key. Reconnects skip
discovery; retargeting repeats it. Redirects are refused.

The exported
[setup receiver](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/setup/SetupReceiver.kt)
is protected by DUMP, so shell and system setup reach it and ordinary apps do not. Acceptance means
stored, not enrolled; identity is stored before redemption so a lost answer reuses its key and
token. Status never carries secrets, because Android logs broadcast results.

## The phone app and its Runner

The accessibility service owns the runtime; its partial wake lock keeps the CPU, not the screen,
awake whenever the runtime is not idle. Pause persists across reboot, works offline and withdraws
running and queued task work. The app is not direct-boot aware, so after a locked reboot a person
must unlock once. Android Advanced Protection can prohibit the service because it does not declare
itself an accessibility tool: a platform limit, not a reconnect fault. Only an explicit Host refusal
means remote access is off; a network failure cannot establish that.

The Runner key is the identity, sealed with Android Keystore in no-backup storage and excluded from
backup and extraction. Identity migration keeps keys and pairing; a stale revocation must never
erase a replacement identity. Bare close 4010 wipes identity and keys and stops reconnecting. Carry
server time on a monotonic clock so wall-clock changes cannot move leases. See
[runner](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/runner).

The phone grant is exactly `integrations`; computer presets must not add shell or messaging. The
Host refuses protocol-incompatible phones before registration or enrollment consumption. Bump the
Android integrations protocol in [runner.ts](../packages/protocol/src/runner.ts) for new baseline
operations, newly required observation fields, changed authority or unnegotiated frame changes;
optional extensions negotiate instead.

## The agent contract

[android-phone.ts](../packages/protocol/src/android-phone.ts) owns actions and observations. The
Host derives scope and access from admission, never from agent arguments. One Run attempt holds the
whole display until release, grant withdrawal, disconnect or removal, and a late close must not
affect the next holder. Agents cannot launch or operate Agent Phone's own UI. Actions cite the
latest observation; a new observation, rotation or geometry change makes them stale. Recheck
authority immediately before each mutation, including each scroll step, and never retry a lost
action answer.

Password nodes omit text, descriptions and hints, but that guarantees nothing about pixels or text
an app renders as ordinary content; discard anything collected across a protected interval. A
tricked agent can still type into the wrong app. Saved credentials use
[sealed delivery](passwords.md#sealed-delivery), and the agent must judge the genuine app.

Agents can press keyguard controls and use a person-supplied screen-lock PIN for an authorized
unlock, following [agent guidance](../apps/runner/agent-skills/skills/computer-use/references/phones.md).
A supplied or retained PIN used by an agent enters its transcript. Remembering one requires the
person's explicit request and a private local file outside memory and version control;
team content must not hold it. Android 13+ hides the bouncer from MediaProjection, so agents
may need the person when controls are unavailable. Wake dismisses only
a keyguard that needs no credential. Lock is not Stop.

## The tab

The phone's tab carries no authority and outlives task sessions, because agents release before
replying. Viewing uses its own owner lease rather than extending a task hold. A closed tab or ended
view must not be resurrected by a late response or another viewer's renewal.

## Live display

Upgrade the Host before its phones. Human viewing is H.264, separate from agent screenshots and
observations. Viewing never wakes the phone, keeps the screen on or extends the task hold; explicit
Open arms one wake, and restore or reconnect never rearms it. See
[display-stream.ts](../packages/protocol/src/display-stream.ts) and the
[Host hub](../apps/host/src/computer-use/display-stream-hub.ts).

Every viewer needs an authenticated owner session, effective ownership and current source
authorization. Task viewers also need the exact held session and Run grant; owner views need their
exact lease generation, which expires on the phone's monotonic clock and never survives a
disconnect; a tab in front opens a new generation. Input needs current read-write approval. No frame, ack or old response may renew
authority or revive a removed generation.

Protection closes publication atomically: detach the Surface, retire its encoder and drop queued
media. Pause, Agent Phone in front, sleep and keyguard clear publication and input; lifting
protection needs a fresh generation, and a static start or wake needs a fresh keyframe. Android
redacts FLAG_SECURE surfaces (Agent Phone's own activity sets it) that accessibility cannot always
identify, so check pixels by decoding the stream. MediaProjection uses the setup-granted app op;
never open consent dialogs on demand.

Encode without B-frames or reordering. Joining viewers need a decodable cached picture without
making a still screen stream continuously. The Host caps the shared encoder for slow viewers. Person input
shares one lane across viewers, blocks conflicting agent input while held, never invalidates agent
observations and is never replayed after reconnect.

API 33+ editing binds to one focused editor and verifies the surrounding text before each change,
never rewriting the whole field; API 30–32 allow only insertion and deletion at a collapsed caret.
Copy and Cut read the bound editor, never the phone clipboard, and return text only to the
initiating viewer. Editing metadata and diagnostics carry no values, selections, offsets or hashes.

## Access and Stop

The owner creates, widens, lowers or disables phone access from any client; agents only request it,
and there is no phone-side approval. Allow settles the Requests it covers; wider ones stay pending.
Off ends task sessions and owner views. Lowering to read ends task sessions and withdraws owner
input at once. Old sessions and tickets cannot revive.

Local Stop binds to the holder the person saw, withdraws its work and refuses that Run's later
sessions; a delayed Stop must not hit the next holder. Stop is journaled under the admitting
identity and retried across stream loss and reboot until the Host acknowledges durable recording;
cleanup close is not acknowledgement.

## Distribution

Agent Phone is sideloaded: autonomous control conflicts with Play's AccessibilityService policy. The
permanent signer is pinned in
[agent-phone-release.json](../packages/protocol/src/agent-phone-release.json); changing it means
uninstalling and losing data. Release signing fails closed, and debug artifacts are never offered
for update.

A phone self-updates only when the Host refuses it as incompatible; there are no optional updates
and enrollment tokens cannot download releases. The paired Host serves only its startup-verified
distribution, and the phone independently checks receipt, manifest and APK agreement, package, a
newer version, non-debuggability and the permanent signer
([update](../apps/agent-phone/app/src/main/kotlin/com/opensteer/agentphone/update)). A phone on an
older proof format needs one same-signer USB update. Android still decides install consent, and
waiting for it is not an install failure. Agent Phone's self-update never needs it to be the
installer of record: on Android 12+ an app holding `UPDATE_PACKAGES_WITHOUT_USER_ACTION` may update
itself silently, and
OEMs rewrite that record for USB installs (OnePlus's Android 12 records `pc`), so setup neither sets
nor reads it.

## Verification

Wire and JVM tests cannot prove Android effects; device receipts cannot prove Electron WebUSB;
software-encoder runs prove neither OEM encoding nor client decoding.
