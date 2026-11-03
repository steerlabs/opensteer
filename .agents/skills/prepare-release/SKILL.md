---
name: prepare-release
description: Dispatch a desktop practice release or stable promotion and inspect exact-source release evidence when requested.
---

# Prepare a desktop release

Read [release constraints](../../../docs/releases.md), especially Tim's credential
ownership and stable publication approval. Never operate on signing keys or
change GitHub environment settings. Dispatch only the release operation requested.

Practice from the default branch (GitHub requires the workflow there):

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=insider -f publish=false
gh run list --repo steerlabs/opensteer --workflow release.yml --limit 5
gh run view RUN_ID --repo steerlabs/opensteer
```

For a run that built artifacts:

```sh
gh run download RUN_ID --repo steerlabs/opensteer --dir /absolute/release-evidence
```

If discovery reused a draft, the build job was skipped and this run has no new
build artifact. Download the matching draft's assets instead:

```sh
gh release download vX.Y.Z-insider --repo steerlabs/opensteer --dir /absolute/release-evidence
```

For stable drafts use `desktop-vX.Y.Z`. Verify the assets against that draft's
release.json and the resolved source; do not substitute unrelated run artifacts.

Record the resolved source SHA, exact main CI run and Check result, commands,
artifact digests, SHA256SUMS and release.json. Inspect the complete draft. Do not
claim a skipped or unrun journey passed. Real desktop journeys run in a VM after
merge or on maintainer request; there is no local release requalification.

Publishing requires the release build's automatic launch check and verified draft
assets. VM update journeys are optional on-demand checks. If authorized to publish
the insider, repeat dispatch with `-f publish=true`. Never backfill an older
insider after a newer one.

For requested stable promotion, choose an already published insider. Run full CI
on main and confirm Check before dispatch (or use the scheduled full run):

```sh
gh workflow run ci.yml --repo steerlabs/opensteer --ref main
gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=stable -f insider_tag=vX.Y.Z-insider
```

Verify the Stable ZIP hash equals the selected insider ZIP hash and inspect its
preserved launch-check evidence. Promotion copies the ZIP and blockmap without
rebuilding; it uses no signing credentials. The source must be newer than published
Stable. Fresh installs default to Stable; Beta is selected in app Settings. Both
channels use the Account at accounts.opensteer.com. Inspect the promoted draft, then repeat the stable dispatch
with `-f publish=true` and leave publication to Tim's
`publish` environment approval. Use `gh run view RUN_ID --log-failed` for failures; never
bypass source, signature, notarization, receipt or asset verification.

For an authorized manual packaging operation, prepare the insider with new absolute
output directories. Stable uses `promote`, never a separate build:

```sh
pnpm desktop:public-release prepare --channel beta --app-zip /absolute/app.zip --version X.Y.Z --source-sha FULL_40_CHARACTER_SHA --out /absolute/new-insider --launch-check-passed
pnpm desktop:public-release promote --repo steerlabs/opensteer --tag vX.Y.Z-insider --version X.Y.Z --source-sha FULL_40_CHARACTER_SHA --out /absolute/new-stable
```

Only set `--launch-check-passed` after the ordinary launch checker passed for those
exact ZIP bytes. Use the workflow for publication: it carries the independently
verified insider ZIP hash into `--certified-zip-sha256` after Tim's approval.
Do not publish unless requested.
