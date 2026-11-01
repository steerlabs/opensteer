# Browser sessions

A named profile keeps Chromium-native browser data on its owning computer. Its
live sessions share an engine host; each Guest session has its own ephemeral
browser. Sessions partition page access even when they share a profile. A
session's identity is fixed at creation. Website sign-in is separate:
[Chrome sign-ins](browser-sources.md) and [Passwords](passwords.md).

## Opening web links in Opensteer

On macOS, Stable and Beta can be selected as the default browser in System
Settings. HTTP(S) links open in signed-in Personal with the last chosen profile
(Guest by default), without starting or messaging an agent. Links wait for
Personal during startup; delivery must not steal focus if the person navigated
elsewhere while waiting.

## Open workspace tabs

The Host database owns durable tab descriptors; live sessions and CDP handles die
with their Host/browser connection. Restoration creates a new binding, never
restarts a finished Run, and never makes an old handle valid. Only a selected
dormant tab restores. It waits for its saved computer and profile; it must not
substitute another computer or Guest. Siblings restore into the same lineage to
preserve Guest isolation. Guest descriptors persist, but their website state does
not. Trigger/watch browsers write no durable tabs.

Closing a tab closes its row; runtime disconnect and shutdown only suspend its
binding. A session close can close a lineage only through its latest session:
an obsolete session cannot close its replacement's tabs. Late updates must not
resurrect closed rows. Reopen consumes only a person's explicit close, after
checking access and admission; it creates a new suspended row and leaves the
old row closed to fence late producers.

Only committed navigation becomes a restore URL. Tab metadata saves neither
cookies nor forms, DOM state or navigation stacks; overlong URLs must remain
unavailable rather than be truncated into another address. Bootstrap omission
is not closure: clients recover omitted inventories through authorized reads.
Durable restoration requires `workspaceTabRestoreVersion`; a browser without it
refuses restoration instead of losing the saved identity.

Opening selects a client-local pending tab immediately on web, desktop and mobile.
`browser.tab.open` returns once the page exists and its initial navigation was
submitted, before document load. Only committed URLs
become restore URLs. An uncertain transport result keeps its original operation
key; late completion must not steal focus after the person navigates elsewhere.
The Host has one 20-second budget for database locks, placement, relay, engine
acquisition and settlement. Runtime authority carries the remaining work budget
and signed expiry. Database lock waits are cancelled on the server; pending opens
become interrupted failures on Host restart. Settlement is conditional: a late
success cannot overwrite failure. Same caller/key/fingerprint replays its outcome;
a terminal failure permits a new key, while uncertainty retries the original key.

One client 25-second deadline includes the pending row and presentation: native
mount/paint or a drawn streamed frame. Foregrounding checks elapsed time. A
presentation timeout offers Retry viewing on the same page; it creates no tab.
Closing a pending row releases presentation immediately. A late known page is
closed through the existing command.

Source: `apps/host/src/browser/browser-service.ts`,
`packages/database/src/browser-session-store.ts`,
`packages/browser-runtime-core/src/browser/surface-ledger.ts`.

## Addressing and input authority

Agent connections bind to one named session for life. Every command rechecks
Workspace/session access and profile grants, including after asynchronous
admission. Run end releases attachments and relay connections, not the session.
The browser runtime must use the current wire contract; older runtimes receive
an update refusal before placement.

A session lists and attaches only its own pages, including popups. Human selection
and agent target selection are independent; agent activation commands do not move
the person's focus. A missing root target fails rather than silently selecting a
replacement. A tab-open replay must preserve the recorded tab/session outcome,
even after closure or Host restart; an uncertain start must not start another
browser. Bind the authenticated caller/key and normalized payload before an
uncertain submission. Transport retries must finish within the retained replay
window; later user actions need new keys.

Automatic personal reuse requires positive personal creation provenance and a
ready browser at the resolved placement. Unknown provenance is ineligible.
Opener/occupant projections recheck reader visibility and must not expose other
people or inaccessible conversation IDs. The Host keeps browsing history and site
icons in each profile, readable and clearable only by its owner. It records a
person's explicit tab opens and address-bar navigations only when the browser
matches the navigation reply to its committed document (including HTTP redirects).
The runtime sends each attribution once with the URL frozen at that commit, so
later page scripts cannot change the visit while its reply is pending. Agent navigations
and Guest browsing create no visits; runtimes without attribution record none. Search
suggestions send search words to Google only under the negotiated feature and
local preference.

