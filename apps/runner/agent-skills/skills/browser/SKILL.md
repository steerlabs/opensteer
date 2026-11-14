---
name: browser
description: Find and use the person's browser tabs, open pages as the right identity, and request sign-in or a browser profile.
---

# Opensteer Browser

Use the browser for websites and the person's pages. For account/API work, use opensteer:integrations unless the person chose the website or no applicable integration exists.

The person's browser is one list of tabs across their profiles and computers, open or asleep, the same list they see. Browser Harness works on tabs:

```bash
"$OPENSTEER_BROWSER_HARNESS" --tab "$TAB_ID" <<'JS'
console.log(JSON.stringify(await pageInfo()));
JS
```

Leave out `--tab` to start without a tab. Then `await listTabs({ query })` finds tabs anywhere, `await switchTab(tabId)` uses one (waking it if asleep), and `await newTab(url, { profile: "Work" })` or `{ guest: true }` opens one. Before opening a page, look at what is already open and use a tab that fits; open a new one when none does, or when the work would disrupt a page the person is using. Scripts can filter, loop and chain these freely.

Choose the identity for new pages yourself: Guest for signed-out work, the profile that fits for anything done as the person (`browser_profile_list`), and `browser_profile_request` only when none fits. Only the person creates or grants profiles. A profile name does not prove a website account: check the site. Never substitute Guest or another profile when one fails, or sign in in Guest for work the person expects to keep.

A profile opens only on its home computer. If that computer is offline, name it and stop; another computer or Guest cannot replace it. Saved passwords and cards fill websites only in the hosting computer's browser. Downloads stay on the device running the browser.

With full access, `browser_profile_write` lists profiles and grants, renames or deletes profiles, clears history or remembered sites, and revokes grants directly. Sign in with `copy_chrome_cookies` or `use_saved_login`; never manage sign-in sessions or retrieve saved credentials yourself. SMS/email codes for a sign-in the person asked for may come from an already-granted integration; follow the sign-in reference.

The person may be using a page while you work. Inspect the outcome before repeating input that may have happened, and never retry input whose outcome is unknown. On a voice call, show pages worth following as you start working in them; skip repeat shows and quick lookups.

On an iPhone, taps are script-made and some sites reject them; verify the result and ask the person holding the phone when it needs a real tap. The [page API](references/page-api.md#iphone-pages) lists the limits.

- Read [tabs and Show](references/tabs-and-show.md) when finding, opening, organizing or showing tabs.
- Read [page API](references/page-api.md) before writing Harness code or handling page input, uploads, sizing or dialogs.
- Read [identity](references/identity.md) before choosing or requesting a profile.
- Read [sign-in](references/sign-in.md) when a website needs authentication.
- Read [cards](references/cards.md) before using a saved payment card at checkout.
