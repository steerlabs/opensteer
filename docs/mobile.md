# Opensteer on a phone

## Scope and authority

The mobile app is a Deployment client; execution stays on Runners. It never installs
or offers to install apps, including the separate [Agent Phone](agent-phone.md).
Files and terminal remain web/desktop surfaces because each adds a protocol and UI
to maintain. [Connections](connections.md) owns discovery and credentials;
[Host boundaries](host-boundaries.md) owns compatibility and machine-local authority.

A phone always resolves with a null local runtime. It cannot exercise the computer's
owner arm. Mac app approval and saved-password approval happen on the named Mac;
the phone may decline, narrow access or stop use, but cannot register that Mac's
approval key. Agent Phone access follows [its owner contract](agent-phone.md#7-access-and-stop).

## Attachment and identity

`apps/mobile/src/client/mobile-client.ts` owns one active Host attachment. Switching
selection disposes the old client before creating another and fences asynchronous
results by generation. Screens never create clients, sockets or read credentials.
Multiple Deployment sockets would multiply reconnect storms and battery use; push
can name a Deployment without keeping it attached.

Selection is persistent context. Switching clears the previous Deployment's screens;
links install the destination's Chat beneath its task so Back cannot cross Hosts.
An explicitly cleared selection is distinct from a missing preference. Sign-out
retains context; removal clears it. Startup waits for local hydration, not remote
verification. `apps/mobile/src/navigation.tsx` and `src/client/selection-file.ts`
(relative to `apps/mobile`) own navigation and selection.

Credentials never cross families: Host OAuth and PersonalRemote sessions have
separate parsers. A locally stored credential does not override Host refusal.
Authentication refusal stays latched until a replacement attachment uses the new
credential. Non-interactive selection never opens OAuth; a row tap can do so only
after verification of that exact selection and attachment.

Sign-out, removal, Account sign-out and disposal synchronously advance the
authorization epoch before awaiting revocation or storage. A late grant exchange
cannot restore credentials. Persisted sign-out suppression loads before selection
restoration, so restart and reconciliation cannot undo sign-out.

Verify through the resolved route, never a Personal Host's canonical loopback
origin. Unreachable discovery is a connection state, not proof of incompatibility.
A definitive identity or epoch refusal revokes the current attachment, closes its
sockets and fences HTTP/socket authorization, including pending credential reads.
Keep selection and the repair verdict visible. Reattachment verifies before
credentials flow; stale results cannot revoke a newer selection or attachment.
When discovery changes the capture agreement, retained browser viewers resubscribe,
including viewers reconnected before discovery finished.
See `apps/mobile/src/client/host-port.ts` and `mobile-client.ts`.

The phone enables Home prefetch through the shared hydration owner. Activation
joins that read; prefetch never claims Chat or marks it read, including under the
sidebar. Shared snapshot/history compatibility belongs to [Connections](connections.md).

## Drafts, decisions and visibility

Drafts and pending sends are scoped by Deployment, authenticated user and Thread.
Persist the exact command and idempotency key before dispatch; retry an unknown
outcome with that key. Acknowledgement clears only its command. Multiple mounted
views share draft and delivery ownership; late uploads cannot restore removed files.
New-task creation and its first message keep their keys across navigation and lost
answers. Leaving an unsent task creates nothing. See `apps/mobile/src/thread/first-message.tsx`
and the draft stores under `apps/mobile/src/thread`.

Never read ownerless legacy drafts into a signed-in user's draft. Migration of a
saved approval-plus-send drops the decision and preserves the unsent message,
files and quote. Sending does not answer a Request. Offline drafts are editable;
approvals require a live authenticated Host because replaying a stale decision
is unsafe. Only Host state resolves a Request, not local command admission.

Execution preferences belong to the Host. Never silently replace an unavailable
model, account or computer. A pending execution change blocks Send. A first-message
send waiting for an AI choice may proceed only from the Host-confirmed choice of
that picker visit; dismissal cancels it. See `apps/mobile/src/thread/thread-mutation-registry.ts`
and [Agent orchestration](agent-orchestration.md) for queue authority.

Keep Chat mounted across task navigation and adaptive layouts. A hidden mounted
Chat neither claims the active Thread nor marks content read; an overlaid sidebar
also makes Chat unread. Mark only published content actually shown at latest.
Layout changes preserve drafts, scroll, streams and navigation. Use measured pane
geometry, reserved folds and text size, not device names; cancel a pointer gesture
if its target geometry changes. Room alone decides whether the sidebar docks,
but a page and Thread pair uses both panes without a sidebar: never three panes.
Sources: `apps/mobile/src/layout.ts`, `src/sidebar` and
`src/screens/workspace-browser*`.

Integration OAuth browser return is only a wake-up: read the durable attempt back
with the same Host credential. Transcript links use
`packages/shared/src/transcriptLinks.ts` so generated content cannot switch Deployments.

### Message dictation

On supported iOS 26+ hardware, the composer offers on-device dictation beside
Attach; Android and unsupported iOS devices hide the mic. Audio stays in native
memory. Send finishes recognition before delivering, typing keeps the displayed
edit, and leaving saves the words into the original draft. See
[Dictation](dictation.md#iphone).

## Saved views

Saved views contain private Chat/task text and are presentation only. They must
never authenticate, start or replay work, send messages, answer Requests, mark
content read, claim the active Thread or start media/input sessions. Live Host
state remains authoritative. An offline phone cannot learn of a server revocation it
has not observed.

Encrypt cached content with native AES-256-GCM and a fresh nonce per write. Keep
one device-only, when-unlocked SecureStore key slot per Deployment, in a separate
service from credentials, without biometric prompts. Ciphertext lives in the
OS-purgeable cache, excluded from backup; never persist plaintext. Authenticate
schema, Host API epoch, Deployment/Host instance/key identity, credential login ID
and optional Account issuer, subject and login ID as associated data. Construct
that expected scope from current credentials/catalog, never from the file.
Missing or locked keys, unavailable native crypto, corruption or scope mismatch
are cache misses, not grounds to weaken verification or block attachment.

Login identity follows the credential: interactive login, pairing and Connect
exchange mint a new ID; token refresh and pending-write retry preserve it. Legacy
credentials gain an ID only after current authenticated bootstrap, serialized by
the credential owner. Changed login IDs replace even a healthy attachment. If
cache identity cannot be read, disable caching for that attempt and attach normally.

Keep keys and ciphertext bounded even after OS cache purges or interrupted first
writes: record key ownership in secure storage before a key can exist, and evict
by that ownership. Journal replacement and fence every asynchronous read/write
against current scope; no await may separate the last lease check from native
atomic commit. Sources: `apps/mobile/src/platform/saved-host-view-store.ts`,
`saved-view-keys.ts`, `saved-view-crypto.ts` and
`packages/client/src/host/saved-host-view.ts`.

### Saved launch views

After local hydration, Chat and the sidebar can show the remembered Deployment's
last published Chat text and task subjects while attachment connects in parallel.

- Each surface says "Updating…", or "Offline · Saved view" / "Unavailable · Saved
  view" from real connection evidence, and switches wholesale when its fresh
  answer arrives, including an empty one. A late disk answer never replaces a
  fresh surface.
- Saved text and task rows offer no actions, media, links, read marks or
  attention counts, and Tabs are live-only. Live task state and attention counts
  come only from the attached Host underneath. A held first-message draft stays
  in front once its live owner is known.
- The load starts alongside attachment, only after local selection, credentials
  and sign-out suppression settle. Readiness follows accepted task/read-state
  installation and an explicit Home answer; connection or prefetch start alone is
  not readiness. Home's initial read starts even while saved Chat is in front.
- Capture debounces installed models for two seconds and flushes best-effort on
  background; it starts no reads of its own. It keeps only published Chat text and
  bounded historical task subjects and groups: no cursor, Requests, queue,
  streams, media or capability. A killed flush can leave an older view. Each
  Deployment holds one encrypted envelope of at most 1 MiB under `Paths.cache`.
- Native linking and OS backup/device-transfer protection need separate device
  qualification; unit tests with Node AES-GCM qualify adapter logic only.

### Saved-view deletion

One deletion owner serves credential lifecycle and presentation. Sign-out,
removal, login replacement, authentication/Workspace refusal and definitive
identity/epoch denial synchronously hide saved content and fence pending reads
and writes. Attempt key erasure before asynchronous revocation or credential
cleanup; relevant Account sign-out invalidates its Deployments too. A failed
Personal sign-out/removal retains its credential and live attachment, but cannot
restore the erased saved view. Fresh authenticated models may capture again only
after cleanup, never reload the refused disk content.

Before key deletion, exclusively create a content-free `.deny` marker in private
document storage, independent of SecureStore and the evictable ciphertext cache.
Any marker, including an interrupted creation, means cache miss and deletion retry
across restart; unreadable denial state also denies cached content. Remove the
marker only after successful key deletion. If marker creation fails, still attempt
key erasure, keep memory blocked, report cleanup failure and retry on foreground.
Content can resurface after restart only if both marker creation and secure key
deletion fail and the app terminates before a retry succeeds. See
`apps/mobile/src/client/saved-view-cache.ts` and its tests.

## Lifecycle and viewing

Backgrounding stops refresh/reconnect timers rather than proactively closing
otherwise usable control sockets. Foreground probes or replaces them under
`packages/client/src/host/lifecycle.ts`; mobile OSes can silently kill sockets.
Every network notification invalidates channels even if both networks are online,
except repeated offline. Re-read network state on foreground because Expo receives
no listener events while suspended. Only AppState `active` is foreground.
Resubscribe from the retained cursor; only Host resync-required resets it.

Media retention is visibility-bound. Release browser picture channels when hidden
or backgrounded. Clear displayed and decoding computer pictures on inactivity,
locked/minimized/closed capture, unavailable phone display or lost access. Return
picture credit even on decode failure, discarded slots or navigation before a callback.
See `apps/mobile/src/browser` and `src/computers`.

Routes select exact tabs or exact owner-view IDs and generations. Closed targets
stay closed; never substitute a sibling or a task holding the same app. How a tab
was reached changes only where Back goes. Who is in it comes from its occupants,
never the route or the screen in front. Where two panes fit, the occupant's own
Thread sits beside the page. Owner metadata does not advance Workspace event
cursors or enter conversation context.
Saved tabs restore through the shared activation owner; a late result after leaving
or switching users must not navigate. Older Hosts retain the live-session listing
path. The phone can open Agent Phone owner views, view existing Mac owner views and manage
connected Chrome profiles; opening Mac owner views, starting browsers and connecting
Chrome stay on computers. See `surfaceRoute`,
`workspaceRoute` and `placeList` in `packages/client/src/host`.

Native decoder epochs clear old pixels and queued output before a replacement
target appears. Same-source recovery may keep its picture; static age alone is not
failure. Suspended capture clears it until lifecycle permits restoration. Task
Watch follows the agent's window; an owner view binds its own window. Follow the
shared [window-group rules](computer-use.md#2-the-helper). iOS Mac window video is
disabled pending native qualification; Android retains native decoding. Bundle
exports do not qualify playback. Native H.264 viewing requires a matching binary.
JavaScript sends media bytes, and draws browser pictures in the native view,
only when the binary declares `binaryPresentationVersion`; an update running on
an older binary keeps base64 decoding and Image data URIs.
A zero-reorder H.264 stream does not guarantee immediate Android output: the
platform software AVC decoder can retain pictures until more input arrives, and
[low-latency decoding](https://source.android.com/docs/core/media/low-latency-media)
is optional. Continuous playback therefore does not qualify a lone or final still
picture.

Human and agent browser input remain concurrent; viewing scales a page, and only
explicit Fit page resizes it. Dialog responses bind to the exact tab and dialog.
Native editing needs a rebuilt custom client; its [adapter contract](../apps/mobile/modules/remote-text-input/README.md)
owns composition and device qualification.

### This iPhone's apps

[iPhone apps](iphone-apps.md) owns the native executor and privacy boundary.
`apps/mobile/src/iphone-apps/controller.ts` is instantiated once. Switching the
viewed Deployment changes the usable session, never moves or stops the enrolled iPhone.

Sign-out/removal of the enrolled Deployment, relevant Account sign-out and catalog
removal call native disconnect synchronously before their first await. Host
revocation follows while credentials remain; failure cannot undo the local stop.
Every add, approval and registration is fenced across awaits. Enrollment requires
Host support and cannot move a phone held by another Deployment.

Only a person's tap may prompt or sign: an app's switch or level, a request's
Allow, or Add. Add lists every app and level it turns on, so its tap is their
review; it turns them on one at a time, so iOS asks about one app at once, each
request is signed alone, and a refusal skips only that app. Switches on the add
screen are a draft until Add. Read iOS permission back before requesting or signing. Calendar add-only is
insufficient; limited Contacts/Photos are sufficient, and picker dismissal is not
refusal. Sign only the exact currently listed request, app and access.

New setup requires both the installed permission capability and Host catalog
definition before prompting. For an existing Location/Photos request, a known
missing Host definition also stops prompting. If another Deployment is open or
catalog lookup fails, the native request remains answerable: rollback may cause
one person-triggered prompt before Host refusal, but grants no access.

Location and Photos are read only. Explain Allow Once expiry and approximate
Location. PhotoKit's broader permission label does not authorize writes or image
transfer; send photos through chat attachments.

Lost approval answers are read back, never blindly signed again. Keep existing
access during expansion. Unknown status stays unverified; reconnect checks without
signing. Usability requires Host access, OS permission and a live connection.
Narrowing/revocation needs only the Host and works while the iPhone is offline;
it stops new use, never promises to undo returned data or completed changes.

## Native compatibility

Keep Expo's generated UIKit scene lifecycle as the sole startup/link owner. The
iOS 27 SDK requires it; multiple scenes are disabled to preserve one navigation
history and draft owner. Generated `ios/` and `android/` are not tracked.
Expo Go cannot provide the native modules or OAuth scheme; use a custom client.
`apps/mobile/app.config.ts` owns configuration. Build instructions are in
[the mobile README](../apps/mobile/README.md).

## 6. Notifications

Alerts are best effort; conversations are durable. Direct replies, waiting Requests,
failures and explicitly addressed agent messages use the existing notification path.
Muting suppresses replies/failures, never Requests. Provider acceptance proves
neither display nor reading; queued and delivered alerts cannot be recalled.

Phone push requires an Account channel and raw APNs/FCM tokens. The Account gets
routing identifiers and expiry, plus optional encrypted preview envelopes. The Host
seals its already-decided title/body independently for each registered installation;
the Account never receives plaintext or preview keys. Account readers must deploy
before rebuilt phones register keys (see
[Active compatibility gates](host-boundaries.md#active-compatibility-gates)). Older phones/Hosts retain generic alerts.

A rebuilt phone registers only after authenticated attachment, Host capability
`notification-preview-v1`, native version 1 and successful Account push registration.
It reuses PushRegistration's installation identity without delaying attachment.
Keys are native secure random, one per Deployment, persisted before registration.
iOS shares preview keys with the notification service extension through the App
Group Keychain access group; ordinary credentials retain their private access group.
Android wraps key records with AndroidKeyStore in noBackupFilesDir. Backup-excluded
installation markers fence surviving keys after reinstall; launch purges stale keys.
Sign-out fences registration and erases the local key before revoking credentials;
starting a sign-in does not, so a cancelled flow keeps the live login and its key.
Host keys die with the Host login session through cascading deletion; Account
sign-out withdraws the push device. Erasure failure does not stop session revocation.

The iOS extension and Android service authenticate routing and expiry before local
decryption. They need no network or background JavaScript. Failure leaves generic
text. Expo owns Android foreground presentation, responses and dismissal; notification
identifiers use deploymentId:notificationId, with notifications stacked in their
Thread group. Payload logging is
disabled in the pinned Expo dependency in every build.

Keep the last confirmed Account registration after refusal so sign-out can withdraw
it. Account withdrawal precedes credential revocation. Re-register on foreground
for provider recovery. APNs environment comes from signing, never a guessed default.
Both iOS targets need the App Group in their provisioning profiles; see
[push verification](../.agents/skills/test-mobile-push/SKILL.md). Signed delivery,
first-unlock behavior and reinstall acceptance require Tim's device workflow.

Notification deepLink is the sole navigation source, parsed by
`packages/core/src/deep-links.ts`. It grants no authority: authenticate and read
current state first. Suppress presentation only for a recognized destination
already being read; unknown payloads remain visible.
