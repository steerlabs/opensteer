# Plugin accounts and OAuth

A custom OAuth app, a connected account and a plugin's reviewed account link are separate
resources. The personal owner manages them; team membership never gives access to private
credentials. Provider registration and real-provider checks belong to the
[setup skill](../.agents/skills/setup/SKILL.md), never shipping code.

## Review and ownership

Account setup creates an engine connection before review. The person reviews that connection's
plugin requirement, requested scopes, declared sites and whether credentials reach plugin code as
sealed handles or values. Completion must use that reviewed declaration and scope request. The
account, reviewed link and successful local attempt commit together. Merely installing a plugin, closing a
popup or receiving a sealed broker response does not complete setup. A committed reviewed link
fulfils matching `plugin.account` Requests and the existing continuation outbox wakes their tasks.
Agents ask for accounts; they do not enter credentials or approve links.

Custom client secrets stay encrypted on the Host and are write-only in its API. Removing a saved
OAuth app does not silently select another app. Managed grants pin the broker registry revision,
requested and actually granted scopes, redirect, client/placement configuration and reviewed
requirement. Scope or client changes need explicit action; historical pins are never rewritten.

## Deployment and callbacks

A Deployment with an active Account link returns every OAuth consent through Account, on every
client surface. One-click sign-in exchanges, refreshes and revokes at the broker; no managed client
secret or provider authorization code reaches the Host. The Host opens only normalized tokens
sealed to its ephemeral key. Account's registry owns provider endpoints, allowed scopes, revision
and managed credential placement. An entry without placement is unavailable for one-click sign-in.
Consent and renewal use the reviewed scopes. The broker accepts only reported grants within the
provider's allowlist that cover every requested functional scope, after normalizing provider aliases. Providers can omit `offline_access` from access-token scopes because it requests renewal.
A provider may return previously consented permissions for the same app. The Host and engine retain
the reported scopes with the grant and keep the original request pinned separately for renewal.
Managed credential handles restrict the destination and token header. A provider can honor any
permission on that token at an allowed destination.

The initiating Opensteer Account and Deployment supply the identity binding. The engine creates an
account with the chosen or default label, and reconnect replaces credentials on the selected account
with a new generation.

The broker accepts only plugin sign-in requests. Hosts using the retired built-in service
integration protocol receive an explicit HTTP 400 asking them to update and restart sign-in.
Account deploys before the plugin-capable desktop release: Beta first, then Stable after qualification. Deploying Account does not upgrade a Host. During this deliberate cutover older Hosts cannot sign in; update the Host and its separately installed web/mobile clients, then restart consent.
Plugin-only metadata uses version 4. Older metadata requests receive the update refusal. Managed
authorization and refresh seal their token results with context version 3. Restart in-flight managed
consent and reconnect if a pending managed refresh crosses this cutover.
The plugin-only broker migration discards short-lived attempts and refresh results: in-flight
consent must restart, and an uncommitted renewal whose recovery result is gone needs reconnecting.

The Account runtime secret at version 11 still contains the old registry shape. Before deploying
this Account build, run `pnpm exec tsx .github/scripts/account-oauth-registry.ts --dry-run`, then
run it without `--dry-run` to create a version with the obsolete `oauth.identity` fields removed.
Pin the reported secret version in `deploy/account/account.yaml` and give the SecretProviderClass
and the Deployment's reference a fresh name. The strict registry schema rejects the old fields at
startup. See the [operator procedure](../.agents/skills/setup/references/plugin-accounts.md).

Custom apps, dynamic registration and client metadata keep discovery, client secrets, PKCE,
exchange and token renewal in the engine on the Host. Account relays only the authorization
parameters sealed to the initiating Host. Select the callback before discovery or registration and
create the relay before opening consent. Custom apps register the exact callback displayed during
setup. MCP and client metadata use Account's fixed `/v1/oauth-broker/callback/mcp` redirect and
`/v1/oauth-broker/mcp/client-metadata.json` document. A missing relay is an actionable failure,
never permission to use a direct callback.

Without an Account link, the Host's own `/v1/plugin-oauth/callback` and client-metadata document
serve direct OAuth. A personal Host reached remotely refuses to start until Account is linked.
Unlinking or relinking during consent invalidates it. Launch rechecks the exact issuer, subject
and link generation, and the committing engine transaction holds local SQL locks through the
account write. This check never makes an HTTP/IPC request or takes a lock on another pool.
Ordinary Account credential rotation does not change the link generation.

Provider-managed apps register `/v1/oauth-broker/callback/{provider}` on their Account origin
(production: `https://accounts.opensteer.com`). The portal is not a callback authority. MCP
servers must accept the exact redirect and preserve issuer, state and PKCE checks; report an
incompatible server rather than weaken those checks.

## Proving who consented

A forwarded launch link must not give its creator the recipient's provider account. The proof
method is fixed at creation and sealed with the attempt:

- **App finish:** Account holds the result until a one-use proof returns to the initiating desktop
  or native app and its Host redeems it. An app accepts returns only for its in-memory registry of
  initiated attempts. Restart loses that registry and needs fresh consent. Native returns use the
  fixed app link. Desktop can also receive a POST body on a sealed port in the reserved
  `48200–48215` block at `/oauth/integration-callback`; the app link remains the fallback.
- **Account session:** web consent requires the initiating person's exact Account session at
  launch. Another Account never consumes the ticket, and the refusal never identifies the
  expected person. A web origin alone does not prove that person's identity.

Loopback cannot identify an OS login. Use it only when macOS confirms that the initiating app owns
the console and is the sole GUI login, at setup and return; otherwise use the OS app link.
Return only to the initiating Deployment's verified origin and stored relative path, the fixed
native callback, or the sealed reserved loopback port. Provider codes, tokens and launch tickets
never enter client recovery state. The app return's one-use proof is the sole permitted exception.

Local launch consumes a one-use ticket. Direct callbacks require that launch's browser cookie and
atomically claim the exact state before exchange. Brokered callbacks also require the broker's
attempt cookie, provider and state; the launch ticket cannot authorize releasing an app proof.
Relays pin the exact authorization URL, client, issuer support, scopes, redirect and PKCE choice.
A failed exchange needs fresh consent, and replay cannot replace saved credentials.

A begin whose answer was lost is sent again as the same command. While its attempt is unlaunched,
the Host returns that attempt and ticket from the sign-in's sealed record, only to the same owner
with identical input; no status read or creation receipt carries the ticket.

## Renewal, disconnect and failures

The engine retains its grant lease and generation checks. The Host persists a pending broker
refresh before sending it: the engine's stable renewal key maps to one broker transaction ID,
expiry, exact sealing context and ephemeral keys. A lost response resumes that transaction instead
of rotating the refresh token again. ACK follows the durable token commit; fetching tokens is not
an ACK. Recovery is bounded by the broker result's expiry. Authorization and refresh failures use
safe grant/client/binding/outage classifications, never provider bodies, codes or credentials.

Local disconnect removes credentials even if upstream revocation fails.
Providers without a token revocation endpoint support local removal only. Slack bot consent needs
confidential Web OAuth. Microsoft requires explicit delegated scopes and rejects `.default`. GitHub
App installation permissions and provider
organization approval remain separate from OAuth consent. Real-provider behavior must be checked
against the registration; a hermetic provider test does not establish it.
