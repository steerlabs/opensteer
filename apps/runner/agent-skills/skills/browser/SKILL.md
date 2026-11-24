---
name: browser
description: Drive the person's web pages with Browser Harness, choose the identity for new pages, and request sign-in or a browser profile.
---

# Opensteer Browser

Browser Harness drives web pages from the shell. Each run is a fresh JavaScript program; the tabs it works in persist in the person's tab list, but its variables do not. Prefer an integration for account or API work unless the person chose the website or none applies.

```bash
"$OPENSTEER_BROWSER_HARNESS" --tab "$TAB_ID" <<'JS'
console.log(JSON.stringify(await pageInfo()));
const found = await opensteer.callTool("tab_list", { query: "invoice", kind: "page" });
if ("error" in found) throw new Error(found.error.message);
const other = await openPage(found.tabs[0].tabId);
console.log(await other.title());
JS
```

- `--tab` binds `page` and the top-level helpers to that tab. Without it, start from `opensteer.callTool("tab_list" | "tab_open", ...)` and `openPage(tabId)`.
- `openPage(tabId)` returns a handle bound to exactly that tab; an asleep tab wakes. Handles never switch tabs, so several can work side by side.
- `opensteer.callTool(name, input)` calls any Opensteer tool this Run has, with the same input, result and `{ error: { code, message, next } }`. Each call shows in the task's activity.
- Every handle has full CDP access through `cdp(method, params)`: network, cookies, storage, frames, workers and every execution world. Use what the task needs; keep credentials and cookies out of replies, files, memory and commits.
- The person may be using the same page. Look before repeating input whose outcome is unknown.

Read [page API](references/page-api.md) before writing Harness code, [identity](references/identity.md) before choosing or requesting a profile, [sign-in](references/sign-in.md) when a site needs authentication, [cards](references/cards.md) before using a saved card, and [extensions](references/extensions.md) before building or loading a Chrome extension.
