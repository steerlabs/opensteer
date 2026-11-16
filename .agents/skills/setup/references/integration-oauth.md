# Integration OAuth

Read the Account broker’s [provider registry schema](../../../../apps/control-plane/src/auth/hosted-oauth-provider-registry.ts) and
[.env.example](../../../../apps/control-plane/.env.example). Register the exact callback the running
service supplies and the plugin’s declared scopes; never invent a redirect from a development port. Provider
distribution or organization approval is separate. Managed registrations use
`https://accounts.opensteer.com/v1/oauth-broker/callback/{provider}`; Google Account sign-in
separately uses `https://accounts.opensteer.com/api/auth/callback/google`.

**Managed apps**, for an Account service you run (production secrets stay in Secret Manager): set
independent `OPENSTEER_HOSTED_OAUTH_STATE_KEY` and `OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY`, and the
`OPENSTEER_HOSTED_OAUTH_PROVIDERS` JSON registry (or its `_FILE` secret). Each managed entry
includes its provider endpoints, allowed scopes, revision, client ID and secret. Bump the revision
when changing the registration or authorization behavior. The broker validates provider behavior
at startup; its public metadata supplies the available clients without their secrets. GitHub needs
its exact installation URL (`https://github.com/apps/<app-slug>/installations/new`). Add a
`relayOnly: true` entry without client credentials to advertise a provider only for custom-app
callback relay. This registry deploys with the Account service, independently of desktop releases;
the older Host request shapes remain available while its integration flow is being replaced.

**Custom apps**: the owner saves credentials in app setup and selects that source. With an Account
link, register the exact Account relay callback the Host shows (also on independent HTTPS Hosts);
without one, the direct Host callback shown. Before reconnecting an old loopback-only registration,
the person adds the displayed URI in their provider console. For MCP, keep Account's static
client-metadata document or the server's dynamic registration with the exact Account HTTPS redirect,
and verify redirects, issuer and PKCE pins.

**Provider registration**:

- Slack: confidential Web OAuth, not desktop PKCE bot consent.
- Microsoft: confidential Web, organizational and personal accounts on `/common` v2, explicit
  delegated scopes.
- Discord: confidential authorization code without PKCE.
- GitHub App: enable expiring user tokens, disable OAuth during installation, register the
  revision's installation URL; user authorization and repository selection stay separate.

```sh
pnpm exec vitest run packages/integration-auth/src/oauth.test.ts apps/control-plane/src/auth/hosted-oauth-broker-contract.test.ts apps/host/src/integrations/integration-auth-attempt-service.test.ts
pnpm test:integration -- apps/control-plane/src/auth/hosted-oauth-broker-store.integration.test.ts packages/database/src/integration-store.integration.test.ts apps/host/src/integrations/mcp-oauth-reconnect.integration.test.ts
pnpm test:integration -- apps/host/src/integrations/api-key-reconnect.integration.test.ts
```

Run the affected contract (the last covers API-key repair). With a real provider, verify consent by
the personal owner and intended source, durable completion, refresh where granted, and disconnect and
revocation notices, initiating remotely and locally through the same Account path. A wrong Account,
browser or provider, callback replay, two concurrent devices, cancellation, and unlink or relink
during exchange must create no credentials. Exercise changed-source and missing-permission refusals
without switching accounts.
