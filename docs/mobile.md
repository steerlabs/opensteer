# Opensteer on a phone

The mobile app is a Deployment client; agent execution stays on computers. A phone may also lend
its in-app browser while foregrounded. It never installs or offers to
install apps, including [Agent Phone](agent-phone.md). Files and terminal stay on web and desktop,
because each would add a protocol and UI to maintain. [Connections](connections.md) owns discovery
and credentials; [Host boundaries](host-boundaries.md) owns compatibility and session authority.
Procedures are in the [mobile skill](../.agents/skills/mobile/SKILL.md).

Saved-password consent and computer app approvals use the person's Host session from any signed-in
device; the native app confirms each password Allow or Only this time, and every saved-card approval, with OS device-owner
authentication, and OS grants still happen on the computer.

## Identity

The iOS bundle ID is `com.opensteer.opensteer` because the App Store binds a listing to its bundle
ID for good, and removing a listing loses the name and the ID. `com.opensteer.mobile` stays the
Android package and the OAuth and deep-link scheme: released Hosts register that scheme, and it cannot
match the desktop's, which is the same string as this bundle ID. The APNs topic is this bundle ID, so
iOS builds under the old ID get no push.

## Attachment and identity

[mobile-client.ts](../apps/mobile/src/client/mobile-client.ts) owns the active personal attachment;
screens never create clients or sockets or read credentials. The phone holds one extra connection
to the team server of the computer it is showing; team chat works while that computer is off.
Switching computers replaces that team attachment rather than accumulating background sockets.
Push can name another computer without attaching it. Links keep Back within the selected computer.

