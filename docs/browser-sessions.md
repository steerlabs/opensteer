# Browser sessions

A named profile keeps native browser data on its home device. Its live sessions share
an engine host; each Guest session has its own throwaway browser. Sessions partition page access
even when they share a profile, and a session's identity is fixed at creation. Checks:
[browser-and-passwords](../.agents/skills/browser-and-passwords/SKILL.md).

## Open tabs

A page tab is one entry in the Host's single tab list, beside window, phone and app tabs;
its `tabId` is durable and its live page is a replaceable
runtime binding. Trigger and watch browsers write no tabs. Only a page's latest session can close it,
late updates never resurrect a closed tab, and Reopen restores the same `tabId` under a new
generation. Closing removes the tab from the list and from person viewing, never stopping a Run that
holds the page; that Run keeps it until ordinary release, and binding the closed tab anew fails.
Only committed navigation becomes a restore URL, except that failed navigation keeps its attempted
address. Overlong addresses are never truncated; legacy Chromium error URLs cannot be reopened.

Old document, node and object handles become invalid after wake. A dormant tab whose session ended
needs a new binding on its saved computer and profile, never a substitute or Guest; neither path
restarts a finished Run. Failed automatic restoration waits for the person's Retry. Guest website
state never crosses sessions: Android's private on-disk profile is tombstoned before use, cleared
when its last tab or session ends, and deleted at the next startup. Guest browsing is not RAM-only.

Incomplete catalog snapshots never imply closure. Only committed explicit removal closes a tab;
browser teardown and late updates cannot recreate or delete durable records.

The Host's open budget sits inside the client's deadline, including first paint. Desktop clients
attach as soon as the Host serves, before its own Runner connects, so an open or restore bound for the
hosting computer, or for a computer still reconciling its profile inventory, waits for that browser's
admission within that budget instead of refusing; any other absent computer still refuses at once. An uncertain open
retries with its original key and replays the recorded outcome, so it never starts a second browser. Tickets, native creation and navigation are never blindly replayed. Tab
groups grant no access, and agent reads reveal nothing of a group they only partly reach. Links
opened with Opensteer as the macOS default browser start no agent.

The Host supplies Run attachments, control subscriptions from every device, Watch previews and
pending sign-in, card and passkey steps. The runtime decides when an unprotected page may sleep,
using its memory budget and idle policy; missing Host state keeps it awake. Harness disconnects
do not release a Run's hold. Watch alone never marks a tab as used by a person. Selecting a sleeping
tab or explicitly resuming it as an agent wakes the existing record within its admitted session.

Restore state stays in runtime memory or inside the running browser, never a database, stream or
log. On macOS, Electron captures navigation history with Blink page state and `sessionStorage` in
runtime memory across a tab sleep. On Linux (and Opensteer Cloud Computers), a sleeping tab is
discarded through Chromium's own tab lifecycle (`chrome.tabs.discard`, after freezing to flush
Blink page state and detaching CDP), so it wakes with its history, scroll, standard form fields and
`sessionStorage` while the browser keeps running. A minimal bundled MV3 helper extension (`tabs`,
`tabGroups` and `debugger` permissions only, hidden from tab lists, session CDP and connected
agents) names a tab only while it sleeps: after Chromium discarded it (a discarded tab runs no
script, so nothing it opens can share its name), it puts the tab in its own tab group whose title
is that sleep's name, in the same call as the discard. A wake finds the one tab carrying the name,
activates it, takes its page only if the name is still on that one tab and it is that page's, and
then removes the name. A wake that cannot finish removes the tab before the tab is opened again by
its address; one whose open was abandoned leaves the tab asleep. Opensteer reads Chromium's tabs only
from a read that agrees with itself; otherwise the answer is "not known", never "absent". The
helper marks each tab it sees as not discardable by Chromium itself, so Opensteer is the one that
discards. A tab that cannot be put to sleep under its name is closed and wakes by address; one whose
end is not proven stays guarded until it is, and a discarded tab without a name, which only a sleep
that failed can leave, is removed with it. Closing a sleeping tab or ending its session removes it
from Chromium on evidence: when the session's end returns, the tab is out of every session's reach,
and a removal that is not confirmed is retried in the background a bounded number of times and then
reported as not removed, still guarded. A page whose tab carries no sleep name is an ordinary
page, handed to sessions as any page is, also when the page that opened it has already closed. A
sleeping tab is kept at the left end of the window, left of a private blank tab, with every live tab
to its right; a tab that wakes moves to the right end first. Chromium activates the tab beside a
closed one and puts a tab a page opens beside the active tab, in its group, so neither reaches a
sleeping tab. No tab is discarded while it is the active tab, and a tab that something else made
active loads by itself and is put back to sleep. A tab that still joins a sleeping tab's group
carries its name without being that tab: its name is removed and it is an ordinary page. On Linux without an explicit `OPENSTEER_BROWSER_MEMORY_BUDGET_MB` override, the tab
sleeper reacts to container working set (`memory.current - inactive_file` against `memory.max`, or
bare-Linux `MemTotal - MemAvailable` against `MemTotal`) — sleeping eligible tabs above 70% and
stopping below 60%, evaluated on its timer and again before each new page is created: over the
threshold an open waits, within a bound of about two seconds, while some tab can sleep for it or
while the last sleeps' memory is still being released, and reads the memory again before it goes —
while keeping renderer `Pss` for reporting only and falling back to its page estimate when memory
state cannot be read. A page arriving that no open of Opensteer's made (a popup, a new-tab link)
asks for a pass at once when memory is over the threshold. Sleeping makes it unlikely that a Home
with many tabs on a small machine runs out of memory; it does not make it impossible. When every tab
is in use, nothing can sleep, and a new tab still opens. A storm of pages that a page opens (many
heavy popups in a few seconds) can outrun sleeping, and background tabs can then be lost to the
system, which ends their renderers.

