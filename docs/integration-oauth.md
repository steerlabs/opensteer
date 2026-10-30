# Integration OAuth

An OAuth app, a connected account, and a Workspace grant are separate resources.
The app identifies the provider registration used for consent and token exchange.
The connection holds one user's provider credentials. A grant determines which
tools a specialized Workspace may use through that connection. Making an app
available to the deployment does not share any user's account credentials.

Messaging connections remain independent. Installing a Slack integration or
authorizing its provider account neither configures nor depends on a Messaging
router.

## App ownership and selection

A provider application with a null `owner_user_id` is deployment-shared. A
non-null owner makes it private to that user. The dashboard returns the caller's
private apps and deployment-shared apps. Members manage their own apps;
administrators manage shared apps. Saving an existing app cannot transfer its
ownership.

The Host advertises managed sign-in only when the integration qualifies the
provider revision and its Account broker actually supports that registration.
An entry in the integration catalog alone is not enough. A new connection uses
the server's concrete selected source; choosing a different app applies to that
authorization, not to other users or existing connections.

Clients submit the exact selected application source. The Host verifies it
against eligible sources, including app id, revision and callback authority.
Authorization, completion and refresh keep that binding. An unavailable app is
an error to act on, never a reason to silently choose another app.

A provider can have several custom apps, introduced in Host API epoch 5 because
older clients permit at most two OAuth sources with unique kinds; the existing
version negotiation reports the upgrade requirement.

## Deployment behavior

Managed cloud uses the Account broker on behalf of the initiating deployment
member. Host credentials prove deployment authority; the authenticated Account
subject proves which member is authorizing. The deployment owner's sign-in is
not a substitute for another member's sign-in.

Both paths resolve a validated account binding before creating a broker attempt.
The binding carries issuer, subject and a 43-character generation. Personal uses
its stored link generation. Server deployments derive a SHA-256 fingerprint from
the account-binding row identity and provider configuration identity/version;
normal sign-in and token updates do not rotate it, but unlink/relink does. Launch
and completion resolve the same binding, so outstanding consent cannot cross a
binding replacement. Invalid internal binding data is a deployment error, not a
malformed user request.

Personal deployments retain the linked-owner, Account-link generation and
canonical-surface checks. Remote access to a Personal deployment does not grant
authority to initiate a new provider authorization from that remote surface.

Independent HTTPS self-hosted deployments use their own provider app and direct
canonical callback. A provider whose bot flow requires HTTPS cannot be offered
with an unsupported loopback callback. Account-linked local deployments can use
the Account callback service for that case while keeping their custom app secret
and provider token exchange on the local Host.

The managed broker retains its own client secret. A custom callback relay
receives the authorization response, not the custom app's secret or resulting
provider token. The relay remains an Account-service dependency and must be
described as such in custom local setup.

The broker keeps the Account's public issuer separate from an internal control
API transport origin. Provider callbacks and sealed identity bindings always
use the public issuer. Host-to-Account requests may use the configured control
API origin.

## Configuring managed providers

The Account service owns managed app configuration. Broker encryption and state
keys are independent of individual provider registrations:

- `OPENSTEER_HOSTED_OAUTH_STATE_KEY`
- `OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY`

For managed Slack, configure a complete registration:

- `OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_ID`
- `OPENSTEER_HOSTED_OAUTH_SLACK_CLIENT_SECRET`
- `OPENSTEER_HOSTED_OAUTH_SLACK_REVISION`

Google and Microsoft use the equivalent `OPENSTEER_HOSTED_OAUTH_GOOGLE_*` and
`OPENSTEER_HOSTED_OAUTH_MICROSOFT_*` names. Each revision must match its catalog
qualification. Incomplete groups are configuration errors; absent groups do not
advertise a managed app. Callback relay support does not require Opensteer's
managed provider credentials.

Register the callback URLs supplied by the running service and the scopes
declared by the integration. Provider registration, distribution approval and
credential installation are operational prerequisites. Shipping support in
Opensteer does not create or approve a provider application.

