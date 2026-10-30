# Computer use: the two desktop panels

The native panels cross a consent boundary. Schemas live in
`packages/protocol/src/desktop.ts`, handlers in
`apps/desktop/src/bridge/methods/computer-use.ts`, and pages in
`apps/web/src/desktop/`. Keep method shapes and presentation fields in those sources.
[Computer use](../../../../docs/computer-use.md) owns helper trust, Mac grants and
[owner-view authority](../../../../docs/computer-use.md#owner-view-wire).

The browser's page-glass child is click-through, non-focusable and has no Desktop
bridge. Main enables it only on macOS/Windows: transparent children render black
on X11 without a compositor, which Electron cannot detect. Renderer placement
must follow main's glass availability. Renderer window rectangles are CSS pixels;
main converts to DIPs with app-view zoom. Browser stage corners mask drawing only;
input still reaches corner arcs inside the rectangle, never its outside margins.
See [Browser sessions](../../../../docs/browser-sessions.md#shared-viewing-and-previews)
and `apps/desktop/src/browser/page-glass.ts`.

## Routes

Approval and permissions windows use the ordinary sandboxed, context-isolated
Desktop preload/bridge. Show them inactive: a task can ask while the person types
elsewhere, and their next Return or Space must not become accidental consent.
Initially focus Don't allow/Cancel with `preventScroll`. Keep consent text fully
readable in a keyboard-accessible scroll region above fixed answer buttons; long
app names, paths or task titles must not hide what is being approved.

Closing an approval normally means Don't allow; quitting leaves it unanswered.
Renderer death leaves the request pending for a fresh panel, not declined or
approved. Once quitting begins, open no further approval panels. See
`computer-use-approval-panel.ts` and `computer-use-panels.test.ts` in this directory.

## Bridge methods

An approval token identifies main-held presentation, never renderer-selected app,
access or Deployment. Reading and answering require that token's exact panel web
contents; even another trusted app renderer holding the token must fail. Answers
settle once. Main signs both decisions with the dedicated approval key and waits
for Host acceptance before beginning app setup.

The helper supplies the installed identity, path and elevated-risk judgement;
the renderer must not replace them with Host-supplied labels. Main refuses a denied
app before showing consent. Task context is the signed request's snapshot, not a
fresh renderer Workspace lookup. Reuse supplied access labels/summaries. GUI approval
permits everything the app interface offers; display the elevated warning.

Approval review stays pinned to its original Deployment despite selection changes.
Main consumes offers only over that Mac's Runner stream, never a person's Host
session. A complete Host list missing a request closes its panel unanswered; bridge
loss closes that slot's panels, and reconnect obtains a fresh list. Other slots keep
their own lifetimes. Identity mismatch is neither a prompt nor a decline. Stale
signatures cannot settle replacement requests. Sources: `computer-use-service.ts`
and `approval-key.ts` in this directory.

The private approval key stays in main, encrypted with Keychain-backed safeStorage.
Registration needs owner authorization and a challenge answered on the named Mac;
a Runner authentication key cannot approve apps. Missing Keychain/key/transport
state must surface a retryable explanation, never apparent consent.

Permission polling never prompts. A person requests exactly one permission at a
time; a returned denial does not prove macOS showed or answered its asynchronous
question. Offer Settings separately so it cannot cover the dialog. The page owns
polling and completion, main owns the window. The helper may restart after Screen
Recording is granted; a transient polling blip is expected. Always name the row
**Opensteer Computer Use**. A packaged build failing the Developer ID policy cannot
open setup; see `apps/desktop/SIGNING.md`.

System Settings targets are main-owned constants. Do not give the renderer a general
`x-apple.systempreferences:` launcher through external-URL APIs. Setup drag likewise
uses the installed helper chosen by main, never a renderer-supplied file path.

## Window picker and owner destinations

Inventory uses the owner-only Host API, not a renderer-to-helper shortcut. Owner
app destinations bind machine/app/resolved window; task destinations bind
machine/app/exact session. Keep them distinct even when their encoder binding
matches. Selection displays a picture without activation. The separate “Use on
this Mac” operation verifies the selected authenticated Host attachment, enrolled
local Runner, exact app and owner generation, then the pinned live process. It
cannot launch a replacement or accept a remote-machine substitution. Expected
refusals use fixed human words; unexpected causes stay in main diagnostics.

## Native window video

The helper owns native capture/encoding. Renderers consume the selected Host display
socket, including same-Mac cloud round trips; no local capture or JPEG fallback.
Task Watch stays view-only. Owner input requires Host-projected shared-input authority
and current displayed geometry; editing negotiates separately. Opening never focuses
the typing target. Blur, hide, F6 and leaving reset input and composition. See
[owner input](../../../../docs/computer-use.md#negotiated-mac-owner-input).

Keep a valid static picture through transient same-source recovery; age alone does
not make it unready. Replacement retires earlier decoder output and refuses input
until the current socket draws. Privacy/terminal events and login end clear both
pending and displayed pixels. Warming retains existing authority without renewing
it; eviction ends media, not the owner lease. Native teardown still occupies
capacity until completion. Terminal generations require explicit reopen and stop
renewal/reconnect. The shared
[window-group contract](../../../../docs/computer-use.md#2-the-helper) owns membership,
coordinates and generation barriers; configuration completion cannot establish
sample origin. Keep media and window contents out of diagnostics.

## The setup panel

Main owns setup state; the renderer draws it. Begin/close carry the displayed app's
identity so a stale poll cannot act on the next app. `unknown` is not completion;
questions outlasting RPC deadlines remain pending. A settings step reopens only on
explicit action; a grant question joins the existing macOS question. Honor reduced
motion with completed static states. See `apps/desktop/src/computer-app-setup-guide.ts`
and [Setting an app up on this Mac](../../../../docs/computer-use.md#setting-an-app-up-on-this-mac).
