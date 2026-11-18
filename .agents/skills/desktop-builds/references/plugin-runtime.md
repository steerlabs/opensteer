# Plugin runtime qualification

The personal runtime ships the engine entry, trusted prebuilt bridge, JavaScript TypeScript compiler,
`ws`, sandbox native package and the runtime wrapper's worker resources in the layout selected by
[sandbox staging](../../../../scripts/plugin-engine/stage-runtime.ts). Keep these together; a Node
entry that imports successfully does not establish that workerd can find its resources. Containers
use the same stager. Qualify each native OS/architecture; Windows arm64 is currently unsupported.
Windows x64 also needs the reviewed PostgreSQL input's VC runtime DLLs.

On macOS, workerd needs its own hardened-runtime signature with the JIT-only entitlement profile
in `apps/desktop/build/entitlements.mac.workerd.plist`. Do not use Node's entitlement profile or
add broad executable-memory/library exceptions. Preserve executable modes and verify the final
nested binary after packing/signing. Full Developer ID signing, notarization, stapling and target
execution remain release checks; only Tim operates signing configuration.

The app currently allows macOS 13.0 but the pinned arm64 sandbox declares 13.5. Read the actual
binary's load commands (`otool -l <binary>`, `LC_BUILD_VERSION/minos`) when upgrading it. Tim must
choose the support policy before release; never incidentally raise the app minimum.

## Measure cost

Use a private throwaway PostgreSQL cluster, never installed Personal data:

```sh
OPENSTEER_TEST_DATABASE_URL=<private-postgres-url> pnpm measure:plugin-engine
```

For just disk and a compressed-payload estimate, `pnpm measure:plugin-engine -- --payload-only` needs no database. It stages the selected external runtime files in a temporary folder, prints unpacked bytes and a gzip estimate, and removes that folder. These exclude the Host/engine bundles and bridge; gzip size is not an updater ZIP measurement.

The full command also builds the Host and measures first use, one and ten built/called plugins, restart with
retained builds, and engine/sandbox resident memory and macOS footprint. It closes its engine,
sandbox and registry and removes its temporary data. The sampling driver is not a full running
Host; measure a disposable complete Host separately for a whole-app budget, and capture cold-build
peak memory separately from the post-build samples. Record OS/architecture, exact source and
whether package/OS caches were warm when comparing runs.

For disk and download contribution, stage the runtime with the same release builder and compare
its manifest/file sizes and the actual Electron Builder ZIP against a build without the subsystem,
holding the rest of the app constant. `stage-runtime.ts <temporary-node-modules-directory>` also
prints the selected external payload's bytes; it excludes the Host/engine bundles and bridge.
Compare final archives for a release download budget, rather than summing npm tarballs. Expect an
order of hundreds of MiB unpacked and tens of MiB compressed; resident engine/sandbox samples are roughly 0.6 GiB idle and around 1 GiB after a hermetic one-plugin build/call, excluding the complete Host and build peaks; the current packaging
estimate is roughly 166 MiB unpacked and 42 MiB isolated ZIP contribution. The selected external files measured about 133 MiB unpacked and 35 MiB gzip on macOS arm64. These are not full signed
app/DMG measurements, and earlier memory samples before worker reductions are not current results.

## Consistent backup

Stop the disposable/personal Deployment through its owner-supported shutdown so the Host, engine,
sandbox and PostgreSQL writers are quiet. Take PostgreSQL (including `plugin_engine`), the entire
Host `plugins` directory (repositories, builds and plugin SQLite files with any journal sidecars),
and the Host credential key as one protected backup. Restore that set together with writers still
stopped, verify permissions, then start a compatible release and check account links and retained
plugin data before admitting work. Restoring only PostgreSQL or rolling code back is not a plugin
data restore. The automatic pre-migration PostgreSQL snapshot alone is not this complete backup.
