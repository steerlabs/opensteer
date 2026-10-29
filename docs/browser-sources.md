# Chrome sign-ins

A person connects their own Chrome once. After that, an agent — or the person
from the browser toolbar — can sign one website in, in a live Opensteer Browser
Session, with that Chrome profile's current sign-in for the site. Nothing is
copied into a new profile, and nothing syncs continuously: each sign-in is one
transfer of one site's cookies into one live browser context.

## Concepts and owners

- **Source**: one Chrome profile paired with one Deployment. The extension holds
  a bearer token; the Host stores its hash with a generation that every revoke
  bumps. [Source store](../packages/database/src/browser-source-store.ts).
- **Site grant**: (owner, Workspace, site) with an optional preferred source.
  It is not bound to a source, so reconnecting Chrome keeps every allowed site.
  The Workspace is always the Browser Session's own Workspace, never the
  caller's; Main may drive another Workspace's session and the grant lands there.
- **Site**: the schemeful registrable site from
  [`browserSiteFromUrl`](../packages/browser-profile/src/source-state.ts)
  (`https://github.com` for `gist.github.com`). IP addresses and `localhost` are
  their own site; any other host without a registrable domain — a public suffix
  such as `github.io` or `co.uk`, or a bare intranet name — is refused, because
  it would cover every tenant under it. `browserSiteCookieMatches` is the single
  scope rule: a cookie belongs to a site only when its own host normalizes to
  that site, so `amazonaws.com` never reaches `bucket.s3.amazonaws.com`. The
  extension exports exactly those cookies, the Host rejects a snapshot with
  anything else, and the runtime replaces exactly those. `BrowserSiteSchema` and
  the 0055 CHECK constraints accept exactly the shapes it produces (lowercase
  hostnames including `_`, IPv4, bracketed IPv6).
- **Receipt**: one row per delivered sign-in, keyed by (owner, invocation). A
  replayed invocation returns its receipt without exporting again.

The Host owns authority and delivery
([service](../apps/host/src/browser/browser-source-service.ts)); the extension
owns Chrome access and its own per-Deployment record of shared sites
([worker](../apps/browser-extension/src/worker.ts)). The wire contract is
[browser-sources.ts](../packages/protocol/src/browser-sources.ts) (version 4);
the invitation is [browser-source.ts](../packages/deployment-authority/src/browser-source.ts).

## Connecting Chrome

`browser.source.pair` returns one signed, one-use invitation valid for 15
minutes. A Personal Deployment on loopback lists its loopback origin and, when
remote access is on, its signed remote route; other Deployments list their
canonical origin. The extension verifies the signature and the live Host
identity and keeps the first destination that matches. Loopback is tried first
and any local process could answer there, so before sending the one-use code
(or a `replaces` token) the extension posts `{origin, routeGeneration, nonce}`
to `POST /internal/v1/browser-sources/pair/challenge` and verifies the returned
Host signature over `browserSourcePairChallengeBytes`. The Host signs only for a
destination it would accept a pairing on (the same ingress and route checks as
`pair`), only for extension origins, and at most 30 times a minute per address.
Every later connection likewise asks the Host to sign a fresh challenge before
the token is sent. Reconnecting an ended connection passes `replaces`; when its
token verifies for the same owner, the old source is revoked and grant
preferences move to the new one in the same transaction.

The Host sends `source-unauthorized` when a source is revoked or its token is
rejected, and `route-changed` when a Personal remote route changes. A
`route-changed` sent while refusing a challenge, before any connection proof,
carries a Host `signature` over `browserSourceRouteChangedBytes` of that
challenge; the extension ignores an unsigned pre-proof notice. Disconnect in
Chrome (`source.disconnect`) revokes the source exactly like Disconnect in
Opensteer. `last_seen_at` records the last connect or disconnect.

## Signing in

No sign-in, from any path, reaches a loopback site (`127.0.0.0/8`, `::1`,
`localhost`, `*.localhost`, `0.0.0.0`) or the site of the Deployment's canonical
origin or current remote route, in either scheme: those hold the owner's
Opensteer session cookie, and an agent signed in there could approve its own
Requests. Agents get `unavailable: not-allowed` before any Request is created;
the owner's toolbar action and Allow get the problem `not-allowed`; drains and
standing grants skip them.

