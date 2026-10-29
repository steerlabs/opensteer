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

## Public Mac download

Both channels use numeric `X.Y.Z` app and bundle versions. Stable uses
`desktop-vX.Y.Z`, title `Opensteer X.Y.Z (Alpha)`, and GitHub Latest
(`prerelease=false`). Beta uses `vX.Y.Z-insider`, title `Opensteer Beta X.Y.Z`,
and `prerelease=true, make_latest=false`; one beta per numeric version.

Stable assets: `Opensteer-mac-arm64.zip`, `Opensteer-mac-arm64.zip.blockmap`,
`latest-mac.yml`, `install.sh`, `SHA256SUMS`, `release.json`.
Beta assets: `Opensteer-Beta-mac-arm64.zip`, `Opensteer-Beta-mac-arm64.zip.blockmap`,
`insider-mac.yml`, `SHA256SUMS`, `release.json`. The channel YAML carries
electron-updater SHA-512 and size metadata; SHA256SUMS covers all assets except
itself and release.json. Blockmaps use app-builder-lib pinned to electron-builder's
26.15.3 version so the producer matches the updater format.

```sh
pnpm desktop:public-release prepare --channel stable --app-zip <absolute.zip> --version X.Y.Z --source-sha <40hex> --out <new-absolute-dir>
pnpm desktop:public-release draft --dir <absolute-dir> --repo steerlabs/opensteer --channel stable
pnpm desktop:public-release publish --repo steerlabs/opensteer --tag desktop-vX.Y.Z --channel stable
```

Use `--channel beta` and `--tag vX.Y.Z-insider` for beta. Prepare checks the
channel's bundle identity, numeric versions, source, arm64 executable, Developer ID
signature/team, notarization, Gatekeeper, `OpensteerUpdateFeed` and the embedded
`app-update.yml` GitHub provider/cache configuration. `--notes-file <absolute-file>`
appends human release notes. Draft/publish infer the channel from the attached
`release.json`; an explicit mismatch is refused. Identical draft bytes are reused,
differing drafts refused. After maintainer approval, publish verifies every draft
asset before changing visibility and Latest status, then checks anonymous downloads.
A published-release rerun only verifies.

Install with:

```sh
curl -fsSL https://github.com/steerlabs/opensteer/releases/latest/download/install.sh | sh
```

The installer requires Apple silicon and macOS 13+, pins Latest once, verifies the
archive checksum, stable bundle identity, version, arm64 executable, Developer ID
team and signature, and Gatekeeper assessment. It serializes installs, refuses
symlinks and conflicting identities, waits for graceful app/ShipIt shutdown, and
replaces the app with rename/restore protection without touching app data.
An installed copy counts only if it is an intact Opensteer-signed build; an equal
or newer one is opened without replacement. The check repeats after the app quits,
because ShipIt may have installed a newer update meanwhile.

For VM mirrors, use `OPENSTEER_RELEASE_REPOSITORY_URL` (repository root),
`OPENSTEER_INSTALL_DIRECTORY` (absolute physical target, without symlink ancestors), and `OPENSTEER_INSTALL_NO_OPEN=1`
to suppress launch. `prepare --download-base <mirror>/releases/download
--allow-private-feed` accepts a test build's embedded private feed. URLs require
HTTPS, except loopback HTTP. YAML asset URLs remain filenames because the
GitHub provider derives download paths from its embedded host. Private-feed assets cannot be drafted or published
to the public repository.

## Automatic updates

Packaged Mac arm64 releases use electron-updater 6.8.11 with the GitHub
provider. Stable uses channel `latest`, tag `desktop-vX.Y.Z`, and GitHub Latest;
Beta uses custom channel `insider`, tag `vX.Y.Z-insider`, and a prerelease
that is never Latest. Beta cannot use channel `beta`: that channel also accepts
legacy semver stable releases. Beta cannot use `desktop-v` tags either, because
prerelease discovery skips non-semver tags. Both app versions remain numeric
`X.Y.Z`, with one Beta per version, to satisfy Squirrel's downgrade guard.

For Beta, the provider selects the first eligible Atom entry, rather than the
highest version. Publish in version order, with all channel assets ready and the tag
visible in Atom. A missing channel file falls back to `latest-mac.yml` on the
same tag; publish `latest-mac.yml` for stable and `insider-mac.yml` for Beta.

Updates run only from Applications; the move prompt precedes supervised children.
Checks run after 30 seconds and every four hours, downloading automatically.
**Restart to Update** appears in the app menu and tray only after Electron's
native `update-downloaded` confirms Squirrel validated and staged the bundle.
Errors clear readiness. Restart and ordinary quit stop children and destroy
windows before handing installation to electron-updater, with a bounded exit.
Both channels refuse downgrades. Packaging keeps bundle entries owner-writable
for ShipIt, and the stable About panel retains its Alpha marker.

Release staging derives `app-update.yml` and channel-specific cache names from
the embedded policy. Development builds omit updates. The build-time
`OPENSTEER_DESKTOP_UPDATE_GITHUB_HOST` mirror override is allowed only for
release builds outside CI; `OpensteerUpdateFeed` records
`https://<host>/<owner>/<repo>#<channel>` for release verification.
See the [updater](../apps/desktop/src/app/desktop-updater.ts),
[shutdown](../apps/desktop/src/app/desktop-shutdown.ts), and
[build policy](../apps/desktop/src/releases/desktop-update-policy.ts).

## Stable channel without an Account

The public stable Mac download is Opensteer (`com.opensteer.opensteer`). Its signed
release policy sets `capabilities.connect: false` and omits `accountUrl` and
`portalUrl`: the public Account service is not available yet. It must not contact
`accounts.opensteer.com` or `accounts.beta.opensteer.com`. Beta keeps Connect and
its staging Account unchanged.

The app runs a Personal Host, agents, files, browser sessions and Passwords on the
Mac without an Account. Private network HTTPS access and one-use pairing codes
remain available, as does adding a self-hosted server with its own sign-in.
Account sign-in, directory discovery/adoption, Opensteer Cloud, Connect and phone
push from this Mac are unavailable. Desktop notifications still work. Managed
integration OAuth and hosted callback relays are unavailable; API keys and your
own OAuth apps work where the provider accepts the deployment's callback URL.
OAuth release identity remains required for Host-native sign-in.
