# Passkeys

`OPENSTEER_PASSKEYS=1` in the Host environment enables routing (default off in `packages/config`);
it grants no OS entitlement. For a desktop's Personal Host, the person launches the app executable
with it, for example `OPENSTEER_PASSKEYS=1 /Applications/Opensteer.app/Contents/MacOS/Opensteer`,
and restarts to change it. Never do this to the live install yourself.

```sh
pnpm exec vitest run tests/passkey-routing.test.ts
pnpm --filter @opensteer/desktop build:passkeys-addon
node --test apps/desktop/native/passkeys/check-addon.cjs
OPENSTEER_VM_SLOTS=1 pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh passkeys
```

- The routing test runs real Chromium, the browser wire and Host routing against verified synthetic
  relying-party ceremonies, without PostgreSQL. The
  [provider](../../../../packages/browser-runtime-core/src/test-support/passkey-provider-scenario.ts)
  and
  [policy](../../../../packages/browser-runtime-core/src/test-support/passkey-policy-scenario.ts)
  scenarios cover both engines and the provider-off case. Fixture TLS identity is public: trust
  exceptions stay in pinned test launchers.
- The addon check loads the real binary in an unentitled Node process and never requests a sheet.
- The VM journey uses a software authenticator and a pinned synthetic RP certificate only its test
  entry imports.

Host tests cannot prove managed-entitlement acceptance or provider behavior. Before release, a
signed app Tim builds must qualify Developer ID signing, embedded profile acceptance, the real sheet
and window anchor, Touch ID, third-party providers, nearby-phone hybrid, security keys, excluded
credentials, cancellation and raw client-data serialization, on macOS 13.5 and 14.4, Intel and Apple
silicon.
