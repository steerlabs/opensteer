# Verify browser sessions

```sh
pnpm exec vitest run apps/browser-runtime/src/browser/editing.test.ts apps/browser-runtime/src/browser/navigation.test.ts apps/browser-runtime/src/browser/agent-cursor.test.ts
pnpm test:integration apps/host/src/browser/browser-editing.integration.test.ts
pnpm --filter @opensteer/web test:browser-navigation
pnpm --filter @opensteer/web test:agent-cursors
pnpm --filter @opensteer/web test:browser-downloads
```

For a real Electron boundary, pick the affected VM journey (guest commands start in `apps/desktop`).
Run the CDP-boundary smoke when changing the allowlist: private-world handles and events and
blocked-CORS headers must stay unavailable.

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh native-browser
pnpm test:vm -- bash scripts/test-viewer-clipboard.sh --editing-v2
pnpm test:vm -- pnpm test:electron-downloads
pnpm test:vm -- pnpm test:electron-cdp-boundary
```

## Native profiles and bounded opening

Select the layer changed; keep every engine's cookie scope and durability checks.

```sh
pnpm exec vitest run packages/browser-runtime-core/src/native-profiles.test.ts packages/browser-runtime-core/src/local-profile-store.test.ts packages/browser-runtime-core/src/native-profile-ready.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/playwright-launcher.test.ts apps/browser-runtime/src/browser/persistent-launch-cleanup.test.ts
pnpm exec vitest run apps/desktop/src/browser/electron-browser-launcher.test.ts apps/desktop/src/browser/session-cookie-mirror.test.ts apps/desktop/src/browser/browser-session-policy.test.ts
pnpm exec vitest run packages/client/src/host/pending-browser-tabs.test.ts packages/client/src/host/browser-presentation-wait.test.ts packages/client/src/host/workspace-tab-activations.test.ts
pnpm test:integration -- tests/browser-native-only-migration.integration.test.ts packages/database/src/operation-budget.integration.test.ts tests/browser-native-profiles.integration.test.ts tests/browser-profiles.integration.test.ts
```

- **Migration**: two fixed local bindings with native sentinels and cookie files present first.
  Owner, name, grants, history, tabs, binding and initialized facts survive; native bytes stay
  unchanged; pending deletion jobs keep archived stubs. New profiles stay empty and unbound until
  signed attach. Missing established data fails; never-created data may publish empty files
  atomically before any Session owns it.
- **Opening**: durable same-key replay, payload conflict, restart interruption, late success after
  terminal failure. The Host's 20-second budget covers locks, placement and relay; the client's 25
  seconds cover native mount, paint and frames. Retry reuses the same page, errors stay visible on
  it, and a hung persistent launch reaps its exact child before rejecting.
- **Lifecycle**: warm reuse, idle eviction, independent profiles, complete and interrupted
  inventories, immutable binding conflicts, tombstone reconciliation, and deletion with an offline
  owner and a Session held until exit; visible pending states precede erasure acknowledgement.
- **Recovery**: a failed or timed-out mirror save keeps pages and the gate open and retries; a
  retired owner and a failed or slow engine close reopen on the next open without a restart; a
  failed saved-tab restore is not re-sent until Retry or a new opening.

## Real Electron qualification

Only in a disposable VM, on request or after merge, from the integrated committed revision; unlock
only the golden's fixture keychain.

```sh
pnpm test:vm -- pnpm test:electron-profile-restore
pnpm test:vm -- pnpm test:electron-cookies
```

Qualify orderly quit, update-style restart and SIGKILL reopen with persistent, session and HttpOnly
cookies, duplicate CHIPS identities, localStorage, IndexedDB, service workers and CacheStorage,
crashing after controlled cookie writes. Session-cookie restore must restore no unauthorized tabs.
After killing the smoke's captured Network Service PID, check gate refusal and view closure,
explicit reopen, the first request, surviving workers, and that interrupted capture cannot shrink
the encrypted mirror. Missing or corrupt mirrors refuse opening without clearing data. Never admit a
Session with an unacknowledged cookie mutation.

Earlier browser releases are rejected by design: check the update refusal, and add no Vault,
preparation, snapshot or Guest-save adapters. For model-facing browser changes, use the
[run-agent-evals skill](../../run-agent-evals/SKILL.md).
