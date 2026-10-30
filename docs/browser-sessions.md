# Browser sessions

A profile's sessions share one Chromium host and its sign-ins on their computer;
each Guest session has its own browser. Sessions partition page access even when
they share a profile. A session's identity is fixed at creation. Website sign-in
is separate: [Chrome sign-ins](browser-sources.md) and [Passwords](passwords.md).

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
Durable restoration is negotiated with `workspaceTabRestoreVersion`; older
clients and runtimes retain the live-only view and close controls.

Source: `apps/host/src/browser/browser-service.ts`,
`packages/database/src/browser-session-store.ts`,
`packages/browser-runtime-core/src/browser/surface-ledger.ts`.

## Addressing and input authority

Agent connections bind to one named session for life. Every command rechecks
Workspace/session access and profile grants, including after asynchronous
admission. Run end releases attachments and relay connections, not the session.
Previous-release Runners' unaddressed CDP route follows their latest session and
closes when another opens; keep that adapter under
[Host compatibility](host-boundaries.md#compatibility).

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
people or inaccessible conversation IDs. Browsing history is local to the signed-in
person, Deployment and profile; Guest and agent activity create none. Search
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

Only transient filesystem preparation retries. Tickets, profile leases, context
launch and navigation are not blindly replayed. An initial website navigation
error opens the existing browser on its error page; transport/CDP failure fails
start. See `packages/browser-runtime-core/src/runtime.ts` and the Host service.

History has bounded retention. Clearing it removes retained icons and fences
pending navigation/icon writes; a later asynchronous result must not resurrect
deleted history. See `packages/client/src/host/recent-sites.ts`.

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
callbacks cannot prove which metrics revision produced equal-sized pixels. There
is no fixed paint deadline and no timeout may manufacture readiness. Cancellation,
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

Watch is passive: only subscribe, acknowledge and unsubscribe are accepted. It
must never navigate, select, resize, input, access clipboard/CDP or import/export
state. Native control subscriptions without pictures require target-control
support and a target; unsupported runtimes must not substitute pictures. Targeted
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
browser is reused only in a matching passkey mode: an idle one is checkpointed
and closed before relaunch, and one held by another session refuses the attach
for retry.

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

Profiles are durable identities, not account names. Main and the person can create
empty profiles; specialized Workspaces require a browser-access Request, with
creation and grant atomic. Delegated/trigger work creates none. Saving Guest
state copies once into a new profile and never links subsequent Guest activity.
The previous-release profile-save tool remains compatibility-only. Saved-state
site inspection cannot prove a currently valid website sign-in.

Only the person renames or deletes a profile, behind `browser-profile-manage-v1`;
agents get no destructive tool. Deletion archives the row, because sessions keep
naming the identity they were created with, then erases its vault revisions and
revokes its grants. It holds the profile's session lock, which session creation
and revision commits also take, and grant creation waits on the row, so no
session, grant, late save or creation replay can follow. The Host then stops the
profile's live sessions and closes its tab lineages. A repeated delete stops
whatever is left, so a failed stop is retried rather than stranded.

## Profile state

The Profile Vault is the only durable state; Runtime disk profiles are disposable.
A profile lease and final-save grace fence ownership and revision commits. Stop
saves before disconnecting. Periodic checkpoints preserve the existing final-save
grace deadline without extending it; only a final commit retires grace. The optional
profile-checkpoint header distinguishes periodic saves while the JSON body stays
compatible with previous releases; an absent header retains final-save semantics.
A refused or transport-failed final commit disposes the quiesced browser and reports
the typed failure; a later attachment restores the last durable revision. A late native
export retains its lock until settled but must never commit after its deadline.
A final save drains admitted imports before export; it is not a transaction over
later autonomous page/worker writes.

Restoration must finish before first navigation. On Playwright, keep the restore
page until Chromium acknowledges localStorage writes via a same-origin storage
event; closing sooner loses writes. Desktop saves include stored origins and
visited origins because Clear-Site-Data/eviction can remove storage without running
that origin's documents. Hidden storage helpers bypass service workers and consume
no user-page admission slots.

Malformed/over-budget origins retain their last captured state where available;
other origins and cookies still commit. An incomplete save must report failure
without logging storage keys/values and remain retryable. Direct export reports
incompleteness with its usable snapshot. There is no UI checkpoint warning.

Sources: `packages/browser-profile/src/snapshot.ts`,
`packages/browser-runtime-core/src/runtime.ts`,
`apps/desktop/src/browser/electron-browser-launcher.ts`,
`apps/browser-runtime/src/browser/playwright-launcher.ts`.

## Tab groups

Groups organize a person's tabs and grant no access. Latest-session authority
still applies. Agent reads must reveal neither ID nor metadata of a partly
reachable group; organization resolves the person's full visibility under the
layout lock even if the agent has narrower reach. Reads never write. Visibility
changes can change membership at the same layout revision, so equal-revision
refreshes after session notices matter. Ending a Run never reorganizes tabs.

## Verification

Use the [browser-session checks](../.agents/skills/verify-browser-sessions/SKILL.md).
