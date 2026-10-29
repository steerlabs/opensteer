# Computer use: the two desktop panels

Main process ↔ renderer, for the two computer-use panels only this app opens.
The pages live in `apps/web/src/desktop/`; everything below is what desktop main
guarantees them. Schemas are in `packages/protocol/src/desktop.ts`, handlers in
`apps/desktop/src/bridge/methods/computer-use.ts`, and both windows get the
ordinary `desktopWebPreferences` — sandboxed, context-isolated, the same
preload and bridge token as the main window's app view. The main window is a
`BaseWindow` whose app view sits beside a natively shown browser page; the
[page glass](../browser/page-glass.ts) over that page is a click-through,
non-focusable child window with its own glass preload and no desktop bridge,
created only on macOS and Windows. Main creates no glass window on Linux because
transparent children render black on X11 without a compositor, which Electron
cannot detect. Main decides glass availability; the app renderer follows
`placed.glass` when sending scenes. App-front marks and the task marks' acting ring
remain available on Linux.

Renderer `DesktopWindowRect` values are app CSS pixels. Main converts them to
window DIPs using the app view’s zoom factor.

The browser page and its stage hole use four uniform 15-DIP corners. It masks
drawing only: corner arcs inside the page rectangle receive input, while margins
outside that rectangle never do. Hidden or minimized app windows retain their
native presentation; hiding the Browser panel or opening settings or the start
page releases it. See [Browser sessions](../../../../docs/browser-sessions.md#shared-viewing-and-previews)
for layout and overlay ownership.

## Routes

| Route                                                | Window                                                                                                                                                               | Opened by                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `app://opensteer/computer-use/permissions`           | 500×380, bottom-centered on the primary display's work area, `alwaysOnTop` floating, frameless, transparent, no shadow, `type: "panel"`, shown with `showInactive()` | `openComputerUsePermissionsPanel()`, from the Computers page |
| `app://opensteer/computer-use/approve?token=<token>` | 480×400, centered on the primary display's work area, `alwaysOnTop` floating, frameless, transparent, `type: "panel"`, created hidden then `showInactive()`          | desktop main, when a computer app needs approval on this Mac |

Neither route takes any other query parameter. The permissions panel takes
none at all: what it shows comes from `computerUsePermissionsGet()`.

**Neither window takes focus.** The approval panel floats above everything so
it is seen, but a request arrives whenever a task makes one — usually while the
person is typing somewhere else — and a panel that took the keyboard would turn
their next Return or Space into an answer they never gave. The page puts its
initial focus on the answer that says no: `Don't allow` for an app, `Cancel`
for the policy, so a key pressed after clicking into the panel never approves
by accident. The permissions panel floats over System Settings the same way.

The full consent text scrolls in one keyboard-accessible region above the fixed
answer buttons. Initial focus uses `preventScroll` so long names cannot hide
the task and app at the top of the question. No app name, path, or task title is
truncated to fit the window.

**Lifetimes.** The permissions page owns passive status polling and briefly
shows success before closing when both grants are `granted`. Main has no second
polling loop. Requests are explicit, one permission at a time: Screen Recording
then Accessibility. A revoked grant returns the page to its missing-permission step.
`closeComputerUsePermissionsPanel()` is the page's own "not now". The approval
window is destroyed by main as soon as an answer is recorded, so the page does
not need to close itself — and a window closed any other way (except quitting)
counts as **Don't allow**. Quitting leaves the request unanswered. Dismissing a question is never consent to it. A
page that dies before it is answered is no answer at all: main destroys the
window and the request stays pending, to be asked again. Once quitting has
begun, main opens no further approval window.

## Bridge methods

All are on `window.opensteerDesktop` (typed `OpensteerDesktopBridge`).

| Method                             | Input                                    | Result                                         |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `computerUseApprovalGet`           | `DesktopComputerUseApprovalInput`        | `DesktopComputerUseApprovalPresentation`       |
| `computerUseApprovalRespond`       | `DesktopComputerUseApprovalRespondInput` | `void`                                         |
| `computerUsePermissionsGet`        | —                                        | `ComputerUsePermissions`                       |
| `computerUsePermissionsRequest`    | `DesktopOpenComputerUseSettingsInput`    | `ComputerUsePermissions`                       |
| `computerUseOpenSystemSettings`    | `DesktopOpenComputerUseSettingsInput`    | `void`                                         |
| `openComputerUsePermissionsPanel`  | —                                        | `DesktopOpenComputerUsePermissionsPanelResult` |
| `closeComputerUsePermissionsPanel` | —                                        | `void`                                         |
| `computerUseApprovalKey`           | —                                        | `{ keyId, publicKey }`                         |
| `reviewComputerAppSetup`           | `DesktopReviewComputerAppSetupInput`     | `DesktopReviewComputerAppSetupResult`          |
| `openComputerAppSetup`             | `DesktopOpenComputerAppSetupInput`       | `{ opened }`                                   |
| `computerAppSetupStatus`           | —                                        | `DesktopComputerAppSetupStatus`                |
| `computerAppSetupBegin`            | `DesktopComputerAppSetupTarget`          | `void`                                         |
| `computerAppSetupShowAgain`        | —                                        | `void`                                         |
| `computerAppSetupStartDrag`        | —                                        | `void`                                         |
| `closeComputerAppSetup`            | `DesktopComputerAppSetupTarget`          | `void`                                         |

### `computerUseApprovalGet({ token })`

The token comes from the window's own query string and nothing else. Main
holds the presentation; the page cannot name an app, an access level or a
Deployment. A token main has already answered, or never minted, throws
`That Computer use approval is no longer open.`

The presentation is one of two kinds. `kind: "app"` asks about one app:

```json
{
  "kind": "app",
  "token": "b3XqM1p7sT9vK0aZ2cN4eR6hJ8lW5yU-dF1gQ3oI7kM",
  "threadTitle": "Plan the offsite",
  "workspaceName": "Main",
  "reason": "To add the meeting notes to the shared note.",
  "app": {
    "bundleId": "com.apple.Notes",
    "displayName": "Notes",
    "path": "/System/Applications/Notes.app",
    "iconPng": null,
    "risk": "standard",
    "reason": null
  },
  "access": "read-write",
  "accessLabel": "Can see and control",
  "accessSummary": "Agents can see the app and click, type, scroll, press keys, and open it in the background. What the app can do, agents can do through it.",
  "deploymentName": "Alex's Deployment",
  "machineName": "Alex's MacBook Pro"
}
```

`kind: "policy"` asks to turn on automatic approval for every app on this Mac,
and names no app:

```json
{
  "kind": "policy",
  "token": "b3XqM1p7sT9vK0aZ2cN4eR6hJ8lW5yU-dF1gQ3oI7kM",
  "appApproval": "automatic",
  "deploymentName": "Alex's Deployment",
  "machineName": "Alex's MacBook Pro"
}
```

- `threadTitle`, `workspaceName` and `reason` name the task that asked. All
  three are `null` for a request the person started from the picker, and each
  is `null` on its own when the corresponding context is absent. The Host
  snapshots these fields in the request; they are covered by the desktop's
  signature and are not refreshed from a renderer's Workspace list.
- `app` is what the **helper** resolved from the request's identity, not what
  the Host carried: `displayName`, `path` and `iconPng` are the Mac's own
  answer. `path` is worth showing when a name could mean two things.
- `iconPng` is base64 PNG (≤ 64 KiB) or `null` — null for an app the helper
  cannot draw and for every computer app whose connection names no app
  (Messages and every app like it), which also gets `path: null`,
  `risk: "standard"`, `reason: null`, and `bundleId` set to the definition id.
- `risk: "elevated"` is the helper's judgement about the app, never the
  Deployment's, and the panel must name it. `reason` is the sentence that goes
  with it.
- `accessLabel` / `accessSummary` are already the product's words for this
  `access` — `computerUseAccessLabel` / `computerUseAccessSummary` for a GUI
  app, the definition's own `accessLabels` / `accessSummaries` otherwise. Do
  not re-derive them.
- The approval names no macOS step. Once the Host accepts the Allow of an app
  the helper serves, main opens the setup panel, which shows each step.
- An app the helper reports as **not allowed** never reaches this panel: main
  refuses the approval before opening a window.

### `computerUseApprovalRespond({ token, allow })`

```json
{ "token": "b3XqM1p7sT9vK0aZ2cN4eR6hJ8lW5yU-dF1gQ3oI7kM", "allow": true }
```

Answers once. Main signs the decision and request with its dedicated desktop approval
key and sends it over the Mac's Runner stream, and destroys the window either way. A second call for the same token
throws. The same call answers both kinds.

Both `computerUseApprovalGet` and `computerUseApprovalRespond` are bound to the
panel's own window: main accepts them only from the web contents of the window
it opened for that token, and answers any other renderer — even one of this
app's own pages holding the token — with `That Computer use approval is no
longer open.`

### `computerUsePermissionsGet()` and `computerUsePermissionsRequest({ pane })`

`Get` never prompts, which is why the panel may poll it. `Request({ pane })`
requests only the named permission after the person clicks its action, and returns
the helper's current `ComputerUsePermissions`. A denied result is not an IPC
error or proof that the user saw or answered a prompt. The panel offers a separate
action to open that permission's System Settings pane, leaving macOS's asynchronous
consent dialog in front. It never automatically requests the next permission. Both
methods install and launch the helper if needed. A Runner's passive status probe
never installs one; it may launch an already-installed helper only when it has
no reported permissions to read since the desktop started.

```json
{ "accessibility": "denied", "screenRecording": "granted" }
```

After Screen Recording is first granted the helper quits itself once by design
— ScreenCaptureKit reads that grant at process start — and main reconnects
transparently. A one-poll blip is expected; it is not an error to show.

### `computerUseOpenSystemSettings({ pane })`

```json
{ "pane": "accessibility" }
```

`"accessibility"` or `"screen-recording"`. Main opens the exact pane
(`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility`
or `?Privacy_ScreenCapture`) and brings System Settings — not Opensteer —
forward. The URLs are main-process constants on purpose: `openExternalUrl`
refuses anything but HTTPS (and plain HTTP to this Mac's loopback address,
for the Personal Host's Chrome connect page), and letting a page name an
`x-apple.systempreferences:` target would hand the renderer a general way to
launch system panes.

The row to switch on is named **`Opensteer Computer Use`**, because that is
what macOS shows in both lists. Never this app's name.

### `openComputerUsePermissionsPanel()` / `closeComputerUsePermissionsPanel()`

```json
{ "opened": true }
```

`Open` first holds the bundled helper to this build's signing policy. A packaged build
that is not Developer ID signed refuses its own helper, so it opens no panel and answers
`{ "opened": false, "reason": "unsigned-build" }`; the Computers page says the build
can't set up computer use and points to [SIGNING.md](../../SIGNING.md). Any other
verification failure rejects with its message.

`Open` is idempotent: an already-open panel is focused rather than duplicated.
`Close` returns nothing and is safe when nothing is open.

### `computerUseApprovalKey()`

Returns this desktop's public approval key and fingerprint. Its private key is encrypted
with `safeStorage` using the login Keychain and never leaves main. The computer page
registers the public key with its owner-authorized Host RPC. The Host then challenges the
named Mac over its Runner stream; desktop main verifies the slot and signs only for its
own key. Registration needs both owner authorization and proof from the Mac. Failure to
read the Keychain or register the key is shown on the page with Retry.

### `reviewComputerAppSetup({ setupRequestId })`

```json
{ "setupRequestId": "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071" }
```

The page has already created the request through `integration.computer.setup.request`.
Main binds this wait to the page's current Deployment, then waits for that request's
Host outcome. The request arrives with its full presentation on the Mac's Runner stream,
as do task requests; main never lists or consumes approvals using a person's Host session.
The queue gives a request with a waiting page priority, and every caller waiting on the
same request shares one panel. Selecting another Deployment cannot move an open answer.

The result is `{ "allowed": true }` only after the Host accepts Allow. Don't allow or a
request ending elsewhere resolves `{ "allowed": false }`. An undelivered request, a
refused signature, an unavailable Keychain, or a missing registered key rejects with an
explanation. Main checks the app through the helper before showing it; an app whose
identity changed is neither shown nor declined.

Each Host list is complete: a missing request closes its panel unanswered and advances
the queue. A slot's bridge disconnect closes its panels and discards its pending offers;
reconnect requests a fresh list and can show an approval whose prior answer never reached
the Host. Other Deployments' panels and waits keep their own lifetimes. Both Allow and
Don't allow are signed; the Host verifies the decision against the registered desktop
key and consumes or declines in one transaction. A stale answer cannot settle a new
request, and a Runner-authentication key cannot sign either decision.

### `useComputerViewOnThisMac({ deploymentId, machineId, viewId, generation, app })`

Available only through the Desktop bridge. Main verifies the selected authenticated
Host attachment and its enrolled local Runner identity through the app-approval
authority: the Personal supervisor for the deployment hosted here, or the local
slot service for a deployment reached from elsewhere. Then the slot bridge verifies that the
exact app identity and owner-view generation are still open on its current Runner
connection. The helper rechecks the approved installed identity and exact running
process before activation. It never launches a replacement app. Remote machines,
ended generations and renderer-supplied app substitutions refuse. The Runner's
bridge cannot request activation; selecting an owner view only displays its picture.

The result is `{ activated: true }` only after the helper accepts activation.
Refusals return `{ activated: false, reason }`, where `reason` is
`deployment-changed`, `not-local`, `view-ended`, `app-changed`,
`permission-required` or `unavailable`. The renderer maps these to human words;
unexpected transport failures also use a fixed sentence, never raw IPC errors.
The enrolled-identity authority returns expected refusals explicitly. Unexpected
authority, helper and result-validation failures reach the activation IPC boundary,
which records their cause once as `desktop.computer-use.activation-failed` through
Desktop's diagnostic writer before returning `unavailable`. Error text stays in
diagnostics and never enters the renderer result.

### Window picker and owner destinations

The shared client uses Host capability `ownerViewWindows: 1` and the owner-only
`computer.app.windows {machineId, app}` RPC, returning `{windows}` with id, title,
focused/main/minimized/on-screen flags. This is a Host API, not a renderer-to-helper
bridge method. The New tab offers a picker for an available app with at least two
windows and labels minimized or other-Space entries. A selection opens
`{kind: "app", app, window: id}`; the app tile omits the id and lets native open choose
focused → main → first, independently of a task.

The returned view carries `window: {id, title} | null`. Owner app destinations key by
machine/app/window; task destinations key by machine/app/session. The renderer keeps
both even if their encoder binding matches. Host/Runner picker frames and version gates
live in the [owner-view wire contract](../../../../docs/computer-use.md#owner-view-wire).

### Native window video

Mac task Watch and owner views consume the same Host display socket and decoder as phone
views, while retaining independent owner-generation and task-session/app authority. The renderer
never captures a Mac window itself or polls JPEG RPCs; the helper owns one SCStream and
hardware H.264 encoder per exact binding.

Mac owner views offer Take over / Give back when the helper, Desktop, Runner,
Host and viewer negotiate owner input. The renderer must receive
`display.state.editingVersion: 1` before offering editing; the person must explicitly
take control of a read-write app. “Use on this Mac” remains the separate explicit
activation operation above.

The Mac editing transport and its native qualification requirements are owned by
the [owner-input contract](../../../../docs/computer-use.md#negotiated-mac-owner-input).
Frame headers and passive viewing use the existing display protocol.

Visible viewport demand selects one shared profile up to 1920/30. Ordinary hiding pauses
the shared stream and releases visible demand while the view keeps its last picture; the
helper may remain warm for 30 seconds
under existing authority, at most one warm/two total native sessions, including unsettled starts/stops. Repeated
empty demand never extends the warm deadline. Warm resource eviction preserves a valid
owner lease; the logical media attachment ends. Warmth never renews
leases. Target or connection replacement retires the earlier socket's decoder output; the
displayed picture stays but takes no input until the current socket draws one, including
Watch changing its window under the same task source, and gives way to the starting words
after five seconds open without one. Explicit privacy/terminal events and an ended login
clear pending and displayed pixels. Transient
starting/keyframe-recovery states preserve a valid decoded picture, and frame age never
changes readiness. Suspended capture clears pixels and consults tracked lifecycle; owner
exit or terminal stream error ends the assignment. One immutable root/process binding permits
serialized window-group filter/configuration updates. The root and OS-associated
same-process sheets, menus, popovers and children share a display-clipped crop;
unrelated sibling documents stay excluded. Hidden/off-Space roots capture alone.
The shared [group contract](../../../../docs/computer-use.md#2-the-helper) owns membership,
filtering and coordinate rules. Ordinary
composition changes preserve valid pixels; update completion is not a sample-origin barrier.
Running producers update independently of the global native start/stop lane. One pending
target can wait behind warm teardown; native resources still count until cleanup settles.
Starting window sharing has one 30-second end-to-end budget, with a
slow-macOS explanation after five seconds. A failed generation offers deliberate Open again
and stops media reconnection and owner renewal. Host lifecycle logs contain IDs, generations
and typed reasons; media and window contents never enter diagnostics.

Helper protocol/minimum 10 and Mac owner-view version 3 replace the old viewing contract;
older Stable clients need an update when the canonical shared helper is replaced.

The macOS sharing badge is accepted in delivered pictures. Release qualification must use
titled AppKit and Chromium/Electron fixture windows through the shipping renderer.

## The setup panel

`app://opensteer/computer-app/setup` draws the setup guide for one app the
helper serves ([Setting an app up on this Mac](../../../../docs/computer-use.md#setting-an-app-up-on-this-mac)).
It polls `computerAppSetupStatus()` once a second and draws what it is told:

```json
{
  "setup": {
    "definitionId": "apple-messages",
    "targetName": "Messages",
    "appIconPng": null,
    "appName": "Opensteer Beta",
    "phase": "steps",
    "helperReachable": true,
    "thisAppHasFullDiskAccess": true,
    "steps": [
      { "grant": "full-disk-access", "kind": "settings", "state": "current" },
      { "grant": "automation", "kind": "ask", "state": "waiting" }
    ]
  }
}
```

- `phase: "offer"` waits for the person's `computerAppSetupBegin()`; `steps`
  draws the `current` step; `done` lingers 1.4 s and then calls
  `closeComputerAppSetup()`. `setup: null` means nothing is being set up.
  Both calls take `{ definitionId }` of the app drawn; main ignores one that
  arrives after the next app replaced it, so a poll that lags a second never
  closes or begins the wrong app.
- A `settings` step draws the helper's row as the macOS list does, its switch
  turning on, and an arrow that calls `computerAppSetupShowAgain()` to reopen
  the pane. For `full-disk-access` the row is draggable: its `dragstart` calls
  `computerAppSetupStartDrag()`, and main drags the installed helper — the page
  never names a file. With `thisAppHasFullDiskAccess`, this app's row (named
  `appName`) is drawn struck out, and the panel shakes when it turns on.
- An `ask` step draws macOS's question with the pointer on Allow; its reload
  button calls `computerAppSetupShowAgain()`, which asks again — the helper
  joins the question already on screen.
- Words are names and buttons; anything longer is a tooltip. Every animation
  stills at its end state under `prefers-reduced-motion`.
- `closeComputerAppSetup()` is the page's "not now" and its close after done.