When the browser itself restarts on a Linux Home or a Cloud Computer (a Home update, a crash, a cold
start), each tab reopens at its address. What was typed into a page and not sent, its scroll
position and its back history are not kept across that restart; sign-ins are kept, since they live
in the profile, except that a sign-in made in the last half minute before the browser is killed may
not be (Chromium writes its cookies to disk on its own timer). On a Cloud Computer the browser pool keeps the exact state through idle time, so a
restart is the rare case there. Before each launch the launcher deletes the last session's records
in the profile directory Opensteer owns, so Chromium has no tabs to bring back while it still keeps
the profile's session cookies; a launch that finds a page anyway refuses to start.
Passwords, `contenteditable` drafts, in-progress uploads, playing media position and arbitrary script
memory are never promised; POST results and playing media stay awake during tab sleep. Phones and
Guest sessions promise only a descriptor and URL reload.

Each engine hands every native page to the runtime as soon as it has a handle. A page the runtime
can attribute belongs to one session: its creator, its opener's, or the session that adopts a raw
target. A session's teardown ends all of its pages, admitted or not; a creation its owner abandoned
is ended too. A page of unknown origin, such as one a person opened in a visible browser, is reported
but never ended for its age. Only the engine's confirmation ends ownership: Electron's WebContents
`destroyed`, or Playwright's page `close` or its context ending. A page that ends because its
browser, process or context did leaves its tab listed and asleep; only a requested close, or the page
closing itself as a popup's `window.close()` does, ends the tab. A destroy request is irreversible:
the page never returns to service, a sleep that asked for it has slept, and a tab gets no new page
while an earlier one may live. A registered tab's close succeeds only on confirmation and otherwise
answers retryably while the tab stays listed, reachable by no route. A page still closing keeps its
browser process. Runtime shutdown reports pages it could not confirm and keeps asking, without
failing, so the engine's own teardown and a supervisor restart still run. Page diagnostics carry
ids, states, fixed reasons, counts and durations, never a URL, title or page content; they cover
what the runtime observed, not every cause.

Before Close and admission move to comparing what the catalog says should exist with what the
runtime holds, the Host makes that comparison in shadow from facts it already has: the open tabs and
eligible Run attempts from one consistent catalog read, and the surfaces the runtime already
reports. It logs what it would destroy, which open tabs have no page, and which holds a Run may no
longer keep, and acts on none of it. It adds nothing to any wire. It reads again only for a session
whose tab a commit changed or whose Runs a commit may have changed (binding acquisition, a Run
change or finish, a grant or Runner revoked), one read at a time for the whole Host, and compares
only against a read no later commit superseded; it never runs on a timer, so an idle Host does no
work for it. What it cannot judge (a page still being admitted, a tab whose generation the Host
never bound, a hold by an unknown Run) is counted, not logged as a disagreement, and an id the
runtime supplied is logged only if it has the shape the runtime issues. The runtime reports no
catalog generation, so a page bound at an earlier generation of a reopened tab is recognised only by
the generation the Host bound it at.

