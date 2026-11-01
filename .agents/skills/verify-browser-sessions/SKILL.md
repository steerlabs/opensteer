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

## Native profiles and bounded opening

Select the layer changed; keep every engine's cookie scope and durability checks:

```sh
pnpm exec vitest run packages/browser-runtime-core/src/native-profiles.test.ts packages/browser-runtime-core/src/local-profile-store.test.ts packages/browser-runtime-core/src/native-profile-ready.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/playwright-launcher.test.ts apps/browser-runtime/src/browser/persistent-launch-cleanup.test.ts
pnpm exec vitest run apps/desktop/src/browser/electron-browser-launcher.test.ts apps/desktop/src/browser/session-cookie-mirror.test.ts apps/desktop/src/browser/browser-session-policy.test.ts
pnpm exec vitest run packages/client/src/host/pending-browser-tabs.test.ts packages/client/src/host/browser-presentation-wait.test.ts
pnpm test:integration -- packages/database/src/browser-native-only-migration.integration.test.ts
pnpm test:integration -- packages/database/src/operation-budget.integration.test.ts
pnpm test:integration -- tests/browser-native-profiles.integration.test.ts
pnpm test:integration -- tests/browser-profiles.integration.test.ts
```

The native migration proof uses two fixed local bindings, with their native
sentinels and cookie files present before migration. Check owner/name/grants,
history, tabs, binding and initialized facts survive, native bytes stay unchanged,
and outstanding deletion jobs keep archived owner/binding stubs. New profiles
remain empty and unbound until signed attach. Missing established data must fail;
never-created data may publish empty files atomically before any Session owns it.

Exercise durable same-key replay, payload conflict, restart interruption and late
success after terminal failure. The Host's 20-second budget includes DB locks,
placement and relay; the runtime receives remaining signed authority. The 25-second
client budget includes native mount/paint and drawn frames. Presentation Retry
must reuse the same page. Initial and additional navigation errors stay visible
on that page. A hung persistent launch must reap its exact child before rejection.

Real Electron qualification runs only in a disposable VM, on request or after
merge. Use the integrated committed revision; never run host Electron. Unlock only
the disposable golden's fixture keychain as its VM instructions allow. Run the
native profile and cookie smokes through the VM workflow.

Qualify orderly quit, update-style restart and SIGKILL reopen with persistent,
session and HttpOnly cookies, duplicate CHIPS identities, native localStorage,
IndexedDB, service workers and CacheStorage. Crash after controlled cookie writes;
there is no conversion or checkpoint path. Keep Chromium session-cookie restore
while proving it restores no unauthorized tabs.

Kill only the smoke's captured Network Service PID. Check immediate gate refusal
and view closure, explicit reopen, the first outgoing request, surviving workers,
and that interrupted capture cannot shrink the encrypted mirror. Missing/corrupt
mirrors must refuse opening without clearing data. Deferred collaborators must
leave reads unresolved through cancellation and reacquire the same mocked Session;
old listeners and publications stay fenced. Never admit a Session with an
unacknowledged cookie mutation.

Check warm reuse, idle capacity eviction, independent profiles, complete and
interrupted inventories, immutable binding conflicts and tombstone reconciliation.
Delete with an offline owner and a Session retained until process exit; visible
pending states must precede physical erasure acknowledgement. Use disposable roots
and test accounts, never installed app data. Stop all owned processes and databases.

The Host epoch and browser wire contract deliberately reject earlier browser
releases. Check their clear update refusal; do not preserve Vault, preparation,
snapshot or Guest-save adapters. Update model-facing browser cases with the tool
catalog, and use the focused agent-eval workflow when behavioral qualification is
requested. Skipped engines and unrun VM smokes remain unqualified.
