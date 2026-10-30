---
name: run-gui-journeys
description: Run or diagnose macOS GUI journeys inside disposable Tart VMs without touching the host screen.
---

Read `scripts/test-vm/README.md` for ownership, storage and golden constraints.
Use a clean committed checkout, Apple silicon macOS, Tart and repository-pinned
Node/pnpm plus Go. Commands start in the guest's `apps/desktop`:

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh saved-password
pnpm test:vm -- --mobile --revision <commit> bash scripts/test-macos-journeys.sh windows
```

Select related native flows in one invocation. Use `bash -c '...'` for shell
syntax. For typing changes, set the repetition count inside the guest:

```sh
pnpm test:vm -- --mobile env OPENSTEER_CHROME_R0_REPEAT=5 bash scripts/test-macos-journeys.sh
```

Retain host PersonKeyOrderTests as the deterministic guard. Do not run GUI checks on the host.

Supply validated native smoke resources via `OPENSTEER_VM_NATIVE_RESOURCES` or
`~/.cache/opensteer/vm/native-resources`. After changing native seed inputs,
remove only the affected SHA payload cache under `~/.cache/opensteer/vm/<sha>`
when no run owns it. A retry verifies cached payload checksums.

Inspect the printed `~/.local/state/opensteer/vm-runs/<run-id>` record, phase logs
and guest artifacts. Confirm selected cases passed and clone cleanup completed;
a successful export is insufficient. After an uncatchable crash, inspect job.json
and stop/delete only its recorded Tart clone. Never delete live lock files.
Preview retention with `pnpm exec tsx scripts/storage-retention.ts --dry-run`.

For credential-free persistent guests only, from `apps/desktop`, use a fresh run
ID (`yyyymmddThhmmssZ-xxxxxxxx`, lowercase hex suffix), full HEAD SHA and explicit
output directory. Run each command separately and always run postflight:

```sh
bash scripts/test-macos-journeys.sh --preflight --run-id "$id" --out "$out"
bash scripts/test-macos-journeys.sh --run-id "$id" --sha "$sha" --out "$out" windows
bash scripts/test-macos-journeys.sh --postflight --run-id "$id" --out "$out"
```

Treat nonzero preflight/postflight as uncertified state; quarantine/reset the
guest rather than broadening cleanup. For GUI golden bootstrap use
`pnpm test:vm:golden`; inspect retained provisioning logs after failures. Do not
replace an existing golden to force a retry. Mobile golden setup belongs to the
mobile owner; use its licensed inputs and provisioning source.

For transport/lifecycle changes, run these credential-free contracts (no VM):

```sh
pnpm exec tsx scripts/test-vm/contract-journey.ts
pnpm exec tsx scripts/test-vm/guest-contract-journey.ts
```
