---
name: verify-browser-sessions
description: Use when verifying browser-session native profiles, CDP boundaries, editing, navigation, cursors or downloads.
---

# verify-browser-sessions

Read `docs/browser-sessions.md` for authority and geometry constraints. Run only the affected check from the repo root:

```sh
pnpm exec vitest run apps/browser-runtime/src/browser/editing.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/navigation.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/agent-cursor.test.ts
pnpm test:integration apps/host/src/browser/browser-editing.integration.test.ts
pnpm --filter @opensteer/web test:browser-navigation
pnpm --filter @opensteer/web test:agent-cursors
pnpm --filter @opensteer/web test:browser-downloads
```

For a real Electron boundary, use the repository's disposable VM workflow; never drive host Electron. Select the affected journey:

```sh
pnpm test:vm -- pnpm test:native-browser-journey
pnpm test:vm -- bash scripts/test-viewer-clipboard.sh --editing-v2
pnpm test:vm -- pnpm test:electron-downloads
```

Use the CDP-boundary smoke in `apps/desktop/scripts/electron-cdp-boundary-smoke.ts` through its VM launcher when changing the allowlist. Check private-world handles/events and blocked-CORS headers stay unavailable. Reuse existing journeys; retain screenshots/traces only when manual acceptance needs them. See `docs/testing.md` for VM ownership and cleanup.

## Native profiles

Select the affected layer rather than running every command:

```sh
pnpm exec vitest run packages/browser-runtime-core/src/native-profiles.test.ts packages/browser-runtime-core/src/local-profile-store.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/playwright-launcher.test.ts
pnpm exec vitest run apps/desktop/src/browser/electron-browser-launcher.test.ts apps/desktop/src/browser/session-cookie-mirror.test.ts apps/desktop/src/browser/browser-session-policy.test.ts
pnpm test:integration -- tests/browser-profiles.integration.test.ts
pnpm test:integration -- tests/browser-sessions-identities.integration.test.ts
```

Real Electron qualification runs only in the disposable VM, on request or after merge.
Use the integrated committed revision for both smokes:

```sh
pnpm test:vm -- --revision <sha> pnpm --filter @opensteer/desktop test:electron-profile-restore
pnpm test:vm -- --revision <sha> pnpm --filter @opensteer/desktop test:electron-cookies
```

Qualify last committed state across process crash, not power loss:

- Check orderly quit, update-style restart and SIGKILL reopen with persistent/session/HttpOnly cookies, duplicate partitioned cookie identities, multiple localStorage/IndexedDB origins, service workers and CacheStorage. Crash immediately after conversion readiness as well as after a controlled cookie write. Requalify the pinned localStorage and cookie commit barriers on engine upgrades.
- Kill only the smoke's owned Network Service PID and check the first outgoing request, surviving worker cookie reads, Cookie Store change events and that interrupted capture never shrinks the mirror. The documented restart window is accepted; eventual DOM state alone cannot qualify restoration. Missing/corrupt ready mirrors must refuse opening without clearing data or falling back to the seed.
- Keep Chromium's native session-cookie restore while proving no unauthorized tabs restore. Guest stays isolated. Close, warm reuse, pressure eviction and failed launch preserve native stores; different profiles proceed independently. Exercise complete inventory, interrupted inventory, binding conflicts and ready/initializing/tombstone reconciliation against an older isolated DB.
- Delete with an offline owner, reconnect and an Electron Session retained until restart. Check visible pending states, stale-ticket refusal and actual tree removal before `deleted`; enrollment removal must preserve profile storage. Use only disposable roots and test accounts, never installed app data. Let the owned engine exit before removing its directories, and stop every owned process/database even after failure.

Do not count a skipped engine/platform or unrun VM smoke as qualified. Frozen
legacy readers must still cover unconverted profiles and old Hosts/runtimes;
converted profiles must report the update refusal without Guest or a new-profile
workaround. Agent behavior checks use `run-agent-evals`.
