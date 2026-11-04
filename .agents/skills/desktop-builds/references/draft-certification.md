# Draft certification

Optionally installs a draft's actual ZIP in disposable VMs; it never rebuilds N, publishes or
pushes. Its N+1 build signs and notarizes with Tim's local Developer ID signing file and notary
profile, and reads the local-install configuration (`~/.config/opensteer/install-mac-local.json`,
or `--config`; schema `localInstallConfigSchema` in
[install-mac-local.ts](../../../../scripts/install-mac-local.ts)), which carries the Agent Phone
release signing and the Passwords provisioning profile. Run it only when Tim has prepared all of
them and asks. From a clean public-main checkout with full history, Node, pnpm, Go, Tart, the
subject's pinned Xcode and a `gh` login that can read the draft:

```sh
export OPENSTEER_UPDATE_JOURNEY_DIR=/absolute/physical/journey-work
pnpm exec tsx scripts/public-download/eu-run.ts \
  --draft v1.2.3-insider --expect-version 1.2.3 --expect-sha FULL_40_HEX_SOURCE_SHA \
  --older v1.2.2-insider
```

- The draft's channel selects its full journey set; partial selections certify nothing. Each passing
  case must report the SHA-256 of the N ZIP it extracted, matching the draft.
- `--older` is a release tag of the channel below N, or an absolute local build directory
  `build-next.ts` wrote.
- N+1 comes from `build-next.ts` on a throwaway local commit; never push or merge that branch. A
  missing toolchain or noninteractive signing failure stops the run.
- `OPENSTEER_UPDATE_JOURNEY_WORKERS=1` runs the guests sequentially. The runner deletes its clones
  on failure too.

On PASS, `$OPENSTEER_UPDATE_JOURNEY_DIR/e2e/<run>/journey.json` records `certifiedZipSha256` and
stdout prints `certified_zip_sha256=<hash>` and the `gh workflow run release.yml` command for the
operator; failure prints neither. The release workflow does not read this result: stable publication
binds to the `promote` job's verified insider ZIP hash.
