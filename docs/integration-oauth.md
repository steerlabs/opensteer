# Integration OAuth

An app registration, a user's connected account and a Workspace grant are separate authority resources. Making an app deployment-shared never shares user credentials. Messaging setup is independent of integration OAuth.

## App ownership and selection

Members manage private apps; administrators manage deployment-shared apps. Saving an app cannot transfer ownership. Authorization, completion and refresh pin the exact selected app, revision and callback authority; an unavailable or replaced source requires explicit action, never fallback. Catalog support alone does not qualify a managed registration. See `apps/host/src/integrations/integration-auth-attempt-service.ts` and `packages/integration-core/src/models.ts`.

Multiple custom apps require Host API epoch 5 because older clients assume unique source kinds. Preserve source pins across upgrades and reject mismatched response-contract digests between Host and broker rather than guessing.

## Deployment behavior

Managed authorization binds both Deployment authority and the initiating Account subject. The owner's sign-in cannot substitute for another member. Launch and completion must resolve the same account-link generation; unlink/relink invalidates outstanding consent, ordinary token refresh does not. Invalid internal bindings are deployment errors. Personal authorization also requires the linked owner. See `apps/host/src/integrations/integration-account-binding.ts`.

Where a sign-in can finish is decided by where the provider returns, not by the device that started it. A Personal remote session (a phone, or a browser or desktop attached through Connect or a private network) may begin any sign-in that returns to the Account service: managed apps and relayed custom apps, which the Host completes from its status poll. One returning to the Host's own loopback callback can only be finished by a browser on that computer, so the Host refuses to begin it remotely and reports `CANONICAL_SURFACE_REQUIRED` when the selected app is one (`oauthSourceFinishesOnHostComputer`). The dashboard's `remoteAccountSignIn` says a Host works this way; clients then offer another app by choice, never as a fallback, and keep an older Host's refusal of every remote sign-in. A remote browser sign-in ends on the Account service's completion page rather than a redirect to the loopback origin. MCP sign-ins return to the Host's callback, so they stay on that computer.

Independent HTTPS Hosts use their registered direct callback. Account-linked local Hosts may relay HTTPS-only callbacks through Account while retaining custom secrets and token exchange locally. The relay receives authorization responses, never the custom app secret or resulting provider token; it remains an Account-service dependency. Public issuer identity and internal control transport origin must remain distinct.

The broker keeps managed secrets and seals normalized token material, not raw responses. Only declared token-response identity fields leave it; the Host resolves userinfo. Tenant identity is mandatory when declared. Omitted scopes follow requested/prior-scope semantics, while an explicitly empty list cannot restore access. Refresh support does not imply every grant has a refresh token. See `packages/integration-auth/src/oauth.ts` and `apps/control-plane/src/auth/hosted-oauth-broker-service.ts`.

## Provider constraints

Use [configure-integration-oauth](../.agents/skills/configure-integration-oauth/SKILL.md) for registration and testing. Shipping code does not register or approve a provider app.

Slack bot consent requires confidential Web OAuth over HTTPS; desktop PKCE cannot request bot scopes. The slack-bot response profile must select the top-level bot grant, never the nested user token. Slack MCP's registered-client flow is unsupported and must not be offered as the standard Slack connector.

Microsoft uses confidential Web registration, organizational/personal accounts and /common v2. Request each integration's explicit delegated scopes, never the registration-wide .default union. offline_access requests refresh but need not appear in access-token scopes. Userinfo is the identity authority: discard incidental ID tokens rather than decode them or guess an issuer from /common. Google's issuer validation still applies. Organization consent and licensing can deny otherwise valid access; personal accounts do not provide Teams organization chat. Microsoft disconnect removes local credentials but has no declared per-token revocation endpoint; direct people to provider security settings.

Discord user scopes identify/email/guilds do not permit general messaging. Bot installation is separate. Managed revocation that needs the app secret goes through a short-lived encrypted broker request bound to Account, Deployment, definition and revision. Local disconnect always removes credentials, even if upstream revocation fails, and reports that failure.

## GitHub App repository access

User-token access is the intersection of App permissions, selected installations and the user's own repository rights; OAuth scopes are empty. Enable expiring user tokens and disable OAuth during installation so the PKCE attempt owns callback/state. Installation and user consent remain separate.

Repository readiness must come from GitHub using the connection's user token, never a browser-supplied installation ID. Do not copy or manage GitHub's selection. Require at least one accessible repository before agents resume, fence the update to credential generation and app authority, and never revive a revoked connection. Network errors and 403/429/5xx do not establish an empty account or invalid sign-in: 403 may mean rate limit, permission or organization policy. Only a sign-in-specific refusal clears the permissions repair reason. See `apps/host/src/integrations/github-repository-access.ts` and `github-connection-readiness.test.ts`.

Installation URLs belong to their registration revision. Broker metadata version=2 adds them while the unversioned response preserves older Hosts' shape; tolerate additive metadata so Account/Host upgrades remain independent. Accounts predating the permissions status reason need sign-in to establish it.

