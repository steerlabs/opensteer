# Opensteer for Chrome

This Manifest V3 extension lets Opensteer sign an agent's browser in with the person's **current
Chrome profile**, one site at a time. Opensteer decides which sites may be used; the extension keeps
its own record so the person can see and stop any site from Chrome. The trust and delivery rules are
in [Chrome sign-ins](../../docs/browser-sessions.md#chrome-sign-ins).

## Build and install

`pnpm --filter @opensteer/browser-extension build` writes `dist/` and
`apps/web/public/browser-extension.zip` (with `INSTALL.txt`). There is no Chrome Web Store listing
yet: unzip, open `chrome://extensions`, turn on Developer mode and Load unpacked. Checks live in the
[browser-and-passwords skill](../../.agents/skills/browser-and-passwords/SKILL.md).

The manifest's public `key` fixes the extension ID to `opensteerChromeExtensionId` in
`@opensteer/protocol/browser-sources`, and the build fails if they disagree. Web pages detect the
extension by loading `icons/probe.png` and hand it a pairing link by opening `connect.html`; those
are its only web-accessible resources. Other files live under a content-hashed `b/` directory.
Replacing the unpacked folder’s files reloads the extension automatically within a minute,
when no pairing or storage mutation is in progress. Saved connections are preserved.

## What the extension enforces

Any website can open `connect.html` and any Deployment can sign an invitation calling itself "Home",
so the page refuses to run in a frame, strips the invitation from the address first, and requires
the tab that opened it to be on one of the invitation's destination origins. It leads with that
address, not the Deployment's name. A destination is used only when it signs a fresh challenge with the
invitation’s pinned key; only then does the pairing code or token leave. A refusal
stops retries until the person acts.

The extension has `<all_urls>` host access, so Chrome never prompts per site. Per connection it keeps
shared and stopped sites and a rolling 24-hour budget of 20 newly shared sites, and it refuses
non-registrable sites, loopback and the sites of any Opensteer it is connected to. Cookie values
leave only in an explicit export after its budget reservation is stored durably. An uncertain send
remains counted. A site's
first share shows a Chrome notification with **Stop sharing**.

Cookies only: passkeys, device-bound sessions and sites that need local storage may not sign in.
Incognito is not supported, and each Chrome profile connects separately.
