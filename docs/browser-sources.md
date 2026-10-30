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

Chrome consent belongs to the Browser Session's Workspace, even when Main drives
it from another Workspace. A standing grant can deliver without another prompt;
new delegated-thread decisions require approval. Decline and delivery must serialize
so a declined Request never signs in. Removing a site during delivery must prevent
import. Recheck source generation, Workspace/session access, grant and originating
Request authority immediately before import; record receipt and settlement atomically.
A replayed invocation returns its receipt without exporting again.

Automatic delivery must respect the grant's preferred source rather than pick an
arbitrary signed-in account. A connected preferred source is used directly. If
the preferred source record exists but is disconnected, automatic delivery waits
rather than substituting another account. Only when that preferred record is
absent may inspection choose exactly one available source. Ambiguity needs a
person's choice. See the service's `#standingSource` logic.

Only the Host imports/exports state: viewer and agent frames must never reach that
private lane. Imports into the same context/site serialize. Runtime timeout means
no late write; Host timeout must allow the Runtime to finish refusing first.

Routing between Chrome and Passwords belongs to
[Passwords](passwords.md#choosing-the-method). Source:
`apps/host/src/browser/browser-source-service.ts` and
`apps/host/src/browser/browser-source-service.integration.test.ts`.

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
that site.

## Verification

Use the [Chrome sign-in checks](../.agents/skills/verify-chrome-signins/SKILL.md).
