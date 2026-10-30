# Repository scripts

Test selection and landing requirements live in [Testing](../docs/testing.md).
Read script sources for arguments and output formats.

## Integration databases

[test-integration.ts](test-integration.ts) owns disposable PostgreSQL and build
preparation; [run-record.ts](run-record.ts) owns diagnostic evidence.
See [testing rules](../docs/testing.md#integration-databases) and
[containment coverage](../tests/file-poison.test.ts).

Templates contain migrated schema, not Deployment/Account identity. Fixtures
must own their clones and producers, including failed startup. Native/recovery
bundle manifests bind source and built bytes; bypassing them can test stale code.
A pnpm lifecycle hook would build before the launcher's checkout-output hold;
keep preparation under the launcher. See `test-integration.ts` and
`../packages/database/src/store.integration.test-support.ts`.

`test:migration-compat` needs an explicit released SHA that is a strict ancestor
of HEAD; tags and deployed state cannot choose the baseline. Its previous-store
read/write check complements wire compatibility, which cannot prove old stores
survive schema upgrades. Negative migration controls are opt-in. See
[test-migration-compat.ts](test-migration-compat.ts).

### Lock-order modes

`OPENSTEER_LOCK_ORDER_MODE=enforce` fails violations; `record` is diagnostic
only and `off` disables instrumentation. CI checks the merged shard graph. See
[lockOrderMode.ts](../packages/shared/src/lockOrderMode.ts).

## Same-SHA reruns

[integration-rerun.ts](integration-rerun.ts) reruns failed files from a complete
unfiltered integration attempt at the same input contract. It always exits 1:
run records are diagnostics, never merge or release qualification receipts.