Input/navigation/geometry mutations share a per-surface ordered lane; observations
must remain independent so an agent script waiting for a person's click cannot
block that click. Dialog answers, detach and close bypass blocked page work.
Held gestures belong to one producer; takeover cleans up the old producer first,
and geometry changes release held input. A lost answer after insertion or press
has unknown outcome and must never trigger automatic replay.

Human activity is an observation, not an input gate or proof of inactivity. Never
record keys, typed/pasted text or dialog answers in activity metadata. Native
activity is conservative: overlapping CDP input can suppress local activity.

Tickets, native creation and navigation are never blindly replayed. Initial and
additional navigation errors remain visible on their existing page; a rejected
navigation command does not turn a successfully acquired browser into a lost
open. See the runtime controller and surface ledger.

History retains at most 300 addresses for 90 days. Removing the last address of a
site removes its retained icon; clearing history or deleting the profile removes
all of both. Erasure is ordered after already-recorded visits; a navigation that
commits afterward is a new visit. Replayed tab opens create no visits. Device-local
history is not imported.

The private cursor observer sends element centre and page scale only, never
values, text, selectors or attributes. See
`packages/browser-runtime-core/src/browser/script-targets.ts`.

Sources: `apps/host/src/browser/trigger-cdp-bridge.ts`,
`apps/runner/src/browser/browser-cdp-relay.ts`,
`packages/browser-core/src/session-cdp-router.ts`,
`apps/desktop/src/browser/electron-browser-launcher.ts`.

## Remote editing

Editing is an optional, three-way negotiation. A Runtime advertises
`modules.browser.editing: 2` with an explicit `clipboard` boolean; the Host copies
that version and capability into its attach ticket. V1 remains supported and
implies an isolated engine clipboard. Headless Chromium advertises v2 with
`clipboard: true`; Personal's Electron engine advertises v2 with
`clipboard: false`. Editing does not require a clipboard port. Headed development
Chromium keeps its existing baseline advertisement.

