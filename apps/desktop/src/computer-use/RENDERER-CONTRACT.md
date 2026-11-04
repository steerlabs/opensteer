# Computer use: desktop permission panels

The native panels cross a consent boundary. Schemas live in `packages/protocol/src/desktop.ts`,
handlers in `apps/desktop/src/bridge/methods/computer-use.ts`, and pages in `apps/web/src/desktop/`.
[Computer use](../../../../docs/computer-use.md) owns helper trust, Mac grants and
[owner-view authority](../../../../docs/computer-use.md#owner-view-wire).

The browser's page-glass child is click-through, non-focusable and has no Desktop bridge. Main
enables it only on macOS and Windows: transparent children render black on X11 without a compositor,
which Electron cannot detect, so renderer placement follows main's glass availability. Renderer
window rectangles are CSS pixels; main converts to DIPs with app-view zoom. Browser stage corners
mask drawing only. See [Browser sessions](../../../../docs/browser-sessions.md#shared-viewing-and-previews)
and `apps/desktop/src/browser/page-glass.ts`.

## Permission panels

Permission and app-setup windows use the sandboxed, context-isolated Desktop bridge and act only on
this computer's OS permission state. Their arrival must not steal typing from another app.

App and local MCP consent use the same authenticated Host review and command on web, desktop and
mobile. No renderer or native approval token or desktop approval key conveys authority. The target
helper still supplies GUI identity, path, risk and deny-list validation. Sensitive review details
belong only to the owner's transient review UI.

Permission polling never prompts. A person requests exactly one permission at a time; a returned
denial does not prove macOS showed or answered its asynchronous question, so Settings is offered
separately where it cannot cover the dialog. The page owns polling and completion; main owns the
window. The helper may restart after Screen Recording is granted, so a polling blip is expected.
Always name the row **Opensteer Computer Use**. A packaged build failing the Developer ID policy
cannot open setup.

System Settings targets are main-owned constants: never give the renderer a general
`x-apple.systempreferences:` launcher through external-URL APIs. Setup drag uses the installed
helper main chose, never a renderer-supplied path.

## Window picker and owner destinations

Inventory uses the owner-only Host API, never a renderer-to-helper shortcut. Owner destinations bind
machine, app and resolved window; task destinations bind machine, app and exact session. Keep them
distinct even when their encoder binding matches. Selecting shows a picture without activating
anything. The separate "Use on this Mac" verifies the selected authenticated Host attachment, the
enrolled local Runner, the exact app and owner generation, then the pinned live process; it cannot
launch a replacement or accept a remote substitution. Expected refusals use fixed human words;
unexpected causes stay in main's diagnostics.

## Native window video

Renderers consume the selected Host display socket, even for a same-Mac round trip; there is no
local capture or JPEG fallback. Opening never focuses the typing target, and blur, hide, F6 and
leaving reset input and composition. A valid static picture survives transient same-source
recovery; a replacement socket retires earlier decoder output and refuses input until it draws.
Terminal generations need an explicit reopen. Owner input, video lifetime and the window group are
owned by [Computer use](../../../../docs/computer-use.md#negotiated-mac-owner-input).

## The setup panel

Main owns setup state; the renderer draws it. Begin and close carry the displayed app's identity so
a stale poll cannot act on the next app. `unknown` is not completion, and questions outlasting RPC
deadlines stay pending. A settings step reopens only on explicit action; a grant question joins the
existing macOS question. Honor reduced motion with completed static states. See
`apps/desktop/src/computer-app-setup-guide.ts` and
[Setting an app up on this Mac](../../../../docs/computer-use.md#setting-an-app-up-on-this-mac).
