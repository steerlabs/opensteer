# Opensteer for Chrome

This Manifest V3 extension lets Opensteer sign an agent's browser in with the
person's **current Chrome profile**, one site at a time. Which sites may be
used is decided in Opensteer; the extension keeps its own record so the person
can see and stop any site from Chrome.

## Build and install

`pnpm --filter @opensteer/browser-extension build` writes `dist/` and
`apps/web/public/browser-extension.zip` (with `INSTALL.txt`). There is no Chrome
Web Store listing yet: install means unzip, `chrome://extensions`, Developer
mode, Load unpacked.

The manifest's public `key` fixes the extension ID to
`opensteerChromeExtensionId` in `@opensteer/protocol/browser-sources`; the
build fails if they disagree. Web pages detect the extension by loading
`chrome-extension://<id>/icons/probe.png` and hand it a pairing link with
`window.open("chrome-extension://<id>/connect.html#<invitation>")`. Those two
files are the only web-accessible resources.

## Connecting

`connect.html` refuses to run in a frame, removes the invitation from the
address before doing anything else, and asks the service worker to verify it
(`decodeBrowserSourceInvitation`). Any website can open the page, and any
Deployment can sign an invitation calling itself "Home", so the worker also
requires that the tab which opened the page (`openerTabId`) is on one of the
invitation's destination origins: Opensteer's web app or the Host's
`/connect/chrome` page. The page leads with that address; the Deployment's name
is secondary.

The worker probes the destinations, loopback first. A destination is used only
when its live `/.well-known/opensteer` identity matches the signed one **and**
it signs a fresh nonce (`POST /internal/v1/browser-sources/pair/challenge`,
`verifyBrowserSourcePairChallenge`) with the invitation's key; only then does
the pairing code leave. If this Chrome profile already has a connection to the
same Deployment (same authority key), pairing always sends `replaces` for it,
healthy or not, so the Opensteer page that opened the tab sees the new
connection; the Host retires the old one in the same transaction, and the
extension carries its shared and stopped sites over.

Every WebSocket connection sends a fresh challenge and verifies the Host's
signature for the dialed origin and route generation before sending the token.
`source-unauthorized` and `unsupported-version` are honoured only after that
proof. `route-changed` may arrive before it, since a Host that no longer serves
the address cannot prove it; it is honoured only when signed over the
challenge (`verifyBrowserSourceRouteChanged`). `unsupported-version` compares
the Host's `supportedVersion` with the extension's protocol version: a newer
Host asks the person to update the extension from it, an older one to update
Opensteer (never to download its older extension). Each refusal stops retries
and is kept in storage until the person acts (reconnect from Opensteer, or
**Try again** after updating).

## Sharing a site

The extension has `<all_urls>` host access, so Chrome never prompts per site.
For each connection it keeps `sharedSites`, `stoppedSites` and a rolling 24-hour
budget of 20 newly shared sites. Inspect and export answer, in order:
`unsupported` (not a registrable site, a loopback site, or the site of any
Opensteer this Chrome is connected to), `stopped`, `chrome-blocked` (Chrome's
own Site access withholds the site), `limit` (a new site over budget), then
reads cookies: none → `no-state`, else `available`/exported.

Export reads unpartitioned cookies for the site's domain and cookies
partitioned under the site, and keeps exactly those `browserSiteCookieMatches`
accepts — the same rule the Host validates and the runtime replaces. Cookie
values leave only in `source.export.result`. A share is recorded (shared sites,
budget, notification) only once that frame was sent on the connection's live
socket. A site's first share shows a Chrome notification with **Stop
sharing**; the popup lists shared sites with when each was last shared, Stop
sharing / Share again, and offers **Allow more today** when the budget is spent.

## Limits

Cookies only: passkeys, device-bound sessions and sites that need local storage
may not sign in. Incognito is not supported; each Chrome profile connects
separately.

## Testing

`pnpm --filter @opensteer/browser-extension test:integration` drives the built
extension in a throwaway Chromium profile against a synthetic Opensteer. Set
`OPENSTEER_EXTENSION_SCREENSHOTS=<dir>` to save the connect page and popup in
each state, and `OPENSTEER_EXTENSION_REPORT=<file>` for the JSON report.
