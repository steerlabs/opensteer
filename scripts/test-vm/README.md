# GUI test VMs

[test-vm.ts](../test-vm.ts) owns payloads and guest lifecycle;
[Testing](../../docs/testing.md#gui-test-vms) explains when to use a VM.

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh            # all journeys
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh saved-password
# Verify another committed revision without changing your checkout:
pnpm test:vm -- --mobile --revision <commit> bash scripts/test-macos-journeys.sh windows
```

`bash scripts/test-macos-journeys.sh` runs the journey set. After a typing or input change,
set `OPENSTEER_CHROME_R0_REPEAT=5` to repeat the live person-keys check five times; host
`PersonKeyOrderTests` remain the deterministic guard. The journey script lists what each case proves.

Commands execute in the guest's `apps/desktop`, matching the desktop scripts.
Arguments retain their boundaries; use `bash -c '...'` explicitly for shell
syntax. The command requires a clean checkout (including untracked files), Apple
silicon macOS, Tart, and the repository's Node/pnpm and Go tools.
A private HEAD checkout builds Electron, smoke bundles, Host, Runner, channel
runtime and web into a checksummed payload at `~/.cache/opensteer/vm/<sha>`.
Reruns verify the checksum and skip building; interrupted builds publish nothing.
Remove the SHA directory to rebuild.

VM admission and every VM payload build reclaim owned outputs before checking
space. Retention takes one
exclusive kernel storage lock; payload builds hold the same lock shared, so
cleanup cannot overlap a build. Entry locks and unfinished job records also
protect payloads being reused by a guest.

- Keep the four most recently used 40-hex SHA payloads by `last-used` (older
  entries fall back to `payload.json`'s build time). Configure the count with
  `OPENSTEER_VM_PAYLOAD_KEEP`. Always keep main's payload and payloads from the
  last two release versions, held entry locks and unfinished jobs. Never remove
  lock files, `native-resources`, or other non-SHA entries. Unknown identity,
  age or ownership keeps the affected candidates.
- `release-*` directories come from the retired local release pipeline (releases
  now build on GitHub Actions). Keep only the installed Beta's version.
  Installed version comes only from `/Applications/Opensteer Beta.app`'s
  `Contents/Info.plist`; the app is never altered. In other identified release
  directories, remove only regular artifacts at least 1 MiB: known archive or
  binary formats and large files in the recorded build-output directories
  (`mac`, `mac-state`, `phone`, `agent-phone`, `infra`, and generated subtrees
  inside `source`, such as `node_modules` or `dist`). Source files stay. Small records
  (`*.json`, `*.md`, `*.txt` under 1 MiB), logs and unknown files stay. Crash
  symbols stay at any size or age: R8 `mapping.txt`/`mapping.prt`, `seeds.txt`,
  `usage.txt` and other mapping-output text records; complete `.dSYM` bundles,
  source maps and native symbol sidecars. Bulk APK/zip outputs remain eligible.
  Records that pipeline left under `check-evidence` and `merge-queue` no longer
  keep anything. An old release with a held coordinator lock stays; retention
  holds those locks while pruning.
- A proven-finished, unreferenced run may go after 24 hours once its clone is
  gone. References under the state tree still protect runs; retention's own
  receipts do not create references. Unknown job records, live processes,
  running VMs and goldens stay. Finished, stopped job clones retain the existing
  Tart/process checks.

Keep escaping or unreadable candidates; paths must stay in canonical owned roots.
Each invocation writes `~/.local/state/opensteer/storage-retention/` JSON receipts
with candidate/removal paths, allocated bytes, free space before/after and errors.
Logs distinguish allocated bytes from observed space freed: APFS sharing and
other jobs can make them differ.
Below 80 GiB free, retention warns with the largest remaining consumers; it
never broadens its deletion rules to meet that target.

Preview the same policy without deleting anything (this command writes its
dry-run receipt):

```sh
pnpm exec tsx scripts/storage-retention.ts --dry-run
```

The command-transports-only retention contract can run independently with
`pnpm exec tsx scripts/test-vm/contract-journey.ts retention`; it starts no VM.

The existing resource builder needs validated native smoke resources containing
`personal-runtime/release.json` and `process-supervisor/`. Set
`OPENSTEER_VM_NATIVE_RESOURCES=/absolute/resources`, or place them at
`~/.cache/opensteer/vm/native-resources`. These are the reviewed native release
inputs, not an installed application. The builder verifies their release hashes
and always rebuilds application services and web from the requested SHA. When
native runtime inputs change, replace the seed and remove the affected SHA cache.
No per-SHA payload preparation is required.

Each invocation prints `~/.local/state/opensteer/vm-runs/<run-id>` for artifacts.
`job.json` records SHA, command, launching checkout and HEAD, runner pid, cache
hit, phase timings, exit code, minimum disk space and clone cleanup result.
Phase logs retain build/boot/staging/suite/export failures. Native evidence lives
under `guest/native/<suite-run>/`, including selected case results, traces,
owned-window PNGs, recordings and process cleanup. Quit evidence lives under
`guest/quit/`. Confirm the selected cases actually passed; a skipped case or a
successful export is not a pass. Duplicate application/resource copies are
omitted from exports; the cached payload retains those inputs.

Jobs use fresh APFS clones of the stopped `opensteer-gui-golden`, each with six
vCPUs and 16 GiB RAM. Every boot disables graphics, audio and clipboard sharing.
Read-only shares stage source/dependencies/resources onto guest APFS; only the
job's artifact share is writable. The runner never boots the golden. It exports
evidence and stops/deletes its clone after success, failure, timeout or catchable
interruption. SIGKILL, power loss and host crashes cannot execute cleanup; the next
job's retention deletes the clone once its runner is gone. To retry sooner, inspect
`job.json`, then stop/delete only that job's recorded Tart name.

Apple's macOS licence limits this setup to two concurrent macOS guests;
`OPENSTEER_VM_SLOTS=1` runs one at a time on a machine with less room. Slot
kernel locks cover each job from its clone through teardown, with a separate
admission lock serializing the running-guest check and boot. A job takes its
slot only once its payload is ready, so waiting for the payload lock or storage
holds no guest. job.json records the time before the suite in phases, waits
included (`storage-admission`, `payload-lock-wait`, `storage-wait`,
`slot-wait`). The locks live at
`~/.local/state/opensteer/vm/locks/slot-0`, `slot-1` and `admission`. The TypeScript
runner opens them with Darwin `O_EXLOCK | O_NONBLOCK`, which has `flock(2)`
semantics: the kernel releases the lock when its descriptor closes or the process
dies. This needs no native dependency or helper process. Never delete or replace
a lock file while a job runs. Stop old runners before switching lock locations.
A third job waits for a slot before cloning, in arrival order, and
nothing stops a running job. A waiting job prints the pid, command and checkout
holding each slot and of every job queued ahead of it. Other VM managers must
respect the same two-guest limit.

Admission requires 40 GiB free; work stops below a monitored 30 GiB floor, leaving
room to export and tear down. Initial builds also install dependencies and package
several gigabytes. Cached runs still pay clone/boot, payload staging and export
costs: the original golden measurements were roughly 7–14 seconds to SSH and
38–59 seconds to stage the original 3.18 GB uncompressed tar. New payloads
use `COPYFILE_DISABLE=1` to omit AppleDouble `._*` metadata entries. Mobile jobs
check their toolchain while staging, and every guest starts from a copy of the
host's shared Vitest results. `job.json` records current measurements. Staging can cost more than a short case; select related cases in
one invocation when useful.

## Recreating the golden

```sh
pnpm test:vm:golden
```

This command refuses an existing golden before changing it, uses the same slots
and disk guards, and clones the pinned Cirrus Tahoe base
`ghcr.io/cirruslabs/macos-tahoe-base@sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77`.
It copies the invoking Node binary, downloads the repository-pinned pnpm package,
installs guest Homebrew `ffmpeg` and `go`,
disables sleep/locking, authorizes the local SSH key, then shuts down and cold
boots to verify Accessibility, ScreenCapture, actual PostEvent delivery and a
real desktop capture. Guest Homebrew versions follow its available formulae;
logs record them. Rebuilding this pinned base still requires those downloads.
Provisioning scripts live in `scripts/test-vm/`; the native permission probe comes
from the current repository helper. One key opens every golden, so a build
reuses the pair already at the key path after checking its halves match,
refuses half a pair, and generates a pair only when there is none. A failed
provisioning run deletes its new VM but keeps diagnostics and the key, which a
retry reuses.

The default key is `~/.local/state/opensteer/vm-golden/id_ed25519`; override it
with `OPENSTEER_VM_SSH_KEY` when adopting an already provisioned golden. Cirrus's
`admin/admin` default credentials stay enabled for this local, disposable image.
Keep it local: do not publish the VM, keys or a remote login endpoint. The base
supplies disabled guest SIP, SSH TCC grants and working auto-login; cold-boot
verification fails if actual permissions or input delivery stop working.

## Mobile simulator golden

The mobile path uses the same slots, admission lock, disk guards, private clones,
SSH key, source payload, artifact export and teardown as GUI jobs. It never changes
`opensteer-gui-golden`. Bootstrap requires that golden stopped and its existing
SSH key. No new key is generated. Keep the source checkout clean.

Prepare a real, non-symlink input directory outside the checkout containing only
trusted licensed inputs: `xcode.tar` rooted at `Xcode.app/`, a `runtime.tar` rooted at `runtime.exportedBundle/` containing the complete
exported arm64 runtime, and `manifest.json`. Input files must be regular non-symlink files.
The manifest pins Xcode 27.1 build `27A9275` and final iOS 27.1 build `24A94425`:

```json
{
  "xcode": {
    "version": "27.1",
    "build": "27A9275",
    "bytes": 123,
    "sha256": "replace-with-64-hex-archive-sha256"
  },
  "runtime": {
    "version": "27.1",
    "build": "24A94425",
    "bytes": 123,
    "sha256": "replace-with-64-hex-runtime-sha256"
  }
}
```

Replace the example byte counts and digests with actual input measurements.
Create the archive with `COPYFILE_DISABLE=1 tar -cf /absolute/inputs/xcode.tar -C
/Applications Xcode.app`. Apple's supported runtime export command is:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -downloadPlatform iOS -buildVersion 27.1 -architectureVariant arm64 \
  -exportPath /absolute/runtime-export
```

Xcode 27.1 exports an `.exportedBundle` directory, including restore metadata;
its inner cryptex DMG alone is not the complete input. Verify
`ExportedMetadata.plist` names final build `24A94425` and architecture `arm64`.
Archive the entire export under the root `runtime.exportedBundle/` as
`/absolute/inputs/runtime.tar` (rename a task-owned copy of the export first).
Guest provisioning extracts it onto APFS, verifies its metadata, imports that
bundle and removes only the temporary extraction. Xcode's export command may
also register/install the downloaded runtime on the downloading Mac; it does not
boot a simulator. See [Apple's exported runtime format](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_4-release-notes).
A catalog download size is not
an installed-space estimate. Budget host storage for the inputs, installed Xcode,
imported runtime and clone writes while preserving the existing 40 GiB admission
and 30 GiB floor. Logical disk expansion does not create host free space.

```sh
pnpm test:vm -- --mobile-golden --tooling-inputs /absolute/inputs
pnpm test:vm -- --mobile --revision <commit> bash -c 'cd ../mobile; YOUR_COMMAND'
```

Bootstrap refuses an existing `opensteer-mobile-golden`, clones the stopped GUI
golden, expands only the new mobile clone to 100 GB, and grows its guest APFS
container. Inputs are shared read-only, checksummed on both sides, and Xcode is
extracted onto guest APFS. Guest archive checks use a private copy of the
host-validated manifest in the read-only provision share; changes to the original
input manifest cannot change the bytes certified by the run receipt. First-launch setup and runtime import happen inside
the guest. A cold boot must verify the exact toolchain/runtime and create, boot,
screenshot, shut down and delete one private simulator whose type is advertised
by both the pinned runtime and installed device catalog (preferring an iPad mini
when supported). The final 27.1 runtime currently advertises iPhone Duo only;
a global mini device type does not establish runtime compatibility. Only then is
the stopped golden retained and `~/.local/state/opensteer/vm-mobile-golden.json`
written. Failure or interruption deletes the owned clone; original golden and
SSH key remain intact. Inspect `job.json` and retained logs even after failure.

Mobile jobs require the readiness receipt and recheck guest toolchain/runtime
before staging source. They still start in `apps/desktop`; use explicit `bash -c`
to change directories. Bootstrap evidence (`mobile-provision.txt`, runtime/device
inventories, simulator PNG and cleanup log) is written directly to the run's
artifact share. Simulator proof is not app qualification. CocoaPods, Maestro and
app-specific build dependencies are separate inputs for subsequent journeys.

The executable transport contract journey runs without GUI or VM startup:

```sh
pnpm exec tsx scripts/test-vm/contract-journey.ts
pnpm exec tsx scripts/test-vm/guest-contract-journey.ts
```

It runs the actual CLI with disposable Tart/SSH/Git transports, exercises failure,
cancellation and floor cleanup, and writes `results.json` plus per-case logs under
the printed temporary artifact directory. These are lifecycle contract checks,
not native simulator certification; the cold guest proof supplies that evidence.
