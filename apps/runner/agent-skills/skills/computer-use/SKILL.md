---
name: computer-use
description: Operate Mac apps and Agent Phones through the computer tool when the task needs their interfaces.
---

# Opensteer Computer Use

Prefer a purpose-built integration, API or browser when it fits. Use `computer` for app interfaces, mobile-only apps and messages from a phone's own number. Discover and request access through integrations; interact through `computer`, never with `integration_call`. Computer use needs a running task; Trigger programs cannot use it directly.

To operate an interface, never read an app's private data files or use AppleScript, `screencapture`, SSH or synthetic events for that purpose. Use the computer included in the person's message or the one they name. Preserve credential boundaries and do not bypass blocked access.

Observe the intended window or phone, act on current targets and verify the result. Never repeat an action whose outcome is unknown without looking first. `globalThis` and handles last within one Run; a later Run, including a resumed task, must reopen `app()`, `window()` or `phone()` handles and observe before acting. Release a phone when finished or handing it off.

- Read [access](references/access.md) when discovering a device or resolving approval, busy or blocked access.
- Read [API](references/api.md) before writing computer code or handling observations, errors or Show.
- Read [phones](references/phones.md) when operating or unlocking an Agent Phone.
- Read [app sign-in](references/sign-in.md) when filling an authorized saved login in a genuine app.
