# Certify a draft's actual Mac ZIP

The release gate installs the CI practice draft itself. It never rebuilds N,
rewrites its updater metadata or compares a locally rebuilt N with CI bytes.
Publishing binds this receipt to the draft in the release workflow; this harness
only reads drafts and records their exact assets.

From a clean public-main checkout with full history, Node/pnpm, Go, Tart and the
local signing prerequisites:

```sh
export OPENSTEER_UPDATE_JOURNEY_DIR=/absolute/physical/journey-work
pnpm exec tsx scripts/public-download/eu-run.ts \
  --draft v1.2.3-insider --expect-version 1.2.3 --expect-sha FULL_40_HEX_SOURCE_SHA
```

The authenticated `gh` CLI must be able to read the draft. Intake checks draft
status before and after download, the operator's version/source expectations,
the release tool's manifest/channel/tag and exact asset set, every manifest hash
and the complete `SHA256SUMS`. Downloaded assets stay under a fresh input directory.
An insider draft runs Beta menu/refusals and ordinary quit only. A stable draft
runs stable menu/refusals, tray restart and ordinary quit. Partial selections do
not certify a release. Each passing case must report the SHA-256 of the N ZIP it
actually extracted into the guest, matching the draft's recorded ZIP hash.

N+1 uses one local path, `build-next.ts`: a throwaway root-version-only commit
on the draft source, stamped by the workflow's release-version helper and built
through `desktop:build-release`. It uses the existing local Agent Phone signing
configuration/receipt stages and a signing **file** accepted by
`apps/desktop/scripts/signing-input.cjs`, with the local Developer ID and its
`notarizationProfile`. `package:mac` owns signing, notarization and stapling.
Configure these with the [local build skill](../../.agents/skills/install-desktop/SKILL.md).
The subject's pinned Xcode/SDK must be available; an unavailable toolchain or
noninteractive signing failure stops the run. No keychains are created and no
key material is exported. This task does not provision Xcode or bypass its pin.
The scratch branch is local only and must never be pushed or merged.

On PASS, `journey.json` records `certifiedZipSha256`, the downloaded channel ZIP’s
hash verified against the draft manifest. The final stdout lines print
`certified_zip_sha256=<hash>` and the exact `gh workflow run release.yml` command
for the operator, including `publish=true` and that hash. Failure prints neither.
The harness never executes publication.

The existing signed 0.1.219 build of the draft channel is the downgrade payload.
Its archive checksum must still match its recorded build. It is never launched;
its former feed configuration has no role in the journey. The wrong-signer
payload is an ad-hoc copy. Both native refusals must follow completed ZIP delivery
and carry the matching classified reason (`signature` or `downgrade`). N remains
healthy with its marker intact, followed by one genuine N→N+1 recovery.

All app builds carry the public GitHub provider with no token or host override.
Inside each disposable guest, a guest-trusted CA covers github.com,
api.github.com and both GitHub asset CDN hosts, mapped to loopback. The mirror
requires `Accept: application/json` for public Latest, serves Atom with legacy
and opposite-channel decoys, and redirects downloads cross-origin with range
support. API-host attempts fail the case. Requests must use the mirror's actual
loopback socket addresses and include the expected feed, channel metadata and
completed ZIP transfers.

PF is installed before the first app launch and held through update, relaunch,
idle and capture shutdown. It blocks all non-loopback IPv4/IPv6 traffic, including
UDP, encrypted DNS and external proxies. The sole off-loopback exception is the
existing SSH connection’s exact address/port four-tuple. Proxy settings
and proxy environment must be absent. An external-address negative control must
increment the PF deny counter; PF must remain enabled with identical rules until
measurement finishes. The guest restores its disabled PF configuration afterward.
No host firewall or trust settings are touched.

DNS/HTTP Host/TLS SNI capture and the Account sinkhole have positive controls;
both capture interfaces must report zero dropped packets. Stable forbids any
Account-host attempt, including failed ones. Beta records Account attempts as
informational, without signing in or enabling Connect. PF containment covers all
guest processes and protocols; capture supplies named-host and mirror evidence.

Artifacts live under `$OPENSTEER_UPDATE_JOURNEY_DIR/e2e/<run>/journey.json` and
the VM run directories: draft provenance/hashes, installed hash per case, identity
and signature checks, native updater/ShipIt logs, ordered supervised child exits
before bundle swap, marker/health/About checks, PF rules/counters, network
captures and window screenshots. The runner uses the existing two-guest queue
(`OPENSTEER_UPDATE_JOURNEY_WORKERS=1` selects sequential execution). It stops its
processes and deletes its clones on failure too. No command pushes or publishes.
