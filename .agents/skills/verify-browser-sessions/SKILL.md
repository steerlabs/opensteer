---
name: verify-browser-sessions
description: Use when verifying browser-session CDP boundaries, editing, navigation, cursors or download changes.
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
