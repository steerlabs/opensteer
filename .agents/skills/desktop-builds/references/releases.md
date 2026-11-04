# Releases

Release builders consume a green main SHA; there is no local release requalification. Real desktop
journeys run in a VM after merge or on maintainer request.

## Practice insider

GitHub requires the workflow on the default branch:

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=insider -f publish=false
gh run list --repo steerlabs/opensteer --workflow release.yml --limit 5
gh run view RUN_ID --repo steerlabs/opensteer
gh run download RUN_ID --repo steerlabs/opensteer --dir /absolute/release-evidence
gh release download vX.Y.Z-insider --repo steerlabs/opensteer --dir /absolute/release-evidence
```

If discovery reused a draft, the build was skipped and the run has no new artifact: download the
draft (stable drafts are `desktop-vX.Y.Z`) and verify it against its `release.json` and resolved
source, never against unrelated run artifacts. Record the source SHA, the exact main CI run and its
`Check`, commands, artifact digests, `SHA256SUMS` and `release.json`, and inspect the whole draft.
Publishing needs the release build's launch check and verified assets; VM update journeys are
optional. If authorized, repeat the dispatch with `-f publish=true`; never publish an older insider
after a newer one. Debug failures with `gh run view RUN_ID --log-failed`.

## Stable promotion

Only on request. Pick a published insider newer than published Stable, and confirm a full main CI
run and `Check` (or the scheduled full run) first:

```sh
gh workflow run ci.yml --repo steerlabs/opensteer --ref main
gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=stable -f insider_tag=vX.Y.Z-insider
```

Check the Stable and immutable insider provenance name the same source SHA; inspect the rebuilt
Stable package's launch-check evidence and draft.
Repeat with `-f publish=true`; publication waits for Tim's `publish` approval.

## Manual packaging

Only for an authorized manual operation, into new absolute directories. Set `--launch-check-passed`
only after the launch checker passed for those exact ZIP bytes. Publish only through the workflow,
which verifies the immutable insider source provenance before Stable publication.

```sh
pnpm desktop:public-release prepare --channel beta --app-zip /absolute/app.zip --version X.Y.Z --source-sha FULL_40_CHARACTER_SHA --out /absolute/new-insider --launch-check-passed
pnpm desktop:public-release promote --repo steerlabs/opensteer --tag vX.Y.Z-insider --version X.Y.Z --source-sha FULL_40_CHARACTER_SHA --app-zip /absolute/rebuilt-stable.zip --launch-check-passed --out /absolute/new-stable
```

## Previous-release baseline

On each public release, move `previousPublicRelease` in
[previous-release-reader.test-support.ts](../../../../apps/host/src/agents/previous-release-reader.test-support.ts),
exercised by `previous-release-compat.integration.test.ts`; CI fetches that commit in shallow
checkouts.
