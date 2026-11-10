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

Unsent drafts never leave the device: no Host API carries them, so a task begun on a Mac does not
appear on a phone, and each client keeps its own store. A new task's draft has its own id, and its
Workspace is a field that can change. Changing it must stage the draft's files again, because the
Host refuses attachments held in another Workspace. A route may name that id and nothing else: an
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
[The connection pill](../apps/mobile/src/ui/connection-pill.tsx) is the only place a Host connection
is said, so no screen adds its own line ([what a person is told](connections.md#what-a-person-is-told)).

Media is visibility-bound: release pictures when hidden, backgrounded or no longer authorized, and
return picture credit even when decoding fails. Routes name exact tabs or owner-view generations; a
closed target stays closed and is never replaced by a sibling. Connecting Chrome stays on computers.

A phone the Host lists as a browser device of the Deployment being viewed opens a conversation's
links in its own browser, in the profile last used on it, else a Guest there; loopback,
private-network, `.local` and bare-host addresses mean the computer's network and open on the
conversation's computer ([link-places.ts](../packages/client/src/host/link-places.ts)). If opening
there fails, the link goes to the system as before, which is also where every link goes on a phone
that is not such a device. New tab offers every profile, and a profile opens on its home.

A tab list shows a page's picture only when this phone already presented one
([browser-last-picture.ts](../packages/client/src/host/browser-last-picture.ts)); a row never asks
for one, because each would cost a stream on cellular. A kept picture is dropped when its tab
closes or loads another page, so it never shows a page the tab no longer has.

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

## The conversation bar

The bar stays: Menu carries the "Needs you" badge, and a transparent bar costs no height, so removing
it would win back about 44 points at the price of the way out of a task. Liquid Glass draws the title
as a capsule beside the bar's other capsules. Material's app bars are full width and its floating
toolbars hold actions, so Android keeps a title and status line, as does earlier iOS, and paints the
bar solid because it has no blur to separate it from text scrolling beneath.

A custom title stays in the bar's row even where iPhone Duo moves bar items into its vertical bar.
iOS draws it in a slot react-native-screens sizes from the bar's margins, and a title wider than its
slot spills past both sides. Our [patch](../patches/react-native-screens@4.30.0.patch) counts a side's
safe area once and leaves out a Back button the vertical bar holds; unpatched, the slot is about 130
points narrower than the room [bar-title.ts](../apps/mobile/src/ui/bar-title.ts) gives a title, and in
Split View the title runs under the status bar.

Every title opens a menu, so a capsule is never a button that does nothing. Android's menu has no
header slot, which is why its status line can't move into the menu as Liquid Glass's does. Beside a
page there is no title menu, so the composer's menu carries Find and Copy thread link there.

## The page bar

A tab, Mac app or phone has one bar, its own, and no native bar above it. The conversation bar's
argument doesn't carry over: a transcript scrolls under a transparent bar, but a streamed page can't
leave room for chrome it doesn't know about, so a native bar's row always costs a page its height,
and its title only repeated the address. [The bar](../apps/mobile/src/browser/toolbar.tsx) never
floats over a streamed page either, for the same reason.

A page on this phone can leave room, so there it behaves as the platform's browser does: the bar,
status row and call dock float over the page, and the bar shrinks to a pill while the person reads
down and returns as they head back or reach either end. The page is told which edges they cover,
once, at their whole height; it never changes size as the bar moves, because a resize would reflow
it under the finger, advance its geometry revision and change the picture other devices watch.
WebKit takes those edges as obscured insets, so the page scrolls under the bar. Android's WebView
has no such inset and ignores system-bar insets for `env(safe-area-inset-*)`, so there the page's
viewport ends where the controls begin: what a page pins to its foot stays clear of them, at the
cost of not scrolling under the shrunk pill. The shrink is decided on the UI thread from the page's
own scroll ([floating-bar.ts](../apps/mobile/src/browser/floating-bar.ts)), and only the person's
own scrolling moves it. Beside its conversation, and on a tall regular screen, the bar stands
still, as Safari's does on iPad. Back goes through the page while it has history and leaves the tab
once it has none: an edge swipe on iPhone, the system Back on Android. Pull to refresh reloads
through the same native navigation as Reload. A held link or image gets WebKit's menu on iPhone and
the platform's context menu on Android, which offers copy, share and the system browser; opening it
in a new tab needs the Host and is not offered there yet.

The native bar is put away only by a view that draws its own, so a state with none, such as an ended
tab, keeps the native Back and can always be left. An Opensteer App keeps the native bar: it has no
bar of its own, and it can run under one.

iPhone Duo's vertical bar is already paid for, so Back and Ask stand in it as native items and leave
the page's bar room for the address. Hiding the native bar would lose them; a transparent bar with no
title keeps them, and costs the page 24 points at its top where hiding costs none. The screen finds
the vertical bar by its one-sided safe area, a notch's being two-sided, measured above the panes
because a pane beside another has one-sided insets of its own.

On a phone the bar's one chevron is the way out, and the page's Back sits in More beside Forward:
two identical chevrons in one row read as one control, and the address needs the room. A cut-off
site name is the worst thing the bar can show, so the capsule holds only the site and, when the tab
runs on another device than this one (`deviceElsewhere`), that device's shape, whose name is a tap
away. Where the page is wide, Back and Forward stand in the capsule, as Safari's do on iPad. Fit
never happens by itself: a page's size is shared with agents and other screens, so a tab keeps its
shape until the person chooses Fit.

A place opened from a conversation says at its foot what that conversation is doing, with its
Stop, or that it needs the person, with Answer, which goes back to the conversation's own dock.
It speaks for that conversation only, not for whoever ranks first in the place, and not at all
where the conversation is already beside the page. The page eases into the room the row leaves
rather than running under it, and a call's bar docks over the place's bar for the same reason.

## The page above a conversation

While a conversation's own Run works in a place, the page stands under the bar and folds into a
small picture beside Around ([rule](../packages/client/src/host/run-page.ts)). Open or folded is
presentation, held in memory per conversation and never in a route, so Back and links stay one
navigation model. It takes the page's own shape and never resizes the page, for the reason Fit never
happens by itself, and takes at most half the room between the bar and the dock, so a docked
Request or the keyboard folds it rather than crowding the conversation. A streamed page only
watches: a tap opens the full tab. Until a picture arrives it is a named row, because a kept
picture must never stand for the page as it is now. Phone-width web (700px and narrower) follows the
same rules with the page under the conversation header, folding into the header's picture; under
another page the picture stands in the sheet's handle and opens the full tab. Wider web has only the
header picture, which opens the place in the middle.

## The sidebar's ends

A safe area says an edge is reserved, not that something stands over all of it. iPhone Duo's inner
screen reserves 82 points across its top with its status items at the far end, so the drawer's head
[rises into that band](../apps/mobile/src/layout.ts), level with Menu, rather than leaving it empty.
The band is told from a status bar by height: an iPhone Air's 68 points have the clock over the
drawer, and reserved regions report a camera or a bar but never a clock. The regions they do report
still push the head down, because the simulator can't unfold from the command line to prove this
screen's camera clear.

At the bottom, iOS's 34 points are mostly empty around a thin indicator, so the foot keeps 20 of them.
Android's inset can hold its navigation buttons, so it keeps all of it.

## Messages

Chat takes its shapes from Messages: bubbles with nothing on them, held to act on. A task doesn't,
because long Markdown needs the full width, so an agent's words stay bare there with their copy mark
and menu under them. Holding a task's words has to stay free to select them. Report stays on
everything an agent wrote, in both places, including a reply with no words.

A bubble's words can't be `selectable`: the system's selection answers the same hold and puts its
own Copy over the menu. Select opens them in a sheet instead.

The hold is `modules/context-menu`, a plain UIKit container around `UIContextMenuInteraction`, so
iOS draws the lift and menu with no JavaScript running. `@expo/ui`'s `ContextMenu` hosts each row in
SwiftUI, which sizes it a layout pass late, so the rows under it overlap. Android mounts its Material
menu only while held, because a native host per row is paid for by every bubble in a long Thread.

Markdown comes from web's parser, through [markdownParser.ts](../packages/shared/src/markdownParser.ts),
so a reply reads the same on every client. Parsing is the dear part of drawing a row on Hermes, so
finished blocks stay cached across the rows a list unmounts.

## Requests

A person only approves what they can see. Allow stands on the card only while the whole request
fits; past that the card clips and its answer is Review. A card that has just arrived ignores taps
for a moment, because it appears above the composer under a thumb on its way somewhere else, and an
approval can't be taken back. High risk always goes through the system's own confirmation.

The card keeps the composer's corner, margins and control sizes, so they read as one family. Answers
are pills drawn inside full touch targets rather than larger slabs.

The sheet is a route because it uses the same native detents as the Model picker, so the card and
the sheet can't share React state: [request-session.ts](../apps/mobile/src/thread/request-session.ts)
holds what's been answered and the idempotency keys across them. A form with a secret field keeps
none of that, so a secret goes when its sheet closes. The form's Send is in a sticky bar because a
pinned footer needs a single detent, and only a long approval pins its answers.

One open question a live Run is holding on is typed in the composer, whose words never join the
Thread's draft. A durable Request leaves the field to messages. "Say why" is offered only for engines
that pass a denial note on: ACP has no field for one, so the words would be dropped without saying.

## The call bar

The bar floats at the app's root, so an iOS sheet covers it while open. `FullWindowOverlay` would
keep it on top, but a window-level view has no view controller, so a sheet opened from it, such as
an integration's review, couldn't present and the person couldn't approve. Android moves the bar with `Keyboard` events
rather than `useAnimatedKeyboard`, which clears the decor insets listener on exit and leaves form
sheets without keyboard handling.

## Phone browser identity

Android's everyday app lends only its browser, not the screen or integrations of the separate
Agent Phone app. Its phone enrollment grant still includes `browser, integrations`; advertising
only browser does not broaden that grant. Enrollment tokens are minted and redeemed natively.
Settings adds it as “This phone” through the same enrollment flow as iPhone. A phone's own page
shows the browser and apps the Host lists it advertising, never what its platform implies; the
platform only names it. The shared phone
manager joins its native connection and WebView pool; viewing another Deployment does not retarget
the enrolled identity. Native registration and pending erasure finish before identity preparation,
and the connection advertises only after the WebView's qualification completes.
Debug builds and providers that keep web debugging reachable can still offer the browser, pictures,
basic input and staged files when those checks pass. They omit agent CDP rather than disabling the
whole browser. A release build alone does not prove that debugging can be disabled.
To support Android 24 and later, a Keystore AES-GCM key seals the native Ed25519 seed in
no-backup storage; this is not a hardware-backed, non-exportable Ed25519 key.
Removing the phone or signing out fences admission before erasure. A durable denial marker keeps
its enrollment unusable until all that Deployment's profiles are physically deleted, including
loaded Android profiles that require a process restart. Sign-out does not wait for that restart.
“Pending restart” is not completed erasure: the native startup gate deletes retired stores before
loading any page. A persisted retiring identity covers even stores not yet tombstoned when the
process ended; unfinished Guest deletion also keeps retirement pending. Android Guest uses an app-private throwaway disk profile, never a reusable or
RAM-only store. Ending it clears cookies and web storage, but service workers and caches can remain
until that startup deletion. The person's system file picker may survive backgrounding for its
original page; agent-staged choosers cannot.

## This iPhone's apps

While the app is open, an iPhone can serve Calendar, Contacts, Reminders, current Location and
Photos metadata to agents as a local Runner with the integrations module, plus the browser module
once its browser qualifies ([native module](../apps/mobile/modules/iphone-apps/ios)). It exposes no screen, files, other apps
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
