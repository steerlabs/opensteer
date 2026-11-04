# Integration OAuth

An app registration, a user's connected account and a Workspace grant are separate authority
resources; sharing an app across the Deployment never shares user credentials. Messaging setup is
independent. Registration and testing are in the [setup skill](../.agents/skills/setup/SKILL.md);
shipping code never registers or approves a provider app.

## App ownership and selection

Members manage private apps and administrators manage Deployment-shared ones; saving an app never
transfers ownership. Consent and completion pin the exact app, revision and callback authority;
credential use and refresh pin the app and revision, so a new consent redirect does not invalidate a
grant. An unavailable or replaced app needs explicit action, never fallback, and historical source
pins are never rewritten. See
[`integration-auth-attempt-service.ts`](../apps/host/src/integrations/integration-auth-attempt-service.ts).

## Deployment behavior

Managed authorization binds both the Deployment and the initiating Account subject; the owner's
sign-in never substitutes for another member. Launch and completion resolve the same account-link
generation, so unlink or relink invalidates outstanding consent and ordinary token refresh does not
([account binding](../apps/host/src/integrations/integration-account-binding.ts)).

A Deployment with an active Account link returns every OAuth consent through the Account, whatever
the device, route or public origin. Managed apps exchange through the broker; custom apps and MCP
keep discovery, PKCE verifiers, client secrets, token exchange and identity on the Host, and the
callback relay receives only the authorization response, sealed to that Host. A missing relay is an
actionable failure, never permission for a direct callback. Without an Account link, consent
returns directly to the Host's own callback on its public origin; a Personal Host reached remotely
refuses to start OAuth until an Account is linked. Before connecting a custom app through the
Account, the person registers the exact redirect URI the Host shows; an old loopback registration
cannot accept the Account callback.

MCP uses the Account's fixed HTTPS callback and public client-metadata document, or dynamic
registration for that exact redirect, and pins the redirect and authorization-server issuer. A
server that refuses this redirect cannot complete sign-in; report the incompatibility and the
required URI. Legacy unbound MCP credentials and changed issuers need fresh authorization before
secrets are sent.

The broker keeps managed secrets and seals normalized token material, never raw responses; only
declared identity fields leave it, and the Host resolves userinfo. Declared tenant identity is
mandatory. An explicitly empty scope list never restores access, and refresh support does not imply
every grant has a refresh token ([oauth.ts](../packages/integration-auth/src/oauth.ts)).

Provider apps register the Account's broker callback, `/v1/oauth-broker/callback/{provider}` on
`https://accounts.opensteer.com`; the portal is never an integration callback authority.

## Provider constraints

- Slack bot consent needs confidential Web OAuth over HTTPS; desktop PKCE cannot request bot scopes.
  Select the top-level bot grant, never the nested user token. Slack MCP's registered-client flow is
  unsupported.
- Microsoft uses confidential Web registration and /common v2. Request each integration's delegated
  scopes, never `.default`. Userinfo is the identity authority: discard incidental ID tokens rather
  than guess an issuer from /common. Disconnect removes local credentials only, since there is no
  per-token revocation endpoint.
- Discord user scopes do not permit general messaging; bot installation is separate. Managed
  revocation that needs the app secret goes through a short-lived encrypted broker request.
- GitHub App user tokens reach the intersection of App permissions, selected installations and the
  user's own rights. Repository readiness comes from GitHub with the connection's token, never a
  browser-supplied installation ID; network errors and 403/429/5xx never establish an empty account
  or invalid sign-in
  ([repository access](../apps/host/src/integrations/github-repository-access.ts)).

Local disconnect always removes credentials, even when upstream revocation fails, and reports it.

## Completion and failure

Only the Host's committed durable result is success; installation, popup closure or a sealed broker
response is not, and closing setup is not cancellation. Recovery state holds only opaque attempt
IDs: launch tickets, provider codes and tokens never enter return URLs or router state, except an
app finish's one-use return proof, which only that attempt's Host can redeem.

