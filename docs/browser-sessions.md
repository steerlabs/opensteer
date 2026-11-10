# Browser sessions

A named profile keeps native browser data on its home device. Its live sessions share
an engine host; each Guest session has its own throwaway browser. Sessions partition page access
even when they share a profile, and a session's identity is fixed at creation. Checks:
[browser-and-passwords](../.agents/skills/browser-and-passwords/SKILL.md).

## Open workspace tabs

The Host database owns durable tab descriptors; live sessions and CDP handles die with their
connection. Restoring makes a new binding and never restarts a finished Run. A selected dormant tab
restores only on its saved computer and profile, waiting rather than substitute another computer or
Guest. Guest website state is never reusable: Android WebView needs a private on-disk profile while
open, tombstoned before use and erased at the next startup. This is not RAM-only browsing.
Trigger and watch browsers write no tabs. Only a
lineage's latest session can close its tabs, late updates never resurrect a closed row, and reopen
makes a new row. Only committed navigation becomes a restore URL, except that a failed navigation
restores to the address it tried, as browsers do, without any credentials typed into it. An overlong
address is never truncated. A row saved before that still holds Chromium's error URL: it names no
site, and reopening it is refused like any other address that cannot be reopened.

The Host's 20-second open budget sits inside the client's 25-second deadline, which covers first
paint. An uncertain open retries with its original key and replays the recorded outcome, so it never
starts a second browser. Tickets, native creation and navigation are never blindly replayed. Tab
groups grant no access, and agent reads reveal nothing of a group they only partly reach. Links
opened with Opensteer as the macOS default browser start no agent.

## Agent access and input

A browser device declares abilities, not a device class. The Host places a session on its profile's
home and admits only what that browser advertises; it never substitutes another home or infers
abilities from a phone engine name. Host tab open, close, resume and context operations use the
ordinary command channel even when the browser does not speak CDP; resume requires `surfaceState`.

When Host discovery advertises `browser-backend-v1`, a Run negotiates its backend for one exact
session; without it, the Run uses CDP. An advertised negotiation error never falls back.
`cdpBoundary` selects CDP first, otherwise
`agentActions` selects typed actions. Both require `sharedControl`. An attachment pins that choice,
reaches only that session's pages and popups, and rechecks Run access and grants on every command.
Requesting the other backend refuses `unsupported-operation`, not an upgrade request. Agent target
selection never moves the person's focus.
Input, navigation and geometry share a per-surface ordered lane; observations stay outside it, so an
agent script waiting for a person's click cannot block that click. A lost answer after a key press
or insertion is never replayed. Person activity is an observation, not an input gate, and never
records keys or text.

Typed actions expose bounded navigation, DOM-derived semantic reads, locators, native input,
dialogs, viewport captures and optional staged-file selection, not CDP or arbitrary JavaScript.
Document and geometry IDs fence stale actions; a dialog has its own one-use identity. A lost answer
after submission is `outcome-unknown`, never permission to retry a click or insertion. The wire is
defined in [browser-actions](../packages/protocol/src/browser-actions.ts).

Browsers may negotiate live/suspended surface state. A suspended tab keeps its last in-memory
picture, or just its named row if none exists, and refuses addressed commands and input with
`target-suspended`. Watching does not resume, reload or create a native view. Selecting a sleeping
tab uses the same saved-tab activation as any other browser; the Host resumes its existing surface
instead of opening another tab. Agents keep their explicit resume path. Older peers without
surface-state negotiation keep their existing behavior.

A phone keeps at most two live views: its visible tab and one covered tab. The covered place belongs
to an agent attachment or to people elsewhere. An attachment may switch tabs after its prior input
settles; agents may replace people, but another attachment cannot displace the owner. People may
replace another people-owned tab only when nobody receives its picture, preventing competing
devices from repeatedly waking each other's tabs. Replacing retains the old page and fences queued
input, never takes the phone's visible tab, and never reloads a retained page. Detaching retains an
unwatched tab; a watched one passes to people until its last picture receiver leaves. Presenting it
locally frees the covered place. Memory pressure may still discard retained pages.

