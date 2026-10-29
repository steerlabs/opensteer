# Builds and releases

Changes land through pull requests after the required `Check` succeeds. Every push
to main runs all public CI lanes. Release builders consume a green main commit
and supply their own signing, publication and deployment configuration.

## Release evidence

Use the CI run for the exact main SHA. There is no local release requalification.
Real desktop journeys run in a VM after merge or on maintainer request. Record the
commands, results and artifact digests for the build you distribute.

## Contributor desktop packages

Contributors can build a desktop package without a Developer ID identity or
notarization credentials. Follow the prerequisites, command and output locations
in [the desktop README](../apps/desktop/README.md). Contributor packages do not
claim signed distribution readiness.

## Signed local installation

For a signed local Beta installation, use the root Node/pnpm versions, Go, Xcode
command-line tools and the Android/JDK prerequisites in
[the Agent Phone README](../apps/agent-phone/README.md). Start from a clean
checkout and an explicit full commit SHA:

```sh
pnpm desktop:install-local --source-sha FULL_40_CHARACTER_COMMIT_SHA \
  --config /absolute/install-beta-mac-local.json
```

The default configuration is `~/.config/opensteer/install-beta-mac-local.json`.
The validated input contract is
[localInstallConfigSchema](../scripts/install-beta-mac-local.ts), which composes
[the Mac build/sign/install inputs](../scripts/release-beta-mac.ts) and
[the Agent Phone signing inputs](../scripts/release-agent-phone.ts).
Supply your own signing identity, provisioning profile, runtime binaries and
Android signing inputs.

The command creates a detached source snapshot outside the checkout, installs
frozen dependencies and builds the embedded runtime, web assets, helpers and
signed Agent Phone APK. It signs the Beta application with deferred notarization,
replaces the configured installation and uses its existing Personal data and
permission identity. Close other Beta copies before running it; never run two
copies against the same Personal data. Installing an older app does not undo
database migrations.

Evidence under `<stateDirectory>/<SHA>` includes `local-install.json`,
`mac-local.json`, `commands.jsonl`, `app-tree.json` and `journey.json`.
Resume with the same SHA and configuration. Receipt or artifact drift fails
closed. The command verifies code signatures and attempts a normal Launch
Services launch; it does not submit to Apple or claim notarized distribution
readiness. Diagnose any reported launch error before proceeding.
