# Plugin account OAuth

Read the Account broker’s [provider registry schema](../../../../apps/control-plane/src/auth/hosted-oauth-provider-registry.ts) and
[.env.example](../../../../apps/control-plane/.env.example). Register the exact callback the running
service supplies and the plugin’s declared scopes; never invent a redirect from a development port. Provider
distribution or organization approval is separate. Managed registrations use
`https://accounts.opensteer.com/v1/oauth-broker/callback/{provider}`; Google Account sign-in
separately uses `https://accounts.opensteer.com/api/auth/callback/google`.

**Managed apps**, for an Account service you run (production secrets stay in Secret Manager): set
independent `OPENSTEER_HOSTED_OAUTH_STATE_KEY` and `OPENSTEER_HOSTED_OAUTH_ENCRYPTION_KEY`, and the
`OPENSTEER_HOSTED_OAUTH_PROVIDERS` JSON registry (or its `_FILE` secret). Each managed entry
includes its provider endpoints, allowed scopes, revision, client ID and secret. Add `placement`
with the exact permitted `hosts` and optional header/scheme for plugin one-click sign-in; without
it the Host does not offer a managed client. Bump the revision
when changing the registration or authorization behavior. The broker validates provider behavior
at startup; its public metadata supplies the available clients without their secrets. GitHub needs
its exact installation URL (`https://github.com/apps/<app-slug>/installations/new`). Add a
managed registration only after checking its endpoints, scopes and credential destinations. This
registry deploys with the Account service, independently of desktop releases. Custom-app relay
uses Account's plugin callback relay capability and does not need a managed provider entry.
Remove old `relayOnly` entries before deploying: registry entries now describe confidential managed
apps only. Retired built-in service requests receive HTTP 400 with an update instruction; they do
not fall back to plugin consent.

**Production registry**: [deploy/account/oauth-providers.json](../../../../deploy/account/oauth-providers.json)
holds every entry except credentials. Its `allowedScopes` and `placement.hosts` are the union of
what the catalog plugins for that provider request and where they send tokens; change it only with
that check, and remember a changed entry makes existing grants reconnect. Credentials live only in
the runtime secret's registry. After any change to the template, with gcloud signed in to the
project:

1. Run `pnpm exec tsx .github/scripts/account-oauth-registry.ts --dry-run`. It reads the version
   `deploy/account/account.yaml` pins, rebuilds the registry from the template with each provider's
   held credentials, validates it and lists the providers included and skipped.
2. Run it again without `--dry-run`. It adds a runtime secret version and prints its number; the
   other runtime settings carry over. To add a provider, first put its `clientId` and
   `clientSecret` in a registry entry of the secret by hand.
3. Set that number in the `opensteer-account-runtime` `resourceName` line of
   `deploy/account/account.yaml`, and give its SecretProviderClass and the Deployment's reference
   the next `account-runtime-v<N>` name. Deploy the Account image and manifest together. To roll
   back, restore the previous image with its secret pin and class.
4. Check `/v1/oauth-broker/metadata?version=4` lists each provider with its placement, then qualify
   sign-in and renewal with an updated Host.

**Custom apps**: prepare the plugin account connection, review its sites, credential exposure and
scopes, then save or select the owner's OAuth client. With an Account
link, register the exact Account relay callback the Host shows (also on independent HTTPS Hosts);
without one, the direct Host callback shown. For MCP, keep Account's static
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
pnpm --filter @opensteer/control-plane test --exclude '**/*.integration.test.ts'
pnpm --filter @opensteer/control-plane-protocol test
pnpm exec vitest run apps/host/src/access/hosted-oauth-broker-client.test.ts apps/host/src/access/integration-auth-attempt-service.test.ts apps/desktop/src/app/integration-authorizations.test.ts
pnpm test:integration -- tests/plugin-oauth.integration.test.ts apps/control-plane/src/auth/hosted-oauth-broker-store.integration.test.ts
```

Run the affected contracts. With a real provider, verify consent by
the personal owner and intended source, durable completion, refresh where granted, and disconnect and
revocation notices, initiating remotely and locally through the same Account path. A wrong Account,
browser or provider, callback replay, two concurrent devices, cancellation, and unlink or relink
during exchange must create no credentials. Exercise changed-source and missing-permission refusals
without switching accounts.

## Plugin broker cutover

Deploy Account and its plugin-only registry/metadata first, verify metadata v4 and the registered
placement, then qualify the plugin-capable Beta Host and matching web/mobile builds. Promote
Stable only after that qualification. Update separately installed clients to the Host's API
window. This order deliberately interrupts old built-in sign-ins; Account does not upgrade Hosts.
Tell affected people to update their computer and clients and start sign-in again. The cutover
migration discards in-flight attempts and uncommitted refresh recovery; an affected saved grant
needs reconnecting. Never replay a discarded result or silently switch OAuth apps.

For each managed provider check `placement.hosts` against every credential destination, including
subdomains and ports. Check the optional lowercase `header` and optional or null `scheme` against
the provider's expected token carrier; null means no scheme prefix. Omitted placement disables
one-click sign-in. Re-qualify consent, renewal and revocation with the actual registration; a
hermetic provider test does not establish that a production provider accepts these settings.
