# Local builds

Use the root Node and pnpm, Go, the Xcode tools, and for Agent Phone the Android SDK and JDK
([agent-phone build](../../agent-phone/references/build.md)).

**Keyless proof.** The contributor package and its inputs are in the
[desktop README](../../../../apps/desktop/README.md). On an arm64 Mac, this fetches pinned public
Node, PostgreSQL source and cloudflared, builds PostgreSQL and the Agent Phone debug APK, and runs
the contributor packager:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build-release --unsigned --out /absolute/proof-inputs
```

Inspect `apps/desktop/release/contributor/mac-arm64/`. The ad-hoc app has development trust, version
0.0.0 and no updater metadata, and cannot be prepared for distribution. Never set
`OPENSTEER_DESKTOP_UPDATE_*` for it.

**Signed local install**, only when Tim authorizes it and supplies the configuration. Close other
Opensteer copies, since two copies must never share one Personal store; use a clean checkout and a
full source SHA:

```sh
pnpm desktop:install-local --source-sha FULL_40_CHARACTER_COMMIT_SHA --config /absolute/install-mac-local.json
```

The configuration follows `localInstallConfigSchema` in
[install-mac-local.ts](../../../../scripts/install-mac-local.ts) (default
`~/.config/opensteer/install-mac-local.json`). Resume with the same SHA and configuration; receipt
or artifact drift fails closed. Inspect receipts, command log, app tree and journey result under
`<stateDirectory>/<SHA>`, and diagnose Launch Services errors. It defers notarization and proves no
distribution readiness. An older app does not reverse migrations.

**Native helpers.** A packaged app refuses unsigned helpers, so work on computer use and Passwords
with `pnpm dev`, which trusts the helpers it builds.

```sh
pnpm --filter @opensteer/desktop build:computer-use-helper
pnpm --filter @opensteer/desktop build:passwords-broker
pnpm --filter @opensteer/desktop build:dictation-helper
pnpm --filter @opensteer/desktop build:passkeys-addon
pnpm --filter @opensteer/desktop build:process-supervisor
```

The passkeys addon pins its toolchain and Node header digests in
`apps/desktop/native/passkeys/toolchain.json` and builds a universal binary into `dist/passkeys`.
Development bundling works without it; release bundling includes it only when both passkey signing
inputs are supplied.
