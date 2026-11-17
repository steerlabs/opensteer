# CI maintenance

```sh
pnpm check:changed --base origin/main --dry-run
gh run download <run> -R steerlabs/opensteer -D <dir> -p 'tests-*' -p 'integration-*'
pnpm exec tsx scripts/ci-durations.ts <dir>
pnpm exec tsx scripts/ci-timeouts.ts
pnpm exec tsx scripts/ci-native-inputs.ts
```

- `--dry-run` prints the selection without running it.
- Main pushes use per-SHA concurrency groups; only PRs cancel older runs. Keep scheduled and
  manual groups separate so a full run cannot displace release preflight's exact-SHA push Check.
- Lint still runs on an unchanged scheduled main to enforce quarantine expiry and the published
  Stable team API floor. The latter reads `desktop-v*` tags; fetch tags before running
  `node .github/scripts/ci-stable-api.mjs` locally.
- Regenerate shard weights from one green run's downloaded artifacts with `ci-durations.ts`.
- `ci-timeouts.ts` records each job's p95 over its last 30 successful runs in
  `ci-job-durations.json`; `ci-timeouts.test.mjs` fails when a `timeout-minutes` is under twice
  that. Refresh it after changing shards or job contents, and give a new job an estimate with
  `runs: 0` until it has history.
- After changing what a native-mac task reads (its `extra` list in
  [ci-native-mac.json](../../../../.github/scripts/ci-native-mac.json) or its imports), regenerate
  with `ci-native-inputs.ts`; `tests/ci-native-inputs.test.ts` fails when stale.
- The lint baseline is maintained through its
  [README](../../../../tooling/oxlint-plugin-opensteer/README.md). Fetch origin before `pnpm lint`.