Current viewers opt in with `editing=2`. A v2 viewer receives the Runtime's
negotiated version and, for v2, its explicit clipboard flag. A viewer opting in
only with `editing=1` receives v1 on an isolated-clipboard session, or the exact
baseline projection on a v2 session without that clipboard. Other viewers get
baseline. The Host removes both editing fields and editing messages from baseline
projections, and refuses their extension commands. An older Host that does not
understand the v2 opt-in keeps the viewer on baseline. This changes no Host API
epoch or binary image header. See [compatibility](host-boundaries.md#compatibility).

On a session without an engine clipboard, editing viewers keep live composition,
verified replacements, commands and context, while copy/cut use the existing
runtime-resolved `primary` chord plus `clipboard.data`, and paste uses `clipboard.paste` plain-text
insertion. Context-menu clipboard actions use that same route. The Runtime keeps
its legacy selection publication with sensitive values excluded. Rich clipboard
operations and page-write notifications are unavailable. Electron ships no native
clipboard addon, and page Clipboard API permission is unchanged.

For baseline viewers of an isolated-clipboard Runtime, the Host replaces copy/cut
keydown with one native clipboard operation and consumes its matching keyup.
Only a complete successful text/plain result within baseline character and frame
bounds becomes `clipboard.data`, sent to that controller. Empty, canceled,
sensitive, oversized and incomplete copies publish nothing. Typing and baseline
plain-text paste retain their meanings.

An editing keystroke carries its text on the same native key event. It is one
admission and one lane operation, so a page can cancel its default without a
second insertion. `primary` maps to the engine platform's command modifier;
explicit Control and Meta keep their identities. Location, keypad and repeat
facts reach Chromium. Logical letters and digits determine shortcut identity
across keyboard layouts. `input.command` supplies an editing meaning; the
Runtime sends that platform's chord with the Blink command on the same keydown.
All commands, text, compositions and clipboard operations share the surface's
input authority and ordering.

Each frame has a lifecycle-owned private editing world, hidden from agent CDP.
It reports field kind, keyboard hints, sensitivity and a normalized caret with
the surface's geometry revision. It never sends values, surrounding text,
selection offsets or preedit. Text controls use mirror geometry; contenteditable
uses a Range; EditContext uses character bounds. An out-of-process frame has
its own platform CDP session. Blur, navigation and renderer replacement clear
the context. An external caret or selection move, a field or document change, or a stale refusal changes its opaque
`contextId`.

A composition or text edit names that context. Range replacements verify their
exact `before` and `after` strings around a collapsed caret before selecting the
range and using native IME or insertion primitives. Text controls, DOM selection
and EditContext are handled through their own editing mechanisms. The private observer fences the original selection revision, including during composition. A mismatch or
changed field or selection refuses the edit and republishes a new context ID without applying
the requested text. A verified deletion uses the native delete command.

When the isolated clipboard capability is negotiated, copy, cut and rich paste use the engine clipboard port. Headless Chromium holds
its clipboard in memory and accesses it through a private helper browser context,
which agents cannot discover or attach. Scopes are serialized across a profile's
sessions and emptied on close. Native text, HTML and PNG representations are
supported; unsupported formats and duplicate representations are refused before
paste. Copy and cut refuse sensitive fields before dispatching any event.
Clipboard data travels in bounded, ordered parts; incomplete operations retain
their lane position and expire after five seconds. Malformed streams are refused,
and the Host stops forwarding their remaining bytes. No part changes a page
until the whole accepted operation is available.
The Host pauses a viewer's socket while its bounded input inbox drains, so a
valid multi-part upload does not overflow the inbox between relay writes.

A controller's keydown or pointer-up may retain a clipboard scope until the next
operation or 500 ms. Page writes in that scope are attributed only to that
controller; any overlapping agent command invalidates attribution. Explicit copy
and cut return their native data and cut performs the native deletion. The Host
assigns consumer identity rather than trusting an incoming token, and delivers
results and parts only to that consumer. Watch never receives clipboard data.
Sessions without the engine clipboard retain their released copy publication, with password
and other sensitive input values excluded.

A page's uncanceled context-menu event reports editable/selection facts and an
optional link URL only to the controller who right-clicked. A page that cancels
the event retains its own menu. Diagnostic counters record operation kinds,
refusal reasons and clipboard outcomes without keys, text or clipboard bytes.

Text-control caret measurement reuses a hidden tree with stable text nodes. Removing even
an unrelated node in that document closes Blink's typing command, so rebuilding the mirror
between keystrokes splits native Undo grouping. The observer updates CharacterData and geometry
without removing measurement nodes until teardown; baseline sessions do not start the observer.

## Agent CDP boundary

Agents get a frame's main-world script reach plus person-like input, never
HttpOnly cookies, network headers unavailable to page scripts, privileged storage,
browser diagnostics, machine clipboard or isolated/preload/platform worlds.
Cross-origin main worlds in the page's renderer are intentional; cross-site
out-of-process frames are not attachable through agent CDP. The router refuses
auto-attach and admits only session-owned pages.

The exact method, nested-parameter and event allowlist in
`packages/browser-core/src/agent-cdp-allowlist.ts` is deny by default. New CDP
methods, fields, enum values and events stay refused until reviewed against the
pinned protocol. Log-domain diagnostics can contain hidden response headers even
when marked JavaScript; only proven main-world console/exception events belong
to agents.

Main-world access requires positive Chromium context provenance, not absence of
foreign evidence. The router inventories contexts before dispatch, tracks renderer
replacement, checks every typed object handle at every parameter depth and in
results/events, and isolates object-group names. Page data that merely resembles
a handle is not authority. A backend channel must behave as a fresh CDP session;
Electron's shared debugger hub must replay its inventory to each channel rather
than rely on a second Runtime.enable emitting contexts. Dialog answers can proceed
while context inventory is blocked by a dialog.

`Opensteer.fillLogin` is platform-handled and never reaches Chromium. It needs
current calling-Workspace lease authority, browser access, negotiated sign-in
support and an attached full-control page. It returns status only; after filling,
page scripts (including agent JavaScript) can read the value. See
[Passwords](passwords.md#filling-a-field).

Agent keys remain page actions, never browser or OS shortcuts. Accept the legacy
nativeVirtualKeyCode for compatibility but strip it before engine dispatch;
shortcut mappings belong to the reviewed router.

Agent paste from the browser computer's clipboard is always refused. On engines
sharing the machine clipboard, native copy/cut and their chords are refused too:
they could overwrite a person's copied password. Agent commands invalidate
person clipboard attribution and never create a person scope. Electron has no
qualified isolated clipboard port; enabling one requires a reviewed engine
boundary. The Host refuses agent CDP without `cdpBoundary`.

Sources: `packages/browser-core/src/session-cdp-router.ts`,
`apps/browser-runtime/src/browser/agent-cdp-allowlist.test.ts`,
`apps/desktop/scripts/electron-cdp-boundary-smoke.ts`.

## Shared viewing and previews

Locality is never authority. Desktop main mounts a local native page only after
the first Host snapshot on that window's admitted control socket, and only under
`browser-target-control-v1`. An unknown capability list leaves presentation pending;
a verified list without support chooses streaming. Native admission never silently
falls back to streaming. Loss of the last admitted socket, logout, page/runtime
closure or app reload removes the page; reconnect needs fresh admission. Overlay
tokens must be acknowledged before an overlay covers a native page, including
exit animations. See `apps/desktop/src/browser/browser-presentation.ts` and the
[renderer contract](../apps/desktop/src/computer-use/RENDERER-CONTRACT.md).

The surface ledger alone owns geometry. A focused desktop-width human view follows
its stage; an unfocused view must not fight it. Phone views scale and change size
only on explicit Fit. Follow preserves an agent override; Fit removes it. Keep
agent emulation on a long-lived platform channel: Chromium drops it on navigation
after its issuing channel detaches. Native pages show true-size layout with margins
or a top-left crop, never a smaller layout disguised as a crop. Fullscreen stays
inside the page and does not resize the app or remove agent emulation.

Desktop Browser Session pages allow fullscreen and no other permission; camera,
microphone, geolocation, notifications and clipboard reads remain denied. See
`apps/desktop/src/browser/browser-session-policy.ts`.

Frames describe their exact surface and drawn geometry. Pointer/wheel aiming must
use the drawn layout and capture revisions, and refuse stale geometry. A native
crop is separately negotiated; an old reader must receive explicit unsupported
policy rather than a cropped picture labelled full-layout. Subscription never
performs Fit. Agent viewport screenshots use input coordinates; beyond-viewport
captures retain native pixel density. A picture with dimensions inconsistent with
its declared capture is never shown.

Native geometry completion is independent of JavaScript and paint. Handoff waits
for matching compositor observation with lifecycle guards, but Electron frame
callbacks cannot prove which metrics revision produced equal-sized pixels. The original opening
deadline bounds presentation waiting; expiry offers Retry on the same page and
never manufactures paint readiness. Cancellation,
dialog answers and the ledger lane never wait for paint. Unmounted Electron pages
need rendering demand leases; hidden/minimized clients pause their own demand,
without stopping independent agents or remote viewers. Locked-screen native Mac
capture remains refused.

Dialogs are tab-modal. Ordinary input is refused while one is open, but answering,
selection and closure remain available. An observed dialog ID fences answers from
reaching a replacement dialog. Plain CDP clients may omit it and keep Chrome's
answer-current-dialog semantics. Older runtimes get Host-generated IDs and a
single forwarded answer with that extension stripped. Shared-control and capture
extensions must be negotiated and stripped for older strict readers/producers.

Watch is passive: it may manage picture subscriptions, receipts and raster
demand. It must never navigate, select, resize the page, input, access
clipboard/CDP or import/export state. Raster demand changes presentation density
without changing page geometry or ending held input; it must not resubscribe
the viewer. Viewers that do not negotiate raster demand keep the existing
full-density capture. Native control subscriptions without pictures require
target-control support and a target; unsupported runtimes must not substitute pictures. Targeted
readers refuse producers without targeted-streaming support. One viewer's image
credit never blocks input or another viewer. A subscription alone is not proof of
a live picture.

Each socket retains its admitting login; logout, expiry or loss of session access
ends it. Workspace realtime reconnection does not revoke a separately authorized
viewer. Profile owners retain visibility; Guest follows Workspace membership.
Catalog, occupant and activity metadata must be projected for each reader, with
no historical usage promoted to live occupants. Bootstrap budgets require an
authorized fallback, never silently lost tabs. Catalog generation ordering still
has a wall-clock rollback/same-millisecond restart limitation.

A message's page is a reference to the draft's document, not a fresh scan of its
fields. Admission uses sender visibility and conversation Workspace authority;
a later navigation, sign-in form or close does not invalidate the message.
Candidate reads must not inspect fields. See
[conversation attachments](agent-orchestration.md#pages-and-apps-in-a-conversation).

Sources: `packages/browser-runtime-core/src/browser/surface-ledger.ts`,
`packages/browser-runtime-core/src/browser/controller.ts`,
`apps/host/src/browser/browser-service.ts`,
`apps/web/src/components/browser/browser-presenter.ts`.

## Site icons

Icons must use the page's own storage, routing and service worker. Never share a
URL-only cache across authentication contexts or correlate opaque response bodies
by URL alone: use the exact private-world request/frame identity. Website policy
is unchanged. Chromium decodes images, with SVG scripts inert and external
resources blocked; clients read authorized bounded rasters, never contact the
website or decode vectors. Publication is fenced by document/declaration revision.

See `packages/browser-runtime-core/src/browser/favicon.ts`. Its network/body
bounds do not promise a hard browser network-memory ceiling. An empty fetch
destination can make a server/service worker refuse an otherwise valid icon.

## Loading

Loading means the main frame's own loading interval, not any child frame or agent
activity. Navigation extensions require negotiation; omit new fields from older
strict snapshots. See `packages/browser-runtime-core/src/browser/surface-ledger.ts`.

## Files and downloads

Page uploads name only staged paths within the session's private folder on the
Runtime machine. Agents cannot name arbitrary machine paths; staging needs the
Runtime capability. The folder disappears with the session. See
`packages/browser-runtime-core/src/browser/session-files.ts`.

Desktop downloads become visible only when complete, with a non-replacing name
and macOS quarantine applied before publication. Electron does not add quarantine
itself. Cross-volume publication requires a hidden copy then a hard link; a volume
without hard links fails. macOS may require Downloads permission. A download
belongs to its partition and survives tab/session close; it never opens itself.
Renderer actions take IDs, never filesystem paths. Host/transport sessions refuse
downloads. Cloud Chromium refuses them because delivery to the person's device
requires a separate authenticated transfer. See
`apps/desktop/src/downloads/desktop-downloads.ts`.

## Passkeys

`OPENSTEER_PASSKEYS=1` on the Host enables passkeys in the Personal browser and
hosted Chromium tabs. Pages see a WebAuthn provider installed before their scripts;
its CDP bridge checks the browser's document identity, trusted HTTPS origin, RP ID
and Permissions Policy before forwarding a ceremony. Both engines keep Chromium's
own WebAuthn implementation disabled. Conditional autofill isn't supported.

The Host routes a person's request only to the viewer where their input reached
that tab. A capable desktop presents the OS passkey manager; an agent or page-load
request first offers Continue. The first person to claim it chooses the desktop.
Main holds the request and its presentation binding, while the renderer names only
an opaque request ID and never receives the request's origin, options or client data. Losing the tab presentation, authority or connection cancels
the ceremony without sending it to another device. The authenticator's signed
bytes return unchanged; Opensteer never stores a passkey private key.

macOS requires 13.5 or later and Apple's browser passkey entitlement; security keys
require 14.4 or later. The OS manager handles local passkeys, installed credential
providers and nearby-phone options. Releases without the channel-specific passkey
signing inputs omit the native addon and entitlement and opt in as notice viewers,
as do web, iPhone, Linux and Windows viewers. A person using a
notice viewer gets an immediate refusal and a message to open the tab on a Mac.
Cross-origin frames are refused, even when the site's Permissions Policy permits
them. Headless Shell lacks the browser security evidence the provider needs, so it
keeps the absent policy. See the [native addon](../apps/desktop/native/passkeys/README.md)
for availability, packaging and signed-build qualification.

The flag defaults off in `packages/config`. A hosted operator sets
`OPENSTEER_PASSKEYS=1` in the Host environment. For the desktop's Personal Host,
quit the app and launch its executable with that value, for example
`OPENSTEER_PASSKEYS=1 /Applications/Opensteer.app/Contents/MacOS/Opensteer`;
the desktop configuration passes it to the supervised Host, including in signed
builds. Restart to change it. This enables routing but doesn't grant the OS
entitlement. With the flag off, pages retain the existing absent policy:
`PublicKeyCredential` is absent and public-key requests reject with
`NotAllowedError`, leaving password and other credential requests unchanged.

Run `pnpm exec vitest run tests/passkey-routing.test.ts` for the real Chromium
runtime, browser WebSocket wire, Host routing and independently verified synthetic
RP ceremonies without PostgreSQL. The [shared provider scenario](../packages/browser-runtime-core/src/test-support/passkey-provider-scenario.ts)
covers popup eligibility and page semantics in both engines; the
[provider-off scenario](../packages/browser-runtime-core/src/test-support/passkey-policy-scenario.ts)
checks the absent policy. Run
`OPENSTEER_VM_SLOTS=1 pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh passkeys`
for the desktop's real Personal Host and native presentation. That journey uses a
software authenticator and pinned synthetic RP certificate imported only by its
test entry; shipped apps cannot select it. Real OS sheets still require signed-build
qualification after entitlement approval.

### Native passkey routing

`OPENSTEER_PASSKEYS=1` enables the optional `browser-passkeys-v1` Host capability;
it is off by default and needs no Host API epoch change. A runtime launches the
page provider only after it advertises `modules.browser.passkeys: 1`, receives
`passkeys: 1` in the browser auxiliary welcome and holds a signed attach ticket
with `passkeys: 1`; otherwise the existing page policy applies. A shared profile
browser is reused only in a matching passkey mode: an idle one closes before
relaunch without clearing native data, and one held by another session refuses
the attach for retry.

- Viewers opt in on their control socket with `passkeys=native` or
  `passkeys=notice`. Only opted-in viewers receive the mode and its consumer
  token, and runtime ceremony messages end at the Host, never fanned out to
  viewers. Desktop builds without native support, web and mobile are notice
  viewers.
- A request belongs to one runtime connection, session and document. A
  person-attributed request reaches only that person's presenting viewer. Agent
  and unattributed requests offer Continue to eligible viewers, and the first
  native claim binds the request. Losing that presentation, access or
  connection ends it without rerouting; the deadline applies even while an
  answer is being authorized.
- Desktop main proxies streamed and native control sockets and holds the
  request before notifying the renderer. The renderer can only ask to present an
  opaque request ID and learns only that the offer ended, never the origin,
  options or client data. The OS authenticator gets the actual origin and the
  complete normalized options from main. Neither main nor the runtime repairs
  the OS's client data or any other signed bytes.

## Profiles and identity

Profiles are durable identities, not account names. Main and the person create
empty profiles; a specialized Workspace needs an atomic creation-and-grant
browser-access Request. Delegated and trigger work creates none. Choose the
profile before signing in: Guest state is ephemeral and cannot be promoted.
The profile list provides identities and grants, never proof of a website login.
Inspect the website only when the task actually needs that sign-in.

Only the person renames or deletes profiles. Deletion fences new work, closes
durable tabs, revokes grants and schedules erasure on the owning computer.
Archival alone is not disk deletion. Offline owners leave visible
`pending-computer` work. Electron retains a Session until process exit, so an
opened profile can remain `pending-restart`; the next start erases its tree
before opening any Session there. Never move or delete a live Session directory
or restart the app just to complete erasure. Completed downloads remain outside
the profile tree. Archived owner/binding stubs and nonsecret tombstones survive
until outstanding erasure can be acknowledged; unfinished deletion occupies one
of the owner's 128 profile slots.

## Native storage

A profile belongs permanently to its computer, storage root and engine. Metadata
creation allocates no engine. The first signed attach records the binding, then
the runtime publishes empty native files atomically before opening a Session.
Only unpublished files may be renamed; an engine-owned native directory is never
moved. The Host durably acknowledges initialization before browser activity.
This fact distinguishes never-created storage from established storage that went
missing. An established missing directory, root identity, sentinel or mirror
refuses opening and preserves what remains; it never creates an empty replacement,
selects another computer, or substitutes Guest.

The forward native-only migration retains every existing local profile and its
exact binding, owner, grants, history and tabs, marking it initialized. It never
reads or rewrites native files or encryption keys. Non-local profiles are removed;
only archived binding/owner stubs required by deletion jobs survive. There is no
Vault conversion, portable snapshot, seed, checkpoint, lease grace or speculative
profile preparation. See the [storage contract](../packages/protocol/src/browser-profile-storage.ts)
and the [native migration proof](../tests/browser-native-only-migration.integration.test.ts).

Electron roots live beneath its `sessionData` tree, namespaced by Deployment,
outside disposable Runner slots. The Network Service sandbox receives only that
tree at process launch. A Session outside it can appear usable while cookies and
caches never reach disk; Host databases and credentials stay outside this grant.
See [desktop paths](../apps/desktop/src/app/application-paths.ts).

The process holds exclusive ownership of the root for life. Desktop application
ownership covers its Deployment roots; standalone runtimes use an OS file lock.
A logical runtime restart cannot erase directories retained by Electron Sessions.
Per-profile serialization lets unrelated profiles proceed independently. Closing
the last tab keeps a native host warm; capacity pressure evicts the least recently
used idle host. Eviction and failure cleanup never clear native storage. Electron
releases views/controllers but retains its Session, so eviction does not bound all
Session memory. Shutdown asks Chromium to close normally, then forces its owned
process group if cleanup expires; the directory stays owned until the child exits.
Controlled cookie writes have a commit barrier, while uncommitted website activity
can still be lost on forced exit. The binding-matched `opensteer.v1.json` sentinel
remains unchanged.

Full Chromium restores session cookies through its native policy, without expiry
rewriting. Opensteer alone owns tab restoration: the launcher removes recognized
tab/window restore records only while the directory has no engine owner. Cookie
and origin databases stay intact. Controlled cookie writes retain native flush
and readback barriers in the [storage adapter](../apps/browser-runtime/src/browser/native-profile-storage.ts).

Electron keeps session cookies in its existing encrypted mirror with an OS-wrapped
key; Guest creates neither. Its format, associated data and key path are unchanged.
Named launches require platform encryption. An unavailable key provider asks the
person to unlock the keychain and Retry; missing, corrupt or mismatched mirrors
preserve storage and refuse opening. The Session-wide request gate covers workers
and pages, follows replacement owners on the same Session, and stays closed until
an actual attach admits activity. Cookie events invalidate an authoritative
Session-scoped capture because their payload omits partition keys. Controlled
writes await native and mirror persistence. See the [mirror owner](../apps/desktop/src/browser/session-cookie-mirror.ts).

Network Service loss stops publication, closes views and refuses requests. Only
an explicit open restores within the acquisition budget. Surviving pages/workers
can briefly observe a jar without session cookies, and restoration can deliver
Cookie Store change events. The mirror preserves its last committed state across
process crashes; it cannot guarantee a website mutation or logout not yet captured.
Power loss is outside this guarantee. Engine upgrades must requalify these barriers.

Chrome sign-ins retain their cookie-only envelope, site scope, partition handling,
count limit and UTF-8 size limit. They use `state.import` to replace exactly one
site's cookies; they never import localStorage or IndexedDB. Passwords remains a
separate authority. No browser-profile Vault key is provisioned or required;
existing key files are left alone.

## Tab groups

Groups organize a person's tabs and grant no access. Latest-session authority
still applies. Agent reads must reveal neither ID nor metadata of a partly
reachable group; organization resolves the person's full visibility under the
layout lock even if the agent has narrower reach. Reads never write. Visibility
changes can change membership at the same layout revision, so equal-revision
refreshes after session notices matter. Ending a Run never reorganizes tabs.

## Verification

Use the [browser-session checks](../.agents/skills/verify-browser-sessions/SKILL.md).
