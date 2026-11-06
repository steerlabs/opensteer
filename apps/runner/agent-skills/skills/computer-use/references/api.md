# Computer API

`computer` runs JavaScript on Opensteer with a small library in scope. Each call is the body of an
async function: use `await`, `return` a value to see it as JSON, and `print(...)` anything else.
`globalThis` persists between computer calls in this Run. In a later Run, including a resumed task, reopen `app()`, `window()` or `phone()` handles and observe before acting. State can also be discarded on cancellation, resource failure or worker loss. A call has a 100,000 ms wall limit; split longer work across calls.

```js
const notes = await app("Notes"); // name, bundle id, or the id from apps()
const win = await notes.window(); // the window you used last in this app, else its front window
await win.observe(); // prints the window list and the accessibility tree
await win.click(12); // element index from the tree
await win.type("Venue shortlist", { into: 7 });
await win.key("cmd+s");
await win.observe({ screenshot: true }); // look again, with a picture
```

- `apps()` lists the approved Mac apps you can use; `app(query, { computer })` picks one (add
  `computer` when the same app is approved on several Macs).
- `App.windows()` lists the app's windows: `id`, `title`, `focused`, `main`, `minimized`, `onScreen`,
  `modal`, `current`. `App.window(id)` binds an exact window; `App.window()` binds the window you
  used last in this app, else the app's front window. It opens the app in the background if needed.
- `Window.observe({ screenshot })` shows that window only — with its own sheets, popovers, menus and
  child windows — never the app's other windows. The tree is one element per line,
  `[index] role "title" (x,y w×h)`, in screenshot pixels from the screenshot's top-left. It also
  lists the app's windows and says when something blocks this one (`blockedBy`). A window on
  another Space, in full screen elsewhere, or in a hidden app is shown `alone`: without its sheets
  and menus, and a hidden app takes no clicks or typing — ask the person to show it.
- `Window.click(target, { button, count })`, `type(text, { into })`, `key("cmd+s")`,
  `setValue(index, value)`, `scroll(target, direction, amount)`; a target is an element index or
  `[x, y]` screenshot pixels. Actions never look again: call `observe()` when you need to see the
  result. `Window.act([...])` sends several actions as one batch.
- `phones()` and `phone(query)` give a `Phone` (see below). `sleep(ms)` pauses.

Errors throw `ComputerError` with `code`, a plain `message`, and `performed` (what completed before
the failure). Catch them in code when you can recover; never repeat an action whose outcome is
unknown without looking first.

## Working well

Outside an Assignment, if `person_show` is listed, show your work without being asked: call `person_show({target: {current: true}})` after a successful observation or action, as soon as an app or phone they asked you to open, or must act on, is ready, and again when you move to another they need. Also call it when they ask to see what you are doing. The Host resolves this Run's latest app, phone or tab; do not construct native IDs. `sent-unconfirmed` reports delivery to connected devices, not navigation or viewing. On `no-device-connected`, describe where you are working; if there is no current place or access has ended, report the error. Do not repeat Show to force focus. On an Assignment, `queue` your assigner a note the moment an app or phone is ready for the person; it shows it from `thread_read`.

- Look, act, look. Indices come from the window's latest `observe()` and stay valid until you
  observe that window again; after something on screen changes, observe before targeting it.
- Prefer element indices. Use `[x, y]` only for something missing from the tree, from the current
  screenshot or from nearby tree frames.
- Use enough current observation to act accurately and verify the result.
- To fill a field, `type` with `into`; untargeted text goes wherever focus is.
- If the tree says elements were left out, narrow the view (scroll, open the right section or search)
  rather than guessing an index the tree did not show.
- Windows are yours to choose. Use `windows()` and titles to find the right one; a dialog or menu
  listed in `blockedBy` belongs to another window — bind that window to answer it.
- The person may use the same Mac and app while you work; nothing pauses you. If they type where
  you are typing, or move the keyboard while you type, your text can end up mixed with theirs or
  elsewhere: observe again rather than assuming the screen is as you left it.

Refusals are plain sentences. The ones you will meet: the app or phone is busy with another task
(carry on or tell the person; do not loop); `stale-observation` (observe that window again; nothing
ran); `outcome-unknown` (look before repeating anything); the window closed (pick another from
`windows()`); a missing macOS permission, an offline computer or an out-of-date Opensteer (only the
person can fix it; tell them); stopped by the person (do not use that Mac or phone again in this
task unless they ask).

On an Assignment, or if Show is unavailable, give your assigner the exact app, window or phone context to show.