## Agents address tabs

Agents see what the person sees: profiles and one list of tabs. Browser Harness is a disposable
shell invocation: `openPage(tabId)` returns a handle bound to that one tab, and the Host resolves,
wakes or restores the browser behind it ([contract](../packages/protocol/src/browser-agent.ts)).
Attaching resumes only that tab, never listing every tab first. There is no daemon: it would stream
idle events over weak links, hold memory per Run and share hidden state between parallel scripts.
`opensteer.callTool` reaches the same tools as MCP through the Run's protected Runner relay; the Host
enforces their authority and records each call as Run activity. No session ID reaches the model,
because two kinds of address made agents open duplicates instead of finding pages already open.
Opening a tab as a profile joins that profile's running browser, as a person's open does; a restored lineage may still run beside it, unseen by agents. Guest belongs to the
task its session's opener records, so tasks never share signed-out state. Every agent entry point
(listing, opening, using, closing and organizing tabs, CDP and actions) passes one admission: live Run,
personal owner, the browser computer's device access, and the Run's resource ceiling, where driving or
changing tabs needs read-write.

## Agent access and input

A browser device declares abilities, not a device class. The Host places a session on its profile's
home and admits only what that browser advertises; it never substitutes another home or infers
abilities from a phone engine name. Guest has no home: a person's own open names the device they are
at when it lends a browser, else the Host chooses. A reply link to an address only the computer's own
network reaches keeps the Host's choice, where the agent works. Host tab open, close, resume and context operations use the
ordinary command channel even when the browser does not speak CDP; resume requires `surfaceState`.

Backend negotiation pins one supported backend to an exact session. An advertised negotiation
failure never falls back, and an attachment reaches only that session's pages and popups.
Every command rechecks Run access and grants; target selection never moves the person's focus.
The [browser action contract](../packages/protocol/src/browser-actions.ts) owns capability details.

Input, navigation and geometry share a per-surface ordered lane; observations stay outside it, so an
agent script waiting for a person's click cannot block that click. A lost answer after a key press
or insertion is never replayed. Person activity is an observation, not an input gate, and never
records keys or text.

Typed actions provide bounded semantic reads and native input, never arbitrary JavaScript.
Document and geometry identities fence stale actions. Scroll must not advance geometry, which would
invalidate points mid-scroll and send traffic every frame. A lost action answer is never permission
to retry. The [wire contract](../packages/protocol/src/browser-actions.ts) owns operations.

Suspended tabs refuse input. Watching never resumes, reloads or creates a view; selecting a sleeping
tab resumes its existing surface instead of opening another record.

Phone browsers have a bounded native view pool. Observation never resumes a suspended tab, and
replacing a covered page must not take the phone's visible page or reload a retained one. Native
attachment revocation fences queued writes and releases debugging without a JavaScript round trip.
The [phone manager](../apps/mobile/src/phone-browser) owns allocation and resume sequencing.

Native picture credit follows transport capacity; after drain, capture the current page rather
than buffer stale pictures.

A failed navigation leaves Chromium's error document committed, and a surface's address stays the
one it tried to reach, so a person sees where they meant to go and the catalog names a real origin.
That address was never visited: `navigationFailed` is what says so, and anything that treats a page
as seen, such as a place's site, retained icons or a sign-in offer, checks it first. History and
context reads use the committed URL, which never changes for this.

History belongs to the profile and only its owner reads it; only a person's own navigations record
visits, never agents or Guest. Search words reach Google only under the person's suggestion
preference. Cursor hints are a bounded enum; CSS, URLs and images never leave the computer. Site
icons load through the page's own storage and service worker, never a cache shared across sign-ins,
and clients read only bounded rasters.

## Agent CDP access

Agents drive the person's browser as browser-use does: every CDP domain, method and event the engine
supports, including Network, Log, Fetch, cookies and storage, every frame and execution world of
their pages, and auto-attached iframes and workers. There is no method allowlist or event filter.

What remains is routing. A Run reaches only the computer, profile, session and browser context it
was admitted to, even when another profile shares the engine: child targets attach only beneath an
admitted target, cookie and storage commands use the admitted context, an explicit foreign target or
context is refused as an ownership violation, and a command whose effect cannot be scoped to that
browser, such as closing a shared engine, refuses. The
[router](../packages/browser-core/src/portable-session-cdp-router.ts) keeps malformed-message and
size checks and input ordering and release; Run admission, Stop, profile home ownership and the
computer's browser access switch still apply. Agents never reach Opensteer itself: its app windows
and targets, preload and platform worlds, IPC bridges carrying Host credentials, or the runtime's
control channel. That isolates the product, not the person's browser.

