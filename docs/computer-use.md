# Computer use: agents using Mac apps in the background

[Computers](computers.md#computer-apps) owns app access and [Agent Phone](agent-phone.md) owns
Android; [iPhone apps](mobile.md#this-iphones-apps) are data-only. Procedures:
[mac-gui](../.agents/skills/mac-gui/SKILL.md).

## Approval model

Approval is durable, per app and Mac, not per task. Bundle identity and signing team identify the
app, never a PID or window. An app approval permits everything its interface offers; it is not a
confinement boundary. Bounded data APIs and GUI app approvals are separate authority, and connection
access caps every Run. The Host owns approvals, blocks and grants; the helper holds no
approval list but enforces app identity, the deny list, access and session ownership.

Automatic approval never widens an existing connection: wider access and unblocking need the owner's
explicit approval from any signed-in device, and under automatic, removing an app blocks it so the
next request cannot recreate it. Wider access or changed identity replaces a pending approval's ID,
so an answer to the old request cannot settle the new one. Approval never lowers an existing grant.
A session grants nothing. Each app has one agent session at a time, and a busy app never names the
task holding it.

## The helper

`Opensteer Computer Use.app` alone holds Accessibility, Screen Recording and the Apple-data grants.
Desktop launches it through LaunchServices, never as its child, or responsible-process attribution
would hand the grants to the desktop and every agent it starts. The desktop release must not claim
Apple events. IPC stays in a private per-user directory, and both peers check the socket's kernel
audit token against a designated Developer ID requirement; a team ID, PID, ancestry or path is not
identity. Desktop verifies the server with the verifier sealed inside itself, never the writable
installed copy, and the verifier exits before using any grant. Ad-hoc trust is development-only.

Verify bundle integrity before trusting an installed version, and compare protocol before app
version. Stop a verified live helper before replacing its bytes, matched by device and inode because
LaunchServices can change path case. Install and launch share one lifecycle lock that is never
unlinked. Readiness probes never install or prompt. Permission requests are one per person action,
Screen Recording first; macOS may return before its dialog is answered, so a denial proves nothing
and Settings must never open over the dialog. ScreenCaptureKit can need a fresh process after a
grant; restart only while nothing is active. Stop, readiness and video stay responsive while an app
hangs in AX, so blocking AX work stays off the main actor and binary media off JSON RPC.

## Window groups and actions

A bound window pins its AX object and exact process incarnation; closing it or replacing its process
retires the ref for good. Acting never launches or substitutes a process, and paths outside the
installed-app catalog are refused because approval stores identity, not a path. The window group
(native `Observe/WindowGroup.swift`) is the shared capture, tree and input boundary: the root,
OS-associated same-process surfaces and eligible menus, never unrelated sibling documents even when
they overlap. Without macOS association APIs window operations refuse: overlap is no fallback.

Tree frames and point targets use delivered screenshot pixels from the crop's top-left, not global
points. Minimized windows refuse; hidden apps stay observable, but posted input refuses because
macOS silently drops it. AX can omit windows on other Spaces, so absence is not proof. Targeted
actions cite the latest snapshot, and acting returns receipts without observing. Choose the delivery
route before the effect and never retry another route: once delivery may have started, a stale or
lost answer, including AX `cannotComplete`, is `outcome-unknown`. Secure AX fields omit values and
labels ([Passwords](passwords.md#typing-in-apps)).

## Background input and its limits

Input targets the process, never the global event stream or system pointer, using private
process-addressed activation whose fields have no public specification; missing private APIs refuse
before effects. Preparation protects the person's front app and key window, and refuses with nothing
sent if they switch elsewhere. Once delivery starts, a person's click does not stop it; only Stop,
lost authority, lock or target loss do, and text can interleave with their typing. Saved-login and
secure-field text need exact-element delivery and never fall back to a click or another field. Key
protection reads destinations and notices, never physical typed contents. It does not cover focus
theft through macOS's shared ViewBridge helper, which cannot be attributed to one app, or keys a
remote view receives ([focus-steal preventer](../apps/desktop/native/computer-use/Sources/ComputerUseCore/Focus/FocusStealPreventer.swift)).

A target can raise itself; it then stays forward and observation reports `focusChanged`. Chromium
tab and window shortcuts can switch Spaces, so they are refused in the background. Posted events
skip keyboard translation: a Control chord without Command can type its letter into a Chrome or
AppKit field (Control-Option-J types `j`), and changing the payload does not fix it, so prefer menu
actions. Chromium drops background `AXSelectedText` writes, so its text uses keystrokes. Clipboard
paste is never a fallback. Native `Apps/AppPolicy.swift` keeps password managers, terminals,
automation tools, Opensteer and security surfaces denied, and browsers, Finder and system apps
behind the elevated warning: a guardrail, not confinement.

## Apps the helper serves

Messages, Contacts, Calendar and Reminders APIs run only in the helper that holds their grants,
never a Runner fallback, and GUI approval does not authorize them. Messages reads need Full Disk
Access and Contacts, because `chat.db` holds only handles; sends need Automation; Calendar and
Reminders need full access. A lost write answer is `outcome-unknown`. macOS grant queries can block
behind another consent question, so `unknown` is neither denial nor success.

### Messages: SQL and files

Agents read Messages with their own SQL and get original files, because a fixed set of read and
media operations cannot predict what a task needs. The helper still owns the boundary: it runs one
read-only statement under an authorizer, and agent code never runs inside it. Full Disk Access
reaches far more than Messages, so anything that widened that boundary would widen it to the whole
Mac. Agents name an attachment by id, never a path, and the helper opens it by descriptor.

A file moves for one live tool call. When the Run is on the Mac's own Runner it never leaves that
computer, so a photo does not reach a team server. When the Run is elsewhere it streams through
the Host, because Runners reach the Host and never each other; nothing is spooled, and the
[relay](../apps/host/src/integrations/run-file-relay.ts) ends with the call. Exports land in the
Thread's attachment directory and go at the end of the Run. Files an agent sends must already be in
its task folder or that directory: the Runner checks, so a send cannot read what the Run could not.
Trigger and Watch programs have no Run, so their file operations refuse.

### Setting an app up on this Mac

macOS grants belong to **Opensteer Computer Use**, not Opensteer. Setup is person-driven and one app
at a time; a task may offer setup but never requests a grant itself. Full Disk Access has no request
API: the person enables the helper in Settings, sometimes dragging it in and restarting it, and a
newly granted read fails retryably until the helper restarts. See the [setup
guide](../apps/desktop/src/computer-app-setup-guide.ts).

### iMessage channel

[Messaging](messaging.md#transports-that-run-on-one-computer) owns channel authority. The helper
claims an Apple account so two Deployments cannot both consume its messages, and sends recheck the
account. It reads only one-to-one iMessages to the current account. Delivery attempts persist before
sending and never expire; an uncertain attempt is never sent again, and only a definite non-send
removes it. Scripts are constant, with data passed as arguments, never interpolated.

## Runner and Host

Bridge credentials never enter the startup environment, which same-user processes can read: desktop
passes them privately, and the Runner strips them from `process.env` and disables
inspector-by-signal. One authenticated bridge connection per slot owns its sessions. Each hop
carries the remaining deadline, and outer grace exceeds inner grace. Giving up ends only that
session; only close bypasses full work slots. Native errors never disclose paths.

Every app operation rechecks callable rows, digests, connection access, grant and Run capability
immediately before Mac dispatch; `integration_call` refuses computer rows. The `computer` REPL guest
has no Node, filesystem, network, process or timers, and its state is per Run attempt, not storage.
Dispatched mutations are never retried. Stop is durable per Run and Mac across reconnects and
restarts, and only native `reason: user` records it; remote Stop returns once Host authority is
withdrawn. The transcript keeps sanitized receipts, never screenshots, AX trees or typed text.

Desktop owns helper lifecycle and OS prompts; the Runner cannot request them, and Mac control needs
an unlocked Mac. A Mac app's task and owner destinations never merge or substitute, even for the
same pixels ([renderer contract](../apps/desktop/src/computer-use/RENDERER-CONTRACT.md)): they can
bind different windows. A phone is one display, so [its tab](agent-phone.md#the-tab) chooses between
them.

## Owner-view wire

`computer-view.ts` and `display-stream.ts` in `packages/protocol` own schemas and bounds. Owner
authority is independent of Run sessions and does not itself authorize input. Video never renews a
lease; visible retain handles do. Lease durations are measured from receipt on local monotonic
clocks; only the Host's client projection has an absolute expiry. Removal notices fence generations
so stale answers cannot resurrect them. Owner opens pin the process start and exact verified window,
never launch an app, and need matching signed producer capabilities.

Close, expiry, revoke, Stop, lock and control loss end publication and discard pixels before
teardown. A mapping change starts a new capture incarnation; never relabel old samples by timestamp
or size. Privacy suppression and login change clear pixels on every client. Media stays on the
selected Host route, even on the same Mac, and viewer frames never authorize an agent action.
Diagnostics hold IDs and typed reasons, never media, window text, typed input or URLs.

Mac video profiles negotiate at every hop; without confirmation a stream keeps the legacy shape
(Baseline, 30 fps, 2.5 Mbps, periodic keys). The low-latency profile makes keys only on demand,
because a periodic key on a scarce budget costs seconds of skipped frames. The Host caps the shared
encoder by the driving viewer's link, else the slowest one.

## Negotiated Mac owner input

Every hop negotiates owner input ([version](../packages/protocol/src/mac-window-video.ts)). Input
needs the exact owner view generation, read-write approval and Host-projected shared-input
authority; task Watch stays view-only. Capture generations fence root, exterior geometry, crop and
display; a child wholly inside the root does not retire the mapping. One per-app coordinator
serializes person batches with every agent mutation, and held keys block agent effects. Blur, hide,
leaving, geometry or authority loss, lock and Stop reset input. Person bursts keep focus protection
and an after-input watch that never renews its own time limit. Copy is an explicit nonsecure
selection read and paste is literal text: there is no Host pasteboard or file transfer. Editing
verifies exact text around the caret and never retries through keys; secure fields are never read.
