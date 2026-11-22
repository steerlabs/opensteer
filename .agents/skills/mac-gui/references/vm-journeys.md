# VM journeys

Use a clean committed checkout on Apple silicon with Tart, the repo's Node and pnpm, and Go. Guest
commands start in `apps/desktop`; wrap shell syntax in `bash -c '...'`.

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh
pnpm test:vm -- --mobile --revision <commit> bash scripts/test-macos-journeys.sh windows saved-password
pnpm test:vm -- --mobile env OPENSTEER_CHROME_R0_REPEAT=5 bash scripts/test-macos-journeys.sh
```

Journey names are in [journey-command.sh](../../../../apps/desktop/scripts/journey-command.sh); with
none named, all defaults run (`mac-owner` and `first-run` only when named). Cached jobs still pay
boot, staging and export, so select related flows in one invocation. Set
`OPENSTEER_CHROME_R0_REPEAT=5` after a typing or input change; host `PersonKeyOrderTests` stay the
deterministic guard.
`OPENSTEER_VM_DISPLAY=1600x1100pt` gives the guest a 2x display on a Retina host; `native-browser`
then runs at 2x, which is the density its capture steps need to show a page shrinking.
`--inputs /absolute/directory`, before `--revision`, adds a read-only share at
`/Volumes/My Shared Files/inputs`; it must be a real path without symlinks or `:`, and files are
copied to guest APFS before modification.

**First run.** `pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh first-run` drives the
Mac app's first run against the real account service code on a PostgreSQL of its own: Sign in
(the account's App Review form, a test account in that database), "Where should your Opensteer
live?", On this Mac, setup, "Connect your phone". It runs twice, `settled` (setup moves on once
the Home is ready) and `racing` (each step at once, so the turn-on meets the Home still being set
up). Only the tunnel provider (`MemoryConnectProvider`), the browser and macOS's `open-url`
hand-off stand in ([journey.ts](../../../../tests/first-run/journey.ts)). A pass is the Home in
the account and the phone step's helper sentence, never "Couldn't add …" or "Another deployment
access operation is already running"; `first-run/<trial>/verdict.json` records the count of
`initialize-failed`. A real tunnel a phone outside can reach stays unverified.

**Fixture keychain.** Before every guest job's suite the runner puts a keychain of the job's own
in place ([fixture-keychain.sh](../../../../scripts/test-vm/fixture-keychain.sh)): a constant test
password, unlocked, no auto-lock, the user's default and first in the search list, so Electron's
protected storage can use it over SSH where the login keychain is locked; cleanup restores the
previous default and list and deletes it. The suite's own SSH connection unlocks it again first
(each connection is a security session of its own) and its log says whether it had to. Setting it
up was not enough on its own the first time it ran: Electron still refused. To see what the
suite's session can do, run the diagnostic as a job:
`pnpm test:vm -- bash ../../scripts/test-vm/keychain-diagnostic.sh`. Both refuse unless macOS
reports a hypervisor and the clone's `~/opensteer-job/guest-job` marker (written at staging) names
the job's VM, and neither touches the login keychain.
`pnpm exec tsx scripts/test-vm/guest-contract-journey.ts` holds them to that.

**Run records.** Inspect the printed `~/.local/state/opensteer/vm-runs/<run-id>` record, phase logs
and guest artifacts, and confirm the selected cases passed and the clone was deleted. After an
uncatchable crash, stop or delete only the Tart clone `job.json` records. Read retention receipts
before manual cleanup and preview with `pnpm exec tsx scripts/storage-retention.ts --dry-run`. Never
touch live lock files or change lock locations while old runners live.

**Native resources.** Supply validated release resources through `OPENSTEER_VM_NATIVE_RESOURCES` or
`~/.cache/opensteer/vm/native-resources`, never an installed app. After native seed inputs change,
replace the seed and remove only the affected `~/.cache/opensteer/vm/<sha>` payload cache when no
run owns it.

## Persistent guests

Credential-free persistent guests only. From `apps/desktop`, use a fresh run ID
(`yyyymmddThhmmssZ-xxxxxxxx`, lowercase hex), the full HEAD SHA and an explicit output directory;
run each command separately and always run postflight:

```sh
bash scripts/test-macos-journeys.sh --preflight --run-id "$id" --out "$out"
bash scripts/test-macos-journeys.sh --run-id "$id" --sha "$sha" --out "$out" windows
bash scripts/test-macos-journeys.sh --postflight --run-id "$id" --out "$out"
```

A nonzero preflight or postflight leaves the guest uncertified: quarantine or reset it rather than
broadening cleanup. [run-macos-journeys.ts](../../../../apps/desktop/scripts/run-macos-journeys.ts)
owns manifest fields and exit codes.

## Goldens and contracts

Bootstrap the GUI golden with `pnpm test:vm:golden` (mobile:
[mobile skill](../../mobile/references/vm-golden.md)). Provisioning refuses an existing golden;
never replace one to force a retry, keep the single SSH key pair across retries, and read the
retained provisioning logs after a failure. Only a cold boot with real input and capture proof
certifies it ([provision-guest.sh](../../../../scripts/test-vm/provision-guest.sh)).

For VM runner transport or lifecycle changes, run the credential-free contracts (no VM):

```sh
pnpm exec tsx scripts/test-vm/contract-journey.ts
pnpm exec tsx scripts/test-vm/guest-contract-journey.ts
```
