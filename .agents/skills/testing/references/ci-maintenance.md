# CI maintenance

```sh
pnpm check:changed --base origin/main --dry-run
gh run download <run> -R steerlabs/opensteer -D <dir> -p 'tests-*' -p 'integration-*'
pnpm exec tsx scripts/ci-durations.ts <dir>
pnpm exec tsx scripts/ci-timeouts.ts <run id>...
pnpm exec tsx scripts/ci-native-inputs.ts
```

- `--dry-run` prints the selection without running it.
- Regenerate shard weights from one green run's downloaded artifacts with `ci-durations.ts`.
- Re-measure job timeouts with `ci-timeouts.ts` after changing shards or job contents: 1.5 times the
  slowest run, at least 3 minutes. Failed runs count; cancelled or timed-out runs are lower bounds.
- After changing what a native-mac task reads (its `extra` list in
  [ci-native-mac.json](../../../../.github/scripts/ci-native-mac.json) or its imports), regenerate
  with `ci-native-inputs.ts`; `tests/ci-native-inputs.test.ts` fails when stale.
- The lint baseline is maintained through its
  [README](../../../../tooling/oxlint-plugin-opensteer/README.md). Fetch origin before `pnpm lint`.