`sign_in {sessionId, site, reason}` routes between Chrome reuse for the session
and saved logins from the Personal Mac. Without `sessionId`, `sign_in` authorizes
Passwords for the calling Workspace directly. [Opensteer Passwords](passwords.md#choosing-the-method)
owns the routing order and Passwords results; its [field fills](passwords.md#filling-a-field)
use the real tab, including profile-backed sessions. Chrome grants and cookie
imports keep the rules below. A Chrome sign-in:

1. The session must be live and reachable from the Run's Workspace, and its
   runtime must advertise `modules.browser.stateImport`; otherwise
   `unavailable: session-closed | runtime-outdated`.
2. In-memory rate limits: 3 calls per (session, site) and 30 per Run per 10
   minutes (`rate-limited`). An open Request for the same Run, Workspace and site
   is returned instead of a new one; if that site has since been allowed some
   other way and a Chrome can answer (the rule below), the Request is delivered
   and completed by that call.
3. With a grant, the preferred connected source (or the only one reporting
   `available` when there is no usable preference) is used immediately.
   Otherwise `main` and `workspace` Threads open a `browser.sign-in` Request;
   delegated Threads get `unavailable: needs-approval`. When every connected
   Chrome reports no sign-in and none is offline, the answer is `not-signed-in`
   without a Request.

`browser.session.sign-in` is the owner's toolbar action: it picks the explicit
source, the grant's preferred source, or the only signed-in one, and remembers
the site for the session's Workspace on success. `browser.sign-in.respond`
answers a Request: Allow remembers the site with that source preferred and
delivers at once; any problem leaves the Request pending and is returned for the
card; `site-removed` means the site was removed while the sign-in was in
flight. Decline runs in the same per-Request turn as delivery, so a declined
Request never signs anything in. `request.respond` refuses sign-in Requests.
When a source connects, the Host drains pending Requests whose (Workspace, site)
has an active grant preferring that source, or preferring none that is still
connected, in pages filtered in SQL, and delivers each whose grant would use
that source now (the preferred one, or the only one reporting `available`).

One delivery: export from Chrome → validate the scope and the 1,000-cookie /
1 MiB bound → re-read the session → immediately before the import, re-check in
one transaction that the source is the same generation, the Workspace is usable,
the grant is still active (standing and Request paths), a Request is still
pending with its originating authority intact, and a newly remembered site fits
the owner's 1,024-site limit → `BrowserService.applySiteCookies` sends
`state.import` with a Host-random operation ID and awaits
`state.import.result` → record the receipt, fulfil the Request and touch the
grant in one transaction. The runtime answers within 20 seconds and never
writes after giving up; the Host waits 30
([`browserStateImport*TimeoutMs`](../packages/protocol/src/browser.ts)).
Deliveries into one browser context and site run one at a time. The Host never relays `state.import` or `state.export` from a viewer
or agent; the broker forwards only an allowlist of input and navigation frames.

## Chrome's side

The extension has `<all_urls>` host access and keeps, per Deployment, the sites
it has shared, the sites the person stopped, and a rolling 24-hour budget of 20
newly shared sites. It answers `stopped`, `chrome-blocked`, `limit`, `no-state`,
`unsupported` or `too-large` instead of exporting, and inspection reports the
same without spending budget and never sends cookie values. The first share of a site to a
Deployment shows a Chrome notification with Stop sharing.

## Limits

Cookie sign-ins do not carry device-bound sessions or local storage, and
Browser Sessions offer no passkeys ([Passkeys](browser-sessions.md#passkeys));
agents verify the account and otherwise ask the person to sign in in the
visible browser. Removing a site stops future sign-ins; browsers already signed
in stay signed in. Any agent with a signed-in browser can act as the person on
that site. Migration 0055 revoked every v1 connection and grant and declined
pending v1 copy Requests with a continuation pointing to `sign_in`; v1
copied profiles remain ordinary profiles.

## Verification

Use the [cheapest relevant check](testing.md#how-to-test) and reuse
one Chrome sign-in journey; these are available checks, not a per-change list.

- Focused `pnpm test:integration <file>` runs
  [the Host sign-in suite](../apps/host/src/browser/browser-source-service.integration.test.ts)
  and [the store suite](../packages/database/src/browser-source-store.integration.test.ts)
  against real PostgreSQL. The 0055 upgrade belongs to
  [migration tests](../packages/database/src/migrations.integration.test.ts);
  Run the full migration check when required.
- `pnpm --filter @opensteer/browser-extension build` and
  `pnpm --filter @opensteer/browser-extension test:integration` drive the
  extension in a disposable Chromium. No verification uses a person's everyday
  browser profile or credentials.
