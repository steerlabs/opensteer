# Computer use: agents using Mac apps in the background

This is the spec for how an agent sees and operates approved apps on a Mac while the
person keeps using that Mac. It extends [Computer apps](computers.md#computer-apps), which owns the app
connection, its access levels and the `integrations` module transport; nothing here changes
those. An Android phone's whole screen is the sibling `display` computer app, specified in
[Agent Phone](agent-phone.md), which reuses these sessions and Stop. The code is
ground truth; when it and this file disagree, the code wins and this file has a bug.

iPhone app sharing is a separate data-only integration path. An iPhone has no computer-use
session, owner view or display stream, even if it reports unsupported live status fields. Its
Calendar, Contacts and Reminders use the existing signed app-approval frames with a dedicated
native approval key; Android's anywhere-approval path does not apply. See
[iPhone app sharing](computers.md#iphone-app-sharing) for enrollment and foreground availability.

## 1. Model

**Computer use** is an ordinary computer app. There is one catalog definition,
`macos-app` (`adapter: "computer"`, `computerApp.kind: "gui"`, shown as `Computer use`), and
each app a person approves is one **connection** of that definition on one Runner:
`(definitionId = "macos-app", runnerId, app)`, where `app` is a `ComputerAppIdentity` —
the bundle identifier, the signing team (`null` when the app has no team identifier), and the display
name at approval time. The bundle identifier, lowercased, is the connection's
**app key**; the process id and window are never part of it. Two apps on one Mac are two
connections, two approvals, and two grants; the connection is named `Notes on example-mac`.

Access has two levels, in the product's words:

- **Can see** (`read`) — observe the app: its accessibility tree and a screenshot, opening
  it in the background when it is not running.
- **Can see and control** (`read-write`) — additionally click, type, scroll, press keys and
  set values, all in the background.

The connection's access caps every grant, as for any computer app; a read-only
connection has no `act` tool row for any grant to reach.

**Agents operate apps through the `computer` MCP tool**, a persistent QuickJS
JavaScript REPL on the Host's integration MCP server (`opensteer_integrations`).
`integration_search` discovers approved apps and phones and their `nextAction`;
`integration_request` asks for access. The `observe` (read) and `act` (write)
integration rows remain the authority units, but `integration_call` refuses them:
`Use the computer tool to see and operate apps and phones.` The phone's `release`
row follows the same rule. App identity, placement and access come from the connection
and effective grant, never from guest code.

An app is the unit of approval; a **window** is the unit of observation, input and
viewing. `app(query, {computer?})` selects an approved app by connection id, exact
name or bundle id. `App.windows()` inventories its windows; `App.window(id)` binds
one exact window, and `App.window()` uses the session's current window, else
focused → main → first. Binding, observing or acting makes that window current for
the task's live view and overlay. An owner view independently binds its own window.

A **session** is internal bookkeeping: the Host opens one per Run attempt and Mac the first
time that attempt uses any app there, and it names the Run and its Thread but grants nothing —
each call carries its own app and access. It ends when the Run ends or the attempt's grant is
revoked (a restart's replacement attempt opens its own), when the person stops it, after
ten minutes without a call (a call in flight counts as use), or when the Host gives up on
one of its calls (the call was cancelled, or its deadline and grace passed). Giving up ends
only that session and is never a Stop: the Run's next call opens a new one. A session holds
no durable state and is never resumed — after any loss the agent observes again. Several
Runs may hold sessions on one Mac at once; what is exclusive is the **app**: an app claimed
by one session answers `busy` to every other, and the helper performs all sessions' work
one piece at a time. The Thread's title travels with the session so the Mac can say which
task is working.

**Approval is durable and per app, and the task asks for it.** A model that needs an app
requests it (`integration_request {kind: "computer-app"}`) with a one-sentence reason; the
Mac shows the native panel naming the task, the Workspace, the app, the reason and the
access, and one `Allow` creates the connection, the requesting Workspace's grant and the
Request's fulfilment in one transaction. Nothing is approved for one task only. Each Mac
also has an owner policy, **App approvals**: `Ask for each app` (the default) or
`Allow any app automatically`. Under automatic, a request for a new app is fulfilled
inline, without a prompt; an existing connection is never widened automatically, and an
increase of access is a native prompt under either policy. A task's ask is decided under
the Mac's row lock against the policy as it stands then, so automatic approval switched off
mid-ask falls back to the Mac prompt. Turning automatic on is signed
once on that Mac; turning it off works from anywhere and keeps every connection. Removing
an app under `ask` revokes its connection; under automatic it **blocks** the app: the
connection is kept, tool-less, its grants revoked, and no request recreates it until the
person unblocks it on that Mac with an ordinary signed approval. App approvals are
unrelated to a Thread's access mode and to macOS Full Disk Access.

An approval is authority to operate that app's interface. It confines nothing: what
Notes can do, an agent can do through Notes, and the approval panel says so for apps the
helper marks elevated. Existing app connections are separate authority — approving
Messages' bounded API says nothing about clicking around Messages.

### Invariants

1. **The helper is the only holder of the macOS grants.** Accessibility, Screen
   Recording, Contacts, Calendars, Reminders, Full Disk Access for Messages and Automation
   of Messages belong to `Opensteer Computer Use.app`, launched through LaunchServices so
   macOS treats it as its own responsible process. The desktop app, the Runner, and every
   command an agent runs descend from `Opensteer.app` and hold none of them; the release
   gate refuses an `Opensteer.app` that claims Apple events.
2. **The helper trusts one peer, by audit token.** It accepts a connection only when
   the kernel's peer audit token (`LOCAL_PEERTOKEN`) satisfies the desktop app's
   designated requirement — Stable or Beta, both named, Developer ID-signed by the
   helper’s own signature team — and it answers only for sessions that connection opened. Process ancestry, a team
   identifier alone, or any token stored in a file authorizes nothing. Before launching
   the helper the desktop checks its signature with `codesign -R` against a Developer ID
   requirement (`computerUseHelperRequirement` in
   [release-identity.ts](../apps/desktop/src/computer-use/release-identity.ts), which
   [Opensteer Passwords](passwords.md) shares through
   [signed-helpers](../apps/desktop/src/signed-helpers)); after
   connecting it checks the helper's peer token with `--verify-peer`, run from the helper
   sealed inside `Opensteer.app`.
3. **The Host is the authority for approvals; the helper enforces the target.** The
   helper keeps no approval list. Every session window operation carries the app identity and
   access the Host resolved from the connection, and the helper refuses a call whose target
   process is not that app, an app on its deny list, an `act` with `read` access, or a
   session it does not hold.
4. **The person keeps the front app, the keyboard and their Space.** The helper never
   activates the target app, never moves the system pointer, and never posts to the
   global event stream: input goes to the target process, by a route decided before the
   action starts. Before keys, the target is told — by activation notices sent to it
   alone — that it is active with the observed window key, so it handles the input as it
   would in front while the person's app keeps the front and the keyboard ("Background
   focus" in §2). If preparing it brings the target forward anyway, the person's app is
   sent back before the screen redraws, and keys the person types meanwhile reach their
   app. The input then goes out with nothing redirected or sent back: once it has started
   it all goes out, whatever the person does, and their keys and clicks go wherever they
   naturally go. An app can still activate itself at cold launch (Chrome does), on the
   input itself or later of its own accord; the helper reports that as `focusChanged`. Once
   the input goes out the person is never pulled back. While the target is being prepared,
   a person who brings it forward — a click into it or Command-Tab — is sent back once like
   any other round trip, and one who switches to another app ends that action with nothing
   sent.
5. **The person keeps using the Mac.** Nothing waits for the person: they may use the
   same app while an agent works, and the next observation shows what changed. If they
   type into the field the agent is typing into, the two texts interleave, and keys the
   agent sends after they move the keyboard go where they moved it; nothing reports that
   but the next observation. To keep
   their keys in their own app, the helper reads key-focus notices and where key events
   are going, never what they type. The pill's `Stop` is the person's control, and it ends
   every session on that Mac.
6. **Targeted actions cite their window's latest snapshot internally.** The REPL
   supplies the snapshot at FIFO dispatch, so aliases of one window share it.
   Indices and points require the latest snapshot; keys and untargeted typing
   need none. Acting retains that snapshot and returns receipts without observing.
   The agent explicitly observes to inspect the effect. Partial failures preserve
   completed receipts; an `outcome-unknown` mutation is never retried.
7. **One window group defines the coordinate space.** The bound window and its
   OS-associated surfaces determine capture, tree membership and point routing.
   Tree frames and `{x, y}` targets are screenshot pixels from the crop's top-left,
   defined by `geometry` even without an image. An unrelated overlapping document
   never joins the group. A point must lie inside a member and the display-clipped
   crop, and that member's geometry must still match before input.

## 2. The helper

`apps/desktop/native/computer-use/` is a Swift package that builds
`Opensteer Computer Use.app` (bundle id `com.opensteer.computer-use`, `LSUIElement`,
minimum macOS 14). Stable and Beta desktop apps ship the same helper and share one grant.

**Install.** The canonical path is
`~/Library/Application Support/Opensteer/Computer Use/Opensteer Computer Use.app`.
The bundled and existing copies are verified for integrity and product identity before
version comparison: `codesign --verify --deep --strict`, the bundle identifier, and, for
anything not ad-hoc signed, `codesign -R` against the Developer ID requirement of
invariant 2 — `codesign -dv` prints whatever authority a self-signed certificate claims. A
packaged desktop refuses ad-hoc signatures. An invalid installed bundle has no version
authority and is replaced. Each build declares the newest protocol its helper speaks as
`OpensteerProtocolVersion` in the helper's `Info.plist`, and a bundle without one counts as
older than any that declares one. A valid helper is replaced only by one that declares a
newer protocol, or the same protocol at a strictly newer version. The protocol comes first
because a build made between releases carries the last release's version: by version alone,
that release's helper would look just as current, refuse the build's newer protocol, and be
kept on every retry. One at the same protocol and version is kept whatever its code hash,
because Stable and Beta each sign their own build of one release. Development builds replace
changed bytes at the same version. Installation copies with `ditto --noqtn` to a sibling
temporary directory and verifies it there. Before replacing an existing bundle, the
staged helper's fixed `--prepare-replacement` mode verifies the live canonical helper's
identity, asks it to quit, and waits for termination; replacing running executable bytes
would prevent macOS from verifying that process, so termination precedes the rename. It
matches the live bundle and executable by their kernel device and inode identities, not by
path spelling: LaunchServices may change the case of a path on a case-insensitive volume,
while two case variants remain different objects on a case-sensitive volume. When
the running helper will not quit, a valid installed bundle is kept and replacement is tried
again on the next connection. An invalid one is replaced anyway, since whatever runs from it
fails peer verification: the next launch removes the socket path and starts a new instance
(`open -n`), and the old process quits on its own idle timer.

Installation and every LaunchServices launch share one lifecycle lock, held through socket
readiness, so another Desktop cannot relaunch the outgoing helper during replacement. The
kernel holds an exclusive lock on a persistent file until its descriptor closes,
including when the holder dies. The file is never unlinked: doing so would let
another desktop lock a different inode and launch during replacement. Active sessions end on
replacement; an action whose answer was lost remains `outcome-unknown`. Release builds
require the explicit signing identity and both arm64 and x86_64 slices; development builds
select the host architecture before building. Stable and Beta share this path. The
handshake accepts only the helper's declared protocol range; this implementation speaks
protocol 10 and requires protocol 10 clients. Mac viewing uses owner-view version 3 and
signed integrations protocol 5 with `macWindowVideoVersion: 1`, plus matching authenticated
producer status. Phones use their [current integrations contract](agent-phone.md#4-the-runner)
and lease version 1. Upgrade the
Host and clients together ([Compatibility](host-boundaries.md#compatibility)). The shared
canonical helper refuses older Stable clients, including Stable 0.0.82, until updated;
there are no legacy screenshot-viewing handlers.

**Launch.** The GUI runtime uses LaunchServices through `open -g -a` so the
helper's pill and cursor windows can appear without taking focus. It uses
`open -n -g -a` when it needs a fresh instance, never a direct child-process
launch. The helper quits after fifteen minutes with no session and no connection;
desktop main lets its connection go after a minute with no
session and no request in flight, so that can happen, and relaunches it on demand. Real work —
a session, the picker, an approval, the permissions panel — installs and launches the
helper. A Runner's status probe never installs one: it reads the grants from the connected
helper, else the grants the helper last reported to this desktop, and a Mac with no helper
installed reports both missing; only when nothing has been reported since the desktop
started, or since the person may have changed a grant, does a probe reconnect to or launch an
installed helper. After Screen Recording is first granted the helper
quits itself once when no session is active and no app call is under way, because
ScreenCaptureKit may need a fresh process. The helper polls for both grants. If macOS keeps a direct System Settings grant
cached as denied, choose **Quit & Reopen** when macOS offers it so a fresh helper
process can see it.

**Permission setup.** Opening the panel only checks status. The person explicitly
requests Screen Recording first, then Accessibility, one permission per action.
The native helper calls only the API for the named permission; it never batches
the two requests. macOS may return before its consent dialog is answered, so the
panel offers a separate action to open System Settings instead of automatically
bringing Settings over the dialog. The page owns polling and completion; main
only owns the window.
There is no timer-based assumption that an unchanged denial means a restart is
needed. The request result is returned through the bridge instead of discarded.

**IPC.** A Unix socket at `~/Library/Application Support/Opensteer/Computer Use/ipc.sock`
in a directory of mode `0700`. Frames are a 4-byte big-endian length then UTF-8 JSON,
at most 4 MiB. Messages are `{id, method, params, timeoutMs?}` answered by `{id, result}` or
`{id, error: {code, message}}`; the helper also sends `{event, params}` for a session
the connection holds. Peer verification happens before the first frame is read:
`LOCAL_PEERTOKEN` → `SecCodeCopyGuestWithAttributes` with `kSecGuestAttributeAudit` →
`SecCodeCheckValidity` against the requirement compiled into the helper. Release helpers
read their own code signature’s team and construct a requirement for that team,
the Developer ID intermediate and leaf, and both desktop bundle identifiers.
Unsigned or ad-hoc helpers refuse trust unless compiled with the explicit
`OPENSTEER_DEV_TRUST` condition; that condition selects a same-user check. The first
frame must be `hello {protocolVersion, clientVersion, ownerViewVersion?: 3, loginText?: 1}`; the answer is
`{protocolVersion, minProtocolVersion, helperVersion, permissions, routes, ownerViewVersion?, loginText?}`, and an unsupported
version is refused with `incompatible-version`. Before sending `hello`, desktop main
passes the connected socket as inherited file descriptor 3 to the `--verify-peer` mode of
the helper sealed inside `Opensteer.app`, never the installed copy, which any process
running as the person can rewrite. That mode checks the server's kernel audit token against
the release helper's requirement, which carries the same Developer ID markers. Neither side
substitutes a pathname or PID for the connected peer's code identity. The short verifier
child exits before creating an application or using either macOS privacy grant; the GUI
runtime still launches through LaunchServices.

`timeoutMs` (at most 120,000) is the time a request has left, counted from when the helper
received it. Work still queued when it passes is answered `failed` with nothing done;
running work stops between actions, text chunks and scroll ticks, as it does for Stop, and
reports what it completed. `hello` is answered on the connection's own queue, ahead of any
frame after it; `session.open`, `session.close`, passive permission reads and the data
methods are answered on the main actor at once, each app the helper serves in its own lane.
Window-video control is admitted there; expensive native transitions are serialized
independently of agent observation/action work.
Session window work runs in arrival order on one serial work lane
whose Accessibility reads and posted events run on `WorkActor`, a dedicated
serial executor off the main thread, so an app that stops answering never holds Stop,
opening or closing a session, `hello`, or a readiness probe.

**Methods.**

| Method                | What it does                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions.get`     | `{accessibility, screenRecording}` as `granted` / `denied`, without prompting.                                                                                                                                                                           |
| `permissions.request` | Requests the named `pane` (`screen-recording` or `accessibility`) using `CGRequestScreenCaptureAccess` or `AXIsProcessTrustedWithOptions`.                                                                                                               |
| `apps.installed`      | `{query = "", limit 1..100 = 50, offset = 0, icons = false}` → `{apps: [{identity, running, iconPng?}], total}`. Case-insensitive substring match on display name and bundle id, filtered and paginated on the Mac.                                      |
| `app.resolve`         | Indexed name, path, or bundle identifier → identity, path, running state, deny-list verdict, risk.                                                                                                                                                       |
| `session.open`        | `{sessionId, threadTitle: string \| null}` → `{sessionId}`. Bookkeeping only: names the session and the task the pill shows, and claims and resolves nothing, so it is never `busy`. Re-opening updates the title.                                       |
| `session.close`       | Ends that session and releases its apps; the overlay stays while other sessions remain.                                                                                                                                                                  |
| `session.windows`     | `{sessionId, app: {identity, access}}` → `{windows: WindowInfo[]}`. Claims and opens the app in the background when needed.                                                                                                                              |
| `session.bind`        | `{sessionId, app, window: id \| null}` → `{window: WindowInfo}`. Selects an exact window, or current → focused → main → first, and makes it current.                                                                                                     |
| `session.observe`     | `{sessionId, app, window: ref, includeScreenshot}` → `{observation: Observation}`. Observes that bound window.                                                                                                                                           |
| `session.act`         | `{sessionId, app, window: ref, snapshot: string \| null, actions, loginContext?}` → `{performed: string[], error: {code, message} \| null}`. Never observes.                                                                                             |
| `view.windows`        | `{app: ComputerAppIdentity}` → `{windows: OwnerWindowInfo[]}`. Owner picker inventory; creates no session or lease, never opens an app or asks it for a window (not running: none), takes no Runner work slot, and leaves out a window it cannot verify. |
| `view.open`           | `{viewId, generation, leaseDurationMs, target: {kind: "app", app, window?: id}}` → the independent owner binding. Requires negotiated owner-view version 3.                                                                                              |
| `data.status`         | `{grants: {automation, calendars, contacts, full-disk-access, reminders}}`, each `granted`, `requestable`, `denied` or `unknown`, without prompting.                                                                                                     |
| `data.request`        | `{grant}` → asks macOS for that one grant and answers `data.status`'s shape. Desktop main sends it only for the person at this Mac. For Full Disk Access, which nothing asks for, it has a helper that still cannot read restart once idle.              |
| `data.invoke`         | `{definitionId, operation, contract, effect, access, arguments}` → `{value}`, one operation of an app the helper serves.                                                                                                                                 |
| `imessage.account`    | `{}` → `{account: {id, handle} \| null, end}`: the Apple account Messages uses for iMessage, and the newest row a new channel starts after.                                                                                                              |
| `imessage.poll`       | `{owner, accountId, after, limit}` → `{account, claim, cursor, rows}`: the whole rows after `after`, renewing `owner`'s claim on the account.                                                                                                            |
| `imessage.send`       | `{owner, accountId, key, to, text}` → `{key, sentAt}`: one reply from that account, sent once per `key`.                                                                                                                                                 |

Window video resolves an exact task session/app or owner view/generation through
`display.resolve`. The helper returns an opaque binding for a verified process incarnation
and retained window lifetime. `display.start`, `display.demand`, `display.refresh` and
`display.stop` carry control only. `display.attach` consumes a one-use token on a separate
peer-verified socket; binary H.264 access units and bounded acknowledgements never enter
the JSON RPC queue. These operations never produce an agent observation or renew authority.

Sessions belong to the connection that opened them and close when it drops or after ten
idle minutes each; a session whose one app quits ends with `app-quit`. The deny list and the
access are checked on every call (`act` on a `read` app is `unsupported`); the identity is
resolved and verified against the installed bundle the first time a session uses the app,
and again when the Host sends a different identity for it. An app is **claimed** by the
first `windows`, `bind`, `observe` or `act` that names it and released when that session
closes; a session holds at most eight apps. Another session's window operation on a claimed app is `busy` with
`This app is already being used by another task.`; the helper names no Thread, because
only the Host that holds the session knows it. A process is selected only when its bundle
path and live code identity match the approved app; that full check runs once per observe
and once per action, and the steps inside an action confirm only that the process is the
same one, by its start time. Paths outside the installed-app
catalog are refused, since an approval stores an app identity rather than a filesystem
path. The catalog scans `/Applications` and `~/Applications` one folder deep (Setapp and
vendor folders), includes hidden-flagged entries such as Safari's symlink and skips only
dot files, adds Finder from CoreServices, and a resolve miss invalidates its 60-second
cache and rescans once. A running app is matched by bundle path and signing team read
with the flag that makes macOS return it. When the app is not running, or runs with no
window, `windows` or `bind` opens it with `NSWorkspace.openApplication` (`activates: false`, not
added to recent items) and waits up to ten seconds for a window, or less when the request's
deadline is sooner; a live identity mismatch is refused rather than launched around. A
locked Mac answers `unsupported` with `The Mac is locked; ask the person to unlock it.`
Known limitation: `windows` lists what the app reports through Accessibility, and macOS
omits windows on another Space. With the person's app in full screen, a window a background
app opens (TextEdit's ⌘N new document) is not listed until the person switches to its Space,
so the agent cannot bind it; Chrome journey R4's TextEdit full-screen case fails this way
(11 of 11 retained runs).

**Window identity and groups.** The wire schemas live in
[`computer-use.ts`](../packages/protocol/src/computer-use.ts); the native implementation
lives in [`SessionWindows.swift`](../apps/desktop/native/computer-use/Sources/ComputerUseCore/Session/SessionWindows.swift)
and [`WindowGroup.swift`](../apps/desktop/native/computer-use/Sources/ComputerUseCore/Observe/WindowGroup.swift).
`WindowInfo` is `{ref, id, title, focused, main, minimized, onScreen, modal, current, frame}`,
with at most 64 windows and titles up to 1,024 characters. `id` is the numeric
WindowServer id. The opaque `ref` retains the AX window and process start stamp within
one session. Closing the window, losing AX membership or replacing its process retires
that ref permanently; numeric id reuse never revives it. Binding an unknown id or using
an ended ref returns `stale-observation`: `That window is closed.` A minimized window
refuses observation/input with `The window is minimized; ask the person to restore it.`

A `WindowGroup` carries a revision, root, stacked window/layer members, crop, display, `alone`,
`blockedBy` and a signature. On `WorkActor`, the helper resolves the root and
`SLSCopyAssociatedWindows` ownership set, filters it to the same process, positive size,
positive alpha and on-screen membership, and preserves WindowServer stacking order.
Enumeration excludes desktop elements. Sheets, popovers, OS child windows and context
or pop-up menus qualify through association; overlap alone adds nothing. When the root
is the app's focused window, selected menu-bar menus also qualify (Apple menu excluded),
using menu AX frames to identify the app's popup-level surfaces.

An unassociated app-modal window appears in `blockedBy` as `{id, title, kind: "dialog"}`;
a sibling's menu names that sibling with `kind: "menu"`. Menu candidates are the app's
unassociated on-screen surfaces at popup-menu level or higher; sibling association
or its focused menu bar supplies the owning window. At most eight blockers are reported. The root and its associated surfaces never block themselves. Observation
remains available; input refuses with
`"<title>" (window <id>) blocks this app; use that window.` The agent binds the listed
window to recover. A hidden app or off-Space root has `alone: true`: only the root is
captured and walked, with no associated surfaces or drawn pointer. Full screen alone
does not set `alone`; the root's on-screen state does.

The signature includes associated ids, qualifying window geometry/layers/visibility,
app popup-level windows and modal dialogs, blockers, focus, menu-bar state, hidden state
and the monitor's lifecycle revision. Capture and tree assembly use one immutable group;
observation commit recomputes and compares the signature and lifecycle before publishing.
A concurrent change returns `stale-observation`, `This app changed while it was being observed.`
Video uses the same group resolver; AX work stays on `WorkActor`.

`hello.routes` reports `{windowLocation, windowGroups}`; Desktop reads it tolerantly so an
older helper still parses and is refused as incompatible. The helper resolves
`SLSCopyAssociatedWindows` and `SLSMainConnectionID` at startup; without them, every window
operation refuses `unsupported`, `This version of macOS cannot identify window groups.` The
Mac is current, so nothing asks for an Opensteer update. There is no overlap-based fallback.
The helper's minimum platform is macOS 14; the association behavior on macOS 14 still needs
qualification.

**Observation v2.**

```text
{ snapshot, app, window: {ref, id, title, frame: {x, y, width, height}, scale},
  windows: WindowInfo[], blockedBy: [{id, title, kind: "dialog" | "menu"}], alone,
  tree, elementCount, truncated, geometry: {width, height},
  screenshot: {mime: "image/jpeg", base64, width, height} | null, focusChanged, capturedAt }
```

`snapshot` is opaque and latest per bound window; the Mac wire has no `observationId`.
`Window.observe({screenshot: false, emit: true})` defaults to tree-only observation;
`emit: false` returns the observation to code without adding it to MCP content. After
input, the next observe settles that window first: it polls the pre-input title,
shallow child count and focused value/selection every 100 ms, stopping after a changed
fingerprint holds for one poll, after one second, on Stop, or three seconds before the
request deadline. Secure field values/selection stay excluded. Settling spans act calls
until a successful observe resets it.

A hidden app can still be observed; mouse/keyboard delivery refuses with
`The app is hidden, so clicks and typing would not reach it; ask the person to show it.`
AX presses, `setValue` and applicable menu shortcuts remain available. The tree is text,
one element per line, indented by depth: `[12] button "Save" (412,88 96×28)` gives
index, role, title/value and screenshot-pixel frame. Roots are group members in front
of the bound root, then the root. Member occlusion suppresses hidden elements and their
subtrees. Layout-only nodes and repeated text are hoisted away; controls remain even
when unlabeled.

The tree is at most 1,500
elements and 32,000 UTF-8 bytes, the smallest tool-output budget of the engines agents run
on, so no engine cuts elements out of the middle. Lines are kept from the start; a cut ends
the tree with a line that counts the elements left out,
`… 212 more elements not shown; act on what you see or scroll.`; `elementCount` counts the
lines shown, `truncated` says something was left out, and an index beyond the cut is
refused. Every observation is a
full snapshot; indices are reassigned each time. Chromium and Electron apps get
both `AXManualAccessibility` and `AXEnhancedUserInterface` written once per app process,
with each result recorded independently; an unsupported attribute does not block the
other. The next observation waits once, up to four seconds, for a populated `AXWebArea`;
native browser controls alone do not establish readiness. Reads and waits are bounded by
the remaining request budget.
A restarted process resets this preparation. Every AX call runs under a two-second messaging timeout.
Secure fields omit `AXValue`, title, help and role-description reads; their tree labels
are generic. Settling also skips their value and selected text. Screenshots remain
unchanged; an app that exposes a password as ordinary text can still reveal it.
One window walk has a three-second budget, and each read may wait only for what is left of
it and of the request's deadline, so an unresponsive app holds an observation for at most
that long; a walk that runs out ends the tree with a line saying the rest was not read. The
menu-shortcut index is read under its own three seconds the same way.

ScreenCaptureKit includes exactly the group's windows in a display filter, so other
apps and sibling documents cannot occlude them. The crop unions the root and all qualified
members, including children extending past the root, then clips to the root's display.
`alone` uses a desktop-independent single-window filter. `geometry` is the crop's size in
pixels; `window.frame` is global points and `scale` is delivered pixels per point.
Native resolution is retained within both 1,440 pixels on the long side and 1,150,000
pixels. JPEG quality drops once, then dimensions shrink until base64 fits 600,000 bytes;
tree frames and point targets follow that delivered size. The result fits the 1 MiB
integrations frame including its envelope. Acquisition failure after planning retains
tree and geometry with `screenshot: null`; `includeScreenshot: false` skips acquisition.
A late capture cannot commit to an ended or replacement session.

**Actions**, performed in order, stop at the first failure. `session.act` returns only
`{performed: string[], error: {code, message} | null}`. It never captures or invalidates
the snapshot merely because input ran. A batch has 1–32 actions and a 30-second native
budget, shortened by the request deadline. The REPL supplies the window's snapshot
internally; index/point targets and `setValue` require it. Missing snapshot:
`stale-observation`, `Observe this window first.` A nonlatest or lifecycle-invalidated
snapshot: `stale-observation`, `Observe this window again.` Keys and untargeted typing
can run without an observation.

`performed` names each fully completed action in order, at most 160 characters:
`Clicked "Save"`, `Typed "Offsite" into "Title"`, `Pressed ⌘S`, `Clicked at 412, 88`.
Secure text is counted, never repeated. Saved-login receipts are exactly
`Typed saved username`, `Typed saved password` or `Typed saved code`. The failing action
may itself have partial effects; the agent decides when to observe again.

Targets are `{index}` or `{x, y}` in snapshot pixels. The index retains its AX element;
a destroyed element refuses before input. A point or an index's center must fit the
snapshot geometry, the current crop and a member. The frontmost snapshot member under
that point must still own it with the same frame; events name that member and use its
local points. A gap in the crop refuses `failed`, `That point is outside this window's members.`
A changed member returns `stale-observation` before input. Once earlier actions completed,
a later stale refusal becomes `failed`; stale results cannot carry completed receipts.
The route is chosen before each action, with no retry through another route.

| Action     | Fields                                                   | Delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`    | `target` (`{index}` or `{x, y}`), `button`, `count`      | Left, single, on an observed actionable element that offers `AXPress`, by index or at a point: that action, including menu controls. Everything else: process-addressed mouse events from AppKit's event factory, stamped with the observed window under the point, at window-local points.                                                                                                                                                                                                               |
| `type`     | Literal `text` or `{loginRef, field}`, optional `target` | With a target, focus first: an observed actionable element, by index or at a point, that takes `AXFocused` is focused through Accessibility; any other target is clicked. Literal text then goes to the focused element through `AXSelectedText` when it takes that (never `AXValue`); otherwise, and whenever the text holds a line break or tab, key by key as the person's layout types it (line breaks and tabs pressed as Return and Tab), to the process stamped with the focused element's window. |
| `key`      | `keys` such as `cmd+s`                                   | The app's menu item whose shortcut matches, pressed through AX; otherwise a keystroke to the process, stamped with the focused element's window. The index skips the Apple menu, Services and disabled items, and Apple menu and Services shortcuts (Log Out, Lock Screen, Force Quit) are refused as `unsupported`. A background Chromium browser is refused its shortcuts that open a tab or window (see "Background focus").                                                                           |
| `setValue` | `index`, `value`                                         | `AXValue`, only when settable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scroll`   | `target`, `direction`, `amount`                          | Scroll-wheel events to the process at the target point, stamped with the window under it, one tick per unit.                                                                                                                                                                                                                                                                                                                                                                                              |

`wait` is absent from Mac actions; scripts pause with `await sleep(ms)`.

For a saved-login source, `field` is `username`, `password` or `code`. Acquire the
reference through `sign_in {site, reason}` and judge that the target is the site's
genuine app. The helper receives only a connection-bound sealed field, authenticates
all saved actions before input and decrypts again immediately before typing. Saved
text uses `AXSelectedText` or Unicode-only keystrokes; CR, LF or tab refuses that type
before any input effect. Missing support at any hop returns `unsupported` before the
batch performs anything. [Opensteer Passwords](passwords.md#typing-in-apps) owns consent,
lease lifetime, sealed delivery and the limits of app destination judgement.

`AXPress`, an `AXFocused` or `AXSelectedText` write, or an `AXValue` write answering
`kAXErrorCannotComplete` is `outcome-unknown`: the action may have happened, so the batch
stops there and nothing is posted after it. A mouse-up is always posted to the process that
received its mouse-down. A private symbol the route needs (`CGEventSetWindowLocation`) is
resolved once at start; when it is absent that route reports `unsupported`, and `hello`
says so in `routes.windowLocation`. Pointer input uses one process-addressed SkyLight route
and carries no invented modifiers. An event posted to a process never passes through the
window server's keyboard translation, so every keystroke carries the characters its key
types. A shortcut's modifiers ride on its key, between a flags change to them and one back
to what is held; there are no modifier key events. Known limitation: a ⌃ chord without ⌘
carries its letter, so a focused text field in Chrome or AppKit also types that letter
(⌃⌥J types "j") while the page or app still sees the shortcut. One posted payload cannot do
both: a control character stops Chrome inserting but changes its `key` to the Option glyph
(`∆`, `code` `KeyJ`), and AppKit then inserts the control character.
Text goes key by key, each the key and
modifiers the person's layout types the character with; a character no key types goes as
one key carrying it. A shortcut is not paced, text 0.25 ms per event. The exact AX
window identifier is required; the helper never guesses from matching window bounds.
An auxiliary pointer destination keeps its own event window; keyboard input requires an
identifiable key-capable owner or refuses.

**Background focus.** Opensteer sends process-addressed activation notices to prepare a target for background input. These private notifications are implementation details, not a public macOS API contract. An app keeps its own idea of whether it is active from the activation
notices the window server sends it. Before keys, and before a process-addressed click into
web content, a menu button, or text a click may select, the helper sends the target those
notices alone, once per focus: activation naming the key-capable window that owns the input's
element, with the click that would activate it at the window's `AXActivationPoint` (apps
put that point where a click changes nothing else — Chromium puts it outside the window),
or, when it already believes it is active, that its window has the keyboard again. Keys
and menu commands go to the app's key window, whatever window their events name: an app
that believes it is active with another of its windows key is told that window was
deactivated, then the activation above — deactivation-before-activation ordering also used by [yabai](https://github.com/koekeishiya/yabai/blob/491ed8d95cd9bcd3e8550dc6d5dc167852fec2f3/src/window_manager.c#L1293-L1322) when changing windows in its focused process — and nothing is sent unless the input's window then
is key. In an app the person is using, their key window is never moved and the keys are
refused. The
target then handles posted keys as it would in front: its key window takes them, and a
command that would bring a window forward finds its app active. A tap on what the target
receives keeps its belief current. While it believes it is active but is not, a click the
person makes into one of its windows activates it for real, since the app would not ask
for activation itself — unless the window server already sends the click to the app; the
session's end tells it it is no longer active.

Opensteer prepares an app while the person's app is in front using a guarded transaction: it saves the person's front app and focused window, holds the
window server's screen updates, drops the activation, deactivation and resign-key/main
notices either app would receive, and sends any key headed for the target that the helper
did not post to the person's app instead (see "in the order typed" below). If the target
comes to the front, the person's
app is activated again, at most every 50 ms, and their window raised over any target
window at its level. Preparation ends when the target reports itself frontmost through AX,
or after 1 s, once both apps have heard of any round trip and 100 ms have passed without
such a notice, with the person's app read in front again last. A third app in front means
the person switched, and the action fails without sending anything. A person who chooses the
target during preparation, with a click or Command-Tab, is sent back once like the target
coming forward on its own; telling Command-Tab apart would mean reading the person's keys. 2 s without settling, or a raise of the
person's window that keeps failing, also fails preparation. The front app is read from the
window server itself, not from `NSWorkspace`, which follows it late. Preparation runs on
the work lane and checks Stop and the request deadline, again just before the input goes
out; whatever stops it, the person's app is put back first. A preparation that sent the
person's app back while the screen was held reports no `focusChanged`: the person never
saw it. Without both halves of the screen hold, or without the taps, input is refused
before anything is sent.

The taps, the screen hold and the redirect end before the input goes out, and nothing
watches afterwards, except the watch that keeps the person's keys in order until any sent
on have arrived. An app that comes forward on the input itself — Chromium's New Tab and
New Window do, whatever it believes — stays in front, and the next observation reports
`focusChanged`. So does a window the agent's own click raises over the person's window, such
as a document behind a popup or menu it opens: the person keeps the front app and the
keyboard, and their window is not raised again. Before the first event of a keyboard action, everything that refuses with
nothing sent is checked: a blocked, minimized, hidden or closed window, a keyboard that
would have to leave the person's window, a stale observation. Once its first event is out
it sends the rest, stopped only by Stop or the session's end, the request deadline, a
locked screen, an invalid saved-login lease, or the target process exiting or being
replaced. A person who clicks into the app meanwhile stops nothing; their keys go where
they clicked. That includes saved-login text: a secret can mix with the person's typing or
land where they moved the keyboard. Pointer actions check their point again between their
events. Opensteer does not paste text through the clipboard or refuse the next action solely because the person is using the target app.

Every action registers its app, whatever the route, and while any app is registered a
session-wide tap reads the window server's key-focus notices. When an app the agent works
in takes the keyboard from another app — a menu it opens, a view service it hosts — the
"focus taken" notice never reaches the app that lost it, its first "returned" notice is
dropped too, keys on their way to the taker go to the person's app instead, and the theft
is released by the id the next key-focus-changed notice carries. Keys sent on this way, or
during preparation, reach the person's app in the order typed: a sent-on key takes a longer
path than the person's next key, so the person's app is watched before any key can be sent on
to it, and while one sent on has not arrived, their own keys reaching their app are sent on
behind it. Nothing is held back or dropped. Preparation refuses without that watch; a theft undo
without it still keeps the keys from the taker, unordered, since keys reaching the wrong
app could leak what the person types. Known limitation: a key sent on and not delivered
within 1 s counts as lost, so the person's later keys stop following it. A view service counts as
the app macOS holds responsible for it. ViewBridge's shared helper hosts remote views for
any app, the person's included, so a theft through it is never attributed to an agent's
app; that path, and a remote view as the recipient of keys, are not covered. A tap macOS
disables is enabled again; the session's end tells an app still believing it is active
that it is not.

This describes Opensteer’s implementation of a private notification protocol. Its numeric fields and view-service behavior have not been matched to a verified public specification.

A menu shortcut is the menu item pressed through AX: in TextEdit a posted keystroke's
menu shortcut does nothing while the app is in the background, and the AX press runs
without bringing it forward. A Chromium browser that does not believe it is active runs a
menu-pressed command at application level, which brings it forward, so for Chromium and
Electron apps the press is prepared like keys, and the browser runs it for the window it
believes is key. A Chromium command that opens or shows a tab or window calls
for activation whatever the browser believes, and when the browser's windows are on
another Space the Dock switches Spaces before the browser can be sent back. So while the
person is in another app — checked again until the shortcut goes out — a Chromium browser,
known by its `BrowserCrApplication` class, is refused the default shortcuts for New
Tab, New Window, New Incognito Window, Reopen Closed Tab, Settings, History, Downloads,
Bookmark Manager and Clear Browsing Data, before anything is sent, with a sentence telling
the agent to use the current tab instead: ⌘L, the address, Return. A Chromium link that opens a tab still
brings the browser forward, and it stays there; with the browser on another Space that can
switch the person's Space.

An AX route is always preferred for a single left click, with no pixel retry after an
AX failure, and AX-routed actions need no preparation. Chromium text goes in as
keystrokes, since Chromium accepts a background `AXSelectedText` write and drops it. No
foreground-app defocus or global input is used.

Before each action, the helper verifies the bound window's exact process,
including its kernel start time, bundle path and live signature. Window inventory/binding can discover
or relaunch an app; acting never switches to a different process with the same bundle id.
Untargeted typing follows focus within the bound group as earlier actions left it.
If a person holds a button or key in that app, agent mutations refuse
`failed`: `A person is pressing in this app; try again.`
When the person is in another app, background key preparation selects the bound group's eligible key window without changing the person's front app. Long input checks Stop, the deadlines
and the target process between chunks or ticks. For clicks, scrolls and point-targeted
typing the drawn pointer travels to the target first and Stop is re-checked before anything
is posted.

**Errors.** `permission-required`, `app-not-allowed`, `app-not-found`, `app-not-running`,
`no-session`, `busy`, `stale-observation`, `stopped-by-user`, `unsupported`, `failed`,
`outcome-unknown`, `delivery-unconfirmed`, `incompatible-version`. Each carries a sentence a person or model can
act on; none carries a path. Session validation precedes the locked-screen check, so a
closed or stopped session retains its own error even while the Mac is locked. A valid
session on a locked Mac remains `unsupported` and sends no input.

**Events.** `session.stopped {sessionId, reason: "user" | "app-quit"}`, sent to the
connection that holds the session. The pill's `Stop` closes every live session and sends
one event per session.

**What the person sees.** One `OverlayModel` state machine decides it, and the AppKit
windows draw it; none of them can become key or main. Reduce Motion replaces pointer
travel with a brief crossfade and the expanding click ring with a static marker, and
disables the breathing glow, border sweep and spring motion.

- The **pill**, top right, settling into the nearest corner (remembered for the helper's
  lifetime) and following the active screen. It drags from anywhere, buttons included: a
  press that moves is a drag and never a click. It leads with the icon of the app the
  agent is in — the one being typed in, else the one most recently worked in, with a
  second held app peeking from behind — carrying the agent's own ember pointer where the
  access is `Can see and control` and an ember eye where it is `Can see`; before any app
  is held, the Opensteer mark with the pointer. The badge moves as the pointer does:
  steady while work is in flight, breathing between calls, pressing on each click. Line 1
  shows the state: `opensteer is using Notes` (work in flight,
  or finished less than 300 ms ago, on a read-write app), `opensteer is viewing Notes`
  (every app in use is read-only), or `opensteer is typing in Notes` (during a `type`
  action). Between calls it names the held apps: `opensteer is waiting to use Notes`;
  before the first app is held, `opensteer is waiting for the agent`. Several active
  apps read `opensteer is using Notes and Calendar`. Line 2 shows the Thread titles,
  joined with `·`. `Stop` and minimize sit at the end nearest the screen's edge, so in a
  left-hand corner they lead. Minimize shrinks the pill to the app and `Stop`; hovering
  the app then hangs `Using Notes · <Thread titles>` beside the pill, and clicking it
  expands the pill. It stays minimized for the helper's lifetime: a new task, a newly held
  app or an app passing to another task shows it expanded for three seconds, but never
  while the pointer is over the pill or where the expanded pill would be, and a reveal
  waits for the pointer to leave. `Stop` keeps its width and its place whatever the pill
  shows and while it changes size, so nothing the agent does moves it under a still
  pointer, and a click that changes the size lands on the control that changes it back.
  When `Stop` appears — a new task's pill, or a notice giving way to one — or jumps to
  another screen, it fades in and takes no press for 0.6 s, so a click aimed at whatever
  was there before cannot land on it.
  Notices always show expanded, with the apps they name dimmed and no badge.
  `Stop` closes every computer-use
  session on this Mac, including sessions from other deployments. After Stop:
  `Stopping…` until in-flight work returns, then `Computer use stopped` for two seconds;
  when the last session closes normally, `Computer use ended` for two seconds; when the
  desktop's connection drops with sessions open, `Connection lost · last action unconfirmed`
  with a `Dismiss` button until dismissed. A new session replaces any notice.
- One **pointer** per app in use: an upright ember arrow with a dark edge, a fine white
  keyline and restrained glow. It has no text badge. AppKit's view coordinate system
  owns its top-left origin, so the visible tip remains at the actual input target.
  Travel accelerates and decelerates smoothly, with quicker short hops and a 340 ms
  maximum. Input is posted after it arrives; an already reached target adds no travel
  delay. A small ring marks each click. It stays at its last target with a slow breathing
  glow between calls and disappears when no session holds that app.
- A **working outline** stays around each held app's target window for the session's
  lifetime. One highlight travels around the border while a call is in flight and for
  300 ms afterward; between calls the border dims and stops moving. Core Animation
  drives the sweep without a frame-by-frame redraw loop. Both the pointer and outline
  stay with their target window in the window stack, so other windows can cover them.
  Releasing an app removes its outline immediately. There is no screenshot-preview
  control in the overlay; observations remain available in the task's computer-use steps.

**Deny list** (`AppPolicy.swift`), refused with `app-not-allowed`: password managers
(1Password, Bitwarden, Dashlane, LastPass, NordPass, Proton Pass, Apple Passwords, Keychain
Access, KeePassXC, Enpass, Strongbox, MacPass, Keeper, RoboForm, KeePassium, Opensteer
Passwords), terminals
(Terminal, iTerm2, Warp, kitty, WezTerm, Ghostty, Rio, Wave, Alacritty, Hyper, Tabby),
script and automation tools, which can run anything the person can (Script Editor,
Automator, Shortcuts, Keyboard Maestro and its engine, Hammerspoon, BetterTouchTool,
Raycast, Alfred, Script Debugger), Opensteer itself, and macOS security surfaces
(`SecurityAgent`, `LocalAuthentication*`, `UserNotificationCenter`). A vendor listed as a
family matches its identifier and any `.variant` or `-variant` build of it, so Setapp, beta
and preview builds are refused too, and never a longer word. Browsers, Finder, Mail,
Messages, System Settings and editors with a built-in terminal (Xcode, VS Code, Cursor,
Zed, Windsurf, Nova, JetBrains IDEs, Android Studio) are allowed with `risk: "elevated"`
and a sentence saying why, which the approval names.

### Apps the helper serves

Some Mac apps are reached through a bounded API rather than their interface — Messages
(`apple-messages`), Contacts (`apple-contacts`), Calendar (`apple-calendar`) and Reminders
(`apple-reminders`) — each a catalog definition with `adapter: "computer"`
([Computer apps](computers.md#computer-apps)). The helper serves them because it holds
their grants (invariant 1). The Runner's provider
([helper-app-provider.ts](../apps/runner/src/computer-apps/helper-app-provider.ts)) only
carries calls to it, so on a Mac without the desktop app such an app is unavailable and
is never read another way. `computerUseDataApps` in
[computer-use.ts](../packages/protocol/src/computer-use.ts) names the grant each app's reads
need and the one its changes need: Messages reads with Full Disk Access and sends with
Automation of Messages; Calendar and Reminders need full access, never add-only.
Full Disk Access is probed by opening `~/.Trash`, and a refused probe is what lists the
helper in that pane; only System Settings grants it. macOS gives it to a process from its
next launch, so a refused probe also asks a fresh child of the helper (`--probe-full-disk-access`,
the same app to macOS) at most once a second; a child that may read means the person
switched it on after launch, and the helper restarts once nothing is under way. Until it
has, the grant reads `denied` and a read fails retryably (`Opensteer Computer Use is
restarting to finish setup.`), never `permission-required`. macOS reports Automation only
while Messages runs, so the grant reads `unknown` otherwise, which the Runner reports as
ready: before a send the helper starts Messages out of sight if needed and settles the
answer without asking.

macOS answers grant questions synchronously and holds every question about Messages while
it asks the person about it, so no grant is read on the main actor: Automation and Full
Disk Access are actors of their own (`MessagesAutomation`, `FullDiskAccessGrant`), their
calls into macOS run on threads that may wait (`Blocking`), and while the helper's own
Automation question is on screen the grant reads `requestable` without asking macOS at
all. A second request joins the question on screen. A check macOS holds for somebody
else's question gives up after two seconds as `unknown`, every read meanwhile sharing it.
`data.invoke` reads only the grant its operation needs; a question on screen counts as
work under way, so no restart takes it down. Every refusal names the app the person
switches on: `Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.`

The build generates `DataContracts.generated.swift` from the catalog: each operation's
`computerAppOperationContract` and effect. Before any app is touched, `data.invoke`
refuses an app or operation this build does not serve, a contract or effect from another
build (`unsupported`), a write without `read-write` access (`failed`), and a grant not
allowed (`permission-required`, never a prompt). An app's own refusal passes through;
anything else it throws is `outcome-unknown` for a write and `failed` for a read, and
every hop treats a lost answer to a write the same way (`computerUseRequestMayHaveEffect`).
A change whose deadline passed before it started is refused as not done, and EventKit's
own refusal of a change (anything but its internal failure) changed nothing. A restart
for Screen Recording waits for app calls under way as it waits for sessions (§2 Launch).
[helper-data-contracts.test.ts](../tests/helper-data-contracts.test.ts) holds every
compiled contract, and an answer the helper's own rules wrote for every operation, to
the catalog.

Readiness is the grant: an operation is `ready` once its grant is `granted`, otherwise
`permission-required` with that grant as the remedy. A status probe reads `data.status`
the way it reads `permissions.get` (§2 Launch), and a Mac with no helper reports every
grant `requestable`. Desktop main refuses `data.request`, like `permissions.request`, from
every Runner. Once the person answers macOS desktop main forgets the grants the helper last
reported and sends every slot's Runner `grants.changed`, so the Runner reads its apps'
readiness from the helper again, reconnecting or launching an installed one, rather than on
its next round; requests to look again made while one waits are answered by that one.

#### Setting an app up on this Mac

Every macOS step for an app the helper serves is taken in one panel on this Mac, the
setup guide ([computer-app-setup-guide.ts](../apps/desktop/src/computer-app-setup-guide.ts)),
floated in the bottom-right corner beside System Settings. It opens three ways: after the
Host accepts an approval of the app, from the app's **Set up** on this Mac's page, and as
an offer when an agent's call finds a grant missing — the Host forwards that call whatever
the Mac's readiness says, so the helper's `permission-required` comes back through this
Mac's Runner bridge, which tells desktop main. An offer waits for the person's **Set up**;
after **Not now** that app is not offered again for 30 minutes. One app is set up at a time;
another waits, and asking again for more access widens the setup already showing or
waiting.

Steps are the grants the access needs that macOS does not give, reading first, because
reading is what the person asked an agent to do. Full Disk Access, and a grant macOS refused
before, is a switch in System Settings: its pane opens once when the step starts, and again
only from the panel's arrow. The rest are questions macOS asks in place. Nothing ends setup
but the person or success: a question that outlasts any request deadline is still the step,
the panel reads the grants once a second and moves on when the answer arrives, and asking
again joins the question on screen. `unknown` after asking is not success — Messages may not
have started, or macOS may be holding the answer — so the step stays and the panel can ask
again. While Full Disk Access is the step, the guide sends `data.request(full-disk-access)`
every 10 s, so a helper that still cannot read restarts and a fresh process looks, whatever
the child probe found. A helper gone for under 3 s (restarting) is not shown as away.

The panel explains with pictures: the helper's row as the macOS list draws it, its switch
turning on, and an arrow toward System Settings; for Full Disk Access the row drags into the
list (main drags the installed helper, never a path the page names) for a Mac that has not
listed it. When this app itself has Full Disk Access — the grant a person most often switches
on instead — its row appears struck out with a red ✕, and the panel shakes when it turns on
during the step. macOS's question is drawn with the pointer on Allow. The helper's icon is
the Opensteer mark with a pointer badge (`apps/web/public/computer-use.png`), so the two
Opensteer rows in System Settings never look alike.

Every listing pages by count and by size, so a page fits the integrations frame whatever
it holds, and a cursor continues only the listing whose arguments issued it. Every field
the catalog names is present, `null` when empty. Calendar and Reminders read and write
times on the Mac's clock: a date is a whole day, a time without an offset is the Mac's
wall time (one the clock skips for daylight saving is refused, one it passes twice is the
first), and every time the helper writes carries the offset in force then. Notes longer
than 100,000 characters are cut when read, say so, and cannot be changed here.

- **Messages**: `list_conversations` and `read_messages` read `chat.db` read-only, leave
  out reactions and conversation events, decode bodies kept only in `attributedBody`, cut a
  body at 16 KiB and say so, and read both date encodings. Pages are keyset pages on the
  last row's date and row id; a text search decodes at most 5,000 rows per call, stops two
  seconds before its deadline and hands back a cursor, and fails rather than reading as the
  end of the history when it read nothing. `send_message` runs `osascript` with a constant
  script and the recipient and body as `argv`; a run that started and ended any way other
  than exit status 0, a definite refusal, or a missing conversation is `outcome-unknown`.
- **Contacts**: `search_contacts` matches names, organizations and email addresses
  whatever their case and accents, and phone numbers by their digits when the query is a
  phone number of at least three digits, in the Mac's own sort order, with at most twenty
  emails and phones and 256 characters per text.
- **Calendar**: `list_calendars`; `list_events` over at most 366 days, one entry per
  occurrence, an end date including that day; `create_event`, `update_event` and
  `delete_event` in calendars that allow changes. An event id names one occurrence by
  EventKit's identifier and its start, so an occurrence moved since it was listed is not
  found rather than guessed at; `span` reaches this occurrence or it and every later one.
  A change sets only what it names, and a new start alone keeps the event's length.
  Attendees are read, never invited.
- **Reminders**: `list_reminder_lists`; `list_reminders`, incomplete soonest due first or
  completed most recent first; `create_reminder`, `update_reminder` (which also
  completes) and `delete_reminder`. Priority reads as `none`, `low`, `medium` or `high`
  and a change that does not name it keeps EventKit's own value. Naming the due replaces
  the reminder's alerts: a due time alerts then, a date alone leaves none.

### iMessage channel

The helper is also the transport of an iMessage channel
([Messaging](messaging.md#7a-transports-that-run-on-one-computer)): the Mac's Runner polls it
and sends each reply through it, under the same two grants Messages uses. It keeps no place in
the history — the Runner's adapter holds the cursor — and only two things of its own.

- **A claim per Apple account.** Every poll takes or renews its channel's claim for 60 s, and a
  send needs it too, so a second Opensteer on the Mac (Stable and Beta pointed at two
  Deployments) is answered `busy` rather than reading the same texts.
- **The replies it attempted**, by delivery id, in
  `~/Library/Application Support/Opensteer/Computer Use/imessage-sends.json`. The attempt is
  written before asking Messages to send; a confirmed send adds its receipt. A retry returns
  that receipt, or reports an unconfirmed attempt without sending again. Only a definite
  non-send removes the attempt. Unreadable or unwritable history prevents sending. Records
  do not expire: a pending Host delivery can survive an arbitrarily long offline period.
  Messages has no atomic send-and-record operation, so a crash can leave an unsent reply
  unconfirmed (`delivery-unconfirmed`). A lost bridge answer is `outcome-unknown`, allowing
  the channel to retry the same key to recover its receipt or persisted uncertain outcome.
  The owner is told to check Messages for an unconfirmed attempt; Opensteer does not repeat it.

`imessage.poll` asks Messages which account it uses at most every 30 s (`changed`,
`signed-out`), and `imessage.send` asks afresh, so a reply never leaves from another account.
That question is AppleScript, so each one first settles the Automation grant the way a send
does — definitely, without asking — and answers `permission-required` rather than prompting.
A cursor past `sqlite_sequence` or on a row holding another guid is in a history Messages
rebuilt (`rebuilt`); one on a deleted row reads on. Rows come back in row-id order, as far as
Messages has written them whole: a row not yet joined to a chat, or one whose text is not written
yet, ends the page, for at most 60 s from when this first saw it so — never from when it was
sent, which a Mac asleep while it arrived may have missed by hours — and is then passed over. A
row carries a `message` only when it is a person texting the bot one to one over iMessage, and
received by the bot's own account — `chat.db` keeps every account the Mac was ever signed into —
and `null` otherwise, so the cursor can pass it: the bot's own, a reaction, a retraction, SMS, a
group, or another account's. Text is cut at 16 KiB. A send is a constant script with the
account, recipient and text as `argv`, classified like `send_message`'s; two asks to send one
delivery at once send it once, and Messages runs one script at a time, whoever asks. The Runner
reports a lost grant, a signed-out Messages, another account or a claim held elsewhere as needing
attention and keeps trying, so the channel resumes once the person fixes the Mac; a rebuilt
history stops it for good.

## 3. Runner

Mac integrations remains protocol 5. `RunnerIntegrationsModule.computerUseVersion: 2`
separately gates window-addressed operations; unknown values parse to absent. Desktop
advertises it once a protocol-10 helper completes its handshake, and the Runner relays that
readiness. Missing version 2 refuses before Mac dispatch with
`incompatible-version`, `Update Opensteer on <Mac> to let agents use its apps.`
Computer-hosted MCP servers and window-video capability have their own gates. Android
keeps integrations protocol 4 and its existing observe/act wire.

The execution Runner advertises `RunnerAgentsModule.computerTool: 1`; all shipped drivers
consume the shared `integrationGatewayToolNames`, including `computer`. The Host checks
that authenticated Runner and boot id on each MCP list/call; trigger/watch executions
cannot use the REPL. The execution Runner may differ from the Mac serving the app.

The `integrations` module handler gains one more frame pair beside invoke/result:

```
host.integrations.computer-use   { requestId, sessionId, runId, operation, app, access, params, threadTitle, timeoutMs }
runner.integrations.computer-use-result { requestId, result: ok {…} | error {code, message} }
runner.integrations.computer-use-event { event: {event, params} }
```

`operation` is `permissions`, `installed_apps`, `resolve_app`, `review_approvals`,
`windows`, `bind`, `observe`, `act`, or `close`. `app` and `access` are what the Host resolved; the Runner
passes them through on every window operation, and the helper enforces them.
`threadTitle` is required and nullable; the Runner opens each session once, with
`session.open {sessionId, threadTitle}`, and concurrent first calls share that open. `act`
params are validated before the session is touched. `installed_apps` params are parsed on
the Runner so the Mac sees the defaults, and
the `{apps, total}` answer passes through unchanged. `review_approvals {setupRequestId}`
is answered `{}` by desktop main and never reaches the helper. The handler routes the
frame to the bridge client, which exists only when the desktop supervises this Runner —
stated by `OPENSTEER_COMPUTER_USE_BRIDGE_URL` in the Runner's environment and
`OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN` among the secrets the desktop delivers to it. Without
them the handler answers every computer-use frame with
`unsupported` and the sentence `Computer use needs the Opensteer desktop app on this Mac.`

The bridge token is minted per slot and never enters any environment, because a process's
startup environment stays readable to every process of the same user for its whole life.
The desktop delivers every Runner credential — the enrollment token and both bridge tokens
— as one JSON object in the variable names the Runner parses
([processSecrets.ts](../packages/shared/src/processSecrets.ts)): the local Runner's utility
process receives it on its parent port and starts the Runner only once it has arrived; a
Personal service reads it from standard input, named by `OPENSTEER_SECRETS_FD=0`. The
Runner removes every credential and the bridge URL from `process.env` once parsed, and its
Node takes no inspector by signal (`--disable-sigusr1` from the Personal launcher; the
utility process ignores `SIGUSR1` itself), so no other program running as the person can
read the token out of its memory and drive the helper.

The frame shares the stream's fence and lease with invoke. Ordinary work shares its
concurrency cap, and a full Runner answers `failed` with its own sentence, never `busy`,
which means another task holds the app. `close` and `review_approvals` are control
traffic and are admitted even when every work slot is occupied. A helper `busy` passes
through unchanged and the session is kept for the next call. Cancellation answers a
written `act` as `outcome-unknown` immediately, but its native promise keeps the capacity
slot until work finishes or the connection ends. A stream detach drops the bridge
connection, including pending opens. Native Stop events travel back through the fenced
stream immediately. Bridge loss also reports the ended sessions while the Runner's Host
stream remains connected, so an idle session cannot leave stale live state behind.

**Deadlines.** The Host's `timeoutMs` is one deadline carried down every hop: the Runner
passes what is left of it as the bridge request's `timeoutMs`, and desktop main as the
helper request's. The helper answers by the deadline (§2 IPC), so each hop waits the
deadline plus a grace longer than the one inside it — the helper client 1.5 s, the bridge
2.5 s, the Runner 4 s, the Host 6 s — and an inner hop's answer arrives before an outer hop
gives up. A hop that gives up on a session window operation ends only that request's session:
it closes it on the helper and reports `session.stopped {reason: "app-quit"}` so the Host
starts another. A late read that names no session ends nothing. No hop drops the bridge
socket or the helper connection for a late or refused request; only transport failure, a
protocol violation, a stream detach, or an idle helper connection with no session does.

The `macos-app` definition's readiness rides `runner.integrations.status` like any app:
one entry per operation, from `permissions.get` over the bridge, which desktop main answers
without installing a helper (§2 Launch) — `observe` and `act`
are `permission-required` with remedy `screen-recording` or `accessibility` until both
grants are present. Readiness still requires both even though Mac `act` no longer
observes. Reporting never prompts. A failed probe preserves the bridge's diagnosis:
an unreachable Desktop is different from a running helper that could not authenticate
or answer. An unexpected internal error is reported as a permission inspection failure,
never as proof that Desktop is absent.

**Images.** Every driver declares `mcpImageContent: true`: Claude, Codex, OpenCode and
cursor-agent render MCP image blocks, and the Pi driver, which is Pi's MCP client, maps an
MCP image block onto a Pi tool-result image. Each driver also fills `acceptsImages` on
its model descriptors from its own catalog source, and leaves it absent when the source
does not say: Claude always; Codex from `model/list`'s `inputModalities`; OpenCode from
`GET /provider`'s `capabilities.input.image`, the flag OpenCode itself gates images on;
Cursor, whose listing states no modalities, only for families whose makers document image
input (Claude, GPT-4o, 4.1, 5.x and 6.x other than Spark, Gemini, Grok 4); Pi from pi-ai's
registry. The Codex driver also sets the `output_token_limit` of `computer`,
`integration_call` and `integration_describe` to 10,000 tokens, so a model whose truncation policy counts bytes cannot
cut the middle out of an observation or a 32,000-byte describe page.

## 4. Host

`ComputerUseService` (`apps/host/src/computer-use/`) owns sessions and is the only
caller of the computer-use frame. `ComputerAppApprovalService`
(`apps/host/src/integrations/computer-app-approval-service.ts`) owns the policy, blocks,
setup requests, task asks, installed-app listings and the Mac's projection; each durable
decision is made in one transaction under the Mac's `runners` row lock, and settlement lives
in `packages/database/src/computer-app-approvals.ts`.
[`IntegrationPlatformService.callComputerOperation`](../apps/host/src/integrations/integration-platform-service.ts)
is the internal authority path used by the REPL: `windows`, `bind` and `observe` select
the read row; action helpers select `act`, and phone release selects `release`. Each call
checks current callable rows, schema/installation digests, the access ceiling, effective
grant and Run capability. `integration_call` refuses computer rows and cannot bypass this.
Identity and access are Host-derived. The Mac admission turn rechecks the connection,
identity and active grant immediately before sending; saved-login sealing and waiting for
the answer happen outside that turn.

The catalog's strict internal read input is
`{operation: "windows" | "bind" | "observe", window?: number | string | null, includeScreenshot?: boolean}`;
the write input is `{window: ref, snapshot: string | null, actions}`. The operation-specific
protocol schemas narrow those inputs before dispatch. Catalog/schema digests rematerialise
through the existing installation path when these rows change.

### The computer REPL

`computer {code}` accepts 1–65,536 UTF-8 bytes, as the body of an async function. A
non-`undefined` **returned value** prints as JSON; a final expression alone does not.
`globalThis` persists within a Run attempt. The guest has standard JavaScript built-ins,
`print(...values)`, `sleep(ms)` and these handles:

| Call                                                                                                                                                             | Result / behavior                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps()`, `phones()`                                                                                                                                             | Approved targets with `id`, `name`, `computer`, `access`; Mac entries also have `bundleId`.                                                                                                                                                         |
| `app(query, {computer?})`                                                                                                                                        | Exact id/name/bundle-id match; ambiguity names candidates. `App.windows()` lists `WindowInfo`; `App.window(id?)` returns a window handle.                                                                                                           |
| `Window.observe({screenshot=false, emit=true})`                                                                                                                  | Returns the observation and normally emits header/tree, then image.                                                                                                                                                                                 |
| `Window.click(target, {button, count})`, `.type(text, {into})`, `.key(keys)`, `.setValue(index, value)`, `.scroll(target, direction, amount=1)`, `.act(actions)` | Returns completed receipts in the Host dispatch envelope (`kind: "app"`, `observation: null`, `performed`, `error: null` on success); emits each receipt and never observes. Convenience targets accept an index, `[x,y]`, or a wire target object. |
| `phone(query)`                                                                                                                                                   | Exact id/name match. `Phone.observe()`, `.act(actions)` and gesture/text helpers return and emit phone observations; `.release()` ends the hold. The phone wire retains post-act observation.                                                       |

Failures throw `ComputerError {code, message, performed}`. Window aliases and phone aliases
share latest snapshot state. The worker injects that state at dispatch, so `Promise.all`
operations execute in issue order through one FIFO. When the body settles, dispatched
work drains under its original deadline; queued unstarted operations are cancelled.
Context generation and call id fence late results.

[`ComputerReplService`](../apps/host/src/computer-use/computer-repl/computer-repl-service.ts)
uses one dedicated Node worker (512 MiB old-generation limit), with a separate QuickJS
WebAssembly module per context. No Node, filesystem, network, process or ambient timers
enter the guest. Pending jobs run in batches of at most 64 with a `setImmediate` yield.
Limits live in [`messages.ts`](../apps/host/src/computer-use/computer-repl/messages.ts):

| Resource             | Limit                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active calls         | One per Run attempt; overlap refuses with a sentence. Four execute across the Host; others queue within their own deadline.                                                                                                                                                              |
| Resident contexts    | 16; idle contexts evict least-recently-used, active contexts never evict. Idle expiry is ten minutes, swept each minute.                                                                                                                                                                 |
| Guest memory / stack | 64 MiB / 1 MiB per context.                                                                                                                                                                                                                                                              |
| Guest execution      | A synchronous slice may use 100 ms of the worker thread's CPU time, and may hold the worker every Run shares for 1 s of wall time; 5 s total guest CPU time per call. Time the thread spends preempted is not charged as CPU. Exceeding any of these fails the call and discards its VM. |
| Wall time            | 100 s including queueing. Mac operations and actions use the lesser of their own deadline and the call's remaining time. Phone observe keeps its own 30 s dispatch deadline and receives cancellation.                                                                                   |
| Bridge JSON          | 1 MiB per arguments/result.                                                                                                                                                                                                                                                              |
| Output               | 512 KiB text, eight images and 4 MiB decoded image bytes per call.                                                                                                                                                                                                                       |

Run end, attempt revocation/replacement and idle eviction destroy context state. Ordinary
guest errors retain globals after draining; cancellation, CPU interruption, memory failure
or worker loss discard the affected VM. Cancellation passes the abort signal to the
operation; a dispatched mutation may have happened and is never retried. Output already
accepted remains in order, subject to the bounded failure text fitting the output budget.

Phone handles retain the latest phone `observationId` internally; each phone act returns a
fresh observation and emits receipts plus the new state. The worker clears phone state on
release or a failed operation without an observation; generation teardown clears all handles.
Agents inspect the returned state before reusing indices. See [Agent Phone](agent-phone.md#6-the-agent-contract).

### Sessions, output and Stop

- **Sessions** are in memory, keyed `(runId, bindingGeneration, runnerId)`: one per Run
  attempt and computer, several per Mac:
  `{sessionId, threadId, threadTitle, workspaceId, apps, openedAt, lastUsedAt, actionCount}`,
  with `cus_` ids minted in `packages/protocol/src/computer-use.ts`. The first window operation
  from a Run attempt on a Mac opens one, carrying the Thread's title and the
  attempt's authority; every later call adds the app if it is new to the session. Each
  session summary includes `windows?: [{appKey, id, title}]` for each app's current
  window. It also keeps when its agent last observed or acted in each app; its summary's
  `actingAppKeys` lists apps (lowercased bundle identifiers) with a call in the last
  15 seconds; `actingDisplay` reports accepted phone actions in that window — an agent acting now, not merely holding the app. When that set changes for a
  confirmed session, the Host sends `host.computer-presence` to the Mac's owner's sockets
  only, and their clients patch the session in place rather than rereading the machines list.
  Successful claims are indexed per Mac, so a helper `busy` is answered as
  `This app is already being used by another task. (Thread: <title>) Continue with other work, or tell the person the app is busy; do not retry in a loop.`
  when this Host holds the app for another Run, otherwise as the Mac's own sentence with
  the same next step; a busy app does not end a session that holds other apps.
- **Deadlines.** Each call carries one deadline — `windows`/`bind`/`observe` 30 s, `act` 60 s — and the
  tool call's `AbortSignal`. When the Host gives up on an answer (cancellation, or the
  deadline plus its 6 s grace) it ends only that session and tells the Mac to close it; an
  `act` is then `outcome-unknown`, an `observe` a retryable failure that says to observe
  again.
- **Emission.** The REPL returns MCP `content[]` in emission order, without
  `structuredContent`. Receipts precede an operation's observation. Observation content
  starts with `Looked at <App>` and the snapshot header, then the complete tree, window
  list, blockers and focus/availability notes; its image follows the text. The
  [`computer-use-tool-result.ts`](../apps/host/src/integrations/computer-use-tool-result.ts)
  emitter uses `#mcpImageContent`: both the driver and selected model must accept images,
  otherwise it emits `Screenshot unavailable in this engine.` Every image carries
  `_meta: {"codex/imageDetail": "original"}`. Mac screenshot acquisition follows the
  script's `screenshot` request; the model gate controls emitted images. Protocol-schema
  validation refuses malformed action arguments before dispatch. Errors retain receipts,
  carry `isError` if uncaught, and require the agent to decide recovery explicitly.
- **Close** happens on Run terminal (the execution coordinator calls it), when the
  attempt's grant is revoked (the Thread's Stop, a restart, a cancelled Assignment or a
  background deadline; [Run tool authority](agent-orchestration.md#run-tool-authority)),
  on removal or block of any app the session holds, on stop, when the Host gives up on one
  of the session's calls, and on the ten-minute idle sweep, which skips a session with a
  call readied or in flight, by sending `close` to the Mac; the helper also closes on its
  own when the bridge drops. Revocation ends that attempt's sessions on every computer and
  never a replacement attempt's. Cleanup closes the exact session without needing a live
  grant.
- **Stop** (`integration.computer.session.stop`) is owner-authorized from any client and
  applies to the Run/Mac pair until that Run ends, across its attempts, Runner reconnects
  and Host restarts. Starting a new session ID or attempt cannot undo it, and grant
  revocation neither records nor clears it. Inside admission, immediately before dispatch,
  the Host re-checks the attempt's grant (`assertActiveGrant`), and late results cannot
  restore or update an ended or replacement session. The pill's Stop arrives as one
  `session.stopped` per session with `reason: "user"`, the only reason that marks the
  Run/Mac pair stopped; `app-quit` only forgets the session. A phone's event also names the
  Run (`runId`) and is repeated on its next stream if the last one dropped, so the Host
  records a phone's Stop even for a session it has already forgotten
  ([Agent Phone](agent-phone.md#7-access-and-stop)).

### Host-authored transcript

Each admitted target operation, including `windows`, `bind`, `observe`, action helpers
and phone `release`, produces a Host-authored `tool.started` / `tool.completed` pair.
`apps()`, `phones()`, `sleep()` and `print()` produce no target step.
[`ComputerOperationStore`](../packages/database/src/computer-operation-store.ts) appends
through the Host Workspace sequence allocator; events have no Runner ordinal.
`tool.started.data` is `{callId: "computer:<uuid>", tool: {namespace:
"opensteer.integrations", name: "computer.<operation>"}, arguments: {window?}, integration}`.
The optional argument is numeric (currently supplied by bind); opaque refs, code and
typed text stay out. `integration` is the existing computerApp/phone subject with exact
computer id. Completion uses `{callId, isError, output}`; its first text line is the
sanitised headline from `computerUseHeadline` / `computerUseActHeadline`, followed by
receipts. It stores neither screenshots nor AX trees. The wire adds no status field:
`isError` marks failure/cancellation, whose headline says `This step was cancelled.`

Completion is idempotent. Run-end and Host-start finalization complete unmatched starts
as cancelled, including interrupted calls; cancellation can finish MCP delivery before
the admitted operation settles and records its receipts. The engine's outer `computer`
step remains a compact `Ran computer code` entry and contributes no computer-operation
count. Clients recognize computer steps by subject and read their stored first-line
headline through `readComputerStepHeadline`; historical `integration_call` computer steps
keep `readComputerUseResultHeadline`. Steps keep the transcript's first-arrival order like
every other entry, so nothing moves once shown; a Runner event delivered after the Host
steps it started stays where it arrived. Reload and pagination retain the existing
tool-pair projection.

**Approval from a task** uses the existing `integration_request` gateway tool with the
shape `{kind: "computer-app", runnerId?, app, access, reason}`; `app` is a name, path or
bundle id the Mac resolves. Without `runnerId` the task's own Mac is used, or the sole
eligible Mac; with several, the error lists `name (runnerId)`. The Mac resolves the app
first; the decision is then made in one transaction under the Mac's row lock, against the
policy as it stands then. The matrix:

| Condition                                          | Result                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App blocked on that Mac                            | `<App> is blocked on <Mac>. The person can unblock it on that Mac.`; nothing is created.                                                                                |
| No connection, policy `ask`                        | A durable `Request` of kind `computer.app.access` plus the setup request storing reason, Thread, Workspace and title; `review_approvals` pushed to that Mac; `pending`. |
| No connection, policy `automatic`                  | Deny-list check; connection, tools and the Workspace grant in one transaction; `fulfilled`; the app becomes available through `computer`.                               |
| Connection exists, this Workspace lacks a grant    | An ordinary `integration.access` Request, approvable from anywhere; under automatic, granted inline for `computer`.                                                     |
| Connection exists with lower access                | An access-increase setup request, a native prompt under both policies; never widened automatically.                                                                     |
| Connection exists with sufficient access and grant | `already-available` with a `computer` next step.                                                                                                                        |
| Mac offline                                        | `<Mac> is offline.`; nothing is created.                                                                                                                                |
| Trigger occurrence or delegated capability         | Refused; gui calls also require a running task.                                                                                                                         |

The Request (`requiredActor: workspace-owner`, presentation `external` with subject
`{kind: "computer-app-setup", id}`) lets the Run continue, as `integration.access` does.
Consuming the setup request creates the connection and, when the requesting Workspace is
specialized, its grant, in the same transaction, then fulfils the Request, which delivers
`Request <id> was fulfilled. <App> on <Mac> is available to this task: observe <toolRef>, act <toolRef>. Continue.`
(read-only omits `act`). This continuation still carries legacy internal row refs;
`integration_call` refuses them, so the agent must use `computer` with `app()` instead.
Phone continuations likewise still name internal observe/act/release refs. A decline delivers
`Request <id> was declined by the user. Continue the task without <App> on <Mac> and do not request it again unless the user asks.`
Declining from a client declines that Request and removes the approval only when no other
Thread is waiting on it; it takes the Mac's row lock first, so a Thread joining the approval
cannot be left waiting on one that is gone. An expired setup request expires the Request.

One app on one Mac has at most one waiting approval, however many Threads ask, and every
ask — a task, the picker, an unblock — joins or widens it by one rule. An ask the waiting
approval already covers joins it. Anything else — wider access, the app as the Mac now
resolves it, a new catalog digest, or a Thread joining an approval no Thread carries —
replaces it under a new id with the wider access and moves every waiting Request to it, so
no signature over the old one consumes anything. The prompt keeps naming the first task that
asked; a Thread joining a picker's approval gets a prompt that names it. Nothing is declined
as a side effect: an ask declines only an approval that is already over (expired, or
another owner's), and a connection that appears or changes fulfils the linked Requests its
access covers and leaves a wider approval, and the Threads waiting on it, waiting — a
reduction reissues it under a new id. `Don't allow`, cancellation, expiry and removing the
app or the Mac decline them all. A Workspace's grant is the widest access its fulfilled
Requests asked for, and an approval never lowers a grant it already holds; only an explicit
edit does.

**Discovery.** `integration_search` with a Mac's `runnerId` returns installed apps,
`total`, `nextOffset`, `computer` facts and response-level `guidance.computers`.
Each app carries `name`, `bundleId`, `status`, `callable`, optional `access`,
`pending`, `inUse` and `heldByThread`. Without `runnerId`, the complete catalog's
Computer use entry carries `computers`, each with those app facts. Phone entries
carry `approval`, `access`, `callable`, `state`, optional `inUse` and `heldByThread`.
Read/write tool rows stay internal; agents use `app()` and `phone()` in `computer`.
Shared guidance states approval, busy, blocked and recovery instructions once per
response. `callable` requires a ready compatible target, a compatible execution Runner,
a Workspace grant, and no pending approval or holder from another Run. Access and
state facts remain visible when it is false. `computerToolEnabled: false` requires a Runner update; a Mac's
`computerUseVersion` other than 2 requires an Opensteer update on that Mac.
Neither compatibility condition is fixed by another approval.

Every app is its own account, so the ordinary `integration_request` forms cannot ask for
one: `{catalog: "macos-app"}`, and `{integration: "macos-app"}` without an `account`, are
refused with
`Computer use is requested one app at a time: call integration_request {kind: "computer-app", runnerId, app, access, reason}.`
Computer and phone installations are omitted from `results` and callable operations;
the complete catalog retains their discovery facts. The run guide delivers platform
instructions; MCP initialization has no instructions. App and phone use is documented
in `opensteer-computer-use`.

**rpc** (mutations through `commands.dispatch`): `integration.computer.setup.request`
with `kind: "app"` (`app`, `access`, `definitionId`, `runnerId`) or
`kind: "policy"` (`runnerId`, `appApproval: "automatic"`); `integration.computer.setup.set`, the
signed consume for both kinds (policy answers `connection: null`); `integration.computer.policy.set {runnerId, appApproval: "ask"}`
(owner, anywhere); `integration.computer.app.block {connectionId}`;
`integration.computer.setup.cancel {requestId}`. Direct rpcs:
`integration.computer.session.stop {sessionId}` (POST),
`integration.computer.policy.get {runnerId}` → `{appApproval}`, `integration.computer.setup.list`,
and `integration.computer.apps.installed {runnerId, query?, limit?, offset?, icons?}` →
`{apps, total}` (owner only; a sleeping Mac answers offline). Unblocking is an ordinary
app setup request approved on that Mac. `MachineSummary` carries
`computerUse: {state, detail, permissions, appApproval, sessions}` projected for the owner
only, exactly as `apps` is; the policy stays visible while the Mac is offline.

## 5. Desktop

`ComputerUseService` in desktop main owns the helper and everything the Runner is not
allowed to do itself, for **every** supervised slot whether or not it runs agents:

- installing, verifying and launching the helper (§2), and the IPC client with the
  version handshake and peer check;
- the **bridge**: a loopback WebSocket per slot, its token delivered privately to that
  Runner (§3), forwarding computer-use frames to the helper and answers back. A slot takes
  one authenticated connection at a time; another holder of the token is refused while the
  first is connected. A session is bound to
  the bridge connection that opened it: when that Runner's socket drops, the desktop
  closes the session on the helper. Losing the shared helper connection ends and reports
  every affected session across the desktop's Runner slots. `review_approvals` is
  answered by main itself and runs `reviewPendingRequests()` at once; one review also
  runs every time a Runner's bridge connects and every time a supervised Deployment's
  Runner (re)connects to its Host, which is how a review that failed while that Host was
  unreachable is retried. There is no timer. Every review is bound to one Deployment for
  its whole length — the slot's Deployment for a push or a reconnect, the page's
  Deployment for a picker or policy review — through a Host transport pinned to that
  Deployment with its own session recovery (`deployment-host-transports.ts`), never the
  one the window has selected;
- the **permissions panel**, opened from the computer's page on this Mac: two rows,
  `macOS Screen Recording` and `macOS Accessibility`, each with its state and purpose.
  It requests the first missing permission only after the person clicks Enable,
  then offers a separate `Open System Settings` action for that exact pane. It names
  `Opensteer Computer Use` as the row to switch on, polls once a second without
  prompting, and briefly confirms success before closing when both are granted;
- the **approval panel**, the one confirmation for every approval. It floats above
  everything but is shown inactive and never takes the keyboard, because a request arrives
  while the person is typing elsewhere; its first key is the answer that says no, and only
  the panel's own web contents may read or answer its token. For an app it shows
  `Let "<Thread title>" use <App> on this Mac?` (or `Let agents use <App> on this Mac?`
  from the picker), the Workspace, `Reason: <reason>`, the app's icon and name as the
  helper resolved them, the access in the product's words, the elevated note
  `This app can reach your files, signed-in accounts or system settings. Agents can use whatever its interface offers.`
  when the helper reports it, and `Don't allow` / `Allow`, with Don't allow focused. For the policy it shows
  `Allow any app automatically on this Mac?` with
  `Agents acting for you can see and control any app on this Mac when a task needs it, including apps installed later, and including browsers, Finder, Mail and System Settings with what they are signed in to. Password managers, terminals and automation tools stay off limits. Blocked apps stay blocked.`
  and `Cancel` / `Allow any app`, with Cancel focused. Every setup request the Host lists
  for this Mac is shown, one panel at a time; a page on this Mac that created one waits for
  its answer through `reviewComputerAppSetup({setupRequestId})`, which shows it next, and
  every caller waiting on the same request shares its one panel. Main verifies the target
  as `assertComputerAppSetupTarget` does, refuses an app the helper reports as not allowed,
  signs the answer with this Mac's approval key and sends it on the slot's Runner stream;
  the Host consumes or declines the request. An app whose identity on this Mac no longer
  matches the request (the shared, case-insensitive identity check) is neither shown nor
  declined, so the Thread is not told the person refused it. Once the Host accepts the
  Allow of an app the helper serves, main hands it to the setup guide
  ([Setting an app up on this Mac](#setting-an-app-up-on-this-mac)), which takes whatever
  macOS steps that access still needs; the approval itself names none. A decline, a
  refusal, or a request that ended elsewhere sets nothing up. The renderer contract is
  [RENDERER-CONTRACT.md](../apps/desktop/src/computer-use/RENDERER-CONTRACT.md).

The [negotiated owner-input lane](#negotiated-mac-owner-input) uses this same
bridge and helper. Desktop offers
`ownerInputVersion: 2` in its protocol-10 hello and forwards owner input only after
that helper confirms it. The bridge checks both the connection-bound view source
and the stream owner on every request. Person input carries no agent observations,
transcript steps or text-bearing action receipts. The local pill says
`Remote control of <App>` and its Stop button releases independent input even when
there is no agent session.

## 6. The page

On a Mac's detail page, **Apps agents can use** gains a **Computer use** block:

- Not set up: `Let agents see and operate apps on this Mac while you keep using it.`
  and `Set up on this Mac` here, or `Set up from <Mac>` elsewhere.
- Needs permissions: which of the two is missing and `Open System Settings`.
- Ready with nothing approved: `Which apps can agents use?` over the **App approvals**
  control, `Ask for each app` (default) and `Allow any app automatically`. Choosing
  automatic opens the native confirmation on this Mac (elsewhere:
  `Turn this on from <Mac>.`); switching back to ask is immediate. Under automatic:
  `Apps appear below as agents use them.`
- Ready: approved apps as rows — icon, name, access — with `Remove` under ask or `Block`
  under automatic, each acting on the first click; blocked rows show `Blocked` and
  `Unblock on this Mac`. `Add app` (only on that Mac, secondary) opens the picker, which
  searches and pages on the Mac; each row offers `Can see` and `Can see and control`, and
  choosing one opens the native panel directly. Live sessions are one row each,
  `Using Notes · <Thread title>`, with `Stop`.

In a Thread, adjacent Computer use steps for one app on one Mac read as one row:
`Using Slack` while live, with the step in progress (`Clicking in Slack`), and
`Used Slack · <n> steps on <Mac>` once settled; opened, it lists each step by its
headline (`Clicked "Opensteer 2"`). These are the Host-authored operation pairs;
failed or cancelled operations read as stopped. The engine's enclosing `computer` call
appears once as `Ran computer code` and does not inflate app-step counts. While a live turn works on the reader's own Mac, its
status line says so in place of `Working`: what it is doing (`Typing in Notes`, and
`Using Notes` between steps), then where (`On example-mac`, `On example-mac · also using
Calendar`), with `Stop using Mac`, which ends that Run's use of that Mac and lets the reply
carry on — unlike the composer's Stop. The line needs both the turn's latest step and the
session: only the Mac's owner sees its sessions, so everyone else reads the ordinary status
(`Typing in Notes on example-mac`), and a session that is stopped, swept or on a Mac gone
offline takes the line with it. A reader scrolled away sees the jump button read
`Using Notes on example-mac`, and a task's bubble in the conversation that handed it out
says the step with its Mac. A `computer.app.access` Request renders as
`Wants to use Notes on example-mac` with the reason; `Approve on example-mac` is information
(the panel appears by itself on that Mac) and `Decline` acts. Mobile shows both, and can
stop and decline but not approve. Machine-change notifications refresh the shared client snapshot, so live state
does not depend on the Computers page being open. Cached sessions and app `In use`
markers are hidden when the target Mac is offline or the client is disconnected from
the Host. App approvals remain visible. Remote `Stop` ends the selected task's session
on the named Mac; it does not stop another task or that task's sessions on other Macs.

The New tab lists approved apps. With Host capability `ownerViewWindows: 1`, available
Mac apps fetch `computer.app.windows {machineId, app}` together, which reads what is open
without starting an app or taking a work slot; an app with at least two windows gets a
window picker. The list is what the app reports through Accessibility, and macOS can omit
windows on other Spaces (N5 proves it for a full-screen Space): such a window appears once
the person switches to its Space. A window the helper cannot verify is left out and
counted rather than hiding the rest, because opening a view checks its window again; the
agent's own inventory fails closed instead. Each list writes one helper log line
(subsystem `com.opensteer.computer-use`, category `apps`: bundle id and counts), and a
refused list logs Host event `computer.app.windows` with its reason, so a missing picker
is diagnosable. Rows show title, `Minimized` or `Other Space`; choosing one opens
`{kind: "app", app, window: id}`. The app tile itself opens the native focused → main →
first window, independently of any task. Owner tabs use
`app:<machine>:<appKey>:<windowId>` and title `<App> — <window title>`; multiple windows of
one app remain independently closeable. Task tabs use
`app:<machine>:<appKey>:task:<sessionId>` and follow that session's current-window summary.
Owner and task destinations never merge or substitute, even when both show the same
window. Ending one authority leaves the other listed.

When that Mac advertises window video, the reply shows a chip for each app its steps
used; the chip, not the status line, opens the app. The conversation's pages and apps
show one tile per app, including work delegated by the conversation, green while an
agent acts in it (`actingAppKeys` and phone `actingDisplay`). An opened tile names both its exact session and app;
ending that session never opens another task or app in its place. The picture can be
enlarged to the size of the window. Mobile opens the same app in its pages screen with
Back and fit/zoom. The Host ends a Run's sessions when the Run ends,
so a session naming the Thread is its work in progress; the Host's owner-only projection
also covers the effective owner's primary, deployment-owned Mac.

Task Watch and owner views use the same DisplayStreamHub and H.264 decoders on web,
Electron and Expo. The Host rechecks ownership, exact task/app or owner generation and
live grants before admission. A task changing windows moves only its own subscription;
an owner stays bound to the window selected at open. No passive JPEG viewing RPC remains.

Local and remote integrations continue to use their ordinary activity/results; only browser
and computer use expose real viewing surfaces.

Phone live display uses the owner-only WebSocket upgrade
`/v1/computer-use/sessions/:sessionId/display`. The Host authenticates it like browser
sockets, checks the session's owner and live attempt grant before admitting it, then
reauthorizes every five seconds and on login expiry. `display.state` and editing messages
JSON accompany binary H.264 frames; clients send acknowledgements, input, input reset or `display.keyframe` messages. The shared
[display contract](../packages/protocol/src/display-stream.ts) bounds each viewer to four
unacknowledged live frames and 1 MiB, with one larger frame admitted into an empty window.
A viewer acknowledges every frame it received exactly once and in order, once its decoder has
taken it off its queue or the viewer chose to drop it. A joining viewer, or one that asks for
a keyframe after losing its decoder state, first receives the Host's cached frames from the
current keyframe on, bounded by bytes alone; their state names the last of them in
`replayThrough`, and the viewer shows nothing older. Replayed frames keep their original
sequences, so after such a state a viewer's sequences restart at or below the replay's first
frame and increase again from there. Scroll deltas have a mouse wheel's sense: positive `dy`
reveals content below. Closes 1001, 1008 and 1013, and transport closes 1005, 1006, 1011 and
1012, are transient and retried with backoff; 1000 (ended or unsupported), 1009, 4002 and 4003
are terminal. Watch does not renew the hold; accepted owner input does. Input checks the current generation and projected shared-input authority.
See [Live display](agent-phone.md#live-display) for the phone’s shared input and gesture rules.

Web and desktop decode the stream with WebCodecs. Before opening a socket they ask whether
the browser decodes Constrained Baseline H.264, preferring hardware; one that cannot reads
“This browser can’t show <phone>’s screen”. One socket and one decoder serve every view of a
session in a client. Each generation is configured from its keyframe's codec, Annex B with no
description, and its deltas wait for that keyframe. A frame is acknowledged once the decoder
takes it off its queue, never waiting for output, and the newest decoded picture is drawn on
the next animation frame. Replayed frames before `replayThrough` are decoded and acknowledged
but never drawn, so a joiner's first picture is the screen as it is now; the viewer bounds no
decode queue of its own. A decoder that fails or rejects its configuration keeps the last
picture and sends `display.keyframe`, again each coalescing interval while live and without a
keyframe, six times at most before it reads “Couldn’t show <phone>’s screen”. The last picture
stays through a generation change or a transient reconnect until a newer one decodes, and leaves
the screen on `protected`, `stopped`, `failed` or `unsupported`, on a terminal close and when
the login changes. After a terminal close the last state chooses the words, such as “Finished
using <phone>”, “<phone> stopped sharing its screen” or “Couldn’t show <phone>’s screen”, and
nothing reconnects until the view is opened again. A transient close reconnects with backoff,
with input reset and no input replayed.
[`phone-display-stream.ts`](../packages/client/src/integrations/phone-display-stream.ts)
owns the transport and the web view's
[`phone-display-media.ts`](../apps/web/src/components/phone-display-media.ts) the decoder.

People press directly into a phone picture or authorized Mac owner picture to focus typing.
Pointer, wheel and keyboard input use only the current displayed geometry; opening the view
never focuses its hidden keyboard. Phone navigation appears whenever input is available.
Blur, hide, F6 and leaving reset input, cancel composition and release all held contacts.
Mac task Watch remains view-only. Phone gesture integrity is owned by
[Live display](agent-phone.md#live-display); Mac integrity is described under
[owner input](#negotiated-mac-owner-input).

Remote Stop is the Host taking the Run's authority on that Mac back, and it is complete
when the RPC returns: the Run can never call there again, even after a Host restart, and the
session leaves the list. A Stop, remote or from the Mac's own pill, is recorded for as long as
its Run lasts, because a Run outlives a Host restart; a Stop the Host could not record still
holds in that Host, and the RPC fails so the person can press it again.
Telling the Mac follows; a Mac that does not hear it ends the session when its connection
drops or its idle lease runs out. Stopping a session the Host no longer holds is already
done, so a Stop can always be pressed again. Every surface — the Thread's line, the
Computer view, Settings — sends Stop through one client store, so they show the same
`Stopping…` and `Stopped using <Mac>`; the store is cleared on sign-out or identity change.

### Words

| Concept              | Use                                             | Do not use                                |
| -------------------- | ----------------------------------------------- | ----------------------------------------- |
| The feature          | `Computer use`                                  | CUA, GUI automation, agent control        |
| Observe-only access  | `Can see`                                       | Read only, view                           |
| Full access          | `Can see and control`                           | Read-write, full control, Full access     |
| The policy           | `App approvals`, `Allow any app automatically`  | Full access, trust mode, auto-approve all |
| Taking an app back   | `Remove` (ask), `Block` (automatic)             | Revoke, disable                           |
| Input into a picture | Click, drag, scroll and type                    | Take over, Give back                      |
| The helper           | `Opensteer Computer Use` (as macOS shows it)    | daemon, service, agent                    |
| A live session       | `Typing in Notes` · `On example-mac`            | session, CUA session                      |
| Ending one           | `Stop using Mac` in a Thread, `Stop` on its Mac | Cancel, Kill, End session                 |
| The grants           | `macOS Accessibility`, `macOS Screen Recording` | permissions (alone), TCC                  |

Mac owner pictures accept shared input when every hop negotiates
[owner input](#negotiated-mac-owner-input) for a read-write app approval.
Only the Host’s projected `sharedInput: 1` enables input.
“Use on this Mac” remains the separate operation that brings the app forward locally.

## 7. Out of scope by decision

Windows and Linux; Macs without the desktop app (the sentence in §3); a locked Mac (the
helper's `unsupported` sentence); approvals for one task only; approving a Mac's app from
the Opensteer mobile client (automatic mode is the away-from-home path); recording or interpreting
arbitrary physical input to the same app on a Mac; two agent sessions in one app at once;
tree diffs between observations; and AppleScript
or any text-command escape under an app's name.

The `android-phone` display definition reuses the Host session protocol.
[Agent Phone](agent-phone.md) owns its access and execution contract.

## 8. Verification

Use the cheapest check that shows the changed requirement or bug
([How to test](testing.md#how-to-test)). Most helper behavior is logic with fakes
and runs on the host, before merge:

```sh
swift test --package-path apps/desktop/native/computer-use --filter ComputerUseCoreTests
pnpm exec vitest run apps/host/src/computer-use/computer-repl/computer-repl.test.ts
pnpm exec vitest run packages/protocol/src/computer-use-helper-wire.test.ts tests/computer-use-action-schema.test.ts
```

`ComputerUseCoreTests` must never reach real windows, focus, activation or event
posting. Interactive tests must not interfere with a person using the host screen. Its action
tests inject complete fakes for AX calls, focus guards, process reads and input,
and unexpected input fails the test;
[a repository guard](../tests/computer-use-core-host-safety.test.ts) rejects direct
live entry points. That is a structural guard, not a sandbox: the fakes prove
ordering and refusal, and the VM journeys prove real focus and key order. Tests
that need a window server belong in `ComputerUseLiveTests`, which runs only in
the VM.

The [Host integration file](../apps/host/src/integrations/computer-use-journey.integration.test.ts)
uses real PostgreSQL and the authenticated MCP gateway with scripted Mac/phone
peers. It catches Host, database or transport bugs that module tests cannot show;
it does not establish native pixels or real-engine behavior. Computer apps and
the iMessage channel have their own integration files beside their sources. The
client picker and transcript presentation have a mock-Host journey,
`pnpm --filter @opensteer/web test:computer-windows`.

What only a real Mac shows (saved logins reaching exactly the right field, the
person's keys staying in order and in their app, bound windows and video, the
helper's launch) is the [macOS VM journey set](testing.md#gui-test-vms), run
after merge or on demand. When a bug needs the real GUI, extend the journey for
that flow rather than adding a new one. The Chrome
[fixture README](../apps/desktop/native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/README.md)
describes its cases.

Agent input is addressed to the target process only (Invariant 4, enforced by `tests/computer-use-core-host-safety.test.ts`); a person's app switch cannot redirect it to another app.

Owner input follows the same layers. `OwnerInputStateTests` and `CaptureLayoutTests`
(in `ComputerUseCoreTests`) cover fence and drain ordering, release epochs, bounded
queue admission, retired sample incarnations, the independent Stop pill and which
layout changes retire a capture generation. The Host socket journey in
`display-stream-hub.test.ts` covers opt-in projection, read-write admission,
viewer-correlated clipboard replies, stale generations and disconnect release against
scripted native peers. The real-GUI check is the
[native Mac owner journey](../apps/desktop/native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh):
AppKit and Electron fields through the real helper core and decoded H.264, covering
shared input during agent typing, viewer contention, IME commits, verified and stale
replacement, paste, copy, secure refusal, composition fencing and cleanup.
`OPENSTEER_MAC_OWNER_VIEW_ONLY_JOURNEY=1` selects the baseline view-only peer checks and
`OPENSTEER_MAC_OWNER_ENGINES=appkit` one engine. It does not exercise the Host/Runner or
the signed responsible-process path. `OPENSTEER_VIDEO_DIAGNOSTICS` adds content-free
input-dispatch and capture timestamps on the helper's monotonic clock.

Regenerate the checked-in Swift wire fixture only for an intentional contract
change, then review the diff:

```sh
cd apps/desktop && OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --package-path native/computer-use --filter HelperWireFixtureTests
```

Keep artifacts only when a manual acceptance or release check consumes the journey.
The `windows` journey runs `current`, `settle`, `cancellation`, `video` and `receipt-switch`; results and case seconds are under its `$OPENSTEER_JOURNEY_OUT`. `video` includes owner loss without a destroy notification. `receipt-switch` keeps the live plain-to-secure field switch (username `c`, password `anary`); transient AX recovery, posted-event gates and the other receipt scenes use host fakes.
`OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR` preserves Host REPL results;
`OPENSTEER_COMPUTER_WINDOWS_EVIDENCE_DIR` selects client screenshots and results.
The display smoke accepts a length-prefixed recorded stream through
`OPENSTEER_DISPLAY_SMOKE_RECORDING` and saves `display.json` through
`OPENSTEER_DISPLAY_E2E_ARTIFACT_DIR`. These are diagnostic outputs, not additional
per-change deliverables. Partial or skipped cases are not passes.

No automated check covers these; manual acceptance or release checks verify them when
the shipping flow changes:

- The real Contacts and EventKit stores. Fixture tests hold the helper's rules
  from records, since reading the stores needs a person's own grant and data.
- On a Mac signed into a real Apple account: the id and handle Messages reports
  for its account, and that a row's `account_guid` is that id (until shown, a
  channel that reads nothing is failing closed); the order Messages writes a
  row and joins it to its chat; whether `message` keeps `AUTOINCREMENT`'s
  counter through Messages' own maintenance; and sends signed as the release
  helper.
- Shipping-path behavior beyond fixtures: real Chromium/Electron surfaces,
  localized Services menus, an app that hangs under the real helper, first-run
  macOS permission onboarding, the overlay's look, and Developer ID builds
  (signing, notarization and the Developer ID peer requirements).

## Owner-view wire

The owner-view contract lives in
[`computer-view.ts`](../packages/protocol/src/computer-view.ts). It is independent of
Run sessions: one effective owner/approved window target has one live view generation, and a
capture never renews it. Visible client retain handles renew; hiding or releasing the
handle stops renewal, and showing it again renews at once. A handle outlives a failed
renewal (retried after 1 s, backing off to the 30 s period) and a dropped connection
(paused, renewed at once on reconnecting); it ends on release, a failed, ended, expired, replaced or
unapproved view, an authorization refusal, or a change of signed-in person
([retainers](../packages/client/src/host/computer-view-retention.ts)). Mac idle expiry is
ten minutes, phone expiry three. Explicit close ends that owner generation across clients
and leaves task sessions and OS apps alone. Closed/expired/revoked authority needs an
explicit reopen. Owner-only machine metadata lists at most 64 views; changed/removal
notices carry exact generation identities, and a removed generation never returns from a
command answer or reread that left before the removal
([records](../packages/client/src/host/owner-view-records.ts)).

Workspace native destinations use an explicit task-session or owner-view source.
Owner app rows key by machine, app and resolved window id; task rows key by machine,
app and exact session. Phone owner rows retain their independent owner-view identity.
An owner destination never substitutes for an ended task destination, and an agent's
Watch never borrows the owner's binding.

Conversation surfaces enumerate only task sessions. A view is never a task grant or
automatic message context. The person's view shows a picture only while its generation is
ready on an online, ready computer, rechecked after each decode; explicit suppression,
terminal media state or ended authority clears it. A realtime reconnect does not: the display
socket is admitted on its own and reports its own drops. A static decoded
picture remains visible while its stream and authority stay healthy; frame age and transient
encoder recovery never turn it into Waiting.

A computer that is back but has not yet reported its apps (the Host lists them as empty
until it does) reads Connecting, never a guess from its other fields. The New tab asks the
same readiness before it offers a view, and also leaves out a phone its owner paused, which
an open view sits out but a new one could not show
([`newOwnerViewReadiness`](../packages/client/src/integrations/computer-reasons.ts)).
A computer that can't show its apps, or a phone that can't show its screen, folds to one
line after the rows that open: its name and a word or two. An away computer (offline,
connecting, updating or paused) offers nothing; one its owner must fix (an update, a
permission, the desktop app) opens its computer page. Losing the Host folds nothing. Typing
still finds a folded computer's apps, after every row that opens; one that is only away is
never highlighted, chosen or opened.

`host.integrations.computer-view` carries the authenticated auxiliary fence, version,
view ID/generation/leaseDurationMs, exact target and operation. Its open/renew/close results
use a separate result frame. The helper/bridge schemas freeze matching `view.*` operations.
`view.activate` additionally names the exact app; Desktop main verifies the selected
Host attachment and the enrolled local Runner through the same authority used for app
approvals. A Personal deployment hosted here uses its supervisor’s hosting Runner;
a deployment reached from elsewhere uses this Desktop’s enrolled slot Runner. The
slot bridge then verifies the owner view, generation and exact approved identity,
and the helper checks the pinned running process before activating it. Activation
refusals cross IPC as typed results; the UI shows concise words and offers the action
only for a live, ready local view. The optional `useComputerViewOnThisMac` bridge method is absent in
clients that cannot perform that check. Selecting a picture never activates an app.

An independent Mac owner view selects its exact process start stamp and WindowServer
ID at open: an explicit `window` must be an AX member of the verified app; omitted
selects AX focused window, main window, then first window. The Host records the returned
`window: {id, title}` and deduplicates against a ready matching owner view after native
resolution. It never borrows a task's current window. AX prepares that
binding and supplies lifecycle notifications. ScreenCaptureKit captures that exact window
without activation, raising, input or Space changes. Off-Space windows remain eligible;
minimized/closed windows end the owner generation. Composition follows the [window-group rules](#2-the-helper); `alone` excludes auxiliaries.

One helper-owned SCStream and hardware VideoToolbox H.264 encoder serve each exact binding.
The native registry includes starting/stopping sessions in its two-session cap and serializes
native starts/stops. Running producers serialize configuration updates independently, so one
window’s slow stop does not block another window’s safe profile update. It admits eight viewer
subscriptions per authenticated Mac connection, retaining at most one session warm
for 30 seconds from the last visible subscriber’s departure; repeated empty demand cannot
extend that deadline. Warm demand retains exact existing sources,
never renews their authority, encodes/sends nothing and retains only one eligible current
buffer for a static-window IDR on return. The Host clears its replay cache while warming;
warming is separate from privacy suppression. Resource eviction retires the warm logical
stream without ending a valid owner lease. A third visible target cannot preempt an existing
viewer. One pending target may wait behind a retiring warm stream’s unsettled stop, without
allocating native resources. Returning to the same binding while its retired producer is still
stopping waits for that producer, without evicting another window or allocating a duplicate.
Its sources, binding and connection are revalidated at admission;
stop, source loss, disconnect or expiry cancels the reservation. Two visible roots refuse a third. Close, expiry, revoke, invalid binding, system
Stop, lock/sleep or control connection loss closes publication and discards pixels before
asynchronous OS teardown. Capacity remains occupied until native completion.

Discovery runs on the control plane; frame callbacks, encoding and final writes recheck
cheap cached binding/authority/generation gates. Samples and encoded output carry their
publication generation. A crop, profile, scale or window topology change closes
publication and input admission. The producer stops the old SCStream, drains its
capture queue and encoder, then creates a different SCStream in a new display
generation. The exact root/process binding stays fixed. The [group resolver](#2-the-helper) admits the root and its
OS-associated same-process surfaces, plus its eligible menu-bar menus, and clips their
union to the root's display. Unrelated sibling documents stay excluded even when they
overlap the root. macOS sharing controls,
including the purple badge, are accepted. Off-Space capture selects the independent root;
auxiliary coverage is limited. Same-app additions/removals and mode/geometry changes
retire the picture until the replacement incarnation produces a keyframe. They do
not withdraw app authority. Update completion is not a sample-origin barrier;
no timestamp/dimension heuristic relabels old samples. Suspended output clears pixels and
consults tracked window lifecycle before restoration. Owner exit and terminal stream errors
end the assignment; complete-frame silence never does. Source or connection replacement
retires the earlier socket's decoder output; on web and Electron the displayed picture stays,
refused for input, until the current socket draws one, and gives way to the starting words
after five seconds open without one. Expo clears it. Same-source profile recovery may retain
a valid picture. The stream
uses SDR NV12, queue depth three, no cursor/audio, hardware Baseline H.264 without frame
reordering, and Annex B SPS/PPS on IDRs. Only eligible complete samples are submitted; this is not an independent pixel-change
detector and does not guarantee zero encoding of static content. Visible viewport demand
aggregates to one profile up to 1920 long side/30 fps with hysteresis, initially 1280/30.

Resolution, native admission, enumeration, start and first usable keyframe share one
30-second end-to-end startup deadline. Mac integrations starts carry the remaining duration
(1–30,000 ms), reduced at each hop; pending teardown admission spends that same budget. Clients show “Starting window sharing…” and then
explain a slow macOS start. Expiry yields one terminal failure and deliberate “Open again”;
late completions cannot publish or free an unsettled native slot. A terminal owner generation
is never renewed. New viewers join the current attempt. Host info logs identify owner/stream
open, ready, first frame, warming, suppression, failure and close with typed reason, source
view ID/generation and stream ID, without pixels. Native capture failures also log the
operation stage, error domain/code and typed helper code before mapping to a viewer reason.
Window enumeration failures retain their native domain/code; diagnostics never include
the native error's user-info dictionary, window text or media.

The on-demand agent screenshot/AX path shares the window-group rules and retains its JPEG
bounds; viewer frames never authorize an agent action. No Electron-local capture path or
screenshot fallback exists. Same-Mac clients use the selected Host route, including a cloud
round trip where applicable. Native Expo decode and shipping signed capture require real
E2E qualification; a Metro export alone does not prove them. Mac window video is disabled
on iOS for this release pending native decode and suppression qualification. The macOS 27.0.1
sharing badge is permitted app presentation; final shipping-path qualification is recorded
separately from native build and export checks.

Mac Runner and Desktop helper use owner-view version 3. Host capability
`ownerViewWindows: 1` gates the owner-only `computer.app.windows {machineId, app}` RPC,
which returns `{windows: OwnerWindowInfo[]}`. The owner inventory contains
`{id, title, focused, main, minimized, onScreen}` and no helper refs. The Host checks
ownership and the exact approved connection before and after the inventory call.
The fenced `host.integrations.computer-app-windows {app, requestId, timeoutMs}` frame
and `runner.integrations.computer-app-windows-result {requestId, result}` carry that
request/result, with a 1–30,000 ms wire timeout (the Host currently uses eight seconds).
The result is `{kind: "ok", value: {windows}}` or a typed refusal. Runner maps it to
helper `view.windows`, creating no task session, reservation or lease. The Host sends
picker frames and window-aware owner opens only to a version-3 Mac.
Phones use the [current phone descriptor](agent-phone.md#4-the-runner) and authenticated encoder status; they carry
no owner-view capability version, and accept only lease open/renew/close. Phone viewing
uses the generation-bound display socket in [Live display](agent-phone.md#live-display).
Mac admission requires matching signed and authenticated window-video capabilities. The
helper's negotiated version survives idle disconnects; opening a view reconnects on demand.
The Runner caches permissions and the negotiated version in one readiness
result, invalidating both on bridge loss, stream replacement or a grant-change notice. Icon hydration asks only online Macs with an available authenticated
Mac app producer, and retries when producer readiness changes. An owned Mac whose
inventory producer is offline or not ready returns an empty page with the typed
`unavailableReason` (`offline` or `not-ready`), rather than an HTTP conflict; phones
and computers outside the viewer’s owned Mac inventory cannot use this endpoint.
Upgrade the Host before Runners or phones; older Hosts reject the strict
descriptor/status fields. The Host sends a bounded `leaseDurationMs`; the bridge, helper and
phone measure expiry relative to receipt using local monotonic time. Only the Host's client
projection contains absolute `expiresAt`. Video cannot renew a lease. Owner open/activate and video control bypass the agent work
lane. Transient renewal transport errors preserve authority until its actual expiry. The mock
exercises lifecycle and approval filtering without establishing native capture correctness.

Phone producers are keyed by authenticated phone/display/fence, independently of viewer
sources. Owner generation removal and task session removal close only their subscriptions;
control remains bound to the exact task and stream incarnation. Source changes do not
restart a surviving producer. Global protection, lock and sleep clear the common GOP and
all decoder/canvas pixels; resume starts a fresh publication generation. The phone keeps
one bounded MediaProjection acquisition turn behind current agent work, with separate
media drain and input lanes. Mac video retains independent source authority. No phone
viewer screenshot budget or phone viewer JPEG encoder remains.

### Negotiated Mac owner input

Every hop negotiates owner input version 2; legacy version 1 is read tolerantly and enables
no input. Writers emit version 2 only to peers that offered it. The viewer sends `sharedInput=1`
and receives `display.state.sharedInput: 1` only while its exact owner-view generation and
read-write app approval authorize input. Editing additionally negotiates `editing=1`.
The Host relays input and reset with no control ID. Results and clipboard replies correlate
by sequence to their originating viewer; editing context reaches authorized editing viewers.
See [Host compatibility](host-boundaries.md#compatibility) for previous-release viewers.

Capture generations fence the picture-to-window mapping: root identity/frame,
exterior member geometry, crop, display, scale and capture mode. A child wholly
inside the root does not retire that mapping when it appears, disappears or
changes within those bounds. This includes AppKit sharing controls and genuine
sheets/popovers; all remain in group discovery, capture and input routing.
A member extending the composition, a shrinking crop, a root move/resize or a
display/scale change still retires and drains the stream; queued old-generation
input remains stale.

The lane has the following authority and cleanup rules:

One per-app mutation coordinator serializes person batches and every mutating agent effect,
including AX mutations. A person press waits for the current agent effect. An agent effect
while a person holds a button or key fails with “A person is pressing in this app; try again.”
Two viewers share one person lane; another viewer’s batch receives `contended` while held.
Observations remain valid after person input. Text edits rotate context after intervening edits.
Reset discards queued input and finishes physical cleanup before admitting the next batch.
Blur, hide, F6, leaving, geometry changes, lock, target or approval loss, disconnect and Stop
reset input. Held contacts retain the five-second liveness bound.

The helper reserves complete batches in a count- and byte-bounded person lane,
separate from agent actions. Shared focus protection inherits the calling lane's
executor, and each lane owns its own shortcut index, so person input does not
queue behind agent AX reads. Bounded native focus rounds share an asynchronous
gate so restoration cannot compete over the local front app. Agent preparation
ends its taps and screen hold before delivery; a local click or window switch
during delivery does not stop agent input. Remote person bursts retain their
keyboard protection and after-input watch, and the mutation coordinator serializes effects. Stop sends
cleanup-only releases without waiting for that gate. Held keys/buttons retain their original process and
AX window identity. Mouse input includes hover, modifiers and click count; wheel
deltas map from normalized picture fractions to native pixels. Keyboard characters
travel on one Unicode-carrying key down. Shortcuts select the app's native menu
action when its menu owns the chord, otherwise they use Mac key events and the
Host keyboard layout. The route is chosen before effect and never retried through
another route. A keystroke cannot invoke the Host's clipboard
chords: copy is an explicit nonsecure AX selection read, and paste inserts literal
text through AX for AppKit or Unicode events for Chromium/Electron. There is no
Host pasteboard access or image/file transfer route. The bounded `paste.items`
metadata alternative refuses `unsupported` before any byte upload.

The AX context contains only field kind, multiline/sensitive metadata and normalized
caret bounds from `AXBoundsForRange`. Focus and external selection changes rotate
its opaque context ID. A replacement verifies exact UTF-16 `before`/`after` through
`AXStringForRange`, chooses its insertion route before changing selection, and uses
`AXSelectedTextRange` followed by that one route. Unverifiable edits refuse stale;
no AX failure retries through keyboard input. Secure fields and Secure Event Input
refuse unqualified dispatch, and secure contents are never read for copy or editing
context. Receipts report dispatched/refused/stale, never that the app applied input.

### Diagnosing a frozen live view

Desktop installs write lifecycle diagnostics under their data directory's `logs/`
(`~/Library/Application Support/Opensteer Beta/logs/` for Beta). Read rotated
siblings too. `desktop.log*` contains `computer.display.client`: visibility
records include `documentVisibility`, `nativeVisible` and effective `visible`;
viewer retain/release records name the source kind and opaque session/view ID
and why demand changed. Socket closes include code and an allowlisted reason
(`unrecognized` withholds arbitrary peer text); retry scheduled/cancelled and
protocol violations include previous/incoming sequence and media generation.
Renderer records are capped at 120 per ten seconds in both renderer and main;
the next accepted record reports `suppressed`. They never log frames or content.

Correlate those source IDs with `personal-host.log*`'s
`computer.display.viewer-removed` (`trigger`, `code`, `remainingViewers`) and
`computer.display.lifecycle` (`streamId`, `mediaGeneration`, actual terminal
`reason`). A hidden-page release followed by zero viewers, `warming`, and
`Display demand ended` after 30 seconds establishes loss of visible demand.
A `4002` close plus `protocol-violation` establishes terminal client rejection;
it deliberately has no retry. A transient close should have `retry-scheduled`,
or `retry-cancelled` if the last viewer departed.

For a reopen failure, match the Host stream ID to `desktop.log*`'s
`desktop.computer-use.video` with `transition: native-start-error`: `operation`,
`domain`, `code`, and `helperCode` identify the native failure without error text.
`transition: producer-stalled` warns once after five seconds without an encoder
submission while complete capture samples keep arriving under visible demand;
`inFlight`, `outstanding`, `outstandingBytes`, and `oldestAckAgeMs` distinguish
encoder saturation from missing downstream credit. `producer-resumed` ends that
episode. This sample-driven check adds no timer or per-frame logs; detailed
per-frame native diagnostics remain opt-in. Absence of a stall warning does not
rule out ScreenCaptureKit ceasing to deliver complete samples.

`desktop.computer-use.media-ended` in `desktop.log*` and
`computer.display.relay-ended` in the Runner's service log each record the first
attachment end/termination reason once per stream (for example `buffer-limit`,
socket error, or `owner-gone`). Personal Runner output lands in `personal-runner.log*`; remote Runner output
stays on that Runner. These diagnostics contain no pixels, window titles, typed input or URLs.