Slack's native integration uses the confidential Web OAuth flow for bot access.
It is separate from Slack MCP's user-token setup. Slack requires HTTPS for this
flow and does not permit bot scopes with desktop PKCE redirects. See
[Slack's authorization-code flow](https://docs.slack.dev/authentication/installing-with-oauth/)
and [PKCE requirements](https://docs.slack.dev/authentication/using-pkce/).

Provider responses are processed once by the shared `integration-auth` exchange
layer, for both managed and custom apps and for refresh. A catalog method may
select a closed `tokenResponseProfile`; omission means standard OAuth. The
`slack-bot` profile validates Slack's success/error envelope and requires the
top-level bot grant. Its actor label `bot` becomes the Bearer transport scheme;
the nested user grant is never selected implicitly. A user-token method would
need its own explicit consent and response contract.

The managed broker seals normalized token material and, for token-response
identity sources, only the declared account and tenant identity fields. It does
not forward the raw provider response or call userinfo. The Host resolves
userinfo identities and saves the connection. Declared tenant identity is
mandatory. Scope omission follows OAuth's defined requested/prior-scope
semantics, while an explicitly empty scope list stays empty and cannot restore
permissions. Refresh qualification means the exchange implementation is
supported; an individual connection can refresh only if its grant supplies a
refresh token.

Microsoft uses a confidential Web registration with organizational and personal
accounts and the `/common` v2 authority. Each Graph integration requests its own
explicit delegated scopes, not the registration-wide `.default` union. Returned
Graph-qualified scopes are normalized through the catalog's declared aliases.
OIDC `offline_access` asks for a refresh token and is not required in the returned
access-token scope list; data permissions remain mandatory. Disconnect removes
Opensteer's credential; Microsoft declares no per-token revocation endpoint here,
so the existing disconnect notice directs users to the provider's security settings.
Organization consent policies and product licensing still apply (for example,
personal accounts do not provide Teams organization chat access).

Microsoft explicitly selects `idTokenValidation: "ignore"`: the integration
uses the access token's authenticated userinfo response as its identity
authority, not ID-token claims. The shared exchange removes incidental ID
tokens before processing both authorization and refresh responses. It never
decodes them for identity or guesses an issuer from `/common`; Microsoft issues
tenant-specific ID-token issuers. This mode is permitted only for userinfo
identity methods. Google's configured issuer validation remains unchanged.

## GitHub App repository access

GitHub App user tokens use an empty OAuth scope list. The registration's fine-grained
permissions and selected installations determine access, intersected with the user's
own repository permissions. GitHub's user authorization and repository installation
remain separate: enable expiring user tokens and leave OAuth during installation off
so the existing PKCE attempt owns its exact callback and state.

Managed GitHub requires the complete `OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_ID`,
`OPENSTEER_HOSTED_OAUTH_GITHUB_CLIENT_SECRET`, `OPENSTEER_HOSTED_OAUTH_GITHUB_REVISION`
and `OPENSTEER_HOSTED_OAUTH_GITHUB_INSTALLATION_URL` configuration. The installation
URL has the form `https://github.com/apps/<app-slug>/installations/new`. It is public
metadata associated with that registration's revision, not a URL hardcoded in the
catalog. Custom applications store their own installation URL on the existing
provider-application record. Saving it follows the same ownership and revision rules
as the client credentials.

Hosts request broker metadata with `?version=2` to receive installation URLs.
The unversioned endpoint retains its original response shape for older Hosts;
the new metadata reader tolerates additive fields so Account and Deployment
upgrades can remain independent.

OAuth saves the user credential in `needs-attention` until repository access is
verified. The authenticated `integration.repositoryAccess.check` RPC reads GitHub's
`/user/installations` using that connection's user token, then checks accessible
repository counts for each non-suspended installation. It never trusts an installation
id supplied by a browser redirect. GitHub remains the repository-selection authority;
Opensteer does not copy or manage that selection. Existing installations link to their
GitHub configuration pages rather than forcing another installation.

The check promotes the account only when at least one repository is accessible.
Credential generation, current status and application authority fence the update;
a concurrent disconnect, refresh or custom-app change cannot be overwritten. Network
or provider failures are errors, not evidence of an empty account. Rechecking can
refresh an expired setup credential, but cannot revive a revoked connection or use
a replacement OAuth app. Agents resume only after repository readiness is established.

While it waits for repositories the account records `statusReason: "permissions"`: the
credential works and GitHub grants it too little. Connecting, and every other status the Host
writes, clears it, so a client offers the repository step only to an account that can take it
and a sign-in to every other account that needs attention (`accountRepair` in
`apps/web/src/components/integrations/helpers.ts`). The dashboard reports an account whose
OAuth app is gone as needing a sign-in even while it waits for repositories, because the check
would refuse it. A check refused for a reason only a new sign-in can fix (GitHub rejecting the
token itself, a changed authorization, an unreadable token expiry) records the account as needing
attention without the reason, fenced to the credential generation it judged, so the account is
offered a sign-in rather than the check again. Any other failure (offline, HTTP 403, 429 or 5xx)
does not show that GitHub rejected the sign-in, so it changes nothing: the account keeps its
repository state, and the person can recheck after fixing access or waiting. A 403 can be a rate
limit or a permission or organization-policy change; these endpoints take a
[GitHub App user access token](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token).
So a refusal alone does not say where the account goes next. After one, the connection sheets,
Settings and a thread's access card reload the account and follow the row the Host kept
(`repositoryAccountStep` in `packages/client/src/integrations/connect-selection.ts`): back to
sign-in, still to the repository step, or connected. An account written before epoch 38 has no
reason, so it is offered a sign-in; signing in again records the reason when GitHub still reaches
no repository.

See [GitHub user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
and [GitHub installation APIs](https://docs.github.com/en/rest/apps/installations).

## Discord user OAuth

Discord's standard connector requests `identify email guilds`: identity, email,
and basic server memberships. These scopes do not grant general message reading
or posting. Bot installation and messaging require a separate capability.

Managed registration uses a confidential Discord application. Its callback is
derived, never hardcoded: `integrationApplicationCallbackUrl`
(`packages/integration-core/src/models.ts`) mints
`/v1/oauth-broker/callback/<provider>` on the Account's public issuer, so each
environment registers the callback for its own issuer. Account configuration
requires the complete `OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_ID`,
`OPENSTEER_HOSTED_OAUTH_DISCORD_CLIENT_SECRET`, and
`OPENSTEER_HOSTED_OAUTH_DISCORD_REVISION` triplet. The authorization-code flow
uses the existing durable state validation and server-side form client authentication;
it uses the catalog’s non-PKCE flow. Refresh uses the same registered app.

When provider revocation requires the managed app secret, the Host sends a
short-lived encrypted revocation request to the broker. The request binds the
Account, Deployment authority, provider definition and app revision. The broker
uses its own registered secret and returns success only after provider acceptance.
Local disconnect always removes the credential; failed upstream revocation produces
an explicit notice.

See [Discord OAuth2 documentation](https://docs.discord.com/developers/topics/oauth2).

## Completion and failure

Installation approval, saving client credentials and closing the provider window
are not connection success. The authorization attempt's durable result and the
resulting account identity are the authority. Workspace access must still match
what the user approved; installation alone cannot imply a read-write grant.

Browser completion returns only to the initiating Deployment's verified
canonical origin plus the Host-supplied relative return path stored in the
durable attempt. The broker never accepts a return origin from the browser and
never puts provider codes, launch tickets, or tokens in that URL. The returned
Host page resumes durable attempt polling; a popup close is not completion.
Native completion uses the fixed
`com.opensteer.mobile:/oauth/integration-callback` application link with only
the durable Deployment and authorization-attempt ids. The broker derives both
ids from its stored attempt; callers cannot supply a native return URL.

Web launches provider and MCP authorization through one shared launcher. It opens
a same-origin preparation tab synchronously from the person's click, before the
begin RPC, and severs the opener before navigating to a provider. A blocked tab
creates no attempt and asks the person to allow tabs and retry. Begin failures
close the preparation tab. Both flows return to `/integration-authorization`,
which reads the authenticated Host's durable status and shows the outcome.
The original tab stays in place and observes that same attempt. Router-owned URL
state retains only the opaque attempt id for refresh recovery, never a launch
ticket or token. The page takes over observation when the Connect sheet closes.
Closing an authorization tab does not cancel an attempt. Cancellation is an
explicit Host command, and status-read interruptions retain the recovery id.

Direct and hosted callbacks share one client-surface return policy. Desktop
callbacks display a completion page rather than navigating the external browser
to the Personal Host, where it has no desktop session. Web return URLs include
`integrationAttempt` so the authenticated page resumes the durable attempt; an
omitted return destination intentionally leaves the browser on the completion
page. A sealed broker result is described as authorization received, not an
already connected account. Only the Host's committed result establishes
completion. Broker acknowledgement releases temporary broker material and
cannot undo a committed connection.

Once a direct callback has claimed its state and browser binding, a persisted
failure also returns through that same client-surface policy. Unclaimed or
untrusted callbacks never acquire a redirect destination from browser input.

Authorization failures retain their safe classification in the Host's attempt
row, including app rejection, expired attempts, response-contract errors and
missing permissions. The broker logs the attempt id, provider, classification
and bounded provider error code for exchange failures, never the response body
or credentials. Existing attempts and connections retain their source pins;
the authorization digest rejects a mismatched response contract across Host and
broker releases rather than guessing how to interpret it.

Missing app configuration, a temporary broker outage, an expired attempt and a
provider-rejected account grant require different remedies. An outage retains
the selected app. A changed app revision requires explicit reconnection. An
existing source default never migrates existing connections.

Refresh requests are deduplicated inside the Host and credential replacement
checks the owner and expected credential generation. One Host per deployment is
enforced by the deployment's PostgreSQL advisory lease; this feature does not
introduce a separate distributed lock service.

## Integration access requests

An agent requests access with the existing `integration_request` tool. A catalog target with an
`access` value, or an `integration_propose` call with `access`, opens one durable `integration.access`
request. That request keeps the reviewed installation manifest until an administrator installs it;
installation binds the request to the installation but does not resolve it or resume the agent.
If several servers are present, the requester selects one explicitly on the same request. The
requester then connects/selects their account and approves any required Workspace grant in
the same access surface. Catalog/proposal calls without access are explicit install-only requests.

Installation remains administrator-authorized, account consent requester-authorized, and
specialized-Workspace access an explicit grant. Main Workspace access retains its inherited
semantics for a lineage that starts from a Main-profile Thread; a channel lineage below Main
can neither use nor request it ([Messaging](messaging.md#6a-conversation-scope-admission-and-authority)).
So a pending request for Main is answered by the first usable account its owner connects, with no
separate Allow, and its card and sheet say so beside every connect action, a key repair that
opens straight on its key included (`mainConnectAllowsNote`). Main's tasks read and make changes
with every account they inherit, up to a computer's own access, so a request for Main states that
access rather than the one the agent asked for (`grantedIntegrationAccess`).
A request pins an explicitly named connection and server, preserves requested write
access even before MCP tools are discovered, and retains the reviewed manifest digest across
installation. Credential-source failures never select another app or connector.

A request that pins a connection is answered by that connection or declined; its card offers no
other account and makes no new one. When the pinned connection needs attention, the card says
why in the Host's recorded words (`statusDetail`) and repairs it the way it was made
([below](#reconnecting-an-api-key)): a key form bound to that connection, shown at once, or one
sign-in hand-off. A pinned connection that is gone leaves only Decline request. Wherever accounts are
listed or chosen, an account is told apart by who the provider says it is, or else by when it
was added, to the minute when another of the same name was added that day, and to the second
when their displayed minutes also match; names are never
changed to tell them apart.

A proposed installation's name is text an agent researched, so the install and access requests
that carry it set `presentation.agentProposed`. Their titles hold the plain name, and every surface
shows "Proposed by an agent" beside it; a surface with no room for a label (an OS notification,
a receipt, a status line, a screen reader) appends it to the title in words, through
`requestTitleText`. The label's tooltip, and the proposed integration's Settings page, say what
it means (`requestAgentProposedDetail`): Opensteer has not reviewed it. An agent can give its
proposal any name, a catalog integration's included, so Settings marks the proposal the same way
wherever it lists or offers one: its card, its accounts under Your accounts, and a Workspace's
grants. A native select names it in words (`agentProposedText`).

Before installation, the browser card and the phone's sheet, and the install-only card on both,
show one review,
[`integrationInstallReview`](../packages/client/src/integrations/access-request.ts): the name; for
a proposal, what agent-proposed means and the host it was researched from; for a preset, its
description; and where a key goes and whether it is checked, in the key form's own words. How
many operations it has is left to the access step, which counts what answering it reaches out of
all of them, "Read only · 135 of 152 operations" in a specialized Workspace and "Read and write ·
152 operations" in Main (`integrationAccessSummary`); the integration's Settings page counts the
same operations. One
note beneath the review says what installing leads to (`integrationInstallNextStep`). A failure
on a request card is shown on that card, not again in the app-wide banner.

Pre-install targets are nullable and connection intent is exact, both introduced in epoch 6;
existing pending install-only requests keep their original meaning.
Installation completion updates the existing pending request; only access resolution queues the
agent continuation. Closing setup or cancelling an OAuth attempt leaves the access request
pending; explicitly declining ends it.

### Account identity in agent tools

Search returns the complete built-in catalog on every discovery call, regardless of query,
provider or result pagination. Rows use `definitionId` as the catalog request key, with a name,
description and installed state; installed rows retain installationId, status and repair detail.
Shared `guidance` states setup and recovery rules once per response. This is agent-readable
MCP output, not a runner-decoded wire contract; previous runners pass it through unchanged.
Server readiness retains recorded details; tool readiness omits detail identical to its server.

`integration_search.operations` is the source of callable toolRefs. Each operation carries its
own grant's `connectionId` (null for connectionless operations), the account display name, effect
and toolRef. Names can repeat; select the account by connectionId. Listed operations carry no
readiness field. `results[].tools[]` contains tool metadata and aggregate readiness, with no
account or toolRef; `results[].accounts[]` retains connectionId. Computer-app and phone discovery
use `app()` / `phone()` in the `computer` tool and report `nextAction` instead of
callable toolRefs; their integration rows remain internal authority units
([Computer use](computer-use.md#1-model)). `integration_describe` names the account as
`{alias, connectionId, isDefault}` in its first header.

An OpenAPI operation is named `<group>.<operation>`: its first tag, or else its path's first
segment that is not a parameter, `api` or a version such as `v3`, `3` or `2.0`, then its
operation ID, each part cut at 240 characters so a name fits. Operations that plan one name gain
their method, then a number while that is taken, so every operation has its own name
([`planOpenApiToolNames`](../packages/integration-adapters/src/openapi/definitions.ts)). A name
is not what a call runs: each tool stores its operation's method and path template as its
`target`, and a call runs that operation in the installation's stored document. A server keeps a
tool's row by its target across materializations, renaming it in place, and only one active tool
holds a name. Tools stored before tools carried a target are bound once at Host startup, from
their own snapshot and without network access, by the names 0.1.131 planned for them
(`bindOpenApiTools`); a bound tool keeps its id under its new name, and one those names never ran
is disabled. Binding reads only each installation's stored snapshot. One that cannot be bound,
from a damaged document or a failed write, keeps its tools unbound, so their calls are refused,
and becomes unavailable with "Opensteer couldn’t read this integration’s API document after an update and
tries again each time it starts. To use it now, uninstall it and add it again."; every other
integration and the Host start as usual, and the error is logged. Each start tries it again, and
binding it clears only that reason, never another one it is unavailable for. Built-in presets are
then reconciled with the catalog (`ensureBuiltIns`): a preset whose catalog definition changed, or
that is unavailable while its key's destinations are known, is materialized again from the catalog,
which can fetch its document over the network, so a preset that binding left unavailable can work
again in the same start. A preset the Host cannot store again is left unavailable with "Opensteer
couldn’t update this integration. Reinstall it from its page.", logged, and tried again at the
next start. Grants hold an access class, not tools, so they and their accounts are unaffected,
and a held toolRef keeps calling the operation it was stored for. GraphQL tools need no target:
`query.<field>` and `mutation.<field>` name exactly one root field. An MCP tool's name is the
server's own.

An access continuation names the request, integration, granted access, account and connectionId
from the fulfillment response. Its state applies to that target and access class, including a
missing Workspace grant or an unusable connection; another account cannot make it active. The
integration skill owns the next steps: search again and choose the fulfilled connection's fresh
operations. These are agent MCP tool results and continuation text, not browser-facing Host API
schemas; they require no Host API epoch change.

### Proposed API-key integrations

`integration_propose` accepts optional `credential: { label, description, setupUrl }`
and `check: { operationId, args? }` for API-key OpenAPI proposals, an optional
`name` for any proposal, and requires a `description` of what the service does. Labels have an
80-character limit, descriptions 240, HTTPS setup URLs 2,048, operation IDs 256, and JSON check
arguments 4,096 UTF-8 bytes. A name is one line of up to 80 characters and a proposal's
description one line of up to 240, without line or paragraph separators, or control or
formatting characters.
The auth input and definition setup URL carry the guidance; the adapter's existing
`healthCheck` carries the check. The name becomes the definition name and the
installation title; without one, an OpenAPI document's `info.title` names it, and
otherwise the source's host ([`integrationProposalName`](../packages/integration-core/src/models.ts)).
The description becomes the definition's description and is shown on the approval card. A
document's own description is not used: OpenAPI's is often long Markdown, and GraphQL and MCP
have none. A proposal stored before descriptions were required has none and keeps its generated
description, such as "OpenAPI integration from api.vapi.ai.". The agent wrote the name and
description, as it wrote the guidance, so every surface showing them marks the integration as
proposed by an agent. A rejected argument is reported by field, as
`invalid_arguments: credential.description: Too big: …`.

The Host admits exactly one named GET or HEAD operation without a request body,
admits only arguments whose names bind exclusively to query/path parameters, and
rejects names shared with even optional header/cookie parameters. It requires every
required parameter and bounds values to JSON scalars or arrays of scalars. The provider validates
argument values. The Host requires the proposal's credential in every
security alternative. Anonymous alternatives cannot verify a key. These proposal
restrictions do not change reviewed catalog definitions. Guidance, check, name and description
join the document in the proposal digest and survive approval reinspection.

The key forms attribute guidance to the agent. Shared `apiKeyDisclosure` instructions name the
credential by its input label when the method has exactly one input, or keep the generic noun
"key" otherwise. Each says once where to get it: a link named by the setup URL's host, or without
one, in the person's account for that service (`ApiKeyForm`, and the phone's `ApiKeyStep`). An
integration's Settings page links its setup URL in its header unless a key form open on the page
already links it.
`definition.apiKey` reports `{ destinations, check }`, or null when no resolved
key disclosure is available. Origins are computed from the resolved document during
proposal inspection and snapshotting, using the same server resolver as invocation.
They appear on the approval card and persist with the installation summary and
runtime snapshot. Destinations are derived facts, excluded from the digest and
recomputed at approval; proposals without guidance, a check, a name or a description retain the
original document-only digest. Startup fills missing disclosure from persisted API-key snapshots independently,
without network access or rematerializing tools. A snapshot whose destinations cannot
be derived becomes unavailable with a remove-and-reinstall repair reason; other
installations and Host startup continue. Dashboard reads use stored summaries; they
never resolve a document. Catalog metadata is projected once at Host startup.
A catalog entry without stored origins has `apiKey: null`.

API-key Connect and reconnect require an active installation and use its immutable
adapter snapshot, matching the stored disclosure. They never resolve catalog
configuration or a remote document. Access requests and Settings install the
integration before offering a key form. Disconnect always removes the local
credential, including when the installation is unavailable; OAuth retains its
declared upstream revocation and failure notice.

Opensteer stores keys encrypted and sends them to the disclosed destinations when
used. A configured check runs before saving. A 401/403 says the provider rejected
the key; other failures report a bounded message and HTTP status when available,
never a provider body. Failed reconnects leave the credential generation unchanged.
Without a check, connecting saves the key unverified and the provider checks it on
first use.

### Reconnecting an API key

A connection is repaired the way it was made. A sign-in lands on the same connection because the
provider names the account. A key often names none: an integration without a health check saves
its key unverified, and the first call the service rejects marks
the connection needs-attention. A reconnect therefore names the connection it repairs:
`integration.apiKey.connect` carries `connectionId`, and the Host replaces that connection's key
in place, under the next credential generation, so a request or grant pinned to it is satisfied
again and resumes as any connection does. The target must be the owner's key-made connection for
the same definition and provider, and not revoked; a connection that already knows its account
accepts only a key proving that account. A rejection from the previous key's in-flight call names
the old generation and leaves the repaired connection alone. Without `connectionId` a key is a new
account, never a guess at an existing one. The thread access card and Settings both reconnect
this way (epoch 36). Settings describes every installed integration, preset or proposal, by the
definition its installation carries, so its key form discloses the installed snapshot's
destinations; a preset's catalog definition and digest describe only installing it. A proposal is
listed with the installed presets, marked as proposed, so its accounts reconnect the same way
(`platformIntegrations` in `apps/web/src/components/integrations/helpers.ts`). An OAuth account's
Reconnect starts that same sign-in and names the account to sign in as, and a GitHub account
waiting for repositories is offered that step instead (`accountRepair`). Once an integration has
an account, its key form opens only from "Add another key" ("Use an API key" beside a sign-in),
so a key pasted under a broken account's Reconnect cannot become a second account by accident;
a Reconnect opens its own form at once. An installation that is not active offers no way to
connect: its page says it is unavailable or turned off, with the Host's stored reason
(`inactiveInstallation`). An administrator may reinstall a catalog preset the Host could not use,
and may uninstall an installation the catalog does not offer, such as a proposal or a retired
preset; a turned-off preset still in the catalog offers neither. Installing a preset again keeps
its installation only when it is not `needs-attention` and its stored digest matches the
catalog's; otherwise the Host materializes the catalog snapshot again
(`installCatalogDefinition`). An MCP server's
own OAuth accounts belong to its installation, not its definition; its Settings page lists and
disconnects them, and authorizing one, first or again, starts from the agent request that needs
it, because `integration.mcp.authorization.begin` names that request.

MCP OAuth credentials are bound to the authorization server discovered when they were issued.
Connections saved before issuer binding must be authorized again; a different issuer also
requires a new authorization before any saved credential is sent.
Older Hosts can read the stored connection but do not enforce this binding. A downgrade can
discard issuer fields when it rewrites credentials, requiring authorization again after upgrade.
An in-flight reconnect started on a newer Host cannot complete on the previous release; start it
again after the downgrade.

Slack MCP is not shipped as a connectable preset: its registered-client authorization is not
supported by the current MCP OAuth implementation. The upgrade disables that built-in preset and
cancels its pending access requests, retaining reviewed manifests and resolved history. It
records on the preset's servers that Opensteer no longer supports Slack MCP and that it should be
uninstalled in favour of Slack, which its Settings page shows. Other installations are unchanged.
Standard Slack supports configured managed sign-in or the user's explicitly registered OAuth app.
