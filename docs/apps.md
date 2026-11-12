# Opensteer Apps

Apps render on the person's device, inline in their Thread or as a tab beside it. Each card resolves
its app ID to the latest publication, even in old history, and the origin Thread owns the app. Stored
HTML and the database belong in the same backup as Host attachments. App authors follow the shipped
[apps reference](../apps/runner/agent-skills/skills/threads/references/apps.md).

An app stays beside its conversation so the person can ask for changes. App tabs belong to the
personal owner and synchronize across their devices; team membership never exposes an app, its
data or its viewing credentials. A client mounts one copy: moving or reloading an iframe loses its
running state. Browser storage stays on one device and is unavailable on some routes, so
cross-device data belongs in a server app.

An HTML app is a self-contained document the Host stores. A server app runs from a folder inside
Agent home on the hosting computer, and that folder holds source and data. Publishing verifies the start command before committing a version but never
copies or rolls back files, so editing the folder can affect a running server. App versions record
their owning computer and never move to the viewer's.

Starting a server and `app_fetch` need a full-access Run, because calling an app can run code with
the computer user's full authority, and a Personal macOS Runner has no outer sandbox. Connected
agents and programs publish or call apps through a managed Run; approving a connection grants no
direct app-server authority. Servers use the program launch and containment paths, get the program
environment allowlist plus `PORT`, and never receive an Opensteer tool credential.

App tool outputs carry app identity and publication metadata, never a viewing credential or a
token-bearing URL; clients get viewing authority on their own and treat the whole URL as private.

## Origins

Each app has its own origin, because an opaque sandbox breaks ordinary web apps: WebKit refuses even
a page's `fetch` to itself there. Over Connect an app is
`https://<key>-<deployment>.opensteerapp.com`, which the
[router](../apps/control-plane/src/account/connect-app-router.ts) forwards to that Deployment's
tunnel. On the same computer it is `http://<key>.localhost:<port>`, which browsers treat as secure
and as its own site. The Host chooses from the route `apps.view` arrived on; clients never decide.
Web and desktop keep their iframe, mobile keeps its WebView, and an app's frame keeps its origin.

The [gateway](../apps/host/src/apps/app-gateway.ts) answers every request on an app origin ahead of
all Host routes and never falls through, because a Host route on an app origin would hand app code
the Host's API. The router bypasses Cloudflare's cache and the gateway marks responses `private`
and removes CDN cache headers: the edge keys on the Connect URL, so a cached app file could otherwise
be served without authorization, or as the Host's own bundle. The `x-opensteer-app-origin` header needs no secret, since a request also needs a
ticket or signed cookie. Desktop admits only the attached Deployment's app origins, and its main
renderer keeps no network access.

Apps share `opensteerapp.com` with each other and with Connect, and it is not a public suffix, so
browsers treat them all as one site and `SameSite` separates nothing. A bad page there could plant
cookies or send logged-in requests, so three rules hold on every app origin, each stopping an attack
we reproduced:

- **Cookies.** App cookies are stored as `__Host-<name>`, which a sibling subdomain cannot set, and
  only byte-exact `__Host-` names reach the app. Never decode or trim names first: that is how these
  prefixes get bypassed. Each app has one flat cookie jar, so `Path` and `Domain` do not apply.
  Cookies are `SameSite=None; Partitioned` so they work inside a frame, which makes a login beside
  chat separate from one in the app's own tab. A shim keeps `document.cookie` working in page scripts;
  workers and the Cookie Store API see the stored names.
- **Isolation.** Another origin may only navigate to an app. Its form posts, fetches, images and
  sockets are refused, so an app cannot receive cross-site POST callbacks.
- **Responses.** `Clear-Site-Data` is removed, since Chromium applies it to the whole registered
  domain. So are `X-Frame-Options` and the app's CSP, which would break framing and the bootstrap.

A server app sees itself at `http://127.0.0.1:$PORT`: `Host`, and a same-origin `Origin` and
`Referer`, all describe loopback. Dev servers and frameworks refuse unknown hosts, and CSRF checks
compare `Origin` with `Host`, so sending the public address breaks one or the other.

Cookie flooding remains: a bad page can make a browser send too many cookies for the whole domain.
It steals nothing, and Connect neighbors could already do it. Apps can move to their own domain
later by changing the origin the Host chooses and the router; logins and browser storage stay behind.

Viewing tickets exchange for session-bound cookies without an extra round trip. Every request
rechecks the session and personal owner authority; access loss must also stop open sockets. A
service worker may still show cached pages, but gets no new data. Recovery that replaces a session
must replace the app frame's viewing authority too.

## Capability path

Routes with no per-app hostname (private networks), Safari on the same computer
(WebKit refuses `Secure` cookies on `*.localhost`) and previous releases use
`/v1/apps/<id>/<theme>/<token>/`. A real origin holds the personal owner's app logins and storage on a device. The capability document is on the Host's own origin, so the frame and every
response enforce an opaque-origin sandbox, and it must never get `allow-same-origin`. That keeps
Opensteer cookies, storage and the parent document out of reach, and leaves the app without browser
storage. The [proxy](../apps/host/src/apps/app-proxy.ts) strips credentials and cookies both ways.
Desktop streams this path through a separate scheme in its main process. Links inside the prefix
stay in the frame; other links open outside. A view capability lasts until Host restart, one per
app and person, and every request checks current personal owner authority. Logout does not revoke a
copied view URL, so clients keep it only in memory.

Servers keep running for background work, restart lazily after a crash, and have no idle shutdown.
They stop when republished as HTML or when the Runner loses its primary Host connection or
stops. App replacement and explicit lifetime controls govern teardown. Only agents get
the startup-failure log tail; viewer error pages omit it.
