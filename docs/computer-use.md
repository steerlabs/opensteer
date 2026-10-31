# Computer use: agents using Mac apps in the background

Read this for boundaries and macOS traps. [Computers](computers.md#computer-apps)
owns enrollment and app access; [Agent Phone](agent-phone.md) owns Android display
control; [iPhone apps](iphone-apps.md) owns data-only iPhone sharing. iPhones have no
computer-use session, owner view or display stream.

## 1. Model

Approval is durable, per app and Mac, not per task. Bundle identity and signing team
identify the app; a PID or window does not. An app approval permits everything its
interface offers: it is not a confinement boundary. Bounded data APIs and GUI app
approvals are separate authority. Connection access caps every Workspace grant.

The Host owns approvals, blocks and grants; the helper holds no approval list. Every
operation carries Host-derived identity and access. The helper enforces the installed
and live app identity, deny list, access and session ownership. Guest code cannot
choose placement or authority. Source: `apps/host/src/integrations/computer-app-approval-service.ts`,
`apps/host/src/integrations/integration-platform-service.ts`, and
`apps/desktop/native/computer-use/Sources/ComputerUseCore/Apps/`.

Automatic app approval never widens an existing connection. Access increases still
require a native prompt. Turning automatic on requires a signed decision on that Mac;
turning it off is owner-authorized from anywhere. Under automatic, removing an app
blocks it and revokes grants instead of allowing the next request to recreate it.
Unblocking requires a signed app approval on that Mac. Decisions run under the Mac's
row lock against its current policy, so turning automatic off during a request takes
effect before settlement.

One pending approval per app/Mac joins compatible asks. Wider access, changed identity
or changed catalog contracts replace the approval ID and move its waiters; a signature
over the old request cannot settle the replacement. Declining one task's Request must
not strand other waiters. Settlement creates the connection, appropriate grants and
fulfilment atomically; approval never lowers an existing grant. See
`packages/database/src/computer-app-approvals.ts` and nearby tests for the joining rules.

A session names a Run attempt and Mac but grants nothing. Multiple sessions may coexist;
each app is exclusive to one agent session. A busy app must not disclose another
Deployment's task title. A session is ephemeral: after loss the agent observes again.
An independent owner view is neither a session nor a task grant.

## 2. The helper

### Trust and lifecycle

`Opensteer Computer Use.app` alone holds Accessibility, Screen Recording and the
Apple-data grants. Launch its GUI runtime through LaunchServices, never as a child
of Desktop: responsible-process attribution would otherwise give the desktop and its
agent descendants the grants. Stable and Beta share the canonical helper and TCC grant.
The desktop release must not claim Apple events.

IPC stays in a private per-user directory. Both peers verify the connected socket's kernel audit token against a designated
Developer ID requirement. A team ID alone, PID, ancestry, path or file token is not
identity. The helper trusts only the named Stable/Beta desktop identities under its
own signing team. Desktop verifies the bundled helper before launch and verifies the
server using the verifier sealed inside Desktop, never the writable installed copy.
The verifier exits before creating an application or using privacy grants. Ad-hoc
trust is development-only and must not ship. See
`apps/desktop/src/computer-use/release-identity.ts`, `helper-client.ts`,
`helper-install.ts`, and native `IPC/PeerVerifier.swift` under
`apps/desktop/native/computer-use/Sources/ComputerUseCore/`.

Verify bundle integrity and product identity before comparing versions; an invalid
installed bundle has no version authority. Compare protocol before app version:
between-release builds can share a version while requiring a newer protocol. Keep
equal protocol/version release builds despite different hashes because Stable and
Beta sign separately; development may replace changed bytes. Stop a verified live
helper before replacing executable bytes or macOS cannot verify it. Match its kernel
device/inode, not path case: LaunchServices can change path spelling on a
case-insensitive volume. Keep a valid helper if it cannot quit and retry later.

Install and launch share one lifecycle lock through socket readiness. Never unlink
the lock file: another desktop could lock a different inode during replacement.
Replacement ends sessions; an action whose answer is lost stays `outcome-unknown`.
The canonical path and staging rules live in `helper-paths.ts` and `helper-install.ts`.
Release builds require Developer ID signing and both Mac architectures.

The helper's declared protocol range is strict. Stable/Beta sharing one helper means
an update can require the other client to update too. Capability gates are separate
from the integrations protocol; do not infer window input or video support from a
successful connection. See `packages/protocol/src/computer-use.ts`,
`computer-use.ts`, `computer-view.ts` and [Host compatibility](host-boundaries.md#compatibility).
Upgrade the Host before producers whose strict descriptors an older Host rejects.

Readiness probes never install a helper or prompt. They use reported grants, and only
reconnect/launch an installed helper when those reports need refreshing. Opening setup
may install it. Permission requests are explicit, one grant per person action, Screen
Recording before Accessibility. macOS may return before its dialog is answered;
a denial is not proof of an answered dialog or a need to restart. Never open Settings
automatically over that dialog. ScreenCaptureKit can require a fresh process after
Screen Recording is granted; restart only while no session or app call is active.

Stop, session control, readiness and video control must remain responsive while an app
hangs in AX. Keep blocking AX/event work off the main actor and binary media off JSON
RPC. Data grant questions also need their own blocking lanes. Sources: native
`Support/WorkActor.swift`, `Session/HelperRuntime.swift`, `IPC/` and `Data/`.

### Windows, observations and actions

A bound window pins the AX object and exact process incarnation. Closing it, losing
membership or replacing its process retires the ref permanently; WindowServer ID reuse
cannot revive it. Acting never launches or substitutes a process. Discovery may open
an approved installed app in the background, but never launch around a live identity
mismatch. Arbitrary paths outside the installed-app catalog are refused because
approval stores identity, not a path. See native `Session/SessionWindows.swift`,
`Observe/WindowIdentity.swift` and `Apps/AppProcess.swift`.

The window group is the shared capture, tree and input boundary. Include the root,
OS-associated same-process surfaces and eligible menu-bar menus; exclude unrelated
sibling documents even when they overlap. Clip the union to the root's display.
Hidden/off-Space roots capture alone, with limited auxiliary coverage. An unrelated
modal or sibling menu can block input while observation remains available. Without
macOS association APIs refuse window operations; overlap is not a safe fallback.
Association behavior on the minimum supported macOS still needs qualification.
Source: native `Observe/WindowGroup.swift`.

Tree frames and point targets use delivered screenshot pixels from the crop's top-left,
including when no screenshot was requested. Global window points are a different space.
Capture and tree assembly use one immutable group and revalidate before publication.
Point routing must still match the snapshot's member geometry; a gap in the crop is
not a target. A minimized window refuses input/observation. Hidden apps remain observable and
allow applicable AX operations, but posted mouse/keyboard input refuses because
macOS silently drops it. AX can omit other-Space
windows, especially windows opened behind a full-screen app; absence from inventory
is not proof that the app has no window. Owner inventory omits unverifiable windows;
agent inventory fails closed. See native `Observe/ObservationCoordinates.swift`,
`AppObserver.swift`, `WindowCapture.swift` and `OwnerViewWindow.swift`.

Targeted actions cite the latest snapshot for that bound window, supplied at FIFO
dispatch so aliases share state. Keys and untargeted typing need none. Acting retains
the snapshot and returns receipts without observing; agents explicitly observe effects.
A partial failure preserves completed receipts. Stale after delivery starts becomes
`outcome-unknown`; stale after an earlier completed action becomes `failed`, never
a claim that the batch safely did nothing. Choose the delivery route before the
effect, never retry through another route. In particular, AX `cannotComplete` can mean
the mutation happened and must become `outcome-unknown`. Mouse-up goes to the process
that received mouse-down. Sources: native `Act/` and
`apps/host/src/computer-use/computer-repl/`.

Secure AX fields omit values and identifying labels, including during settling; saved
login receipts never repeat secrets. Screenshots are unchanged, and an app exposing a
password as ordinary text can still reveal it. Saved-login input authenticates the sealed
connection-bound field before effects and again immediately before typing; missing support
or CR, LF or tab refuse before effects. [Passwords](passwords.md#typing-in-apps)
owns consent and destination judgement. Native `IPC/LoginTextReceiver.swift` and
`Act/` enforce delivery.

### Background focus and known limitations

Input targets the process, never the global event stream or system pointer. Preparation
uses private process-addressed activation notices to establish the exact key window.
The person's existing key window is never moved while they use that app. The protocol's
numeric fields and view-service behavior lack a verified public specification; do not
treat them as a stable macOS API. Missing private routing APIs refuse before effects.

Preparation protects the person's front app and key order. If the target comes forward
during preparation, restore the person's app before releasing the screen hold; if the
person switches to a third app, refuse with nothing sent. A deliberate switch to the
target during preparation is also restored once: distinguishing Command-Tab would
require reading their keys. Missing taps or screen-hold support refuse before input.
See native `Focus/FocusEnforcer.swift`, `FocusStealPreventer.swift`, `PersonKeyOrder.swift`
and `Act/`.

Agent preparation ends its taps, redirect and screen hold before delivery. For ordinary
input, once delivery starts, a person's click or app switch does not stop it or pull them back; only Stop,
authority/deadline loss, lock or target-process loss interrupt it. Text can interleave
with the person's typing or land where they moved the target app's keyboard focus.
Observe to inspect the result. Saved-login values and secure-field text instead
require exact-element delivery: Chromium and unsupported routes refuse, and keyboard
chunks stop if exact-field focus or validation is lost. They never fall back to a click
or another focused field. The session's separate
key-focus protection reads destinations/notices, never physical typed contents.

A target can activate itself at cold launch, on input or later. After delivery starts
it stays forward and observation reports `focusChanged`. Chromium tab/window-opening
commands can even change Spaces, so background Chromium menu shortcuts that do this are
refused before effects; use the current tab. A link that opens a tab can still activate
it and switch Spaces. The agent's own popup/document click can also raise a window;
there is no after-input restoration for agent actions.

Forwarded physical keys preserve order while delivery is tracked, but a forwarded key
undelivered past its liveness bound counts as lost and later keys stop following it.
Shared ViewBridge helpers cannot safely be attributed to one agent app; theft through
that path and remote views receiving keys are not covered. These are product limitations,
not reasons to weaken the journey assertions. The Chrome background fixture README and
`tests/quarantine.json` record affected cases.

Posted events bypass WindowServer keyboard translation, so they carry characters for
the Host layout. A Control chord without Command can also insert its letter into a
focused Chrome/AppKit text field (Control-Option-J inserts `j`). A control-character
payload breaks Chrome's shortcut key and AppKit inserts the control character; do not
claim this is fixed by changing payload encoding. Prefer native menu actions when they
own the chord. Apple menu and Services shortcuts are refused. Chromium drops background
`AXSelectedText` writes despite accepting them, so its text uses keystrokes, not an AX
retry. No clipboard paste or global defocus is an agent-input fallback.

The deny/elevated lists live in native `Apps/AppPolicy.swift`. Password managers,
terminals, automation tools, Opensteer and macOS security surfaces remain denied,
including vendor variants. Browsers, Finder, editors with terminals and system apps
can expose broad authority and require the elevated warning. This list is a guardrail,
not confinement under an approved app's name; no AppleScript/text-command escape exists.

### Apps the helper serves

Bounded Messages, Contacts, Calendar and Reminders APIs run only through the helper
that holds their grants, never by a Runner fallback. GUI approval does not authorize
these APIs. Messages reads require helper Full Disk Access and sends require Automation;
Calendar/Reminders require full access, not add-only. Contracts/effects generated from
the catalog are checked before touching an app; writes require write access. A lost or
unexpected write answer is `outcome-unknown`. See native `Data/DataPlane.swift`,
`packages/apple-data/` and `tests/helper-data-contracts.test.ts`.

Full Disk Access is probed by opening `~/.Trash`; only Settings grants it, and an existing
process may need relaunch. A fresh helper child can detect a newly enabled grant; until
restart completes, reads fail retryably rather than ask the person to grant it again.
Automation is unknown while Messages is absent; a send starts it invisibly and checks
without prompting. macOS grant queries can block behind another consent question, so
unknown is neither denial nor success. A pending helper consent question prevents idle
restart. See native `Data/DataGrants.swift` and `Messages/MessagesAutomation.swift`.

Calendar/Reminders use the Mac's clock. Offset-free times use local wall time: refuse
skipped daylight-saving times and choose the first repeated time. Occurrence identity
includes its start, so moved occurrences are not guessed at. Attendees are read, never
invited. Setting a reminder's due value replaces its alerts: a time creates one alert,
while a date alone or null leaves none. Truncated notes cannot be changed through these APIs. These external-store
constraints live in `packages/apple-data/Sources/` and its tests.

#### Setting an app up on this Mac

macOS grants belong to **Opensteer Computer Use**, not Opensteer or Opensteer Beta.
The native setup guide is person-driven and serializes app setup. A task discovering
missing grants may offer setup, never request the grant itself. `unknown` is not setup
success, and a macOS question outlasting an RPC deadline stays pending. Full Disk Access
has no request API: the person must enable the helper in Settings, sometimes dragging
it into the list and restarting it. If macOS offers **Quit & Reopen** after a direct grant,
use that to refresh cached denial. See
[set-up-mac-app](../.agents/skills/set-up-mac-app/SKILL.md) and
`apps/desktop/src/computer-app-setup-guide.ts`.

### iMessage channel

[Messaging](messaging.md#7a-transports-that-run-on-one-computer) owns channel authority.
The helper claims an Apple account so Stable/Beta on separate Deployments cannot both
consume its messages. Sends check the current account again and require that claim;
never reply from a replacement account. Read only one-to-one iMessages received by the
bot's current account, not historical accounts in `chat.db`, SMS, groups or reactions.
Messages can write rows before joining chats or writing bodies: allow bounded waiting
from first observation, not message date, so sleep does not skip fresh arrivals.

Persist delivery attempts before sending and never expire them: a pending Host delivery
can survive arbitrarily long offline. A retry returns the receipt or uncertain outcome,
never sends an uncertain attempt again. Unreadable/unwritable history prevents sends.
Messages offers no atomic send-and-record; a crash can leave an unsent reply unconfirmed.
Only a definite non-send removes the attempt. A lost bridge answer may retry the same key
to recover its persisted outcome. Scripts are constant with data passed as argv, never
interpolated AppleScript. Source: native `Data/Messages/IMessageChannel.swift` and
`MessagesSender.swift`. Real Apple account/store behavior still needs manual qualification.

## 3. Runner

Bridge credentials must never enter startup environment: same-user processes can read
it for the process lifetime. Desktop delivers credentials through a private parent port
or stdin; Runner removes credentials and bridge URLs from `process.env` and disables
inspector-by-signal. A loopback URL alone authorizes nothing. One authenticated bridge
connection per slot owns its sessions, and disconnect closes them. See
`packages/shared/src/processSecrets.ts`, `apps/runner/src/computer-apps/` and
`apps/desktop/src/computer-use/computer-use-bridge-server.ts`.

Each hop carries the remaining deadline; outer grace exceeds inner grace so a native
answer can arrive before callers give up. Giving up on a window call ends only that
session, never every session by dropping a shared connection. A written mutation whose
answer is lost is `outcome-unknown`; cancellation retains its work slot until native
work settles. Busy means another task holds the app, not general capacity exhaustion.
Native error sentences must not disclose filesystem paths.
Close and approval review bypass full work slots. Bridge loss reports ended sessions
even if the Host stream survives. Status errors must distinguish unreachable Desktop
from helper verification/inspection failures. Permission inspection never prompts.

The execution Runner and app-serving Mac may differ. The Host checks the authenticated
execution Runner/boot and REPL capability; readiness of the Mac alone is insufficient.
Image emission requires both driver support and model image capability; acquisition
and emission are separate gates. Engine behavior belongs in [AI engines](ai-engines.md).

## 4. Host

All app operations pass through current callable rows, installation/schema digests,
connection access, effective grant and active Run capability. Recheck identity,
connection and grant at admission immediately before Mac dispatch. Cleanup closes an
exact session without requiring a live grant. `integration_call` refuses computer rows;
internal tool references are not an escape around the `computer` REPL. Sources:
`apps/host/src/integrations/integration-platform-service.ts` and
`apps/host/src/computer-use/`.

### The computer REPL

The guest has no Node, filesystem, network, process or ambient timers. State is scoped
to a Run attempt and can be evicted; it is not durable task storage. Cancellation,
resource failure or worker loss discards the VM; ordinary guest errors may retain it.
FIFO dispatch supplies the latest shared window snapshot, including across aliases.
Already-dispatched work drains under its original deadline; queued unstarted work is
cancelled when the body settles. Generation/call fences reject late results. Dispatched
mutations may have happened and are never automatically retried. Source and limits:
`apps/host/src/computer-use/computer-repl/`. Agent-facing procedure belongs in the shipped
`apps/runner/agent-skills/skills/opensteer-computer-use/`.

### Sessions, output and Stop

A revoked/replaced attempt cannot update or close its replacement's sessions. Late results
cannot restore ended state. Idle expiry must exclude calls readied or in flight. Removing
or blocking an app ends sessions holding it. Session summaries and live presence are
owner-only; another user must not learn task titles through helper errors.

Stop is durable for the Run/Mac pair across attempts, reconnects and Host restarts.
A new session ID cannot undo it. Grant revocation neither records nor clears Stop.
Only native `reason: user` records Stop; app quit/session loss permits a new session.
Remote Stop returns only once Host authority is withdrawn, even if native cleanup has
not arrived. If persistence fails, the in-memory fence holds and the RPC fails so the
person can retry. The local pill stops every session across Deployments and independent
owner input; remote task Stop affects only that Run on that Mac. Sources:
`apps/host/src/computer-use/` and native `Session/SessionRegistry.swift`.

### Host-authored transcript

Computer-operation transcript pairs are Host-authored, idempotently completed and
finalized as cancelled on Run end or Host recovery. Store sanitized headlines/receipts,
not screenshots, AX trees, guest code, opaque refs or typed-text arguments. Saved-login
receipts remain generic. Cancellation can finish MCP delivery before native receipts
settle. Preserve transcript first-arrival order. See
`packages/database/src/computer-operation-store.ts` and
`apps/host/src/integrations/computer-use-tool-result.ts`.

## 5. Desktop

Desktop owns helper lifecycle, native approval and grant prompts for every supervised
slot. Runner cannot request macOS permission prompts. Approval review pins its Deployment
transport for its lifetime; changing the selected Deployment cannot move an answer.
Both Allow and Don't allow are signed with the dedicated approval key, never the Runner
authentication key. Identity mismatch is not a user decline. Key registration requires
owner authorization plus a challenge answered on the named Mac. The private key stays
in main, encrypted through Keychain-backed safeStorage. Sources:
`apps/desktop/src/computer-use/approval-key.ts`, `computer-use-service.ts`, and
[renderer contract](../apps/desktop/src/computer-use/RENDERER-CONTRACT.md).

## 6. The page

Task destinations pin exact session/app; owner destinations pin exact owner generation
and resolved window. They never merge or substitute, even for the same pixels. An ended
task cannot silently open another task's window. Conversation surfaces list task sessions;
an owner view never becomes automatic message context. Shared client sources live in
`packages/client/src/host/` and `packages/client/src/integrations/`.

Opening a picture never focuses typing or activates the local app. Task Watch is view-only;
Mac owner input requires the Host's current projection and displayed geometry. “Use on
this Mac” is a separate, local activation checked through the selected authenticated
Host attachment, enrolled local Runner, exact owner generation and pinned process.
It never launches a replacement app or accepts Runner-requested activation.

## 7. Out of scope by decision

No one-task-only app approval, remote/mobile native approval, concurrent agent sessions
in one app, physical-input recording, tree diffs or command escape under an app identity.
Mac control requires Desktop and an unlocked Mac. Other platforms' contracts remain
separate.

## 8. Verification

Use [test-mac-app-control](../.agents/skills/test-mac-app-control/SKILL.md) and
[diagnose-mac-live-view](../.agents/skills/diagnose-mac-live-view/SKILL.md).
Pure helper fakes prove ordering/refusal, not real focus or key order. The host-safety
guard is structural, not a sandbox. Host scripted-peer tests do not prove native pixels,
real engines or signed responsible-process attribution. Real Contacts/EventKit stores,
Apple account identity/history maintenance, localized Services, first-run TCC and signed
shipping capture require manual qualification. Minimum-macOS association behavior and
native Expo decoding/suppression also need qualification; build/export success is not
that evidence. Mac window video stays disabled on iOS pending that qualification.

## Owner-view wire

`packages/protocol/src/computer-view.ts` and `display-stream.ts` own schemas and bounds.
Owner authority is independent of Run sessions. Video never renews it; visible retain
handles do. Transient renewal transport failures preserve authority until actual expiry;
terminal/expired/revoked generations need explicit reopen. Lease durations are measured
from receipt using local monotonic clocks; only the Host's client projection has an
absolute expiry. Removal notices fence generations so stale command answers/rereads
cannot resurrect them. Source: `packages/client/src/host/owner-view-records.ts` and
`computer-view-retention.ts`.

Owner opens pin process start stamp and exact verified window, independently of a task's
current window. Owner inventory neither launches an app nor creates a session/lease;
ownership and approved connection are checked before and after it. Admission requires
matching signed and authenticated producer capabilities. Grant-change notices
require a fresh readiness check; unchanged grants and negotiated versions preserve
live and warm owner media. Bridge loss discards readiness; actual changes and failed
grant revalidation fence owner media. A reply superseded by a grant notice or
connection loss cannot restore cached readiness. Versions and picker gates live in
the protocol sources; do not send window-aware opens to older Macs.

One native capture/encoder serves an exact binding. Starting/stopping resources still
count toward capacity until OS completion; a late completion cannot publish or free an
unsettled slot. Warm retention preserves existing source authority without renewing it,
encoding or sending pixels. Repeated empty demand cannot extend its deadline. Warm eviction
ends media, not an otherwise valid owner lease, and cannot preempt visible viewers.
Revalidate any pending admission after teardown. Source: native `Observe/MacWindowVideo.swift`.

Close, expiry, revoke, invalid binding, Stop, lock/sleep and control-connection loss close
publication and discard pixels before asynchronous teardown. Frame callbacks, encoding
and final writes recheck binding/authority/generation gates. A mapping change closes input
and publication, drains the old capture and encoder, and starts a distinct SCStream
incarnation. Configuration completion is not a sample-origin barrier: never relabel old
samples using timestamps or dimensions. Interior child changes that do not change the
mapping are covered under [owner input](#negotiated-mac-owner-input).

Privacy suppression/terminal state/login change clears pending and displayed pixels.
Static-frame age and complete-frame silence do not end authority or indicate failure.
Source/socket replacement retires earlier decoder output; web/Electron may retain a
picture temporarily but refuse its input until the current socket draws. Expo clears it.
Suspended capture clears pixels and checks tracked lifecycle before restoration.
Transient same-source recovery may retain a valid picture. Replay decodes from a keyframe
but never draws frames older than the advertised replay boundary. Acknowledgement follows
decode admission/drop, not displayed output. Transient reconnect resets input without
replay; terminal failure needs explicit reopen. Source:
`packages/client/src/integrations/phone-display-stream.ts` and
`apps/web/src/components/phone-display-media.ts`.

Startup has one end-to-end budget through resolution, admission and first usable keyframe,
including time waiting for teardown. New viewers join that attempt, not restart its budget.
Expired attempts cannot publish late; terminal owner generations are never renewed.
Video control and activation bypass agent work. Media stays on the selected Host route,
even on the same Mac; no Electron-local capture or JPEG fallback. Viewer frames never
authorize an agent action. Window video captures neither audio nor the system cursor. macOS sharing badges are accepted in captured presentation.
Diagnostics contain IDs, typed reasons and native domain/code, never media, window text,
typed input, URLs or native error user-info dictionaries.

### Negotiated Mac owner input

Every hop negotiates owner input; legacy version 1 parses tolerantly and enables none.
Writers emit version 2 only to peers that offered it. Input requires the exact owner
view generation, read-write approval and Host-projected shared-input authority. Editing
negotiates separately. Task Watch stays view-only. Results/clipboard replies correlate
to the originating viewer; editing context reaches only authorized editing viewers.
See [Host compatibility](host-boundaries.md#compatibility) and
`packages/protocol/src/display-stream.ts`.

Capture generations fence root/process identity, exterior member geometry, crop, display,
scale and mode. An associated child wholly inside the root does not retire the mapping;
it still participates in capture and routing, including genuine sheets/popovers and
AppKit sharing controls. Exterior changes or root/display changes drain and retire the
stream, making queued old-generation input stale.

One per-app mutation coordinator serializes person batches with every agent mutation,
including AX. Held person keys/buttons block agent effects and contend across viewers
and windows of that app. Observations remain valid after person input; intervening text
edits rotate editing context. Reset discards queued input and finishes physical cleanup
before admitting another batch. Held contacts retain a bounded liveness lease. Blur,
hide, F6, leaving, geometry/authority/target loss, lock, disconnect and Stop reset input.
Held contacts retain their original process and AX window identities.

Person input has a bounded lane separate from agent AX reads. Focus protection uses its
calling executor and serializes native focus rounds; Stop cleanup releases do not wait
for that gate. Unlike agent delivery, remote person bursts retain keyboard protection
and an after-input watch. Choose a shortcut's menu/event route before effect and never
retry. Clipboard chords cannot access the Host pasteboard: copy is an explicit nonsecure
AX selection read, paste is literal AX/Unicode text. Image/file paste metadata refuses
before any upload. There is no Host pasteboard or file-transfer route.

The after-input watch protects focus without imposing a pause between person batches:
new input may join the guarded round while it watches. Waiting input in another lane
ends that extension, and continuous arrivals cannot renew the burst's time limit.
The final input still receives the full watch before the round releases protection.

Editing context exposes only field kind, multiline/sensitive metadata and normalized
caret bounds. Focus/selection changes rotate its opaque ID. Replacement verifies exact
UTF-16 before/after using AX, chooses insertion before changing selection and refuses
unverifiable edits as stale. No AX failure retries through keyboard input. Secure fields
and Secure Event Input refuse unqualified dispatch; secure contents are never read for
copy/context. Receipts mean dispatched/refused/stale, not confirmed application.
Source: native `Session/OwnerInputState.swift`, `Act/` and
`apps/host/src/computer-use/display-stream-hub.ts`.

### Diagnosing a frozen live view

Use [diagnose-mac-live-view](../.agents/skills/diagnose-mac-live-view/SKILL.md).
Lifecycle logs must remain content-free; absent encoder-stall warnings do not rule out
ScreenCaptureKit ceasing complete samples. Static windows need not produce fresh frames.
