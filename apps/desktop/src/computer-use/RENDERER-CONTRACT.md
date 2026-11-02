# Computer use: desktop permission panels

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

## Permission panels

Permission and app-setup windows use the sandboxed, context-isolated Desktop bridge.
They act only on this computer's OS permission state. Keep controls readable and
keyboard-accessible, and do not let arrival steal typing from another app.

App and local MCP consent use the same authenticated Host review and command on
web, desktop and mobile. No renderer/native approval token or desktop approval key
conveys authority. The target helper still supplies GUI identity, path, risk and deny-list
validation. Sensitive review details belong only to the owner's transient review UI.

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