The phone marks its local presentation intent before asking the Host to reopen a saved tab. That
resume needs no covered place, even while an agent owns the other live view. After a brief
background, the Host creates a new session and the phone adopts surviving profile tabs without
reloading; fresh local viewer admission still precedes presentation. The Host's initial and dormant
surface list is authoritative for that profile lineage: omitted retired tabs are destroyed. Guest
tabs have no saved lineage and end when their session loses its connection. Native local mounting
revives a retained or discarded tab directly in the visible place; resuming it through the covered
place first would incorrectly displace or be refused by an agent.

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

## Agent CDP boundary

Agents get a frame's main-world script reach plus person-like input, never HttpOnly cookies, headers
hidden from page scripts, privileged storage, browser diagnostics, the machine clipboard or
isolated, preload and platform worlds. Cross-site out-of-process frames and auto-attach are refused.
The [allowlist](../packages/browser-core/src/agent-cdp-allowlist.ts) is deny by default: new
methods, fields, enum values and events stay refused until reviewed against the pinned protocol.
Log-domain events can carry hidden response headers, so only proven main-world console and exception
events reach agents. Main-world access needs positive context provenance; the
[router](../packages/browser-core/src/session-cdp-router.ts) checks every object handle.

Agent keys are page actions, never browser or OS shortcuts. Agent paste is always refused, and on an
engine sharing the machine clipboard so are copy and cut: they could overwrite a person's copied
password. `Opensteer.fillLogin` and `Opensteer.fillCard` are platform-handled and never reach Chromium.
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
data. A JavaScript clipboard shim would not be a security boundary and is not used as one. Android's
CDP backend must qualify machine-clipboard denial independently before it is enabled.
It must also prove that releasing the last native CDP permit makes the WebView debugger inaccessible.
Debug app builds never declare CDP; a release on a debuggable system or provider that fails shutdown
also omits it. The phone still offers each independently qualified browser/viewer/file ability, and
agent backend negotiation returns `unsupported-operation` rather than falling back.
Android cannot map a page-opened popup to an agent's trusted CDP target. That tab remains usable by
people, but an agent receives: “A page opened this tab and this phone cannot hand it to an agent;
open its address in a new tab instead.” Opensteer never reloads or recreates it to bypass that refusal.

For full editing, each frame's private editing world, hidden from
agent CDP, reports field kind, sensitivity and a caret, never values or surrounding text. A
replacement first verifies the exact text around the caret, else refuses. Rebuilding the hidden
caret mirror between keystrokes would split Blink's Undo grouping, so the observer updates its nodes
in place. Headless Chromium has an isolated in-memory clipboard behind a helper context agents
cannot discover; Electron has none, so copy publishes plain text to the controlling viewer.
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

The surface ledger alone owns geometry. Keep agent emulation on a long-lived platform channel:
Chromium drops it on navigation after the issuing channel detaches. Electron frame callbacks cannot
prove which metrics revision drew a frame, so presentation never invents paint readiness.

Looking at a page never changes it. An agent screenshot may demand rendering and transform the
returned pixels, but leaves native bounds, layout, emulation, scroll, focus and selection alone.
Chromium's `Page.captureScreenshot` cannot promise that: with a clip, or on a session holding
emulation, it resizes the view for the capture and a person watches the page shrink. So each engine
copies its surface through `captureViewport` instead, and full-page capture, which only that resize
can make, does not exist.

Watch is passive: it may manage picture subscriptions and raster demand, but never navigate, select,
resize, input, touch the clipboard or CDP, or move state. Profile owners can always view their
sessions, whatever the grants; Guest follows Workspace membership.

