# Browser sessions

A named profile keeps Chromium-native browser data on its owning computer. Its live sessions share
an engine host; each Guest session has its own ephemeral browser. Sessions partition page access
even when they share a profile, and a session's identity is fixed at creation. Checks:
[browser-and-passwords](../.agents/skills/browser-and-passwords/SKILL.md).

## Open workspace tabs

The Host database owns durable tab descriptors; live sessions and CDP handles die with their
connection. Restoring makes a new binding and never restarts a finished Run. A selected dormant tab
restores only on its saved computer and profile, waiting rather than substitute another computer or
Guest. Guest website state never persists, and trigger and watch browsers write no tabs. Only a
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

A Run's CDP connection binds to one session for life, reaches only its pages and popups, and
rechecks access and grants on every command. Agent target selection never moves the person's focus.
Input, navigation and geometry share a per-surface ordered lane; observations stay outside it, so an
agent script waiting for a person's click cannot block that click. A lost answer after a key press
or insertion is never replayed. Person activity is an observation, not an input gate, and never
records keys or text.

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
password. `Opensteer.fillLogin` is platform-handled and never reaches Chromium; after a fill, page
scripts and agent JavaScript can read the value ([Passwords](passwords.md#filling-a-field)).

## Remote editing and clipboard

Editing is negotiated per runtime, Host and viewer. Each frame's private editing world, hidden from
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

Watch is passive: it may manage picture subscriptions and raster demand, but never navigate, select,
resize, input, touch the clipboard or CDP, or move state. Profile owners can always view their
sessions, whatever the grants; Guest follows Workspace membership.

## Profile state

Profile listing, opening, CDP and tab reach follow the [Run resource authority
rule](agent-orchestration.md#run-tool-authority); driving needs `read-write`. Only people create
profiles; an agent asks with a browser-access Request. Main already reaches every owner profile and
holds no grants. Grants decide which agents may use a profile, never whether its owner may watch it.
Guest state cannot be promoted, so choose the profile before signing in.

Deletion revokes grants and schedules erasure on the owning computer (`pending-computer` while it is
offline). Electron keeps a Session until exit, so an opened profile stays `pending-restart` until
the next start erases it: never move or delete a live Session directory to finish sooner.

A profile belongs permanently to its computer, storage root and engine. The first signed attach
records the binding and publishes empty native files atomically; an engine-owned directory is never
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