### Proving who consented

The broker hands a consent to whichever Host created the attempt, so without proof that the
consenting browser belongs to the requester, someone could forward a launch link from their own Host
and receive the recipient's account. Each Account attempt is proven one way, fixed and sealed at
creation, never chosen by the browser:

- **App finish** (desktop and native). The callback holds the sealed result and returns a one-use
  proof to the app that started the attempt, which hands it only to that attempt's Deployment; its
  Host redeems it once before the result is released. A forwarded link ends on a device whose app
  never started the attempt, so the proof goes nowhere (RFC 8252's native-app pattern). Phones
  return through their fixed app link. Desktop browsers open app links only on a click, so a
  desktop attempt can also carry a port, and the callback page posts the proof to the app's
  listener on `127.0.0.1` with no click; the app link stays on the page as the fallback.
- **Account session** (web, and peers without `integration-app-finish-v1`). Launch needs the
  initiating member's exact Account identity in the browser. A mismatch never consumes the ticket,
  and the page never names the expected Account. A web origin cannot be the proof, because an
  attacker's Host serves a real Opensteer origin.

A hostile Host chooses the port of its own attempts, which is why three things hold. The port is
limited to a reserved block, so it can never name a service a person happens to run. The proof
travels only in the form body, because the attacker is that Host: a proof left in an address bar or
history after a failed return would be one paste away from redemption. And a second opaque token
would change nothing, since the attacker owns the initiating app; the app's own registry of attempts
it started is what refuses the proof.

Every login on a computer shares loopback ports, while the operating system routes an app link to
the current login's app. So a desktop listener runs only while its app's login session owns the
console, and otherwise the attempt uses the app link. Only macOS reports that, so other desktops
always use the app link. The listener closes when its session resigns; pending attempts keep their
authority and get their sealed port back if it is still free. The app's attempts live in memory, so
a restarted app refuses them and the person starts again.

This covers links from Deployments the person does not belong to, not a hostile operator of a joined
server Deployment, malware on the device, or a deliberately hostile process under another login on
the same computer. Launch consumes a one-use ticket, and the atomic callback claim matches state,
provider and that attempt's own browser-binding cookie. That ticket is known to the Host that
created the attempt, so its cookie can never authorize releasing a proof. A relay claim authorizes
one exchange; a failed exchange needs fresh consent. Completion rechecks the Account-link generation
in the transaction that stores credentials, and a replayed relay response cannot replace them.
Return only to the initiating Deployment's verified origin and stored relative path, the fixed
native callback, or a sealed port in the reserved block on `127.0.0.1` at the fixed path, never a
caller-supplied URL. Failures persist with safe classifications and never log provider bodies or
credentials.

## Integration access requests

Installation needs an administrator, account consent belongs to the requester, and Project access
needs an explicit grant ([Run tool authority](agent-orchestration.md#run-tool-authority)). Reviewed
manifests, requested access and explicit account choices are pinned through installation; a pinned
account is repaired or the request declined, never fulfilled by another. Installation alone does not
resolve access or resume the agent. Proposals can impersonate catalog names, so every approval
surface attributes their name and guidance to the agent and says Opensteer has not reviewed them.

Agents select accounts by `connectionId`, not display names. OpenAPI operation identity is its
method and path, never its display name. Unbound or damaged installations fail closed without
blocking other integrations or Host startup, and grants hold access classes, not tool lists. A
proposed API-key check is one body-free GET or HEAD that needs the credential in every security
alternative, with arguments bound only to query and path parameters. Key destinations are derived
with invocation's document resolver and recomputed at approval; connect and reconnect use the
installation's immutable snapshot and never fetch a remote document. Keys are stored encrypted and
sent only to disclosed destinations; failed checks expose bounded details, never provider bodies.
Reconnect repairs the exact owner's key connection in place, a known account must prove the same
identity, and without a `connectionId` it creates a new account rather than guessing
([platform service](../apps/host/src/integrations/integration-platform-service.ts)).