## Completion and failure

Only the Host's committed durable result establishes success. Installation, popup closure or a sealed broker response does not. Closing setup is not cancellation. Keep recovery state to opaque attempt IDs; launch tickets, provider codes and tokens must not enter return URLs or router state.

Direct provider and MCP callbacks must match the launch browser binding and claim state exactly once before processing the response or exchanging tokens. A sign-in through the Account service launches from any origin that reaches the Host, since its single-use ticket is the authority; one returning to the Host's own callback launches only on that callback's origin, where its binding cookie is set. Launch tickets travel only in that request: the Host logs request paths without queries.

Return only to the initiating Deployment's verified canonical origin and stored relative path. Native completion uses the fixed application callback with stored Deployment/attempt IDs, never a caller-supplied native URL. Unclaimed callbacks cannot acquire redirect destinations from browser input. Desktop shows a completion page because the external browser lacks its Personal Host session. Broker acknowledgment releases temporary material and cannot undo a committed connection.

Open a same-origin preparation tab from the click before beginning authorization, sever its opener before provider navigation, and create no attempt if blocked. Both tabs observe authenticated durable status. Persist failures with safe classifications; log bounded error codes and identifiers, never provider bodies or credentials. Deduplicate refresh inside the single leased Host and fence credential replacement to owner/generation. See `apps/host/src/integrations/integration-authorization-routes.ts` and `integration-auth-attempt-service.ts`.

## Integration access requests

Installation needs administrator authorization, account consent belongs to the requester, and specialized Workspace access needs an explicit grant. Only Main-profile lineage inherits Main connections; a channel root below Main cannot use or request inheritance ([Messaging](messaging.md#6a-conversation-scope-admission-and-authority)). Main requests disclose inherited read/write authority rather than imply requested read-only access limits Main.

Pin reviewed manifests, requested access and explicit account/server choices through installation. A pinned account must be repaired or the request declined; another account cannot fulfill it. Installation alone does not resolve access or resume the agent. Closing setup or canceling OAuth leaves the access request pending. Preserve older install-only request meaning; nullable pre-install targets and exact connection intent require epoch 6. See `packages/client/src/integrations/access-request.ts` and `apps/host/src/integrations/integration-platform-service.ts`.

Proposals can impersonate catalog names. Every approval/account/grant surface must attribute their name and guidance to the agent and disclose that Opensteer has not reviewed them, including accessible and notification text. Show credential destinations and check behavior before installation.

### Account identity in agent tools

Select accounts by connectionId, not repeated display names. A fulfillment continuation applies only to its exact account and access class; search fresh operations for that account. MCP output passes through older Runners unchanged and is not a browser Host API schema.

OpenAPI operation identity is method/path target, never its display name. Renaming must preserve tool identity and held toolRefs. Legacy target binding uses only the stored snapshot, no network; unbound/damaged installations fail closed without preventing other integrations or Host startup. Built-in reconciliation may separately rematerialize from catalog. Grants hold access classes, not tool lists. See `packages/integration-adapters/src/openapi/definitions.ts` and `bindOpenApiTools` in `packages/database`.

### Proposed API-key integrations

A proposed key check must be one body-free GET/HEAD requiring the credential in every security alternative. Bind arguments only to query/path parameters, never header/cookie names, including ambiguous optional ones; accept only scalar values/arrays and require required parameters. Anonymous alternatives cannot verify keys. Reviewed catalog checks retain their own contract. Guidance and checks join the reviewed digest. See `apps/host/src/integrations/integration-proposal-credentials.integration.test.ts`.

Derive disclosed key destinations using invocation's document resolver. Recompute them at approval; destinations are derived facts outside the digest. Backfill stored snapshots without network; an unreadable destination fails that installation closed. Connect/reconnect uses the active installation's immutable snapshot and never fetches a remote document or substitutes catalog configuration. Missing disclosure is null, not a claim that no destination receives the key.

Store keys encrypted and send only to disclosed destinations. Failed checks expose bounded status/details, never provider bodies. Failed reconnect leaves credential generation unchanged. No check means save unverified and let first use validate; disclose that behavior. See `apps/host/src/integrations/integration-platform-service.ts`.

### Reconnecting an API key

Repair the exact owner's non-revoked key connection for the same provider/definition in place; a known account must prove the same identity. Without connectionId, create a new account rather than guessing. Fence old in-flight failures to the old generation so they cannot invalidate the replacement. Epoch 36 introduced explicit repair targeting. Disclose installed snapshot destinations, including presets; catalog metadata describes a new installation. See `apps/host/src/integrations/api-key-reconnect.integration.test.ts`.

MCP OAuth belongs to an installation and is bound to its discovered authorization server. Legacy unbound credentials and changed issuers require fresh authorization before sending secrets. Older Hosts can read but do not enforce issuer binding and can discard it on rewrite; newer in-flight reconnects cannot complete on the previous release. Reauthorize after downgrade when needed. Slack MCP remains unsupported; use standard Slack's managed or explicitly registered custom app.
