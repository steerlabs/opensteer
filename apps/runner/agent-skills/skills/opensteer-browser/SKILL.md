---
name: opensteer-browser
description: Use Opensteer Browser Sessions to interact with websites, manage saved tabs and profiles, or sign in to a website.
---

# Opensteer Browser

Use Browser Sessions for website interaction and saved pages. For account/API work, use opensteer-integrations unless the person chose the website or no applicable integration exists. The Host owns sessions, profile grants and isolation; Browser Harness operates pages.

Select or reuse the session with the intended identity and observe the exact page. Profile names do not prove a website account. Named profiles keep data on their owning computer; Guest loses it on close. Never substitute Guest when profile access or opening fails, or sign in there for work the person expects to keep. A profile's placement is fixed after first open.

Use the supplied Browser Harness for page operations. Preserve the person's pages and arrangement, and inspect the outcome before repeating input that may have happened.

- Read [identity](references/identity.md) when choosing, opening or requesting profiles and sessions.
- Read [sign-in](references/sign-in.md) when a website needs authentication.
- Read [tabs and Show](references/tabs-and-show.md) when finding, organizing, using an included page or showing one to the person.
- Read [page API](references/page-api.md) before writing Harness code or handling page input, uploads, sizing or dialogs.
