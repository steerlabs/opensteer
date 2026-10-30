---
name: configure-integration-oauth
description: Use when registering an integration OAuth app, configuring managed or custom consent, or testing an integration authorization flow.
---

Read `docs/integration-oauth.md`, the provider definition in `packages/integration-catalog`, and `apps/control-plane/.env.example`. Register the exact callback supplied by the running service and the catalog's scopes; do not invent a redirect from a development port. Obtain any provider distribution/organization approval separately.

For managed apps, configure independent OPENSTEER_HOSTED_OAUTH_STATE_KEY and OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY as the env example instructs. Set the complete OPENSTEER_HOSTED_OAUTH_<PROVIDER>_CLIENT_ID, _CLIENT_SECRET and _REVISION group for GOOGLE, MICROSOFT, SLACK, DISCORD or GITHUB; match the catalog qualification revision. Omit a whole group to disable it; partial groups fail configuration. GitHub additionally requires _INSTALLATION_URL (`https://github.com/apps/<app-slug>/installations/new`). Callback relay needs no managed provider credentials.

For custom apps, save credentials through the owner's app setup and explicitly select that source. Independent HTTPS Hosts register their canonical direct callback. Account-linked local setup uses Account's callback relay for HTTPS-only providers while the local Host retains custom secrets and exchanges tokens; disclose that dependency.

Register Slack as confidential Web OAuth, not desktop PKCE bot consent. Register Microsoft as confidential Web for organizational/personal accounts on /common v2; use explicit delegated scopes. Register Discord as confidential authorization-code without PKCE. For GitHub Apps enable expiring user tokens, disable OAuth during installation, and register the revision's installation URL; authorize a user and select repositories separately.

Run affected focused checks, choosing the service or real-database contract that changed:

```sh
pnpm exec vitest run packages/integration-auth/src/oauth.test.ts
pnpm exec vitest run apps/control-plane/src/auth/hosted-oauth-broker-contract.test.ts
pnpm exec vitest run apps/host/src/integrations/integration-auth-attempt-service.test.ts
pnpm test:integration -- apps/host/src/integrations/integration-account-binding.integration.test.ts
```

For API-key repair use `pnpm test:integration -- apps/host/src/integrations/api-key-reconnect.integration.test.ts`. Verify real provider consent with the intended member/source, durable completion, refresh where granted, and disconnect/revocation notices; a fake token endpoint cannot qualify provider registration. Exercise changed-source and missing-permission refusals without switching accounts. Stop started services and report blocked provider access rather than passing it.
