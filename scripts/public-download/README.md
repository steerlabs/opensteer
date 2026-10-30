# Signed desktop update journeys

These on-demand journeys exercise electron-updater's GitHub provider for stable
and Beta: app-menu restart, stable tray restart, ordinary quit, channel isolation,
native readiness, signer and downgrade refusal, health and data preservation.
The mirror includes opposite-channel releases and a legacy stable decoy. Captures
cover DNS, HTTP Host and TLS SNI with positive controls through relaunch and idle.
Stable forbids Account traffic; Beta records it without signing in or enabling
Connect. Both forbid public update hosts. Captures must have zero dropped packets.

Everything that launches Electron, changes trust or drives UI runs in disposable
`pnpm test:vm` clones. The runner uses the existing two-guest queue and deletes
owned clones after failures too. Nothing installs or launches an app on the host.
No command here publishes releases or pushes a branch.

## Prepare signed builds

Use a clean committed checkout. Set an absolute physical output directory outside
it, with no symlink components:

```sh
export OPENSTEER_UPDATE_JOURNEY_DIR=/absolute/journey-work
pnpm exec tsx scripts/public-download/pair.ts FULL_SOURCE_SHA X.Y.Z
```

The pair helper creates local commit objects differing only in the root version
and prints a scratch branch that must never be pushed or merged. For each printed
SHA, build both channels:

```sh
pnpm exec tsx scripts/public-download/build.ts --revision FULL_SHA --channel stable
pnpm exec tsx scripts/public-download/build.ts --revision FULL_SHA --channel beta
```

The build-only path reuses the repository's local-install configuration and Agent
Phone signing/receipt stages. It uses the local Developer ID keychain and the
`opensteer-notary` profile. Configure these as described in
[Signed local testing](../../docs/releases.md#signed-local-testing-on-this-mac),
or pass `--config /absolute/local-install.json`. Never export credentials or work
around a noninteractive signing failure.

Outputs stay under `$OPENSTEER_UPDATE_JOURNEY_DIR/builds/<sha>/<channel>/`.
Each app carries the reserved `github.opensteer.test` provider override, is signed,
notarized, stapled and zipped with `ditto -c -k --sequesterRsrc --keepParent`.
Preparation extracts each final zip and verifies owner-write permissions,
signature and staple, then invokes the real channel-specific release tool:

```sh
pnpm exec tsx scripts/public-download/eu-prepare.ts FULL_N_SHA FULL_NEXT_SHA
```

## Run and inspect

Use the input directory printed by preparation:

```sh
pnpm exec tsx scripts/public-download/eu-run.ts /absolute/prepared-inputs
```

An optional comma-separated selection follows it, such as
`stable:menu,beta:menu` or `stable:negative`. Each case uses a fresh clone and a
short-lived guest-trusted CA. Archives are checksum-verified and extracted directly
into the guest's Applications directory without removing quarantine or disabling
assessment. These journeys qualify updates; installer and quarantined
browser-download acceptance are separate flows.

`$OPENSTEER_UPDATE_JOURNEY_DIR/e2e/<run-id>/journey.json` records all four archive
hashes and per-case results. Each case includes the VM receipt, timings,
codesign/stapler output, native-readiness observations, child-exit observer,
marker check, screenshots, traffic captures and ShipIt/updater logs. Missing
receipts and incomplete captures fail the run. The VM's original run directory
also retains its evidence.