Host OAuth and PersonalRemote credentials have separate parsers and never cross. A stored credential
does not override Host refusal, which stays latched until an attachment uses a new credential.
Non-interactive selection never opens OAuth. An open link
(`com.opensteer.mobile:/open?d=<DeploymentId>`, from a desktop's setup code) names a destination
only: it waits across Account sign-in and selects only that exact entry in the Account's directory.

Sign-out, removal and Account sign-out advance the authorization epoch synchronously, before
awaiting revocation or storage, so a late grant exchange cannot restore credentials, and sign-out
suppression loads before selection is restored. Verify through the resolved route, never a Personal
Host's loopback origin. Unreachable discovery is a connection state, not proof of incompatibility; a
definitive identity or epoch refusal revokes the attachment and fences pending credential reads.

## Drafts and decisions

Drafts and pending sends are scoped by Deployment, user and Thread. Persist the exact command and
idempotency key before dispatch and retry an unknown outcome with that key. Ask puts its page on the
destination draft, never in a route, because routes carry no reader identity and outlive sign-out.
Drafts work offline, but approvals need a live authenticated Host, because replaying a stale
decision is unsafe; only Host state resolves a Request, and sending does not answer one.

Unsent drafts never leave the device: no Host API carries them, so a task begun on a Mac does not
appear on a phone, and each client keeps its own store. A new task's draft has its own id. Attachment staging remains bound to the authenticated personal owner. A route may name that id and nothing else: an
id with no draft behind it is a blank page, so nothing about a draft is readable from an address.

Execution preferences belong to the Host: never silently replace an unavailable model, account or
computer, and a pending execution change blocks Send. A hidden mounted pane neither claims the
active Thread nor marks content read; mark read only published content actually shown. Layout uses
measured geometry, folds and text size, never device names. Integration OAuth's browser return is
only a wake-up: read the attempt back with the same Host credential. Transcript links go through
[transcriptLinks.ts](../packages/shared/src/transcriptLinks.ts) so generated content cannot switch
Deployments. Composer dictation is in [Dictation](dictation.md).

## AI sharing

Mobile asks before sending content or live audio to the AI companies named by the computer's
existing account/model choices, using a generic disclosure for unknown services. Permission is
stored on this device, separately for content and live audio; Settings can clear it for future
sends without stopping work already running. Attachment staging goes only to the person's Host;
on-device dictation and computer-side background work do not pass through this mobile gate. Live
audio names OpenAI alone because voice only runs through Codex, and also needs content permission
because a call can start agent work.

## Saved views

While attachment connects, task views and the sidebar can show the remembered Deployment's
last published task text and subjects, replaced wholesale by the fresh answer. Saved views are presentation
only: they never authenticate, start or replay work, send, answer Requests, mark read, claim the
active Thread or open media, and hold no cursor, Requests, queue, media or capability. An offline
phone cannot learn of a revocation it has not seen.

Saved content is encrypted under a device-only, when-unlocked key separate from credentials.
It lives in purgeable cache, never plaintext persistence or backup. Scope binds the schema, Host
identity, Deployment and current login, using trusted credentials rather than file claims.
Missing keys, corruption or mismatch are cache misses, never grounds to weaken verification.

Sign-out, removal and authority refusal hide content synchronously and erase its key before
revocation. A durable denial marker prevents leftover ciphertext returning across restart when
key deletion fails. If both marker and deletion fail before the app exits, old content can return;
[the cache](../apps/mobile/src/client/saved-view-cache.ts) owns that recovery boundary.

## Lifecycle and viewing

Mobile OSes can kill sockets and suspend network listeners without notification. Foreground must
re-read network state and probe or replace stale connections; background stops refresh and
reconnect timers. Connection reporting follows [Connections](connections.md#what-a-person-is-told).

Media is visibility-bound: release pictures when hidden, backgrounded or no longer authorized.
Native picture credit follows actual transport capacity, not enqueue acceptance. A closed target
never substitutes a sibling. A tab-list row must not start a picture stream, because each stream
costs cellular traffic.

A zero-reorder H.264 stream can still hold a lone or final picture in Android's software decoder;
continuous playback does not prove still-picture delivery. Remote editing follows the
[editing contract](../packages/client/src/editing/README.md).

Expo Go lacks native modules and the OAuth scheme. A JavaScript update cannot add native
capabilities. Keep one native scene lifecycle so links, navigation and drafts have one owner.

## Shared page geometry

A page's size is shared with agents and other viewers. Folding a preview, moving controls or
opening the keyboard must not resize it; only the person's explicit Fit changes its shape.
Watching a streamed preview never takes control.

## Requests

A person only approves what they can see. Allow is available only when the whole request fits;
otherwise require Review. Newly arrived cards ignore taps briefly to prevent an approval under a
thumb already moving elsewhere. High-risk decisions need system confirmation.

Card and sheet share decision identity and idempotency keys, while closing a secret form discards
its values. A live question's answer never joins the message draft. Denial notes are offered only
when the engine can pass them on.

## Phone browser identity

The Android mobile client lends its browser, not the whole device authority of Agent Phone.
Capabilities come from qualification, never device shape or release-build status. A provider that
cannot disable debugging omits agent CDP while retaining independently qualified viewer abilities.
The [phone manager](../apps/mobile/src/phone-browser) owns enrollment and native WebView lifecycle;
viewing another Deployment never retargets its enrolled identity.

Removing the phone or signing out fences admission before erasure. Loaded Android profiles may
need a process restart; pending restart is never completed erasure. Durable retirement prevents
re-enrollment until startup deletes the old stores. Guest uses private disk storage, not RAM-only
browsing, and caches may survive until startup deletion. See
[profile state](browser-sessions.md#profile-state).

Android seals its Ed25519 seed with a Keystore AES-GCM key; this is not a hardware-backed,
non-exportable Ed25519 key. The person's system file picker may survive backgrounding for its
original page; agent-staged choosers cannot.

## This iPhone's apps

While the app is open, an iPhone can serve Calendar, Contacts, Reminders, current Location and
Photos metadata to agents as a local Runner with the integrations module, plus the browser module
once its browser qualifies ([native module](../apps/mobile/modules/iphone-apps/ios)). It exposes no screen, files, other apps
or Messages. The Host decides each app's agent access; iOS separately decides whether Opensteer may
use the store.

The Runner's Ed25519 key and enrollment token live only in the Keychain
(`WhenUnlockedThisDeviceOnly`, not synchronized); JavaScript never sees the key, the token after
enrollment or runner authentication/ticket proofs. Only the scoped session-binding and leave
signatures cross the native bridge; they never expose the signing key. Discovery must name the
same Deployment and Host instance before a token or proof is sent, and redirects are refused. The enrollment marker is excluded from backup;
a missing marker wipes the Keychain items, and removal clears the marker first so a failed Keychain
delete cannot restore sharing.

Only a live stream with an unexpired lease admits work; a write crosses a second fence right before
the EventKit save, and a lost write answer is never replayed. Backgrounding closes admission and
drains admitted work. Switching the viewed Deployment never moves or stops the enrolled iPhone.

Only a person's action prompts for iOS permission or approves agent access. OS permission and
Host approval are separate; neither widens the other. Calendar and Reminders need full access,
Contacts is read-only, Location is When In Use, and Photos returns metadata only. PhotoKit's broad
permission label never authorizes writes or image access.

Enrollment and OS prompts need the iPhone; the owner can approve from any signed-in device.
Read back uncertain approval outcomes rather than submitting again. Lowering or revocation works
while the phone is offline, stops future use and cannot undo returned data.

## This phone as a device

A phone becomes one of a personal Opensteer's devices only through Set up, which follows sign-in
and asks the OS nothing before Continue. Native storage holds one identity, so a phone belongs to
one Opensteer; moving it to another is an explicit leave there, never automatic.

Sign-out is the device's leave. Native admission stops synchronously, before push cleanup or
network work. The signed obligation must reach durable storage before key/profile erasure can
start; a signing or storage failure returns an error and retains the identity in a non-admitting
leave state. Obligations are keyed by runner identity, so moving to another Opensteer cannot replace
an earlier offline leave. Each survives restart until removal is confirmed.

Setup records the Host's advertised `devices-v1` support and pinned route before issuance. New
Hosts receive the prepared runner ID and public key, so signed leave can retire issuance even when
the enrollment response was lost. A never-issued prepared identity needs only local cleanup. On
older Hosts the retained obligation uses authenticated revoke or enrollment retirement; an HTTP
404 never selects that compatibility path and never clears an obligation. The phone binds its
session when the authenticated Host snapshot becomes capable, independently of native timing.

Native storage remembers 4010 removal before erasure, carries its Deployment after enrollment
vanishes, and exposes it before restored attachments may authorize. It stays until Set up again.
Removal drops the local session, saved views and preview keys without another revoke. Losing a
session, including cold-start natural expiry, keeps the identity and requires explicit Sign in
again. A pending or expired enrollment stays unfinished, with resume/remint and cancellation;
it never counts as ready.

## Notifications

Alerts are best effort; conversations are durable. Muting suppresses replies and failures, never
Requests. Off, chosen in setup or by turning every alert off, is a durable preference: the phone
never asks the OS for permission while it holds, and setup's Ready reports permission and
registration as they settled. Provider acceptance proves neither display nor reading, and sent alerts cannot be
recalled.

Phone push needs an Account channel and raw APNs or FCM tokens. The Account gets routing
identifiers, expiry and optional encrypted previews, never plaintext or preview keys: the Host seals
title and body together in a separate envelope for each registered installation. An Account that
predates sealed previews rejects them, and the Host resends the generic alert. Preview keys are
native secure random, one per Deployment. iOS shares them with the notification service extension
through an App Group Keychain group, while credentials keep their private group; Android wraps them
with AndroidKeyStore in `noBackupFilesDir`. Backup-excluded installation markers fence surviving
keys after a reinstall. The extension and Android service authenticate routing and expiry before
decrypting, need no network or JavaScript, and fall back to generic text.

Sign-out erases the local preview key, and Account sign-out withdraws the push device, before
credentials are revoked; a cancelled sign-in keeps the live login and its key. The pinned
`expo-notifications` patch disables Android payload logging in every build. The APNs environment
comes from signing, never a guess. A notification's deep link
([deep-links.ts](../packages/core/src/deep-links.ts)) is the only navigation source and grants no
authority: authenticate and read current state first.
