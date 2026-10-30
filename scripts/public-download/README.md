# Signed desktop update journeys

These on-demand journeys exercise electron-updater's GitHub provider for stable
and Beta: app-menu restart, stable tray restart, ordinary quit, channel isolation,
signer and downgrade refusal, health and data preservation.
The mirror includes opposite-channel releases and a legacy stable decoy. Captures
retain DNS plus client-to-server TCP HTTP/TLS flights, including fragmented
ClientHello and SYN attempts, with positive controls through relaunch and idle.
Bulk ZIP response traffic is excluded. Each interface records captured/received/
dropped counts; missing counters or any drop fail the case. UDP/QUIC and encrypted
DNS are not certified.
Stable forbids Account traffic; Beta records it without signing in or enabling
Connect. Both check for named public GitHub/Opensteer update hosts in guest-wide captures.
This is not process-attributed destination enforcement: arbitrary external hosts
and Apple OCSP/notarization requests are not covered by that assertion. Mirror
request receipts and embedded provider configuration separately establish that
the exercised feed, metadata and ZIP requests reached the mirror. Captures must have zero dropped packets.

Everything that launches Electron, changes trust or drives UI runs in disposable
`pnpm test:vm` clones. Set `OPENSTEER_UPDATE_JOURNEY_WORKERS=1` to run sequentially; the receipt records
worker count, overall timestamps and each VM job’s phase timings.
The runner compiles the AX test driver once on the host (without executing it),
using the local module cache, then stages it through the read-only input share.
The guest checks both source and binary hashes before running it; GUI control
remains entirely inside the VM.
The runner uses the existing two-guest queue and deletes
owned clones after failures too. Nothing installs or launches an app on the host.
No command here publishes releases or pushes a branch.

## Prepare signed builds

Use a clean committed checkout. Set an absolute physical output directory outside
it, with no symlink components:

```sh
export OPENSTEER_UPDATE_JOURNEY_DIR=/absolute/journey-work
node scripts/release-version.cjs FULL_SOURCE_SHA
```

Certification is per source commit and channel. Choose two source commits whose
derived versions increase, and build each in both channels. Full Git history is
required. The build snapshot uses the workflow-owned `stampReleaseVersion`; its
root manifest edit is never committed. `--version X.Y.Z` optionally asserts the
expected derived version; it cannot invent a release version.

```sh
pnpm exec tsx scripts/public-download/build.ts --revision FULL_SHA --channel stable
pnpm exec tsx scripts/public-download/build.ts --revision FULL_SHA --channel beta
```

The build-only path reuses the repository's local-install configuration and Agent
Phone signing/receipt stages. It uses the local Developer ID keychain and the
`notarizationProfile` from `apps/desktop/scripts/signing-input.cjs` configuration
(`OPENSTEER_DESKTOP_SIGNING_FILE`). Team identity is carried as validated journey
metadata; no credentials enter guest metadata. Configure these as described in
[signed local installation](../../.agents/skills/install-desktop/SKILL.md),
or pass `--config /absolute/local-install.json`. Never export credentials or work
around a noninteractive signing failure.

Outputs stay under `$OPENSTEER_UPDATE_JOURNEY_DIR/builds/<sha>/<channel>/`.
After successful final verification, the builder verifies the ZIP checksum and
removes its source worktree, extracted app trees, compiled runtime and redundant
raw APK. ZIPs, receipts, manifests, provenance and verification logs remain.
Preparation runs the current release tool without depending on source snapshots.
Existing completed build directories can be pruned the same way:

```sh
pnpm exec tsx scripts/public-download/prune-builds.ts FULL_SHA [ANOTHER_FULL_SHA]
```

Each app carries the reserved `github.opensteer.test` provider override, is signed,
notarized, stapled and zipped with `ditto -c -k --sequesterRsrc --keepParent`.
Preparation extracts each final zip only to verify owner-write permissions, then
cleans the extraction. The real release tool verifies identity, signature, staple
and Gatekeeper; its verification output and archive hashes are retained:

```sh
pnpm exec tsx scripts/public-download/eu-prepare.ts FULL_N_SHA FULL_NEXT_SHA FULL_OLDER_FIXTURE_SHA
```

## Run and inspect

Use the input directory printed by preparation:

```sh
pnpm exec tsx scripts/public-download/eu-run.ts /absolute/prepared-inputs
```

An optional comma-separated selection follows it, such as
`stable:menu,beta:menu`. Menu cases include equal/channel isolation, wrong-signer
refusal and misleading-metadata downgrade refusal while N stays healthy, then
one genuine N→N+1 recovery. The downgrade fixture is an older, genuinely signed
bundle of the same channel, with its archive hash verified. Preparation requires
`older < N < N+1`; reuse an existing signed older build rather than resetting a
newer app or its Personal runtime backward.
The default set has five clones: both menu cases, stable tray, and both quit cases.
Each case uses a fresh clone and a short-lived guest-trusted CA. Archives are checksum-verified and extracted directly
into the guest's Applications directory without removing quarantine or disabling
assessment. These journeys qualify updates; installer and quarantined
browser-download acceptance are separate flows.

`$OPENSTEER_UPDATE_JOURNEY_DIR/e2e/<run-id>/journey.json` records all four archive
hashes and per-case results. Each case includes the VM receipt, timings,
codesign/stapler output, native refusal logs, ordered child-exit observer,
marker check, screenshots, traffic captures and ShipIt/updater logs. Missing
receipts and incomplete captures fail the run. The VM's original run directory
also retains its evidence.

The journey waits for the real restart menu but does not claim to distinguish a
finished download from native staging. The updater unit test owns the event-source
contract. Negative cases require a fully delivered fixture followed by a validated
`desktop.update.failed` event whose classified `reason` matches `signature` or
`downgrade`. Generic failures, `other`, missing reasons and earlier events fail.
These fixed classifications are the product contract for native Squirrel causes;
no raw URL-bearing native error text is required.

For a pre-merge rehearsal, append the complete selection and `--rehearsal`:

```sh
pnpm exec tsx scripts/public-download/eu-run.ts /absolute/prepared-inputs \
  stable:menu,beta:menu,stable:tray,stable:quit,beta:quit --rehearsal
```

The receipt is marked `rehearsal` and the CI bridge refuses it. Release gate
evidence must be rebuilt and rerun from the merged main source commit.

## Bridge to a CI archive

After downloading a draft asset separately, compare it to the locally certified
ZIP from the same source commit and channel:

```sh
pnpm exec tsx scripts/public-download/compare-release-bytes.ts \
  --ci /absolute/ci.zip --local /absolute/certified.zip --channel beta \
  --certification /absolute/journey.json --out /absolute/comparison.json
```

This gate never launches either app. It extracts temporarily, checks both apps'
strict signatures, notarized Gatekeeper acceptance and staples, and compares
source, versions, designated requirements, TeamIdentifiers, hardened runtime and
entitlements for the main app, nested apps and Mach-O executables (including universal helpers). Temporary
extractions are removed on success or failure. This is signing-policy parity,
not byte-for-byte equality: the host override, signatures and notarization differ.
No GitHub identities or CI receipts are fabricated. A comparison is valid only
with the referenced passing per-commit journey; legacy prepared fixtures reused
for harness regression testing do not certify a newer source commit.
