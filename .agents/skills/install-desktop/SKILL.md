---
name: install-desktop
description: Build and install a signed local Beta or keyless desktop proof when local package feedback is needed.
---

# Install desktop

Read [signing constraints](../../../apps/desktop/SIGNING.md). Use the root
Node/pnpm versions, Go, Xcode tools and the Android/JDK prerequisites in
`apps/agent-phone/README.md`. Never read or operate on key material; the operator
supplies a prepared signing configuration outside the checkout.

For an authorized local installation, close other Beta copies and use a clean
checkout and explicit full source SHA:

```sh
pnpm desktop:install-local --source-sha FULL_40_CHARACTER_COMMIT_SHA --config /absolute/install-beta-mac-local.json
```

Use `localInstallConfigSchema` in `scripts/install-beta-mac-local.ts` for inputs.
Resume with the same SHA/configuration; receipt or artifact drift fails closed.
Inspect `<stateDirectory>/<SHA>` receipts, command log, app tree and journey result.
Diagnose Launch Services errors. This defers Apple notarization and proves no
public distribution readiness. Never run two copies against one Personal store;
installing an older app does not reverse migrations.

For keyless proof on an arm64 Mac:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build-release --unsigned --out /absolute/proof-inputs
```

Inspect `apps/desktop/release/contributor/mac-arm64/`. The ad-hoc app uses
development trust, version 0.0.0 and no updater metadata; it cannot be prepared
for distribution. Never set `OPENSTEER_DESKTOP_UPDATE_*` for this proof.
Do not launch GUI/Electron verification on the host; use the disposable VM.
