---
name: verify-chrome-signins
description: Use when checking Chrome extension pairing, site-cookie admission or sign-in delivery.
---

# verify-chrome-signins

Run the relevant check from the repo root:

```sh
pnpm test:integration apps/host/src/browser/browser-source-service.integration.test.ts
pnpm test:integration packages/database/src/browser-source-store.integration.test.ts
pnpm --filter @opensteer/browser-extension build
pnpm --filter @opensteer/browser-extension test:integration
```

Use disposable Chromium and test accounts, never a person's everyday profile or credentials. Verify challenge-before-token, site scoping, revocation during delivery and passive inspection. For migration changes, select the affected cases in `packages/database/src/migrations.integration.test.ts`; follow `docs/testing.md` for database setup. Read `docs/browser-sources.md` before changing trust rules.