Agent keys are page input, never browser or OS shortcuts. On an engine sharing the machine
clipboard, an agent's copy, cut and paste use the computer's clipboard. `Opensteer.fillLogin` and
`Opensteer.fillCard` are platform-handled and never reach Chromium.
Card approval binds the top-level merchant, and filling may reach its cross-origin payment frame.
After a fill, page scripts and agent JavaScript can read the value ([Passwords](passwords.md#filling-a-field)).

## Remote editing and clipboard

Editing is negotiated per runtime, Host and viewer. `basicInput` is a separate narrow ability, not
full `editing` or engine `clipboard`: it admits text insertion, backward deletion, Enter,
select-all, marked composition and plain-text copy/paste. Range replacement, cut, rich clipboard,
other editing commands and OS shortcuts refuse. Paste carries only the controlling person's
explicit bytes, never a phone clipboard read; copy returns only non-sensitive selection to that
viewer. Browsers without this ability retain the full editing contract's existing admission rules.

On iPhone the agent has no arbitrary-script, clipboard or paste action and the native helper never
reads UIPasteboard. A website may still ask iOS for Paste permission. The person can approve that
system UI; Opensteer does not claim to prevent the website or its DOM from then receiving clipboard
data. A JavaScript clipboard shim would not be a security boundary and is not used as one. Android's CDP backend permits the same browser access as other CDP engines, including the
clipboard capabilities its engine supports. Releasing the last native CDP permit must make the
WebView debugger inaccessible.
Debug app builds never declare CDP; a release on a debuggable system or provider that fails shutdown
also omits it. The phone still offers each independently qualified browser/viewer/file ability, and
agent backend negotiation returns `unsupported-operation` rather than falling back.
Android cannot map a page-opened popup to an agent's trusted CDP target. That tab remains usable by
people, but an agent receives: “A page opened this tab and this phone cannot hand it to an agent;
open its address in a new tab instead.” Opensteer never reloads or recreates it to bypass that refusal.

For full editing, each frame's platform editing world reports field kind, sensitivity and a caret
to viewers, never values or surrounding text. A replacement first verifies the exact text around
the caret, else refuses. Rebuilding the hidden caret mirror between keystrokes would split Blink's
Undo grouping, so the observer updates its nodes in place. Headless Chromium has an isolated
in-memory clipboard behind a helper context; Electron shares the machine clipboard, so copy
publishes plain text to the controlling viewer and paste inserts the copy's plain text without
touching that clipboard.
Sensitive fields never publish. Clipboard data goes only to the consumer the Host assigns, never to
Watch, and any agent command ends a person's page-write attribution. Diagnostics never hold text or
clipboard bytes. Client adapters, the native proxies and their evidence follow the
[editing contract](../packages/client/src/editing/README.md).

## Shared viewing and previews

Locality is never authority: desktop main mounts a native page only after the first Host snapshot on
that window's admitted control socket, under `browser-target-control-v1`; an unknown capability list
leaves it pending, never silently streaming. Overlays are acknowledged before covering a native page
([renderer contract](../apps/desktop/src/computer-use/RENDERER-CONTRACT.md)). Session pages may go
fullscreen and get no other permission.
A phone's own page follows the same rule; its tabs sleep until shown, so only its own control socket
is admitted to a sleeping tab, and the screen wakes the tab after that snapshot.
A mobile page keeps its admitted viewer for as long as its screen is on the stack in the foreground:
a sheet over it takes only input, and a screen over it also takes pictures, so showing it again asks
nothing of the Host. A held control viewer counts as viewing, so its tab stays awake until the
person leaves that screen or the app.

The surface ledger alone owns geometry. Keep agent emulation on a long-lived platform channel:
Chromium drops it on navigation after the issuing channel detaches. Electron frame callbacks cannot
prove which metrics revision drew a frame, so presentation never invents paint readiness.

Looking at a page never changes it. An agent screenshot may demand rendering and transform the
returned pixels, but leaves native bounds, layout, emulation, scroll, focus and selection alone.
Chromium's `Page.captureScreenshot` cannot promise that: with a clip, or on a session holding
emulation, it resizes the view for the capture and a person watches the page shrink. So each engine
copies its surface through `captureViewport` for native harness screenshots. See
[managed browser CDP connections](#managed-browser-cdp-connections) for full-page capture.

Watch is passive: it may manage picture subscriptions and raster demand, but never navigate, select,
resize, input, touch the clipboard or CDP, or move state. Profile owners can always view their
sessions, whatever the grants; Guest follows personal owner authority.

A popup is another tab in its session. Only the viewer whose input opened a foreground popup
follows it; everyone else stays put. `Page.windowOpen` cannot prove an opening, since it fires for
blocked attempts and cross-site frame events arrive elsewhere. Attribution shares Chromium's
user-activation limitation: an agent timer immediately after person input can look like theirs.
An intervening agent command clears that attribution. Password offers use the same viewer-local
routing, and Watch never receives them ([Passwords](passwords.md#filling-for-people)).

## Profile state

Profile listing, opening, CDP and tab reach follow the Run resource authority
rule; driving needs `read-write`. Only people create
profiles; an agent asks with a browser-access Request. Private profile access is decided for the personal owner and current caller ceiling. Consent never limits whether the owner may watch their own profile.
Guest state cannot be promoted, so choose the profile before signing in.

Deletion revokes grants and schedules erasure on the owning computer (`pending-computer` while it is
offline). Electron keeps a Session until exit, and Android WebView cannot delete a loaded profile,
so an opened profile stays `pending-restart` until the next start erases it: never move or delete a
live store directory to finish sooner. Android retirement remains `erasure-pending` until Guest
stores are deleted too. Its durable retiring identity survives interruption before tombstoning;
startup completes that erasure before any profile can load.

Removing a computer deletes its homed profiles in the same transaction. Their storage erasure is
terminal `unconfirmed`, not pending work and never a claim that files were erased. A device clears
its own storage when it learns of removal or leaves, including at sign-out.

A profile's home and established storage identity are fixed. Missing directories, sentinels or
cookie mirrors refuse open while preserving what remains; never create an empty replacement or
fall back to another computer or Guest. The owning device keeps its own record of every profile it
created, so it refuses a missing one even before the Host knows it exists. The Host records that
fact when the profile's first session becomes ready, before anyone can use it. A browser runtime
reaches the Host only through its Runner's relay, never by an address the Host mints: the Host's
own origin is usually loopback, which on another computer is that computer. An engine-owned
directory never moves. There is no portable snapshot, sync or profile Vault key
([storage contract](../packages/protocol/src/browser-profile-storage.ts)).

Electron roots live under `sessionData`, outside disposable Runner slots, because the Network
Service sandbox writes only there: a Session elsewhere looks usable but loses cookies. Eviction and
failure cleanup never clear a root. Full Chromium restores session cookies itself; the launcher
removes only tab restore records, only while no engine owns the directory. Electron keeps session
cookies in an encrypted [mirror](../apps/desktop/src/browser/session-cookie-mirror.ts) with an
OS-wrapped key. Engine upgrades must requalify cookie persistence.

A mirror failure does not make the live browser jar untrustworthy: keep pages open and retry the
save. Network Service loss can invalidate the live jar. Engines must prove directory ownership has
ended before reuse; a settled close alone does not prove a Chromium process exited.

## Passkeys

`OPENSTEER_PASSKEYS=1` on the Host enables passkeys in the Personal browser and hosted Chromium; off
by default, pages see no `PublicKeyCredential`. Chromium's own WebAuthn stays disabled. A provider
installed before page scripts forwards a ceremony through a per-tab CDP bridge that checks the
caller's context, a committed HTTPS document with secure TLS, the RP ID and Permissions Policy.
Cross-origin frames, conditional mediation and Headless Shell are refused.

The Host routes a person's request only to the viewer where their input reached the tab; agent and
page-load requests offer Continue, and the first native claim binds it. Desktop main holds the
request: the renderer sees an opaque ID, RP ID and operation, never the origin, full options or
client data. Losing presentation, access or connection cancels without rerouting. The OS passkey
manager signs; main refuses mismatched client data rather than repair it, signed bytes return
unchanged, and no private key ever enters Opensteer.

The [native addon](../apps/desktop/native/passkeys) runs in main, which holds the browser
entitlement and window, using only public APIs (macOS 13.5; 14.4 for security keys). A release built
without its signing inputs, like web and mobile, tells the person to use a Mac.

## Chrome sign-ins

Chrome sign-in import is the one explicit, person-started exception to sign-ins never moving between
devices. It requires the target browser's state-import ability; phone browsers do not support it.
After a person connects Chrome with the [extension](../apps/browser-extension/README.md), each
sign-in copies one site's current cookies into one live session; nothing syncs. Public suffixes and
bare intranet names are refused because they would cover every tenant, and
`browserSiteCookieMatches` is the one scope rule the extension, Host and runtime all apply. Loopback
is tried first and any local process could answer there, so the extension sends a code or token only
after the Host signs a fresh challenge.

No path signs in a loopback site or the Deployment's own origins: they hold the owner's Opensteer
cookie, and an agent signed in there could approve its own Requests. Consent belongs to the person and site, independently of the task driving the Browser Session. The
[service](../apps/host/src/browser/browser-source-service.ts) serializes decline with delivery and
rechecks authority just before import. Automatic delivery waits for the grant's preferred source,
never another account, and inspection never sends cookie values. Any agent with a signed-in browser
can act as the person on that site.

When a Chrome connects while a Request nobody has allowed waits, and every paired Chrome is
connected without the site, the Request ends as `not-signed-in`: the check
`agentCopyChromeCookies` makes before opening one. Left pending, its card offers only Don't allow,
which tells the agent the person refused; ending it lets the agent try another way in.

A source token works only at the destination (origin and route generation) it paired on; a source
paired before that rule binds to the first destination it connects through. The Host checks token,
owner and binding before the version, and replaces a live connection only with one that is ready,
so a failed hello learns and changes nothing. One site Chrome and the Host scope differently fails
that site alone; the Host closes the connection only for framing and authentication violations.

### Installed extensions keep working

Unpacked extensions are never forced to update: the Host carries compatibility, back to wire 4
(every build since #542, pinned as `apps/browser-extension/compat/opensteer-extension-0.1.565.zip`).
A newer extension states its highest wire in the connect URL's `wire` query; the Host speaks the
lower of that and its own, and wire 4 to one that states none. Negotiation is unsigned, so every
supported version must keep every security property (Host proof before any secret, token
authentication, exact signed and scoped fields); a downgrade is then harmless. Never add a version
that weakens one.

While wire-4 extensions are supported, what they strictly parse is frozen
([`@opensteer/browser-source-wire/frozen`](../packages/browser-source-wire/src/frozen/index.ts) and
the v4 frame schemas in [`./frames`](../packages/browser-source-wire/src/frames/v4.ts)):

- the `/.well-known/opensteer` descriptor: its outer object is read tolerantly, but `kind` must stay
  in its enum, `apiVersion` positive, `bootstrapMethods` in its enum and at most 4, capabilities at
  most 64 of at most 64 characters, and the nested authority envelope exact (document fields,
  `deploymentShape` as `{ kind }`, host key, SPKI and signature formats, signing bytes);
- the Personal access route envelope (document version 2, purpose, kind enum, origin rules,
  signing);
- the v2 invitation format and its signing bytes;
- the ID formats inside those documents (deployment, host instance, source);
- every frame the Host sends a wire-4 peer.

CI runs the pinned build through the real-Host journey, and tests check that what the Host signs
parses under the frozen copies. Builds from before #542 can't be served: their strict reader
requires `deploymentShape.defaultWorkspaceBacking`, which the current strict reader forbids, so no
Host can satisfy both. Their stored pairings carry over after one update.

## Files and downloads

Page uploads name only files staged in the session's private folder. Desktop downloads appear only
when complete, under a non-replacing name, with macOS quarantine applied first because Electron does
not. They never open themselves; renderer actions take IDs, and Cloud Chromium refuses them.

## Managed browser CDP connections

The Home's `/v1/browser/connect/<ticket>` WebSocket accepts a single-use attachment ticket.
The reply that issues the ticket gives the mode. Use stock
`chromium.connectOverCDP(endpoint)` for `whole-context` and
`chromium.connectOverCDP(endpoint, { noDefaults: true })` for `session`. A lost exclusive grant
requires a new ticket. Closing the client disconnects it. The Browser Session and adopted pages
have their own lifetime.

The browser profile is the isolation boundary for cookies, storage and permissions. Every Guest
Browser Session gets a fresh Chromium context. A connected agent needs a saved profile and a
device running an Opensteer version that supports page lineage. On older devices, use
`browser_use`.

For up to ten minutes, a connected agent can drive the tab its connection was issued for,
pages it creates on that connection, and their popups and child frames. The Home records those
pages as open tabs of the agent's task and closes any page it cannot record. Closing one of
those tabs in Opensteer closes its browser page and ends its CDP channels. Whole-context mode
gives the agent access to all cookies, storage, permissions and signed-in sites in the profile,
including the state it shares with a person or another agent. Runs continue to use the pages
owned by their attached Browser Session.

The virtual root supports `Browser.getVersion`, `Target.getTargets`, `Target.getTargetInfo`,
`Target.getBrowserContexts`, `Target.createTarget`, `Target.closeTarget`,
`Target.activateTarget`, `Target.attachToTarget`, `Target.detachFromTarget`,
`Target.setAutoAttach`, `Target.setDiscoverTargets`, and scoped nested sends through
`Target.sendMessageToTarget`. Root auto-attach requires `flatten: true` when enabled, refuses
a filter, and announces owned pages unpaused even if `waitForDebuggerOnStart` is set.
Root target discovery accepts up to 64 ordered type filter entries for both the initial
snapshot and live events. Context creation and disposal, browser shutdown, and browser-wide
commands outside the supported context operations are refused.

In both modes, `Target.attachToBrowserTarget` opens a browser-level CDP session that is an alias
of the connection's virtual root. Playwright's `browser.newBrowserCDPSession()` uses this alias,
and `context.newCDPSession(page)` opens a separate channel for an owned page through it.
`Target.getTargets` on either channel uses the same filtered target list as the connection root.
The alias keeps the connection's mode, lease and command restrictions. Discovery and auto-attach
subscriptions deliver their events on the alias that enabled them. Calling
`Target.detachFromTarget` from the connection root closes the alias and its channels. Nested
browser aliases are refused.

Page and child commands use the [reviewed method list](../packages/browser-core/src/standard-cdp-page-methods.ts).
Whole-context leases add `Storage.getCookies`, `Storage.setCookies`, `Storage.clearCookies`,
`Browser.setPermission`, `Browser.grantPermissions`, `Browser.resetPermissions`, and shared and
service worker channels. Omit `browserContextId` or use the virtual context ID from the owned
page's target info. The Runtime supplies the real profile context. At the root,
`Browser.setDownloadBehavior` accepts Playwright's `behavior: "allowAndName"` with
`eventsEnabled: true` and leaves the profile's download settings and path alone.
Other download settings and `Browser.cancelDownload` are refused. Uploads naming paths
require files staged on the Runtime.

Saved login and card fills use `browser_use` on the personal hosting Mac's Opensteer browser.
The standard CDP connection refuses both fill commands, including calls through Playwright's
`context.newCDPSession(page)`. The managed Chromium Runtime has no Passwords broker, and the
standard relay has no check for a Passwords reference bound to an agent session, tab, and site.

After `saved_login_request` or `card_request` returns a reference for that tab, bind the approved
tab in `browser_use` and focus the field before each call:

```js
const page = await openPage(tabId);
// After focusing the password input:
await page.cdp("Opensteer.fillLogin", { loginRef, field: "password" });
// After focusing the card number input:
await page.cdp("Opensteer.fillCard", { cardRef, field: "number" });
```

Login fields are `username`, `password`, and `code`. Card fields are `number`, `expiry`,
`expiry-month`, `expiry-year`, `cvc`, `name`, and `billing-postal-code`. The call returns
a fill status. If the hosting Mac's browser is unavailable, ask the person to complete the
sign-in or fill the card in the tab.

Screenshots capture the page surface. Full-page capture requires a clip. Each edge is capped at
30,720 pixels before and after scaling, scale is capped at 4, and scaled area is capped at
16,777,216 pixels. The Runtime uses the page's geometry channel so the viewing viewport keeps
its size. An image that exceeds the message limit after encoding is refused.

The limit is 8 MiB per JSON message including base64 and framing, with 16 MiB and 128 in-flight
items at each endpoint. Each attachment can hold up to 128 live logical channels. Standard
result and event JSON is limited to 32 levels and 16,384 entries. The relay uses
192 KiB raw chunks, with up to four live attachments per binding and 16 per Runner. The Home
and Runtime allow one second for the public close handshake. A busy client can compete for
the same Runner stream, browser process, and machine resources.
