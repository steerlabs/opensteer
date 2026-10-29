# Browser sessions

Verification follows [Testing](testing.md#how-to-test): choose the
cheapest affected checks and keep one journey per user-facing flow. Existing
commands and output directories below are reference recipes, not per-change
journey or artifact requirements.

An agent works in Browser Sessions, each with an ID, opened with a saved profile or
fresh. Every session with one profile shares that profile's single Chromium host on
its computer, and with it cookies and sign-ins; each fresh (Guest) session is its own
browser ([`browserHostKey`](../packages/browser-runtime-core/src/runtime.ts)). A
session partitions pages: which tabs an agent may list and attach to, what a Run
holds, and how a tab lineage is restored and ends. Profiles and grants decide which
Workspace may use which identity; website sign-in is separate
([Chrome sign-ins](browser-sources.md), [Opensteer Passwords](passwords.md)).
Saved-password field fills work in fresh and profile-backed sessions; their
signed-in state follows the same profile persistence rules. This page covers the
contracts that make a session usable: how an agent reaches one, what it may do
there, how files reach its pages and where its downloads go, and how a profile's
state is kept.

People never see sessions in any client. The web and desktop workspace groups, names
and acts on tabs by their profile or Guest identity, their computer and the agents in
them. Mobile Tabs list each tab and open exactly that tab, beside Mac apps and phone
displays: a conversation's own, or from the sidebar every tab the reader may see,
including saved tabs, which the phone restores on their saved computer when opened.
Every close is per tab, and a session ends with its last tab.

The web and desktop Tabs header offers profile filtering when more than one
identity is in use. A selection shows only that profile's browser tabs, including
saved tabs and members of collapsed groups, in their existing order. Apps and
phones return when the filter is cleared. The selected profile stays visible and
clearable even after its last tab closes. This is local navigation state: it never
changes browser identity, opens a browser or changes Host inventory. The global
sidebar search still covers every profile; choosing a result outside the filter
clears it so the chosen tab is visible.

A live Browser Session and its CDP targets do not survive their Host or browser
connection. Open workspace tabs do: they retain their identity and descriptor
and obtain a new live binding on demand. A Run can outlive both connections
([Agent orchestration](agent-orchestration.md#runs-across-connection-loss-and-restarts));
its dead session/target handles still fail, so it opens another session. Restoring
a tab never restarts a finished Run.

A web link in an agent reply opens a new workspace browser tab through the start
page, using its default profile and computer choice. On the web, modified clicks,
middle clicks and the context menu keep the device browser’s own link behavior.
Mobile hands links to the phone.

## Opening web links in Opensteer

On macOS, Stable and Beta can be chosen as the default browser in System Settings.
HTTP and HTTPS links open directly in a new tab in the signed-in Personal
deployment, using the person's last browser profile choice (Guest by default),
with the tab selected and its address bar visible. Links received during startup
wait for Personal; after 15 seconds the app explains how to open them. The queue
holds the first 20 links, reports overflow, and collapses exact duplicates received
within one second. Opening a web link does not start or message an agent.
If you navigate elsewhere in the app after a link arrives, its tab opens in the
background and the delivery completes without changing your view; links already
waiting behind it open in the background too.

## Open workspace tabs

The Host database owns the open browser-tab inventory. Each row keeps its Runtime
surface ID, committed URL, title, insertion order and popup opener. Its original
session identifies the lineage; the latest session in that lineage supplies Workspace,
profile, computer and creation provenance under the existing session access rule.
Only a selected dormant tab opens a page. Siblings join that lineage's current
session when selected, preserving Guest isolation. New tab and Talk open none.
A selected tab waits for its saved computer to connect, including during Personal
startup; it never moves to another computer or substitutes Guest for a missing
profile. Unsupported addresses remain unavailable.

Guest/fresh tabs retain descriptors, including those opened by a person or a Run,
but their sign-ins and website state remain disposable. Trigger/watch-owned
browsers write no durable tabs. Dormant lineages count toward no admission limit;
the existing 64-page lineage and 32-live-session profile bounds remain. Bootstrap
lists the newest 100 lineages within its byte budget; omitted lineage inventories are
read through the authorized `workspace.tabs.get` fallback. A selected or remembered
session outside that window is resolved to its lineage and read explicitly; bounded
bootstrap omission does not close the selected tab.

Closing a tab closes that row only. If it was the last live page, the session ends
and its dormant siblings stay. Explicit `browser.session.close` closes the whole
lineage only when it names the lineage's latest session; an obsolete session cannot
close its replacement's tabs. Runtime/context teardown, disconnect and Host shutdown suspend bindings;
they never mean tab closure. Page-initiated closes, including OAuth popups, do close
the row. Closed markers fence late updates through the 24-hour open-command replay
window and while their producer remains live.

Reopen closed tab consumes the person's newest unconsumed explicit tab close
within 24 hours. It creates a new suspended tab in the same lineage with the saved
URL, title and icon, after its nearest surviving preceding tab and in its group
if that group still exists. Selection uses normal activation. Access and the
64-tab bound are checked before consumption; a refusal changes nothing. Repeating
walks backward. Agent, page, Runtime inventory and lineage closes are ineligible.
The source stays closed to fence late updates. `workspace-tab-reopen-v1` gates
`workspace.tab.reopen`, the tab menu and desktop ⌘⇧T.

The existing 100 ms catalog flush diffs durable descriptors before publishing.
Loading, presence and occupant changes cause no durable metadata writes. Only
committed main-frame and same-document navigation updates the restore URL, including
URL fragments. Durable URLs and the negotiated restore lane share a 16,384-character
bound; longer committed addresses remain unavailable, never truncated and reopened.
The public tab-open command retains its 8,192-character bound. A crash
can lose the final coalescing interval; an unfinished navigation restores its
preceding committed URL. Graceful shutdown drains pending descriptors. Profile
checkpoints retain their separate existing guarantees; tab metadata does not save
cookies, forms, navigation stacks or DOM state. Each row retains its last successful
bounded site icon for that committed URL, including while suspended.

Capable web/desktop clients read durable membership and overlay live fields from
the existing session catalog. `workspaceTabRestoreVersion: 1` gates the added Host
operations and Runtime ticket/private stable-ID lane. Older clients keep the
live-session view; Expo lists durable rows and restores a saved tab through the same
`workspace.tab.activate`; older Runtimes cannot produce or restore durable rows.
Each participating live session advertises the matching capability. New clients
keep the live-only sidebar and close controls for unnegotiated sessions.
Agent browser tools continue to list live sessions and targets.

## Runtime readiness and session-start diagnostics

A Runtime binds its relay only after preparing the session-files root and any
engine startup probe.
The desktop engine waits for Electron readiness and opens, initializes CDP on,
and closes a fresh throwaway context before it can advertise a placement.
Concurrent preparation and server starts share one promise. The probe never
loads a website or saved profile, and leaves no live context.

Only transient filesystem setup failures (`EBUSY`, `EMFILE`, `ENFILE`) can retry:
two additional attempts with 100 ms and 200 ms delays before any session is
admitted. Tickets, profile leases, context launch and website navigation are not
replayed. The Host waits for the first navigation's CDP answer before returning
an opened session. A navigation error, such as a local server that is not up yet,
is recorded with the session's correlation ID and the session opens on Chromium's
error page; only a CDP or transport failure fails the start.

Session-start diagnostics carry the Browser Session ID as the correlation ID on
both Host and Runtime. Runtime diagnostics name preparation, profile state,
context launch, session initialization or snapshot delivery; Host diagnostics
name runtime connection, readiness, first navigation or the final session read.
The Host preserves a Runtime's startup protocol error instead of replacing it
with a socket-close error. Agent-facing failures stay plain; the correlated
internal cause is recorded in the Personal logs described in
[Connections](connections.md#personal-process-recovery-and-diagnostics).

A stopping Runtime saves each profile it holds first. If a profile commit fails, the stop
fails and every connection and the health endpoint stay up, so the stop can be
retried. Once the saves succeed, it ends every connection at once without
waiting for any peer to answer. An open viewer is sent `1001 runtime shutting
down` just before, as best effort: a broken or backed-up connection may not
deliver it ([`BrowserRuntimeServer`](../packages/browser-runtime-core/src/server.ts)).

Snapshot export has a 15-second deadline, including the shared state lock; each
profile's complete close has a 35-second deadline, including quiescence, the
existing import drain, checkpoint serialization, the Host commit and browser
disposal. Shutdown waits at most 15 seconds to enter the Runtime lock, and at
most 15 seconds for preparation already in progress. These waits never sleep
until placement grace expires. A final Host commit releases grace immediately.
Failures log `browser.profile.checkpoint.failed` with profile/session IDs, phase,
stage, elapsed time and a typed reason; queue and preparation failures log
`browser.runtime.shutdown.failed`. Lease refusals and revision conflicts stop
automatic save retries. A native export that outlives its deadline keeps the
state lock until it settles; its late snapshot cannot commit, and a new attempt
fails promptly with `profile-checkpoint.snapshot-pending`. Unsaved profiles stay
owned for an explicit retry. A confirmed browser exit releases ownership even
when process cleanup reports an error; an unconfirmed close retains it, and a
confirmed final save is never repeated on its retired lease.

Each Chromium Profile Host owns a Playwright browser server. Its close ends
that process group and waits for exit and temporary-directory cleanup, including
when setup fails. The pinned Playwright patch rolls back a launched process if
its loopback listener or server setup fails before returning an owner. Profile durability comes from the snapshot exported before
shutdown; the temporary Chromium disk profile is disposable. A saved profile stops admitting state mutations and drains admitted imports
under their existing deadlines before its final export takes the shared state
lock. An import that does not drain fails the save and keeps its browser owned
for a retry. The snapshot preserves the state exported at that boundary; it is
not a transaction over later autonomous page or service-worker writes. A failed
save after the last session closes retries automatically; a failed runtime stop
reports that shutdown did not complete. Retaining the browser keeps unsaved profile state
in memory, but the session's pages have already closed. Native graceful
shutdown waits for NetworkService to flush that disk profile, so it is not part
of this close path. CDP channel disposal stops local use immediately and sends a
remote detach as best effort; neither a page dialog nor an unanswered detach can
hold the owning process open
([launcher](../apps/browser-runtime/src/browser/playwright-launcher.ts)).

## Addressing

A session is always named. `browser_session_open` starts one (`profileId` or
`fresh`) or continues one (`sessionId`) and adds it to the Run's set; a Run can
hold several and use them side by side. Browser Harness takes the ID with
`--session`, and the [Runner relay](../apps/runner/src/browser/browser-cdp-relay.ts)
opens one Host connection per harness connection at
`/internal/v1/browser-cdp/<session ID>`. That connection is bound to the session
for its whole life, so nothing an earlier connection did can redirect a later
one. Connecting to a session the Workspace may use records that the Run holds it;
the Run's end releases what it held and leaves the sessions open. The Run's end,
or a warm engine going idle between Runs, cuts each relay connection and its Host
connection at once. An open harness connection is sent `1001 Run ended` just
before, as best effort, and Browser Harness reports that reason to later calls.

The [Host connection](../apps/host/src/browser/trigger-cdp-bridge.ts) admits
commands one at a time, in the order they arrive (admission ends when the
command is handed to the browser; its fences are described under activity
below), and answers each when the
browser does, correlated by ID. An input whose handler opens a dialog stays
unanswered until the dialog closes. The dialog's answer and detach, which the
runtime runs past a blocked page, therefore never wait on that input. Clients
await commands that depend on each other. The broker's 32 pending requests are
shared: a client that pipelines enough blocked commands to fill them is refused
more, including an answer, until results or timeouts free room.

Page targeting is independent of the person's view. Browser Harness attaches
lazily: with only the session's initial page it can use that page; with several,
page operations require `--tab <target ID>` or `switchTab(targetId)`.
`listTabs()` and `newTab(url)` work without an attachment. The agent keeps
target IDs in its own code across invocations. Agents browse as a person does,
in one work tab navigated in place, because every tab they leave stays in the
person's session. `newTab(url)` therefore leaves nothing behind when it cannot
open: it checks the URL before creating a tab and closes its tab when
attaching or navigation fails. A page still loading at the command timeout
keeps its tab, and so does a tab the person acted in meanwhile, since their
navigation also aborts the agent's; the error names the tab. When `newTab` brings a session past six tabs,
Browser Harness prints one line to stderr, once per invocation, such as
`[opensteer] This Browser Session has 7 tabs open. Visit your next page in a tab you already opened with gotoUrl(url), and close the tabs you opened once you are done with them.` `Target.getTargets` carries the
immutable `rootTargetId` recorded when the session opened, so closing the
initial page cannot redirect an implicit attachment to its replacement. A
missing or closed target fails instead of choosing another.

Every page the session holds is in its target inventory: the initial page, tabs
agents open, tabs the person opens, and popups of any of them. The
[ledger](../packages/browser-runtime-core/src/browser/surface-ledger.ts) claims
each page it registers for its session's
[router](../packages/browser-core/src/session-cdp-router.ts); another session's
pages, even in the same profile, are never listed or attachable. Agents receive
one `Target.targetCreated` for each page that joins the session after it opens,
a tab the person opens included: the router holds a page's announcement until
the ledger claims it. They receive `Target.targetDestroyed` when the page or the
person closes one; an agent's own `Target.closeTarget` answers instead. Chromium
also sends `Target.targetInfoChanged`; Electron does not. Neither the person's tab
selection nor the agent's target selection changes the other:
`Target.activateTarget` and `Page.bringToFront` only check that the target still
exists, and new agent tabs appear in the inventory without pulling the viewer
away from the page they selected. Popups appear in the inventory beside their opener;
opening one never selects it for a person. Selection is an explicit client action.

The web and desktop New tab is a start page that opens nothing until the person
chooses: a website or search opens through an identity target in the person's own
browser for the profile shown in Browse with; Duplicate tab uses the tab's session
target, so the copy stays beside the original; "Open this page in…" copies the page's
candidate-read URL into another identity's target and never moves the original.
Browsing history is local to this deployment, signed-in person and profile, with none
for Guest ([store](../packages/client/src/host/recent-sites.ts)). It keeps full URLs,
titles from the person's own recorded navigations, visit and typed counts, and the last
visit. Before every write it retains at most 300 entries per profile, 128 profiles,
90 days and 1 MiB of serialized UTF-8 data, evicting oldest visits first. URLs longer
than 2,048 characters are not recorded; titles stop at 200. Recent-site tiles derive
at most 12 origins from this history. Legacy recent origins migrate with no title or
typed count, so they cannot inline-complete until typed again.

An address-bar navigation counts when its own load ends, including a same-URL
navigation and redirects. Stop or no load beginning within 10 s records nothing;
agent activity never starts a history intent. Clearing history fences late writes;
an open the Host already granted still completes, and only a change of signed-in person
or deployment refuses a late answer ([viewer scope](../packages/client/src/host/viewer-scope.ts)).
Both address fields share the omnibox model and controller. Search suggestions use
the authenticated `browser.searchSuggestions.get` read only when the Host advertises
`browser-search-suggestions-v1` and General → Show search suggestions is on. The
preference is local to this deployment and person, defaults on, and requests only
search words, at least 100 ms apart. The Host bounds Google's response to 64 KiB and
1,500 ms. Old Hosts receive no suggest requests.

Each open is
`commands.dispatch` → `browser.tab.open`
with one session or identity target, an optional HTTP(S) URL and an idempotency key. It returns the exact
tab ID and a replacement catalog, so only the requesting viewer selects that
ID and adds one history entry. Opening needs no viewer socket and changes no
existing selection or viewport. The Host authorizes it like tab close; the
Runtime serializes it with other tab creation and close operations. The Host durably
binds the authenticated caller/key to its normalized request, selected session and
page operation before submission; the Runtime also retains a bounded 1,000-key
replay window. Replaying a completed Host key preserves its exact tab ID,
even if that tab later closed; the returned catalog always describes the current inventory. A closing or ended session
refuses a new open with reason `browser-session-closed`. A starting session or a runtime
that cannot accept a tab yet returns retryable `browser-session-unavailable` before any
submission; `browser-tab-open-outcome-unknown` is reserved for a submitted operation whose
result cannot be recovered. Expo retains its legacy
`surface.open` viewer message.

Epoch 41 extends `browser.tab.open` with mutually exclusive session or identity targets.
Identity means `{kind: "profile", profileId}` or `{kind: "guest"}` and always names the
person's Host-derived Main Workspace. An explicit placement must match a live profile's
holder or refuse. Without one, resolution honors that holder (including final-save grace),
then the Host's remembered preference, then the existing placement resolver. A remembered
computer is never sent as an explicit choice. Only a ready personally opened browser at
the resolved placement is eligible for automatic reuse; unknown provenance is ineligible.
The Host serializes selection and start per owner and identity. Session-target opens use
only their session turn. New-session admission uses the start queue, releasing it before
runtime readiness and first navigation so unrelated identities can start independently.
The Host opens the requested URL in the new
session’s initial page. Concurrent opens with distinct keys reuse one ready personal
browser and add one page each. Explicit-session opens retain their deliberate target.

The identity result includes `browserStarted` and an authorized `session` view so the client
can adopt it before selecting the returned tab. `BrowserTabOpenBindingSchema` defines the
durable caller/key, normalized request fingerprint, chosen session, initial-page operation
key and outcome. The binding must precede an uncertain start/navigation. Replay preserves
that recorded outcome even after the session ends; it cannot choose another browser.
Completed outcomes survive Host restart and session closure. An uncertain new-session
start refuses with an unknown/ended outcome instead of starting another session; an
uncertain existing-session open uses its same Runtime operation key while that session
remains ready. Keys cannot be reused for a changed payload. The Host retains bindings for at least
24 hours from creation; clients must finish transport retries within that window
and use a fresh key for a later user action. A new binding prunes that owner's older rows,
keeping the most recent successful row per identity as the placement preference. Older
pruned keys have no replay guarantee. Retained completed preferences still replay exactly.
An uncertain existing-session retry also depends on the Runtime retaining its operation
key in the bounded replay window described above.
Host-owned placement preferences are scoped to caller and identity.

The optional `viewport` carries the initial page's CSS dimensions for a newly started
person-opened browser. Desktop callers measure the inner page stage, use
`layoutWidth = max(768, round(W))`, `scale = min(1, W / layoutWidth)` and
`layoutHeight = round(H / scale)`, subject to the existing frame/raster bounds.
Phone callers keep physical-stage sizing. This field neither changes agent defaults nor
adds DPR scaling or a new viewport writer; reflow/follow/Fit behavior belongs to the viewer.

Public session provenance is reader-relative: `you`, visible `task {threadId}`,
positively identified visible `opensteer`, recorded `automation`, or `unknown`.
`projectBrowserSessionOpener` redacts other people and inaccessible task/home IDs;
occupants and usage never determine the opener. Creation provenance is stored on the
session, including the historical Run/task or positively identified home conversation.
Reads recheck membership after task completion; membership changes invalidate the
reader’s browser metadata. Legacy rows retain unknown provenance and are never
automatic personal reuse candidates. Agent session summaries omit opener presentation.

Host-private tab operations use a separate Runtime lane and a per-session Host queue;
page reads for messages run outside the agent and inventory queues. Tab mutations share the
inventory lock, and navigation starts after registration without holding it.
The Runtime orders input, navigation and metrics mutations in one bounded lane per
surface, including raw agent CDP mutations. Observations such as an agent's
`Runtime.evaluate` remain independent. Compatible unsent wheel events sum both
fractional axes; unsent pointer moves retain the newest coordinates and held
state. A scroll transaction latches its initial anchor until a 200 ms inter-event
pause or a producer, generation, geometry, modifier or discrete-action boundary.
Bare pointer movement does not change the latched scroll target; dragging does.
A waiting scroll run retains the wheel sum and the final bare-hover endpoint,
then dispatches that endpoint after the wheel. Intermediate hover events may
coalesce within that run; button/key/page boundaries preserve their order.
Wheel units arrive as CSS pixels after the client's single line/page conversion.
Ctrl-wheel stays discrete, and opposite deltas stay separate to preserve edges
and snapping. Changes of context and discrete actions seal pending runs. Admission refusals identify the producer and input sequence
range; releases for admitted presses have reserved capacity. A held gesture or
key belongs to one producer until release or cancellation. A person's new press
can take over after the old producer's cleanup; competing input is refused.
Geometry writes release held input before changing the page.
The Host assigns each consumer its identity and propagates departure, while the
client cancels held state on focus loss or target departure. On
Electron both share one `webContents.debugger` per page; its hub sends each
command as it is issued, so an agent's `Runtime.evaluate` awaiting a promise that
the person's next click or key resolves cannot hold that click or key. Domain
enables and disables, screencast ownership and Runtime subscription change one
at a time, so one can wait behind another channel's change. A channel's later
command of the same domain waits for its enable or disable; a command of another
domain does not, and can reach Chromium first. When its last channel goes, or
the page closes, the hub waits on nothing the renderer has not answered: every
caller is rejected, changes already under way ask nothing more, and no cleanup
is sent, since the detach ends the screencast and every domain. Only input
waits for Chromium's answer (or the page's destruction) before the detach, and
a channel opened meanwhile attaches afresh after it
([launcher](../apps/desktop/src/browser/electron-browser-launcher.ts)). A person's size change releases held input before changing geometry. An
agent's competing metrics mutation is refused while another producer holds input.

Closing a session never waits for an agent command. The Runtime ends the
session's CDP routing, which answers an agent command still waiting in a page,
such as a `Runtime.evaluate` awaiting the person's click, with an error, then
closes its pages; it serves its other sessions throughout
([`BrowserRuntime`](../packages/browser-runtime-core/src/runtime.ts)). An
agent's `Target.detachFromTarget` ends its page session the same way, at once,
even on a page under a dialog. The person's commands already admitted get up to
2 seconds to finish. The Host acknowledges close only after storing the session's
terminal state; later transitions cannot change an ended session. If that write
fails, close returns an error while transport and broker cleanup still finish.
The error says the browser disconnected but Opensteer could not save its ended
state, and tells the agent to open a new session.

The latest human action on each page is exposed as `userActivity` in CDP target
information, `Target.attachToTarget` results and Harness `pageInfo`,
`currentTab`, and `listTabs`: an action kind (click, scroll, typing, navigation
or dialog), a timestamp, pointer coordinates where applicable, and
`sinceLastAgentCommand`, true when the person acted after the latest agent
command sent to that page. The Host relays every Run's commands over the
session's one Runtime attachment, so the Runtime measures from the latest
command of any agent. Keys, typed or pasted text, and dialog text and answers
are never recorded there. Harness `currentTab` and `pageInfo` read the
activity before they send the page anything. When Browser Harness learns, on
attach or from either of them, that the person acted since the latest agent
command there, it prints one line to stderr, such as
`[opensteer] The person clicked in this page 4s ago. Look at the page again before continuing.`
The attach and every page command count as commands, so the line appears once
per new action. A resize by the person's view is kept apart as `pageResize`, in
the same places: the width and height the page now shows, a timestamp,
`sinceLastAgentCommand`, and `agentSizeRemoved` when the person's fit removed
an agent's override. It is recorded only when a person's size write changes
what the page shows or removes that override, never replaces their latest input in `userActivity`, and
never brings a popup forward. Browser Harness prints its own line once per
resize, such as
`[opensteer] The person resized this page to 840×790 3s ago. Look at the page again before continuing.`
Both are observation data, not a pause or an input gate. A JavaScript dialog
open on a page is `dialog` (`id`, `type` and `message`) in the same places, and
Browser Harness prints one line about it on attach, when an input action opens
it, and when a raw CDP command times out, such as
`[opensteer] This page shows a confirm dialog ("Delete this listing?"); the page answers no other command until the dialog is answered with Page.handleJavaScriptDialog.`
Input actions enable Page events first, so when their input opens a dialog
they throw `DialogOpenedError` (`error.dialog` holds `id`, `type`, `message`)
at once instead of blocking until the command timeout; what the action did is
unverified.

Browser Harness gives each program a lazy, Playwright-shaped `page`
([page.mjs](../apps/runner/browser-harness/page.mjs)). It is a subset with its
own contract, not Playwright: unsupported members throw. Locators hold no
element; every operation resolves CSS, text, DOM-label or role locators again,
because agent scripts often outlive the layout they inspected. Roles and names
come from Chromium's accessibility tree through `Accessibility.queryAXTree`, so
`getByRole` matches what `ariaSnapshot()` prints; that result is bounded by the
router's 432 KiB limit, and an overflow asks for a CSS scope. Pointer actions wait for a
visible, enabled, stable and unobstructed target, measured by the harness rather
than page timers because background pages may not run animation frames, and
check the point again after moving there; a page can still change between that
last check and the press. A visually hidden control activates through its
visible label. `includeHidden` admits nodes Chromium's tree ignores, whose names
may be empty. Retries end at the
first press or insertion: an action failing after that reports an unknown
outcome and is never replayed. Fill selects the field's own contents and
inserts trusted text, which controlled inputs accept. Key names are validated,
and macOS editing commands follow the connected browser's operating system,
which may differ from the Runner's. The older helpers remain; `fillInput` keeps
first-match semantics on the trusted path.

On a [natively shown page](#shared-viewing-and-previews), activity is a
conservative observation of local interaction. Before dispatching an `Input.*`
command, from an agent or a viewer, the page's debugger hub registers it as
outstanding until the command itself settles, even when the channel that sent it
closes first. A person's mouse press (a click, with
its coordinates) or key press (typing) is recorded only when no input command
is outstanding on that page; scrolling is not recorded natively. Overlapping
local activity may be omitted; missing activity never proves that the person
did nothing ([launcher](../apps/desktop/src/browser/electron-browser-launcher.ts)).
The hub accepts only the router's reviewed input methods; it rejects derived
touch and gesture methods whose native events can arrive after the command settles.
Agent `Page.bringToFront` and `Target.activateTarget` succeed without moving focus.
If a page renderer crashes, pending agent commands fail with a reload instruction;
the page remains available for reload and subsequent commands.

Every command re-checks authority. When the session ends, belongs to another
Workspace, or its profile grant is revoked, the command fails with a message that
names the next step and the connection closes
([`BrowserService.attachCdpForAgent`](../apps/host/src/browser/browser-service.ts)).
Runners that predate session addressing still connect to
`/internal/v1/browser-cdp`, which follows the Run's most recently opened session
and closes when another is opened; a new Host admits older Runners
([compatibility](host-boundaries.md#compatibility)).

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

The real Runtime wire journey is
`pnpm exec vitest run apps/browser-runtime/src/browser/editing.test.ts`.
`OPENSTEER_EDITING_EVIDENCE_DIR` selects its JSON, event trace and PNG output root.
`OPENSTEER_EDITORS_FIXTURE_DIR` can name an editor harness directory containing
`index.html` and `probe.js` for CodeMirror, ProseMirror, both Monaco modes,
Lexical, Draft, React, xterm and the keypress canvas. The journey prints its artifact directory. The authenticated Host-to-Chromium journey is
`pnpm test:integration apps/host/src/browser/browser-editing.integration.test.ts`;
`OPENSTEER_EDITING_HOST_EVIDENCE_DIR` selects its output root, and its report includes
control/Watch routing and binary envelopes. Electron advertises editing v2 with baseline clipboard. Qualify its
observer, commands and compositions with the shared
[engine journey](../packages/browser-runtime-core/src/test-support/editing-engine-journey.ts)
through `pnpm test:vm`; clipboard qualification additionally requires the native
engine clipboard port. The isolated Electron clipboard remains gated while Personal uses
baseline clipboard with v2 editing. The real desktop renderer's v1 baseline and v2 editing
with baseline clipboard run together with
`pnpm test:vm -- bash scripts/test-viewer-clipboard.sh --editing-v2`.
The web viewer has no explicit Copy Image action yet; that image-copy gesture is a follow-up.

## Agent CDP boundary

Agents act in the main world of every frame in a page's own renderer, including
cross-origin frames there, with exactly the reach of that frame's own scripts,
plus a person's input. A cross-site frame runs in its own renderer, which agent
CDP never attaches: the router admits only the pages a session owns and refuses
auto-attach. Like a person, an agent works inside an embedded login or payment
frame through input, or navigates the tab to that frame's origin. It never gets
anything those scripts cannot get: HttpOnly cookies, request or response
headers, other script worlds (isolated, preload and platform worlds), the
network outside the page, privileged storage or browser APIs, the machine clipboard, or
the browser's own diagnostics. Reading a cross-origin frame's storage through
that frame's own main world is therefore intended. Reaching an isolated world
is not, and neither is a header the page's fetch never saw.

The [router](../packages/browser-core/src/session-cdp-router.ts) enforces this
for both engines with an exact
[allowlist](../packages/browser-core/src/agent-cdp-allowlist.ts). It covers the
page methods for navigation, input, page scripts, DOM, accessibility,
screenshots, PDF and emulation. Each method has an exact parameter schema:
names, required values, types, enum values and nested fields. Agent-visible
events are listed by name, each one something a frame's own scripts could
observe. No domain is allowed wholesale. Every other command is refused with
`forbidden`, including the Network, Fetch, Storage, Debugger, Audits, Security
and Log domains, `Network.loadNetworkResource` and `Page.navigate`'s
`referrer`. Every other event, such as DOM ad-tagging verdicts or one Chromium
adds later, is dropped. Log entries are Chromium's diagnostics, not the page's: a blocked CORS fetch logs
the response header that the page's fetch never sees, with `source:
"javascript"`. Agents see page console output only through main-world
`Runtime.consoleAPICalled` and `Runtime.exceptionThrown`. At browser scope only
the router's own `Target` commands and `Browser.getVersion` remain.

`Opensteer.fillLogin {loginRef, field}` is a separate platform method for
[Passwords field fills](passwords.md#filling-a-field). The Host explicitly admits
it independently of `fileStaging`, requiring browser `signIn: {version: 3}` and
a live lease for the connection's Browser Session and calling Run's Workspace;
missing or foreign authority answers `{status: "expired"}` before forwarding.
It rechecks after asynchronous session admission. A closed browser answers
`expired` before attachment checks; closing it does not revoke the Workspace's
sign-in lease. The runtime requires an
attached page CDP `sessionId` and full-control access, resolves that exact target,
and handles the method before generic CDP dispatch. A browser-level call is
`bad_message`; the method is never forwarded to Chromium. Its result contains
only a status. Filled values remain readable by the approved page's scripts,
including the agent's main-world JavaScript.

Agent keys use Chromium's cross-platform key identity: Browser Harness omits
`nativeVirtualKeyCode`, and the router validates then discards that legacy field
from older agents before engine dispatch while translating supported Meta editing
chords to explicit page commands unless the caller supplies its own commands.
Unhandled keys stay page actions rather than invoking browser or OS shortcuts,
avoiding macOS's native event/cursor path; pasting the host clipboard stays refused.

The allowlist names the devtools-protocol release it was reviewed against, and
the browser runtime pins that release; a
[test](../apps/browser-runtime/src/browser/agent-cdp-allowlist.test.ts) fails
when the two differ, or when an entry is not in that spec. An upgrade therefore
forces a review. Anything Chromium adds stays refused until it is reviewed and
listed: a method, parameter, nested field, enum value or event. A newer engine
can only narrow what agents get.

Main-world access is granted by positive provenance. Nothing is admitted
because it was never reported as foreign.

- **Inventory.** When the agent attaches to a page, the router enables Runtime
  on that session itself, and nothing the agent sends there reaches the page
  until Chromium has reported every live execution context to it, then each
  creation, destruction and reset. A page under a JavaScript dialog reports
  none until the dialog closes, so the session is the agent's at once and its
  `Page.handleJavaScriptDialog` alone goes ahead. A context is a main world only when Chromium describes it with
  `auxData.isDefault` true, `auxData.type` `"default"` and a frame ID. The
  inventory follows navigations and renderer swaps: a context ID that a new
  renderer reuses takes its newest description. It does not depend on the
  agent: the agent's `Runtime.enable` and `Runtime.disable` only decide whether
  it receives Runtime events, and the router answers its `Runtime.enable` by
  reporting the main worlds that exist.
- **Commands.** Every object handle in the parameters, at any depth, must name
  an object in a main world that this session reported. This covers `objectId`,
  `Runtime.callFunctionOn` `arguments[].objectId`, `promiseObjectId` and every
  other field the CDP spec types as `Runtime.RemoteObjectId`. V8 writes a
  handle as `<isolate>.<context>.<object>`. A handle that is not in that
  canonical decimal form, or that names an unknown, destroyed or non-main
  context, is refused before Chromium sees it. Execution-context parameters,
  `includeCommandLineAPI` and parameters the shipped CDP spec does not define
  for the script methods are refused outright. An agent's `objectGroup` names
  are prefixed with its session, so it can never release a group the platform
  holds on a shared debugger session.
- **Events and results.** Context events, console messages and exceptions are
  forwarded only for main worlds. An exception that names no context is
  dropped, and so is any event that carries a handle from elsewhere. A command
  result that carries such a handle is refused. Page data inside a result that
  only looks like a handle is not a handle.

`BrowserCdpBackend.attach` must return a channel that behaves as a fresh CDP
session. A Chromium CDP session does. Electron multiplexes one
`webContents.debugger` per page, and only the first `Runtime.enable` on it
reaches Chromium. Its debugger hub therefore enables Runtime itself for as long
as the debugger is attached, and a channel is ready only after that; commands
issued while that enable reports contexts wait for it, in issue order. The hub
keeps the page's contexts and reports them to each channel that enables Runtime
([launcher](../apps/desktop/src/browser/electron-browser-launcher.ts)).

Electron has no qualified default clipboard port. Its editing v2 sessions use
baseline clipboard transport. No native clipboard addon, pasteboard redirect or
clipboard attribution preload ships with Personal. Baseline scripted-write
refusal remains, and page clipboard reads stay refused. Isolated Electron
clipboard support requires a separately reviewed engine boundary before it can
be enabled.

Key events that would paste the browser computer's clipboard are refused on
every engine: on a person's Mac it can hold a password they just copied. On an
engine that shares the machine clipboard, agent native copy and cut commands and
their chords are refused too, so they cannot overwrite what that person copied.
The headless Chromium engine keeps copies in its process-local virtual
clipboard, cleared at the end of each person scope.
Agent commands invalidate person attribution and never create a person scope.
Runtimes advertise
`cdpBoundary`, and the Host refuses agent CDP to a runtime that does not. The
[Electron smoke](../apps/desktop/scripts/electron-cdp-boundary-smoke.ts) and the
[Chromium runtime test](../apps/browser-runtime/src/browser/chromium-runtime.test.ts)
and [view-following test](../apps/browser-runtime/src/browser/chromium-follow-view.test.ts)
drive a signed-in session through the boundary. Before the agent attaches, a
platform channel holds objects in other worlds. The agent then tries those
handles before and after its own `Runtime.enable`, and forges handles from its
own isolate prefix. The smoke and the test also check that private-world
console output stays away from the agent, and that a blocked CORS fetch leaves
no header value anywhere the agent can read. The Electron smoke repeats the
probe after a renderer swap. Both write their reports to
`OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR`.

## Shared viewing and previews

Browser details use the authenticated `/v1/browser-sessions/<session ID>/connect`
control stream and accept input at any time.

On the desktop app, a page that lives in this computer's own Browser Runtime (the
Personal browser, or one this computer lends to another Deployment) is shown
natively: the real page sits in the Browser panel and takes the person's mouse
and keyboard directly. Every other view (web, phone, another computer's page,
previews) shows the frame stream. A view decides once, up front: native only when
desktop main finds the session in its own runtimes and the Host advertises
`browser-target-control-v1`; otherwise it streams. Connection verification owns
that capability list and carries it through the attachment-scoped desktop access
snapshot into the Host client. Reverification recreates the client when the list
changes. An unknown list keeps presentation pending; a verified list without the
capability chooses streaming. The renderer does not rediscover the descriptor.
Locality is never authority: main mounts a page only after the Host's first
`browser.snapshot` on that window's admitted control socket for the session,
which main proxies. Closing that window's last such socket, logging out, closing
the page, stopping its Runtime, or reloading the app removes the page at once;
a reconnect needs a new snapshot. A native view keeps its control socket but
sends no picture subscription and no `viewport.follow`: its stage size reaches
the ledger in-process with the same follow semantics (below). Native
presentation never falls back to streaming; if a page cannot be shown, the panel
says so ([presentation](../apps/desktop/src/browser/browser-presentation.ts)).
Failures block only the admission/request generation that failed; a fresh
admission or target change reconciles the latest desired tab, and stale request
results cannot replace it.
App dialogs and menus hold document-owned overlay tokens while open, including
their exit animations. Each overlay registers its token before its visible commit,
and acquisition is ordered before presentation requests. Detached windows with no
pending presentation show overlays immediately; pending or live presentations
require main's acknowledgement first. Tokens belong to overlays and survive tab
and presentation changes. Drawers release them after their actual exit animations
finish or cancel, including reduced-motion transitions.
Decorative page glass is available only on macOS and Windows; Linux creates no glass window and sends no glass scenes, while the task marks' acting ring and app-front marks still show agent activity. A glass appearing never raises its window above the app the person is using: on macOS it is ordered in just above that window, and becomes its child once the window is focused ([glass](../apps/desktop/src/browser/page-glass.ts)).

A page is the size of the person's view of it, as a window is, and an agent may
lay its own size over that, as Chromium's device emulation lies over a window's
size ([ledger](../packages/browser-runtime-core/src/browser/surface-ledger.ts)).
The ledger alone decides each page's geometry: the person's size, and the agent's
override if one stands. On the desktop engine an ordinary layout that fits the
native stage uses real view bounds, at the display's real pixel ratio and screen.
If the ledger's ordinary layout exceeds either stage axis, the engine uses
device emulation at the full layout size with `deviceScaleFactor: 0` (the page's
own scale), and the stage crops it. An agent's override uses device emulation,
forwarded to Chromium whole. The Chromium
engine applies the person's size as emulation at scale 1 on an ordinary
1920×1080 screen, grown for a larger page.
Every size write names one page and changes only that page. An agent's
`Emulation.setDeviceMetricsOverride` is what its target shows until the agent
sends `Emulation.clearDeviceMetricsOverride` or the person fits the page; either
returns it to the person's current size. A zero width or height in the override
follows the person's size. A zero scale factor keeps the page's own scale, as in
Chromium: the display's on the desktop engine, so 2× on a Retina Mac, and 1 on
the Chromium engine. Each override
replaces the agent's last one whole; nothing is merged. The Runtime refuses
agent-supplied `dontSetVisibleSize: true`: visible-size ownership belongs to the
engine, which derives that flag from its native capture contract. It applies an agent's override through its own
long-lived session on the page: Chromium drops an override at the page's next
navigation once the CDP session that set it detaches, and Browser Harness
detaches after every run.

Two viewer messages carry the person's size. `viewport.follow` says their view
of a page is now this size: the page takes it and keeps any agent override. A
targeted control or watch subscription names its own surface. The interactive
desktop or web view the person is using, the one whose window has focus,
keeps its selected page at its size: a streamed view sends `viewport.follow` when
its page area changes size, when the active tab changes, and when the view comes
into use (opened, shown, or its window focused), waiting while the person holds a
press on the page so a size never lands under it. For a native view, desktop main
gives the ledger the full stage size at the same moments, in-process, with the
same semantics and `pageResize`. Size-changing native bounds also pass through
the ledger's release barrier for remote/agent gestures before the engine applies
origin and size together. Native OS-held keys and pointers retain Chromium/OS
capture semantics. A view in a
window without focus never follows, so two screens on one session do not fight
over it, and the screen
the person returns to takes the page back. The web and desktop apps list a session's tabs as rows
in the sidebar's Tabs section, each opening exactly that tab, rather than in a strip above the
page, so tabs opening and closing never change the page area. `viewport.set` is the
person's explicit fit: it sets their size and removes the agent's override on
that page. A tab reports `sizedByAgent` while an agent's override stands, and a
view offers Fit then, or once the page has settled at a size another view gave
it, such as a phone's fit; a tab without the field comes from an older Runtime,
so the view offers Fit whenever the page and the view differ, as a phone does.
On that computer Fit retains its released, session-wide meaning. Phone layouts, in the native app and on the web at
phone width, never send `viewport.follow`; they scale the picture and fit only
when the person asks.

On a desktop-width view the conversation docks beside the page and never covers it.
Opening it, the page area takes its new width in one layout (a native page is placed
there first), then the conversation's contents glide in for 200 ms; closing, they glide
out for 160 ms, then the page area widens in one step. A streamed view only scales its
current picture until the glide ends or is cancelled, then follows once at its settled
size. Leaving the desktop dock mid-glide (Talk, or a phone width) settles at
once, and a reversal's newer glide settles for both
([layout](../apps/web/src/components/workspace/workspace-layout.tsx)). Dragging the
divider resizes a native page live; a streamed view follows at most five times a second
and once on release. The divider's width is stored once per gesture. A streamed view
narrower than 768 CSS pixels asks
for a 768-pixel layout, with the height that fills its stage at the same scale, and scales
the picture to fit, so a page keeps a tablet layout instead of reflowing to a phone one;
Fit uses that same size and is not offered for the intentional scale. Reduced motion has
no glide and follows straight after layout
([viewport](../apps/web/src/components/browser/browser-viewport.tsx)).

A native page follows its stage's real size when this window is focused, with no
768-pixel floor, and Opensteer adds no scaling of its own, so Chromium's mobile-viewport
and pinch-zoom behavior stay intact. Its view shows the agent's override if one stands,
else the focused stage size or, while unfocused, the ledger's person size. Focus and blur
update that choice directly, so a delayed ledger follow cannot restore an older stage size.
Another view, such as a phone's Fit, can set the person size while this window is unfocused. On each axis where that size is
smaller than the stage, the view is that size, centred horizontally and flush with the
top, and the panel shows a margin around it that a click never passes through. On an
axis where it is larger, the view fills the stage and Chromium crops the page; cropping is
the only case where the area shown differs from the page's viewport. This applies
to both agent overrides and ordinary ledger layouts. The ledger owns the page's
layout. A mounted native page is shown at its true size, with a margin when smaller
than its stage and a top-left crop when larger. While the page is natively cropped,
a simultaneous remote stream shows that same content region and describes it
separately from the full layout. Outside native cropping the stream covers the
whole layout. Agent viewport screenshots still cover the full CSS visual viewport
in input coordinates. Fit explicitly clears the agent override and sizes the page
to the requesting view; starting a stream never performs Fit. Electron owns the visible
rectangle through real view bounds, including the full layout size of an unmounted
page. Its engine adds `dontSetVisibleSize: true` to layout emulation while preserving
the agent's other metrics. This prevents CDP from independently resizing the widget
and restoring a cached size when Fit clears emulation. The mounted page and
stage hole use a uniform 15-DIP radius on all four corners. That radius masks
drawing only: the entire page rectangle, including the corner arcs, receives input;
the margins outside it never do. Fit sends the full
stage size in `viewport.set`, and the engine places the page at that size before it
removes the override. Only the full stage size is ever the person's size, never the
smaller view.

Page fullscreen is contained. On the desktop engine, Browser Session pages may use the
fullscreen permission and no other. Every page and popup is created with
`disableHtmlFullscreenWindowResize`, so a fullscreen element
fills the page's current viewport, placed and cropped as above. It neither removes an
agent's override, changes the page's size, enters the system's full screen nor hides the
app around the page. Escape, or the toolbar's Exit full screen control, leaves it
([session policy](../apps/desktop/src/browser/browser-session-policy.ts)).

An agent's viewport screenshot is in input coordinates: pixel (x, y) of a
`Page.captureScreenshot` image without `captureBeyondViewport` is `Input` coordinate
(x, y). Under the page's geometry lock, the Runtime reads the page's pixel ratio (an
agent's positive scale factor, else the native layout/CSS ratio) and visual viewport.
When the agent named no `clip`, it always constructs the visual-viewport content clip,
even at DPR 1, rounding its origin and dimensions to whole CSS pixels and keeping
dimensions positive. Explicit clip geometry stays as requested; the forwarded `scale`
is the requested scale (default 1) divided by effective DPR. Visual-viewport pinch scale
does not enter that conversion. It never changes the page's emulation for
this ([controller](../packages/browser-runtime-core/src/browser/controller.ts)). A
`captureBeyondViewport: true` capture passes through unchanged, at the page's own pixel
density, 2× on a Retina Mac: Chromium cannot make one in CSS pixels without laying the
page out again. The router's 432 KiB result limit applies to both; a larger image fails.

A page has its size before anyone sees it. A person who starts a browser from a
view sends that view's size (`StartHostedBrowserBody.viewport`); the Host puts
it in the attach ticket, and the session's first page takes it before the first
navigation. Otherwise the first page starts at `defaultBrowserViewport`,
709×729, the Browser panel's page area in the desktop app's default window
([frame limits](../packages/browser-core/src/browser-frame-limits.ts)). A tab
the person opens starts at the `viewport` its `surface.open` names, a popup at
the size its opener shows, and any other page, an agent's tab included, at the
size the person's view last followed in the session. A fit or a tab opened from
a phone sizes that page alone, so a glance from a phone never narrows the pages
an agent opens next.

Every frame carries its page's `surfaceId` and full layout size, including any
scrollbar. Opted-in native frames also carry `capture: {width, height, revision}`:
the top-left region in page DIPs, with a monotonic capture revision independent of
the ledger's `geometryRevision`. Strict pointer and wheel input names the drawn
layout revision and size, and echoes `captureRevision` when the frame has one.
Normalized image coordinates map through that recorded region and page scale;
stale aiming receives a correlated refusal, including after a crop-only resize.
Retained dialog pictures keep their original capture descriptor. Release cleanup uses the last valid point. Wheel deltas
are remote CSS pixels: DOM lines are 16 pixels and pages use the corresponding
remote viewport axis. Pointer and wheel commands carry modifiers, including
ctrl-wheel. The input-lane contracts ship with compatibility epoch 41; capture
regions use the additive capability negotiation described below.
Before picturing a page the Chromium engine's Runtime sets Chromium's visible size
to the page's size: headless Chrome shows a tab again at its window's size when
another tab closes, while the page keeps its laid-out size. A desktop page keeps its real bounds clamped to the stage. Its engine invalidates the
applied surface on reparenting and resizing, and on a mismatching frame;
one reconciliation reapplies the current placement's full-layout metrics under the
ledger's geometry lock, even when the parameters are unchanged. Geometry completion acknowledges the requested native bounds and metrics,
independently of page JavaScript and paint. Visible handoff waits for compositor
observation requested after that acknowledgement, with matching native capture
dimensions and current application/lifecycle guards. Electron's public frame
callback does not identify the geometry revision that produced its pixels: an
already composed frame of the same page can satisfy this observation until the
new frame is presented, including same-raster metric changes. This has no fixed
duration bound if rendering stalls. Dialog controls, answers and revocation remain
reachable; cancellation never waits for paint, the ledger lane never waits for
paint, and no timeout manufactures readiness. Capture revisions identify the
applied capture interpretation, not the metrics revision that produced the pixels.
An open dialog preserves existing content and defers blocked geometry until answered.
A picture of another size or
shape than the declared capture region (the full layout for a non-native engine),
to within a pixel and even when Chromium labels it with that size, is never shown: it was made before the latest resize, or that
happened after the picture started. A page with nothing new to draw may send no
other, so each such picture, like each tab closing, asks the Runtime to size the
view again and restart the picture. Requests made while a repair waits to start
join it; a mismatching picture that arrives once it has started, even before
Chromium answers the restart, asks for one more. A matching picture asks for
nothing, and nothing restarts on a timer. Electron 44.9.2 includes the upstream
[hidden-rendering fix](https://releases.electronjs.org/pr/54341), first shipped in
44.5.0. A desktop page that is not mounted rests in its own window, sized to the
person's size. Rendering leases cover screenshots, streams, agent channels and required paint waits;
releasing the last lease restores normal background throttling. Visible pages keep
normal animation, and a mounted page stays mounted while its window is hidden or
minimized; background throttling there follows the same demand. Its resting host is
matched to the page's current bounds before reparenting; its resting size then
lands through the ledger's release barrier. Native admission and placement continue when the app document is hidden,
without waiting for animation frames. Hiding the Browser panel or opening settings or
the start page releases the presentation. No synthetic redraw or capture is used to repair engine visibility.
The local Desktop viewer combines document visibility with native screen lock,
display sleep, system suspend and login-session activity. A hidden client pauses
its Watch/Control pictures, the viewfinder and owner-view capture, and stops
owner-view renewal; agents and remote viewers keep their own independent demand.
Each view keeps its last picture while paused or reconnecting and shows it the
moment the page is shown again, until a newer picture replaces it; it takes no
input against it. Only a closed session, a target the catalog no longer lists, a
terminal close or a change of login clears it. Native Mac capture
still refuses a locked screen. Stream pictures are capped at
twice the page's CSS size, shrunk to fit the frame limits: Electron on a Retina Mac composites at 2×, headless Chromium at
1×. Native stream raster validation uses the applied capture region and actual native
display scale, including under agent emulation; agent DPR never substitutes for
native compositor density. Emulated Playwright streams retain Chromium's compositor density.
Screenshot conversion uses a positive agent DPR even when it is lower than the
display's, because screenshots name input coordinates. A write that leaves a page's metrics unchanged sends Chromium nothing,
releases no held button and restarts no stream. A drag reports sizes faster
than a page reflows, so a `viewport.follow` still waiting last in the viewer
queue for the same page is replaced by the newer one; a resize never moves past
anything the person did in between. A follow for a closed tab is ignored.

Each page orders its own size writes, so a write Chromium holds on one page
never keeps another page waiting. A page with a JavaScript dialog open answers
nothing else, a size write included, until the dialog closes. The dialog is
tab-modal, as in a browser: a command the page holds, such as the click that
opened it, finishes when the dialog closes. Dialog answers, tab selection,
capture demand and close operations bypass that wait. New ordinary input to a
page with an open dialog is refused rather than accumulating behind it. The person can switch,
open and close tabs while a page's dialog waits, and closing that page's tab,
by `surface.close` or an agent's `Target.closeTarget`, closes it at once. The
Runtime keeps each page's open dialog from the moment it opens and shows it to
viewers whenever that page is the one they see, including after a tab switch or
a paused stream. The person's size waits for the dialog and reaches the page
once it closes; an agent's override is refused with a message to answer the
dialog first; the page's picture starts once the dialog closes, so the stream
never waits on it. Each dialog has an `id`, and `dialog.respond` names it. An
agent answers with `Page.handleJavaScriptDialog` from the run whose click
opened the dialog or a later one. The ledger is the single source for target
metadata and `Page.javascriptDialogOpening` events (whose extra `dialogId` is
the same ID). Browser Harness sends that observed ID with every answer; an
explicit `dialogId` is recommended when keeping an observation across other
work. The Runtime checks it against the ledger before answering on the page's
behalf. A stale answer fails and reaches no replacement dialog. Standard CDP
clients may omit `dialogId`, retaining Chrome's semantics of answering the
dialog open now. Answers bypass commands the dialog holds. On Playwright the
ledger answers through the CDP session that heard the opening.

A Runtime advertises `modules.browser.sharedControl` for shared pages, view
following, the attach ticket's initial size and dialog IDs. For an older
computer the Host omits `viewport.follow` and ticket `viewport`, strips
`surface.open.viewport`, and strips `viewport.set.surfaceId` so Fit keeps its
released, session-wide meaning. New tabs use that Runtime's existing size.
Views scale the picture until the person fits it. The Host gives each older
dialog an ID in snapshots and changes, keeps it until the dialog changes or
closes, and forwards only one answer for that ID, with `dialogId` removed.
Viewers always use the current contract
([compatibility](host-boundaries.md#compatibility)).

A transcript destination may name a tab; that one explicit navigation selects it
once, and later human tab selections stay independent from the agent.

Previews — a working reply's live picture in the web and desktop apps, and the mobile app's
tiles — use `/v1/browser-sessions/<session ID>/connect?mode=watch`, a passive
preview transport rather than a user-facing mode. The old Watch page is gone; `/live` opens Chat. A Watch socket accepts only
`stream.subscribe`, `stream.ack`, and `stream.unsubscribe`; the Host refuses
navigation, tab changes, viewport changes, input, clipboard, CDP, and profile
state commands before they reach the Runtime, and never changes a page's size. Watch receives the same bounded binary image envelope as control, with
a `watchToken` in the frame header.

The token is flow control for both Control and Watch. The Host sends each viewer one image at a time
and keeps only the newest one waiting; the viewer echoes the token in
`stream.ack` once it is done with the image — drawn, or dropped because it could
not be decoded or because another tab came forward — and the next follows. A
token that is not the outstanding one is late and changes nothing, so a title or
address changing while an image is out never interrupts presentation. A viewer that
holds an image for 15 seconds is closed as stalled and reconnects. Input never
waits for image credit. The web presenter lives outside React's picture updates,
shares one explicitly closed `ImageBitmap` across main and preview canvases,
finishes its current decode and retains only the newest pending image. Each
canvas's drawn descriptor drives aiming and cursor alignment
([presenter](../apps/web/src/components/browser/browser-presenter.ts)). The Runtime maintains at most eight demanded casts per session; further demand receives
a typed `browser-capture-limit` refusal at the Runtime boundary. The Host admits the
first eight distinct demanded targets beside its demand aggregation and sends each targeted
reader `browser.stream.state` (`admitted` or recoverable `capacity`). A capacity-waiting
reader keeps its demand; releasing an admitted target automatically admits the next reader.
Sending the subscription alone does not establish a live picture: only a matching frame does.
The Runtime maintains a cast for each admitted surface, and the Host keeps its newest
image while that demand lives. A legacy session-wide subscriber also retains the
bounded inactive-tab pictures needed beneath a dialog when it returns to a tab;
those are cleared when that session-wide demand ends. A late subscriber to that surface starts from the
current picture. Frames, dialogs, navigation, input and clipboard remain addressed
to that exact surface. Watching never activates a page or writes its viewport.
Legacy clients retain the session-active stream and popups answering their recent
input come forward; targeted input never selects a popup. Targeted readers require
`targetedStreamingVersion: 1` and refuse older producers.

A native view follows its target without pictures: `stream.subscribe` with the
`surfaceId` and `frames: false`. Only a control socket may send it, and it must name a
surface. The Host replays that target's current dialog at once (`null` when none) and
routes later dialogs, target changes and input as for any targeted control reader, but
never sends it a frame, and the subscription takes none of the eight capture slots; a
picture subscriber to the same surface keeps its frames. The Runtime observes the target,
its dialogs included, without starting a screencast or taking one of its capture slots. The Host advertises
`browser-target-control-v1` and passes such a subscription only to a Runtime that
advertises `modules.browser.targetControl`; for any other it answers `browser.error`
(`conflict`, reason `browser-target-control-unsupported`) and never requests pictures
instead ([compatibility](host-boundaries.md#compatibility)).

The additive Host capability `browser-capture-region-v1` enables `stream.subscribe`
with `captureRegion: true` for ordinary and targeted Control/Watch readers. The
Host negotiates upstream only with a Runtime advertising
`modules.browser.captureRegion: 1`. It keeps negotiation per viewer, forwards
capture descriptors only to opted-in readers, and strips the new fields for older
strict-schema producers. A non-opted-in reader may receive a full-layout picture
without the descriptor. Input without a capture revision is accepted only while
the current native capture covers the full layout, checking the layout revision
when supplied and mapping through that layout. If a native page is cropped, that reader receives the
existing explicit unsupported policy as `browser.error` (`conflict`, reason
`browser-capture-region-unsupported`); it receives no cropped picture labelled as
full. Updating the viewer or the person's existing explicit Fit action resolves
that incompatibility. No subscription performs Fit or changes native presentation.
Optional Runner descriptor features are disabled by Hosts that do not understand
them; this additive viewer opt-in changes no Host API epoch. Renderers opt in explicitly; the shared client transport never
adds region support on a caller's behalf. Web and mobile viewers opt in, render
the declared region at its aspect ratio, and echo the drawn layout and capture
revisions on pointer and wheel input. Remote regions fit the main viewing stage
without enlargement; previews may enlarge small regions to fill their boxes.
The canvas, aiming rectangle and cursors share that scale. Native frames always
have a 15px remote drawing radius, independent of desktop mount state. Mounting
or unmounting at equal capture geometry does not change the capture revision. Main views, previews and mobile use the same 24px
right/bottom gradient fade as the desktop native crop.

The socket retains the login that admitted it. Ending that login closes its
browser sockets, and so does the login's expiry (a native client's short-lived
access token included), with `1008`; the client then reconnects with the
credential it holds now. Session access is read again every 5 seconds: losing it
closes with the final `4003`, while a failed read closes with `1013` and the
viewer reconnects. A message the protocol does not allow closes with the final
`4002`. Because each socket carries its own authority, a viewer outlives a
reconnect of the Workspace realtime channel: the page stays mounted and only a
change of login, a Host close or a reread that removes the tab ends it. A profile-backed session remains visible to its profile owner, while a
fresh session follows active Workspace membership. The browser catalog includes
`attachedRunIds` from current session attachments, and is refreshed when a Run
attaches, detaches or loses its grant. Lifecycle and catalog changes arrive as
`host.browser-sessions-changed` on every authorized viewer's sockets, regardless
of which Workspace they follow. Conversation usage arrives as
`host.browser-usage-changed` when a use adds a page, changes its title/site or
changes the latest-eight projection. A revisit that changes the catalog's
latest-sixteen conversation list also refreshes the catalog; a timestamp-only
repeat leaves clients alone. Usage is recorded on attachment, an admitted agent target change, or included message
pages. Repeated activity on the same target does not write usage per mouse move. The catalog also carries `acting` — an agent sent
the session a CDP command in the last 15 seconds — and `page`, the title and
site (origin only) of the page the person sees. Those two change often, so they
arrive as `host.browser-presence` patches to the people who may see the session
rather than as a list change; a browser is shown as an agent's live work only
while `acting` is true. Closing or losing a session immediately publishes
inactive presence to the same audience and clears its acting timer.
Agents' own session summaries carry none of these.

The cold catalog includes `tabCatalog`: one generation/revision replacement of at most
64 tabs with up to 16 occupants each, 2 MiB per session (including worst-case escaped
metadata), and 768 KiB of session data per bootstrap. Catalog construction preserves every
supported tab and occupant; invalid or oversized producer data fails explicitly. If the
bootstrap budget is exceeded, clients recover each omitted catalog through the authorized
`browser.tabs.get` read, independently of realtime timing and periodic refresh. Coalesced
session notices keep subsequent replacements current. Catalogs carry origin-only sites, document identity, insertion
order, opener provenance, whether the tab's page is [loading](#loading) and
reader-authorized listed-task/Chat occupants. Tabs render as one flat list; a tab
opened from another follows that opener and its earlier children, in order.
`holding` means a live Run is still attached to the session and has a durable use of that tab; `acting` means admitted work within
15 seconds. Historical usage supplies no occupants. `host.browser-tabs-changed`
replaces exactly one session's catalog, including an explicit empty replacement.
For each reader within a broker generation, changed validated catalog content (including
occupants, activity timestamps and inventory revision) advances the catalog revision.
The Host retains at most 256 SHA-256 digests and assigned revisions per broker; hash
collisions are negligible. An evicted reader receives a fresh global revision on its
next read. Holdings restorations run in session FIFO order and install their results
after metadata loading. History ends with the broker. Generations still use wall-clock
milliseconds: clock rollback or same-millisecond broker recreation remains a known
limitation of restart ordering.

Icons are read by authorized session-scoped `browser.tabIcon.get`; its references
resolve against the bounded live inventory or currently bound, nonclosed durable tabs.
Reads authorize the lineage's latest session and never restore a page. Cold summaries
carry references only; raster bytes are loaded lazily.
The Runner relay keeps one pending picture per surface, rotating between them,
within 128 surfaces and 32 MiB per session. One page's newer picture replaces
only that page's pending picture.

The Runtime emits secret-free activity only after an admitted command resolves its
target, carrying an opaque Host actor token. The Host resolves the current Run's
assignment chain for each reader before forwarding its first command, then
rechecks session admission. The optional metadata wait has one 1,000 ms deadline
(`browserActorMetadataTimeoutMs`, injectable as `actorMetadataTimeoutMs`); authority
invalidation follows the replacement lookup within that same deadline. A lookup
failure or deadline falls back to no actor token so page commands stay usable;
durable page-use recording remains independent of activity. Attachment/service
closure and a Run ending during admission fence held commands after asynchronous
admission and immediately before forwarding. A command entering after its Run
ended still checks Workspace/session authority and may answer, but carries no
actor token and restores neither activity nor the Run's attachment.
The Host coalesces activity to at most 10 Hz per place.
An activity's pointer is the agent's cursor on that page, normalized to the page's view
and labelled with its current geometry revision ([Agent cursors](#agent-cursors)). Stop,
revocation and session end clear activity immediately. `host.thread-place-changed` uses
Host receipt ordering and has a lifetime separate from cursor presence. Each reference
names the Run that acted there, so another Run acting in the same place announces a new
reference.

`browser.contextCandidate.get` reads one authorized tab's current page on demand, without
a viewer socket: its exact document identity, title and full bounded attachment URL. An
address beyond the attachment URL budget is answered with an empty URL. The read never
inspects the page's frames or fields, so it answers at once whatever the page is doing.
Hosts and clients of the previous release also require `eligibility`, `reason` and
`checkedAt`; the Runtime and the Host send `eligible`, `null` and the time of the read,
because any page may be included automatically.

A browser page in a message is a reference to whatever the page was when the draft took
it. Its `auto` and `documentId` say how the page was included and which document it
showed; neither decides admission. The Host admits it on the sender's visibility and the
conversation's Workspace use alone
([Pages and apps in a conversation](agent-orchestration.md#pages-and-apps-in-a-conversation)),
never by reading the page, so a page that has since shown a sign-in form, reloaded or
closed is still sent. These checks run before the admission transaction, after an
accepted-key lookup. Enqueue rechecks idempotency under its advisory lock. A refusal
rereads the accepted key so a concurrent committed duplicate still replays.

`browser.tab.close` checks the expected catalog generation and Runtime inventory revision
(`tabCatalog.inventoryRevision`, sent as `expectedRevision`), which changes only with tab set/order, then makes the
close/last-tab decision at the Runtime under the same inventory lane as tab creation.
The final-tab decision seals the inventory and the Runtime itself publishes closing/closed
status; it does not depend on the caller receiving the response. A stale inventory is refused; clients never infer session closure from a failed
tab close. Attached Runs supply the live-work confirmation facts. A close confirmation stays up
while the browser's other tabs open and close; it lapses when the tab, its holders or whether it
is the last tab change, and confirming sends the inventory current then.

Native latest-place references are recorded as soon as accepted activity arrives, independently
of the 100 ms live activity coalescer. After Host restart, successful native transcript calls
recover their Host-resolved app/phone identity and historical assignment lineage. An ended
session remains an unavailable reference; no screenshots or helper sessions are persisted.

## Agent cursors

An agent at work in a page shows there as one collaborator cursor: an arrow in a deeper
shade of its task's colour, with a white subject glyph and its title in the label. Chat keeps the product's ember cursor. It draws nothing else, no click marks,
keys or highlights; the page shows what changed, as it does for a person working beside
you.

Marks are resolved by thread id from the client task directory during render, so an icon edit updates occupants and cursors without new activity. A task outside that directory uses a muted document. The native glass receives the resolved icon and colour in its scene; it has no Host snapshot.

**Position.** The Runtime keeps each agent's cursor per page
([controller](../packages/browser-runtime-core/src/browser/controller.ts)). Pointer input
(`Input.dispatchMouseEvent`, `dispatchTouchEvent`, `dispatchDragEvent`) moves it to its
point. So does a script-dispatched `click`, `input`, `change`, `pointerdown` or
`mousedown` in the top frame while the agent's `Runtime.evaluate`, `callFunctionOn` or
`awaitPromise` runs on that page: the cursor goes to the target element's centre, or a
closed shadow root's host. The first such event wins, and only while that is the page's
one agent script and the agent sent the page no pointer input meanwhile. Every other
command, typing, keys, reads, screenshots, navigation and emulation included, keeps the
cursor where it is. It is held as a fraction of the page's view, so it stays put across
navigation and resizes, as a resting mouse does. A point outside the view is ignored; a
new Run starts with none. Input points are normalized with the page scale the
screencast last reported, so on a native page under pinch zoom or mobile emulation they
can be misplaced; script targets carry their own scale.

Script targets come from a listener the Runtime installs in a private world of each page
([`PageScriptTargets`](../packages/browser-runtime-core/src/browser/script-targets.ts)),
which neither the page nor an agent can see. It reports an element's centre and the page
scale only, never a value, text, selector or attribute, and ignores trusted events: the
person's, and those of Input commands. A page's own synthetic events during a long
agent `awaitPromise` can steer the cursor. `el.focus()`, non-composed events inside a
shadow root and scripts acting inside frames do not move it, and a document rewritten
with `document.open()` has no listener until its next navigation.

**Presence.** A client shows the cursor from the agent's first command in a page until
the Host clears it (the Run ends or is stopped, access is revoked, the session ends),
the same Run acts in another place with a later `order`, the place goes away, or the
client disconnects ([store](../packages/client/src/host/place-activity.ts)). It does not
expire while the agent thinks or waits for the person; the 15-second `expiresAt` only
bounds older clients. A cursor with no known point appears 50% across and 30% down the
picture; a known point outside a cropped native capture hides it. After a reconnect the
cursor returns with the agent's next command.

**Motion.** One [motion module](../apps/web/src/components/workspace/cursor-motion.tsx)
draws streamed pages, a reply's live picture and native desktop pages, in the glass
window and the raised layer. A critically damped spring glides each cursor without
overshoot and bends toward a target that changes mid-glide. Each layer runs one
animation-frame loop only while a cursor moves (`data-animating`) and changes only
transforms and opacity. A first appearance, a remount and a resize place the cursor
without gliding; removal fades for 180 ms. The name shows on appearing and on each
move, and fades 2.6 s after the cursor comes to rest. Reduced motion replaces the glide
with a brief fade at the new point.

For cursor regressions, choose the cheapest relevant check:
`pnpm exec vitest run apps/browser-runtime/src/browser/agent-cursor.test.ts`
uses real Chromium; `pnpm --filter @opensteer/web test:agent-cursors` checks the
web build against a mock Host. Reuse this cursor flow rather than adding a
journey per animation edge case. Only manual acceptance or release checks need retained
outputs (`OPENSTEER_AGENT_CURSOR_EVIDENCE_DIR` for Runtime results,
`OPENSTEER_AGENT_CURSORS_E2E_ARTIFACT_DIR` for web screenshots and trajectories).

## Site icons

Each tab carries its site's icon (`favicon`), read by the Runtime's surface ledger
([favicon.ts](../packages/browser-runtime-core/src/browser/favicon.ts)) whenever the page's
metadata changes. A top-level isolated-world observer also notices changed declarations,
base URLs and icon media queries, without polling. Matching `<link rel="icon">` candidates
are ordered by distance from 32 pixels (including SVG `sizes="any"`), with the last declaration
winning a tie; failed candidates fall through to the next and then the site's `/favicon.ico`.

One controller per live tab owns acquisition, normalization and cleanup for both Electron
and Chromium. A private page world uses native `fetch` with credentials and its own scoped
policy. Requests retain the page's browser storage, network routing and service worker;
the website keeps its original policy. Cross-origin opaque responses are read through
their exact CDP request ID, correlated by the private world's unique script marker and
frame, including redirects and browser cache hits. No URL-only response lookup or shared
icon URL cache crosses authentication contexts. This fetch has an empty request destination;
a server or service worker requiring an image destination can reject it, leaving a fallback.

SVG, PNG, ICO, GIF, JPEG, WebP, data URLs and blob URLs are decoded by Chromium and become
a 32px PNG within the existing 16 KiB wire budget. The private decoder permits SVG's
embedded styles; Chromium's SVG image mode keeps scripts inert and external resources blocked.
Acquisition rejects sources exceeding
1 MiB, checks decompressed network progress and the returned body, and limits candidates
to 1.5 seconds and the overall job to eight seconds. These checks do not promise a hard
browser network-memory ceiling. The Network domain is leased only during acquisition.
Invalid images, excessive dimensions and error pages fall through to another candidate.
Clients receive an authorized content reference from the Host's tab catalog and lazily read
its raster through `browser.tabIcon.get`; they never contact the website or decode vectors.
A different URL's reference is null until its icon is published, usually about a second
later, so clients read it from the live catalog instead of copying it when the page appears.

Each controller coalesces work to at most one job per second, starts new documents immediately,
retains ownership while a renderer is paused, and fences
publication by document and declaration revision, including same-URL reloads. Successful
preferred selections are reused within their document. Missing or fallback selections get
one automatic retry; after a five-second cooldown, later metadata can trigger another bounded
attempt. Navigation, declaration/media changes and dialog completion provide fresh work.
Closing a ledger aborts acquisition and removes its observer; cleanup acknowledgement is
bounded when a dialog holds the renderer. The Host saves the last successful image beside
the durable tab's committed URL, joining live and durable metadata by exact tab ID and URL.
Navigation publishes its URL, document identity and cleared icon atomically. A different
committed URL clears the stored image until a replacement arrives; same-URL reloads retain
the last successful image. Suspension and rebinding preserve the image and its lineage-scoped
content reference. Metadata queries exclude image bytes, and closed rows cannot resolve them.
Rows saved before icon persistence need one authorized visit to acquire an image.
Client caches are scoped to their Host connection and retain only
successful reads, so a transient catalog miss or reconnect can recover.

Local browsing history retains one of these rasters per origin and profile for the
New tab tiles and history suggestions, including after its tab closes or the client
restarts. Only a person's recorded navigation supplies an icon: the client follows
that exact tab and document as its reference arrives or changes, and reads through
the same authorized `browser.tabIcon.get` path. A later document, removed visit,
cleared history or changed viewer fences pending results. Icon updates never add
visits or change their counts or timestamps. Images share history's 1 MiB budget
and expire with the last visit to their origin; clearing history removes both.
Existing history migrates and gains icons on subsequent visits.

## Loading

A tab is loading from its page's own `Page.frameStartedLoading` to its
`Page.frameStoppedLoading`: the main frame shares the page target's ID, so a frame inside the
page loading on its own never makes the tab load
([surface ledger](../packages/browser-runtime-core/src/browser/surface-ledger.ts)). The
surface carries `loading: true` only while it loads, and the Host's tab catalog repeats it; a
change reaches clients through the coalesced `host.browser-tabs-changed`, never through
activity notices. `navigation.stop` is a targeted page command like `navigation.reload`
(`Page.stopLoading`). Clients offer Stop only while a tab reports `loading`, which a Runtime
that does not know the command never reports.

## Navigation commands

`modules.browser.navigationVersion: 1` negotiates history availability and cache-bypassing
reload together. The Host adds `navigationVersion: 1` to attach tickets only for an
advertising Runtime. Without that claim, the Runtime emits neither `canGoBack` nor
`canGoForward` and refuses the `ignoreCache` reload field, including `false`.
Both engines use the shared ledger's CDP navigation history and controller's
`Page.reload` with `ignoreCache: true` for a hard reload.

The Host retains history availability for the tab catalog and strips both fields
from every viewer snapshot and surface event, keeping older strict viewer readers
compatible. The tolerant catalog carries optional `canGoBack` and `canGoForward`;
clients disable a direction only on explicit `false`. The person's live session
projects `navigationVersion: 1` only while its Runtime supports it; agent session
summaries omit it. Clients send `navigation.reload.ignoreCache` only under that
projection, and the Host refuses the field for an unnegotiated session.

Desktop browser keys share one handler for streamed and native pages. The session
projection gates ⌘⇧R and the focused window's “Reload Without Cache” menu item.
Find remains native-only; web clients leave reserved browser chords to their outer
browser. ⌘⌥←/→ and ⌘⇧[/] switch workspace tabs alongside ⌃Tab on desktop.

For navigation regressions, choose the relevant layer:
`pnpm exec vitest run apps/browser-runtime/src/browser/navigation.test.ts`
uses real Chromium; `pnpm --filter @opensteer/web test:browser-navigation` covers
the mock-web controls. Reuse one navigation flow for end-to-end acceptance;
native keyboard/menu delivery is covered by the
[native browser journey](../apps/desktop/scripts/native-browser-journey.ts):
`pnpm test:vm -- pnpm test:native-browser-journey`.
Only manual acceptance or release checks need retained JSON or screenshots; the existing
output overrides are `OPENSTEER_NAVIGATION_EVIDENCE_DIR` and
`OPENSTEER_NAVIGATION_WEB_EVIDENCE_DIR`.

## Files for pages

A page receives files the way a person picks them: through a file input, a file
chooser, or a drop. The browser may run on another machine, so each session has
a private folder on the Browser Runtime machine
([`SessionFiles`](../packages/browser-runtime-core/src/browser/session-files.ts)).
The harness streams a file the agent can read into it over the session's own CDP
connection (`Opensteer.stageFile`, bounded chunks, size checked) and the
[router](../packages/browser-core/src/session-cdp-router.ts) lets
`DOM.setFileInputFiles` and drag `data.files` name only paths inside that folder.
Download and retired chooser commands are outside the
[agent boundary](#agent-cdp-boundary). The folder disappears with
the session. A Runtime advertises `fileStaging`; the Host refuses staging to one
that does not, with a message to update it.

## Downloads

On the desktop app, a download that a page or the app itself starts is saved to
this computer's Downloads folder without a dialog, as Chrome saves one. One owner in
Electron main ([`DesktopDownloads`](../apps/desktop/src/downloads/desktop-downloads.ts))
takes `will-download` from every Browser Session partition and from the app window's
session, which saves conversation attachments. The Host and service transport
sessions never render pages and refuse downloads.

Chromium writes a download to a temporary file and renames it on its own schedule,
so each download runs alone in a private staging folder in the app's data directory.
Only a complete file enters Downloads, under its first free Chrome-style name
(`report (1).pdf`), as a hard link that never replaces a file, including one whose
name differs only in case. When Downloads is on another volume, the file is first
copied under a hidden name beside it and then linked; only a crash during that copy
can leave the hidden file behind. A Downloads volume without hard links fails the
download. A name becomes one visible file name of at most 255 bytes. Before its
visible name appears, a file gets macOS quarantine (`com.apple.quarantine`, agent
`Opensteer`), which Electron does not apply, so Gatekeeper checks it when it is
first opened. Cancelling, a failed transfer, quitting and the next start remove
staged files; a partial file never appears under a visible name. macOS asks once
before the app may write to Downloads; a refusal fails the download. Each entry
names the host the file came from, without a port.

A download belongs to its browser partition, not its tab: closing the tab or ending
the session does not stop it. For the app's lifetime, main keeps every unfinished
download (at most 100 at once; another is refused and listed as failed) and the 50
newest finished ones. It sends the whole list to every app window over the desktop
bridge's `downloads`, with progress coalesced to four updates a second. A renderer
names a download only by its ID; Open, Show in Finder and Cancel never take a path.
The browser toolbar offers the list once it is non-empty, and the focused window
confirms each completion or failure with a toast, including an attachment saved from
a conversation.

An agent's download is the person's: its click saves the same way and appears in
the same list. Nothing opens by itself, and the [agent boundary](#agent-cdp-boundary)
still refuses download commands and events.

A Chromium Browser Runtime still refuses every download (`acceptDownloads: false`):
its file would land on the Runtime's machine, which may be a cloud container.
Delivering it needs an authenticated path from the Runtime through the Host to the
person's device. On the desktop, a main-process adapter would give that transfer to
the same owner, so it joins the same list; the app session refuses HTTP(S) and the
Host transport sessions refuse downloads, so neither can fetch it directly.

Use `pnpm --filter @opensteer/web test:browser-downloads` for toolbar/list/toast
regressions against the mock bridge. Reuse
`pnpm test:vm -- pnpm test:electron-downloads` for the user download flow when
real Electron/file ownership is needed. Retain its `guest/downloads/` results or
the web's `OPENSTEER_BROWSER_DOWNLOADS_EVIDENCE_DIR` output only for manual acceptance or a release check. Do not add a download journey for each UI edge case.

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
providers and nearby-phone options. Current builds lack the entitlement and opt in
as notice viewers, as do web, iPhone, Linux and Windows viewers. A person using a
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

## Profiles and identity

A browser profile is an owner's durable browser identity: a name, which is a label
rather than an account and need not be unique, plus the Profile Vault's latest saved
state. A session's identity, one profile or Guest (`fresh`), is fixed when it opens.
The person's `browser.profile.create` command and Main's `browser_profile_create`
tool are one operation
([`createBrowserProfile`](../packages/database/src/browser-session-store.ts)). It
creates an empty profile and records a `browser.profile.create` command under the
caller's idempotency key, so a replayed command or agent call returns the same
profile, while separate calls with one name create separate profiles. A specialized
Workspace gets a new or existing profile only through a `browser.access` Request,
which creates and grants it in one transaction. Delegated Threads and Trigger
programs create none.

"Save sign-ins as a profile…" (`browser.session.profile.save`) copies a ready Guest
session's current state into a new profile once. The Guest session stays Guest and
unlinked, so later activity there never reaches the profile. Current agents cannot
ask for this copy; previous-release Runners still can through `browser_profile_save`
([Host compatibility](host-boundaries.md#compatibility)). A fulfilled `browser.access`
or `browser.profile.save` Request stores the Host-derived `{id, name}` of the profile
it created or selected beside the person's decision, and the agent's continuation
names that exact profile.

A profile created, saved, granted or revoked from a Workspace, by an agent, a Request
or the person, sends the owner's viewers `host.browser-sessions-changed` addressed to
that Workspace; they reread the browser bootstrap, which carries profiles and grants.
The person's own `browser.profile.create` names no Workspace, so it sends none: the
client that sent it applies its result, and their other clients see it on their next
reread.

Agents read identity without waking anything. `browser_session_list` reports each
live session's profile, and `browser_tab_read` reports every reachable saved tab's
`profileId` (null for Guest) from its lineage's latest session, asleep tabs
included. `browser_profile_list` with `site` reports, for each listed profile,
whether its latest saved state holds cookies or origin storage for that site under
the sign-in scope rule
([`browserProfileHoldsSite`](../packages/browser-profile/src/source-state.ts)), and
when that state was saved. It reads saved revisions only: live changes arrive with
the next checkpoint, and only the website knows whether a sign-in is still valid.

## Profile state

The Profile Vault holds a profile's only durable state; live browser storage is
disposable on every Runtime. While sessions use a profile, its Runtime saves
changed state on an interval, and it saves once more when the profile closes
([`BrowserRuntime`](../packages/browser-runtime-core/src/runtime.ts)). A session
that ends, cleanly or because its Runtime's connection dropped, keeps its
profile lease for a short grace so that final save is accepted; the first commit
ends the grace. Only the newest revision is kept.

On the desktop engine a profile's start returns only after every saved site is
restored; its first page opens meanwhile on a blank document, which nothing can
navigate before the start returns. A failed restore fails the start. Sites that
hold no localStorage entry and no IndexedDB database have nothing to restore and
are not kept. Restores and saves spread their hidden per-site loads over three
windowless helper views, which bypass service workers, take none of the
Runtime's page slots, and are destroyed before the restore or save returns. A
site gains storage only by running its own documents or workers, but can lose it
without them (`Clear-Site-Data` on a same-site request, eviction), so a save
reads every site that holds storage plus every site the profile's pages
navigated to since it opened. A save covers navigations made before it starts
([launcher](../apps/desktop/src/browser/electron-browser-launcher.ts)).

The [snapshot contract](../packages/browser-profile/src/snapshot.ts) uses Chromium's
10 MiB localStorage quota per origin: keys and values each count two bytes per
UTF-16 code unit, including large individual keys or values. The encoded profile
budget is 64 MiB so a quota-sized value still fits after JSON escaping. Both
Electron and Playwright validate each captured origin separately. A malformed,
over-quota or envelope-budget-exceeding origin retains its last captured state
where available; other origins and cookies still commit. Capture failures report
which origin was rejected, why, and whether its earlier state was retained, without
logging storage keys or values. Direct exports without a diagnostic observer throw
an incomplete-snapshot error carrying the usable snapshot.

On the Playwright engine, the pinned patch keeps the temporary restore page open
until Chromium has acknowledged each localStorage write through a storage event
in a same-origin document. Closing the page sooner can lose pending writes.

Periodic saves (every two minutes by default) and final saves use this same path.
An incomplete save emits `browser.profile.checkpoint.failed` with reason
`profile-checkpoint.origins-incomplete` after committing the usable state, and
periodic saves continue retrying. Desktop records these diagnostics in the local
browser log. There is currently no checkpoint status or warning in the browser UI;
a person does not see an automatic-save failure there.

## Tab groups

Each person keeps their own order and groups for durable tabs across sessions, profiles, computers and Workspaces. A tab belongs to at most one of that person's groups, and its members stay adjacent in their order. Two people can arrange a shared Guest tab differently. Groups grant no access; the tab's latest session remains its authority.

New tabs go to the bottom. A link-opened tab follows its opener, after the opener's group when grouped and after earlier links from that opener. Recording a tab never inherits a group. Moves reorder tabs or whole groups, place tabs into or out of groups, and refuse a destination that disappeared or changed. Joining an existing group appends; a new group forms in place; removing some members puts them after their group, while ungrouping the whole group keeps their places.

Groups have a title, one of Chrome's nine colours and a collapsed state. Moving or ungrouping the last member deletes the empty group. Groups with only closed or inaccessible members disappear from reads; pruning durable tabs removes their memberships and later removes groups with no membership rows. Ending a Run never reorganizes tabs.

Membership and order writes resolve all tabs the person can see, apply the shared core operation and save that full order under the person's layout lock. Hidden, closed and deleted tabs lose saved positions at that write; hidden memberships survive, so a tab that becomes visible again joins its group's run or takes its normal opener/recording place. Reads never write and return saved order filtered by visibility. An organization write above 10,000 visible tabs is refused until some are closed; reads remain bounded. Title, colour and collapse updates need not materialize order.

`browser_tab_read` lists reachable saved tabs, open and asleep, in bounded pages ordered by lineage creation. Each tab's zero-based `position` counts only reachable tabs in the person's resolved order, across all pages. Every page includes metadata and a tab count for every group whose owner-visible members the agent can all reach. Read every page and filter tabs by `groupId` to recover a group’s membership. A partially reachable group discloses neither its metadata nor its ID. `browser_tab_write` groups, ungroups, moves, updates groups, closes exactly the listed tabs or restores at most eight sleeping tabs. `move` takes `tabIds` or `groupId`, optional `toGroupId` (otherwise root) and optional `before` tab or group ID (otherwise end); moved, destination and anchor groups must be reachable in full. Agent organization materializes the person's full visibility, even when the agent has narrower reach. Restore retains membership and position, opens only those tabs and attaches their live sessions to the calling Run. Main can reach the owner's Workspaces; specialized agents stay within theirs, and profile sessions still require grants.

Layout revisions order explicit organization mutations. Session and visibility changes can change the projected membership at the same layout revision, so clients also refresh equal-revision layouts after the existing sessions-changed notice.

## Streamed editing

Streamed browser viewers use the shared [editing reducer](../packages/client/src/editing/reducer.ts)
through the web/desktop [text proxy](../apps/web/src/components/remote-editing/remote-editing-proxy.tsx).
A printable key carries its text once; the proxy's following native input updates its local mirror.
Composition and verified replacements name the target's editing context. Native adapters may supply
`markedRange: {start, end}` in UTF-16 offsets to identify the preedit exactly. Field changes fence late
composition events. The presented frame's geometry places the proxy and IME at the remote caret;
secret fields use a password input.

Browser sockets follow the version and explicit clipboard capability negotiation in
[Remote editing](#remote-editing). The [browser editing transport](../packages/client/src/host/browser-editing.ts)
assembles bounded clipboard parts when an engine clipboard is available and delivers results
only to the operation awaiting them. Page writes go to the active viewer. Sessions without
an engine clipboard retain text copy/cut through the legacy bridge and plain-text paste,
including context-menu actions. Desktop writes use the authorized application renderer's
preload port; web copy/cut gestures arm promised clipboard representations before the remote
result arrives. Local paste events carry text, HTML and files when the engine supports them.
Desktop menu and keyboard paste request a trusted native paste event through the validated
preload port. A custom web menu's Paste action uses the browser's gesture-gated Clipboard API,
since a web page cannot request a trusted native Paste command.

A runtime-originated context menu offers Cut, Copy, Paste and Select All, with link actions when the
runtime supplies a link. Open Link in New Tab uses `HostClient.openBrowserTab`, the same domain
command path as the browser tab UI. Pages that cancel their own context menu do not produce this menu.

Older sessions keep no mirror or autocorrect and receive only baseline operations with exact
representations. The browser adapter supplies the viewer platform to translate primary shortcuts and semantic
commands onto baseline chords. macOS runtimes attach the matching Cocoa command to each
editing keydown so Blink applies it once unless the page cancels it. Range edits,
live composition and rich paste are not projected onto that wire.

Image-only copy results are visibly refused by both web and desktop viewers. **Follow-up: Copy Image
from streamed pages** needs an explicit menu gesture and an image representation in the viewer
clipboard writer. Text/HTML copy and image/file paste use the existing paths.

### Native passkey routing

`OPENSTEER_PASSKEYS=1` enables the optional `browser-passkeys-v1` Host capability.
It is off by default. A runtime must advertise `modules.browser.passkeys: 1`,
receive the browser auxiliary welcome's `passkeys: 1`, and hold a signed attach
ticket with `passkeys: 1` before launching the page provider. The existing page
policy remains in effect otherwise. A shared profile browser is reused only when
its passkey mode matches: an idle browser is checkpointed and closed before
relaunch, while a profile held by another session refuses the attach for retry.
No Host API epoch changes.

Viewers opt in on their control socket with `passkeys=native` or `passkeys=notice`.
The Host projects that mode and its consumer token only to opted-in viewers;
runtime ceremony messages terminate at the Host before viewer fan-out. A request
belongs to one runtime connection, session and document. A person-attributed
request reaches only that person's presenting viewer. Agent and unattributed
requests offer Continue to the eligible viewers; the first native claim binds
the request. Losing that presentation, access or connection ends it without
rerouting. The deadline applies even while an answer is being authorized.

The desktop proxies streamed and native control sockets through main. Main holds
the request before notifying the renderer, and the renderer can ask to present
only its opaque request ID; it never receives the request's origin, options or client
data, only that the offer ended. The OS authenticator receives the actual origin and
complete normalized options from main. Neither main nor the runtime repairs the
OS's client data or other signed bytes. Desktop builds without native support,
the web app and mobile opt in as notice viewers.
