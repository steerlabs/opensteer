# Integration OAuth

Read the provider definition in `packages/integration-catalog` and
[.env.example](../../../../apps/control-plane/.env.example). Register the exact callback the running
service supplies and the catalog's scopes; never invent a redirect from a development port. Provider
distribution or organization approval is separate. Managed registrations use
`https://accounts.opensteer.com/v1/oauth-broker/callback/{provider}`; Google Account sign-in
separately uses `https://accounts.opensteer.com/api/auth/callback/google`.

**Managed apps**, for an Account service you run (production secrets stay in Secret Manager): set
independent `OPENSTEER_HOSTED_OAUTH_STATE_KEY` and `OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY`, and the
complete `OPENSTEER_HOSTED_OAUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET` and `_REVISION` group for
`GOOGLE`, `MICROSOFT`, `SLACK`, `DISCORD` or `GITHUB`, matching the catalog's qualification
revision. Omit a whole group to disable it; a partial group fails configuration. GitHub also needs
`_INSTALLATION_URL` (`https://github.com/apps/<app-slug>/installations/new`). Callback relay needs
no managed credentials.

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
the intended member and source, durable completion, refresh where granted, and disconnect and
revocation notices, initiating remotely and locally through the same Account path. A wrong Account,
browser or provider, callback replay, two concurrent devices, cancellation, and unlink or relink
during exchange must create no credentials. Exercise changed-source and missing-permission refusals
without switching accounts.