A popup is another tab of its session. A background-tab opening, such as an unmodified middle-click,
leaves every viewer on its opener. For a foreground opening, each viewer owns what it shows, so
nothing about following is stored on the tab: the runtime tells the one viewer whose own input
opened it, once, and that viewer moves as if it had chosen the row. Everyone else stays put. The
ledger decides this when the popup registers, from the opener's latest person input.
`Page.windowOpen` cannot decide it: a cross-site frame's event reaches only that frame's session, and
a blocked attempt fires it too. The rule shares Chromium's user activation and its limit: an agent
timer firing just after a person's input reads as theirs, as it does to Chromium. Any agent command
after the input cancels the follow, which leaves the popup as a new row.

## Profile state

Profile listing, opening, CDP and tab reach follow the [Run resource authority
rule](agent-orchestration.md#run-tool-authority); driving needs `read-write`. Only people create
profiles; an agent asks with a browser-access Request. Main already reaches every owner profile and
holds no grants. Grants decide which agents may use a profile, never whether its owner may watch it.
Guest state cannot be promoted, so choose the profile before signing in.

Deletion revokes grants and schedules erasure on the owning computer (`pending-computer` while it is
offline). Electron keeps a Session until exit, and Android WebView cannot delete a loaded profile,
so an opened profile stays `pending-restart` until the next start erases it: never move or delete a
live store directory to finish sooner. Android retirement remains `erasure-pending` until Guest
stores are deleted too. Its durable retiring identity survives interruption before tombstoning;
startup completes that erasure before any profile can load.

Removing a computer deletes its homed profiles in the same transaction. Their storage erasure is
terminal `unconfirmed`, not pending work and never a claim that files were erased. The removed device
clears its own storage when it learns of removal; a phone also clears it at sign-out.

A profile created by a caller that knows about homes always has one. A previous-release
caller that cannot choose gets a profile that takes its home on first open; from then on it is fixed. The
database also adopts a previous store's first storage binding as its home and enforces the same
home/storage match for both writers. Offline homes refuse opens by name, without falling back.
The first signed attach binds its storage root and engine on that home and publishes empty native files atomically; an engine-owned directory is never
moved. The Host records initialization so missing established storage is distinguishable from
never-created storage. A missing directory, root identity, sentinel or cookie mirror refuses to open
and keeps what remains: never an empty replacement, another computer or Guest. There is no portable
snapshot, sync or profile Vault key ([storage
contract](../packages/protocol/src/browser-profile-storage.ts)).

Electron roots live under `sessionData`, outside disposable Runner slots, because the Network
Service sandbox writes only there: a Session elsewhere looks usable but loses cookies. Eviction and
failure cleanup never clear a root. Full Chromium restores session cookies itself; the launcher
removes only tab restore records, only while no engine owns the directory. Electron keeps session
cookies in an encrypted [mirror](../apps/desktop/src/browser/session-cookie-mirror.ts) with an
OS-wrapped key. Engine upgrades must requalify cookie persistence.

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
cookie, and an agent signed in there could approve its own Requests. Consent belongs to the Browser
Session's Workspace, even when Main drives it. The
[service](../apps/host/src/browser/browser-source-service.ts) serializes decline with delivery and
rechecks authority just before import. Automatic delivery waits for the grant's preferred source,
never another account, and inspection never sends cookie values. Any agent with a signed-in browser
can act as the person on that site.

When a Chrome connects while a Request nobody has allowed waits, and every paired Chrome is
connected without the site, the Request ends as `not-signed-in`: the check `agentSignIn` makes
before opening one. Left pending, its card offers only Don't allow, which tells the agent the
person refused; ending it lets the agent offer signing in by hand or Opensteer Passwords.

## Files and downloads

Page uploads name only files staged in the session's private folder. Desktop downloads appear only
when complete, under a non-replacing name, with macOS quarantine applied first because Electron does
not. They never open themselves; renderer actions take IDs, and Cloud Chromium refuses them.
