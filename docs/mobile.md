# Opensteer on a phone

The mobile app is a Deployment client; execution stays on Runners. It never installs or offers to
install apps, including [Agent Phone](agent-phone.md). Files and terminal stay on web and desktop,
because each would add a protocol and UI to maintain. [Connections](connections.md) owns discovery
and credentials; [Host boundaries](host-boundaries.md) owns compatibility and session authority.
Procedures are in the [mobile skill](../.agents/skills/mobile/SKILL.md).

Saved-password consent and computer app approvals use the person's Host session from any signed-in
device; the native app confirms each password Allow or Only this time, and every saved-card approval, with OS device-owner
authentication, and OS grants still happen on the computer.

## Attachment and identity

[mobile-client.ts](../apps/mobile/src/client/mobile-client.ts) owns the one active Host attachment;
screens never create clients or sockets or read credentials. Several Deployment sockets would
multiply reconnect storms and battery use, and push can name a Deployment without attaching it.
Links install the destination's Chat beneath its task so Back cannot cross Hosts.

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

Execution preferences belong to the Host: never silently replace an unavailable model, account or
computer, and a pending execution change blocks Send. A hidden mounted pane neither claims the
active Thread nor marks content read; mark read only published content actually shown. Layout uses
measured geometry, folds and text size, never device names. Integration OAuth's browser return is
only a wake-up: read the attempt back with the same Host credential. Transcript links go through
[transcriptLinks.ts](../packages/shared/src/transcriptLinks.ts) so generated content cannot switch
Deployments. Composer dictation is in [Dictation](dictation.md).

## Saved views

While attachment connects, Chat and the sidebar can show the remembered Deployment's last published
Chat text and task subjects, replaced wholesale by the fresh answer. Saved views are presentation
only: they never authenticate, start or replay work, send, answer Requests, mark read, claim the
active Thread or open media, and hold no cursor, Requests, queue, media or capability. An offline
phone cannot learn of a revocation it has not seen.

Each envelope is AES-256-GCM with a fresh nonce per write, under one device-only, when-unlocked
SecureStore key per Deployment, in a service separate from credentials and without biometric
prompts. Ciphertext lives in `Paths.cache`, which the OS may purge and does not back up; plaintext
is never persisted. The associated data binds schema, Host API epoch, Deployment, Host instance and
key, credential login ID and optional Account identity, built from current credentials and catalog,
never the file ([saved-host-view.ts](../packages/client/src/host/saved-host-view.ts)). Missing keys,
corruption or scope mismatch are cache misses, never grounds to weaken verification or block
attachment.

Sign-out, removal, login replacement and authentication, Workspace or identity refusal hide saved
content synchronously and attempt key erasure before revocation. A content-free `.deny` marker in
document storage, created before the key is deleted and removed only after, turns any leftover
ciphertext into a miss across restarts. Content can return after a restart only if both the marker
and the key deletion fail and the app ends before a retry
([saved-view-cache.ts](../apps/mobile/src/client/saved-view-cache.ts)).

## Lifecycle and viewing

Backgrounding stops refresh and reconnect timers without closing usable sockets; foreground probes
or replaces them, because mobile OSes kill sockets silently. Only AppState `active` is foreground,
and network state is re-read on foreground because Expo gets no listener events while suspended.

Media is visibility-bound: release pictures when hidden, backgrounded or no longer authorized, and
return picture credit even when decoding fails. Routes name exact tabs or owner-view generations; a
closed target stays closed and is never replaced by a sibling. Starting browsers and connecting
Chrome stay on computers.

A zero-reorder H.264 stream does not guarantee immediate Android output: the software AVC decoder
can hold pictures until more input arrives, and
[low-latency decoding](https://source.android.com/docs/core/media/low-latency-media) is optional, so
continuous playback does not qualify a lone or final still picture. Remote editing follows the
[editing contract](../packages/client/src/editing/README.md).

Expo Go lacks the native modules and OAuth scheme, so use a custom client. Face ID confirmation,
native H.264 viewing, Opensteer Apps (`react-native-webview`) and notification previews need a
rebuilt binary; a JavaScript update cannot add them. Expo's generated UIKit scene lifecycle is the
sole startup and link owner, and multiple scenes stay disabled so there is one navigation history
and draft owner.

## This iPhone's apps

While the app is open, an iPhone can serve Calendar, Contacts, Reminders, current Location and
Photos metadata to agents as a local Runner with only the integrations module
([native module](../apps/mobile/modules/iphone-apps/ios)). It exposes no screen, files, other apps
or Messages. The Host decides each app's agent access; iOS separately decides whether Opensteer may
use the store.

The Runner's Ed25519 key and enrollment token live only in the Keychain
(`WhenUnlockedThisDeviceOnly`, not synchronized); JavaScript never sees the key, the token after
enrollment, tickets or signatures. Discovery must name the same Deployment and Host instance before
a token or proof is sent, and redirects are refused. The enrollment marker is excluded from backup;
a missing marker wipes the Keychain items, and removal clears the marker first so a failed Keychain
delete cannot restore sharing.

Only a live stream with an unexpired lease admits work; a write crosses a second fence right before
the EventKit save, and a lost write answer is never replayed. Backgrounding closes admission and
drains admitted work. Sign-out, removal of the enrolled Deployment, Account sign-out and catalog
removal call native disconnect before their first await, and a failed Host revocation cannot undo
that stop. Switching the viewed Deployment never moves or stops the enrolled iPhone.

Only a person's tap prompts or approves. Add lists every app and level it turns on, then enables
them one at a time, so iOS asks about one app at once and a refusal skips only that app. Read OS
permission back before requesting agent access. Calendar and Reminders need full access (add-only is
not enough); Contacts takes full or limited access and is read only. Location is a When In Use fix
labelled precise or approximate. Photos returns metadata only (no image bytes, filenames, EXIF,
coordinates or iCloud downloads), and PhotoKit's broader permission label authorizes no writes.

New setup needs both the installed build's permission and the Host's catalog definition. Any
signed-in device of the owner can approve new access, but enrollment and iOS prompts need the
iPhone. A lost approval answer is read back, never resent. Lowering and revocation need only the
Host and work while the iPhone is offline; they stop new use and cannot undo returned data.

## Notifications

Alerts are best effort; conversations are durable. Muting suppresses replies and failures, never
Requests. Provider acceptance proves neither display nor reading, and sent alerts cannot be
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
