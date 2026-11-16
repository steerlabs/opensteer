# Computer API

`computer_use` runs JavaScript on Opensteer with a small library in scope. Each call is the body of an
async function: use `await`, `return` a value to see it as JSON, and `print(...)` anything else.
`globalThis` persists between `computer_use` calls in this Run. In a later Run, including a resumed task, bind again with `tab()`, `app()` or `phone()` and observe before acting. State can also be discarded on cancellation, resource failure or worker loss. A call has a 100,000 ms wall limit; split longer work across calls.

```js
const notes = await app("Notes"); // name, bundle id, or the id from apps()
const win = await notes.window(); // the window you used last in this app, else its front window
// or: const win = await tab(tabId); // the exact window or phone of a tab_list / tab_open tab
await win.observe(); // prints the window list and the accessibility tree
await win.click(12); // element index from the tree
await win.type("Venue shortlist", { into: 7 });
await win.key("cmd+s");
await win.observe({ screenshot: true }); // look again, with a picture
```

- `apps()` lists the approved Mac apps you can use; `app(query, { computer })` picks one (add
  `computer` when the same app is approved on several Macs).
- `App.windows()` lists the app's windows as `{ windowId, title }`. `App.window(windowId)` binds
  that exact window; `App.window()` binds
  the window you used last in this app, else the app's front window. It opens the app in the
  background if needed. A `windowId` is valid on its computer only; `tab_open` with
  `{ kind: "window", computerId, windowId }` puts it in the person's tab list.
- `tab(tabId)` binds the exact window or phone of a tab from `tab_list` or `tab_open`. A page or app
  tab is refused with the tool to use instead; a closed or unknown tab is `not_found`.
- `Window.tabId` and `Phone.tabId` name the handle's tab. Acquiring a window or phone adds its tab
  once; if the person closes it, your handle keeps working and does not add it back.
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
- `phones()` and `phone(name or computerId)` give a `Phone`: `observe()`, `tap`, `longPress`,
  `swipe`, `drag`, `scroll`, `type`, `clear`, `navigate(button)`, `launch(appId)`, `wake`,
  `wait(ms)`, `installedApps({ query })` and `release()`. Its `navigation` and `actions` say what
  that phone accepts; see [phones](phones.md). `sleep(ms)` pauses.

Errors throw `ComputerError` with `code`, a plain `message`, and `performed` (what completed before
the failure). Catch them in code when you can recover; never repeat an action whose outcome is
unknown without looking first.

## Working well

Outside a delegation, show your work without being asked: once a window or phone the person asked for, or must act on, is ready, call `person_show({ target: { tabId: win.tabId } })`, and again when you move to another they need. `sent-unconfirmed` reports delivery to connected devices, not viewing. Do not repeat Show to force focus. On a delegation, `queue` the delegating task the `tabId` and why it matters.

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
`windows()`; its tab says "Window closed"); a missing macOS permission, an offline computer or an out-of-date Opensteer (only the
person can fix it; tell them); ended before it was sent (nothing happened; observe again); stopped
by the person (do not use that Mac or phone again in this task unless they ask).
