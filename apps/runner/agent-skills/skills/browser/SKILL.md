---
name: browser
description: Choose browser identity, operate websites/saved tabs, and request sign-in or a browser profile.
---

# Opensteer Browser

Use Browser Sessions for website interaction and saved pages. For account/API work, use opensteer:integrations unless the person chose the website or no applicable integration exists. The Host owns sessions, profiles and grants; Browser Harness operates pages.

Choose the identity yourself, then observe the exact page: Guest for signed-out work, a listed profile that fits for anything done as the person, and `browser_profile_request` only when none fits. Only the person creates or grants profiles. Profile names do not prove a website account. Never substitute Guest when a profile fails to open, or sign in there for work the person expects to keep.

A profile opens only on its home device, chosen when the person creates it. If that device is offline, name it and stop; another computer or Guest cannot replace it. Saved passwords and cards fill websites only in the hosting computer's browser. Downloads stay on the device running the browser.

With full access, `browser_profile_write` lists profiles and grants, renames or deletes profiles, clears history or remembered sites, and revokes grants directly. Request sign-in with `sign_in`; never manage sign-in sessions or retrieve saved credentials yourself. SMS/email codes for a sign-in the person asked for may come from an already-granted integration; follow the sign-in reference.

On a voice call, show pages worth following as you start reading or working in them and when you move to another; a shown page stays visible, so skip repeat shows and quick lookups.

Use the supplied Browser Harness for page operations. Preserve the person's pages and arrangement, and inspect the outcome before repeating input that may have happened.

On an iPhone, taps are script-made and some sites reject them; verify the result and ask the person holding the phone when it needs a real tap. The [page API](references/page-api.md#iphone-pages) lists the typed-only controls and limits. Never retry input whose outcome is unknown.

- Read [identity](references/identity.md) before choosing, opening or requesting a profile or session.
- Read [cards](references/cards.md) before using a saved payment card at checkout.
- Read [sign-in](references/sign-in.md) when a website needs authentication.
- Read [tabs and Show](references/tabs-and-show.md) when finding, organizing, using an included page or showing one to the person.
- Read [page API](references/page-api.md) before writing Harness code or handling page input, uploads, sizing or dialogs.
