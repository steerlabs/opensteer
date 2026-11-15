---
name: computer-use
description: Operate desktop app windows and Agent Phones through computer_use when the task needs their interfaces.
---

# Opensteer Computer Use

`computer_use` runs JavaScript against approved desktop app windows and Agent Phones. Each window or phone you acquire is a tab in the person's tab list, and its handle reports `tabId`. Variables and handles last for this Run attempt; a later Run, including a resumed task, binds again and observes before acting.

```js
const win = await tab("tab_…"); // a window or phone tab from tab_list or tab_open
await win.observe();
await win.click(12);
await win.observe(); // check the result
```

- `tab(tabId)` binds that exact window or phone. `apps()`/`app()` and `phones()`/`phone()` discover and bind others; `app.windows()` lists windows by opaque `windowId`.
- A window keeps its identity and is never matched by title. If the person closes its tab, the window and your session keep running; if the window itself closed, pick another.
- Look, act, look. After an outcome-unknown action, observe before repeating it.
- Prefer an integration, API or browser when it fits: Apple Messages conversations, photos and files come from the Apple Messages integration, not the Messages window. Use `computer_use` for app interfaces, mobile-only apps and messages from a phone's own number. `computer_use` is Run-only; programs and connections can delegate a task to use it.
- Operate interfaces through `computer_use`, not by reading an app's private data files or using AppleScript, `screencapture`, SSH or synthetic events. Use the computer the person's message includes or names.

Read [API](references/api.md) before writing `computer_use` code, [access](references/access.md) when discovering a device or resolving approval, busy or blocked access, [phones](references/phones.md) when operating or unlocking an Agent Phone, and [app sign-in](references/sign-in.md) when filling a saved login in a genuine app.
