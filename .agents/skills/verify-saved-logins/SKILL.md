---
name: verify-saved-logins
description: Use when verifying Passwords Workspace leases, browser fills or sealed app delivery.
---

# verify-saved-logins

Run the affected cheap checks from the repo root:

```sh
pnpm exec vitest run apps/host/src/browser/password-sign-in-service.test.ts apps/desktop/src/passwords/login-authority.test.ts
pnpm exec vitest run packages/protocol/src/login-envelope.test.ts apps/desktop/src/passwords/login-envelope.test.ts
```

For a Host/database boundary, select the affected integration:

```sh
pnpm test:integration apps/host/src/browser/browser-sign-in-tool.integration.test.ts
pnpm test:integration apps/host/src/browser/browser-source-service.integration.test.ts
```

Use `docs/testing.md`'s disposable VM workflow for real input. Run `pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh saved-password` (guest commands start in `apps/desktop`), and require a zero-match leak scan over observations, logs and artifacts. The browser smoke command is:

```sh
pnpm test:vm -- pnpm test:electron-passwords
```

Follow `docs/agent-phone.md#11-verification` for a real phone receiver and `apps/desktop/native/passwords/README.md#testing` for Swift. Do not treat receiver tests as proof that a real device completed sign-in. Confirm the intended signed-in account and keep saved values out of reports.
