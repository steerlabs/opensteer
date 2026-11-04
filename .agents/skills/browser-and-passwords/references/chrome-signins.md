# Chrome sign-ins

Read [Chrome sign-ins](../../../../docs/browser-sessions.md#chrome-sign-ins) before changing trust
rules.

```sh
pnpm test:integration apps/host/src/browser/browser-source-service.integration.test.ts packages/database/src/browser-source-store.integration.test.ts
pnpm --filter @opensteer/browser-extension build
pnpm --filter @opensteer/browser-extension test:integration
```

The extension integration drives the built extension in a throwaway Chromium profile against a
synthetic Opensteer; `OPENSTEER_EXTENSION_SCREENSHOTS=<dir>` saves each state and
`OPENSTEER_EXTENSION_REPORT=<file>` the JSON report. Check challenge before token, site scoping,
revocation during delivery and passive inspection. For migrations, select the affected cases in
`packages/database/src/migrations.integration.test.ts`.
