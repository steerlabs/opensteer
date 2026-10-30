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

## Public desktop releases

[Desktop release](../.github/workflows/release.yml) builds macOS arm64 on GitHub's
public-repository hosted runner. On every merge to main that changes an eligible
path, it resolves main HEAD and waits up to one hour for that exact SHA's newest
main CI run and `Check` to succeed. It skips if the newest published insider
already targets it. Otherwise it
builds **Opensteer Beta** (`com.steerlabs.opensteer.beta`), signs, notarizes and
publishes `vX.Y.Z-insider` automatically as a prerelease, never Latest. Insiders
use updater channel `insider` and product build channel `beta`.

Documentation and CI-only paths are excluded; there is no blanket Markdown
exclusion because notices and agent skills are shipped build inputs. The exact
`paths-ignore` list is in the workflow, with a contract guarding all tracked app,
package, build-script, deployment and patch sources plus root build inputs.
There are no schedule, tag-push or pull-request triggers. Draft creation targets
the built SHA; tags created with GITHUB_TOKEN do not start another release workflow.
Per-channel concurrency keeps one running and at most one pending run. Bursts
coalesce: the newest pending run replaces older pending runs. A running build is
never canceled mid-notarization. A coalesced manual stable dispatch can be
re-dispatched.

Never backfill an older insider after a newer one: the updater selects the first
eligible feed entry.

### Derived versions

Both channels use plain numeric `X.Y.Z`. No version commit or bump PR is needed.
In a full-history checkout, infra and maintainers can recompute a source's version:

```sh
node scripts/release-version.cjs FULL_40_CHARACTER_SHA
```

The root manifest at that SHA supplies base `M.m.p`. Find the most recent
first-parent commit that changed the **version value**, or the root commit.
For N first-parent commits after it, the release is `M.m.(p+N)`. Non-version
manifest edits count as commits. A new base must exceed the preceding derived
version; nonlinear or shallow history, invalid versions and unreadable manifests
fail closed. The CommonJS export is
`deriveReleaseVersion({ repositoryRoot, revision })`.

The build stamps only its workspace's root package.json, never committing it.
The canonical identity guard accepts that one byte-exact generated change only
when its version is derived for HEAD; any other field/file change is refused.
Desktop packaging and the Personal runtime use the same guard. Infra must use it before building the container release-record stage, which retains its existing Git-free manifest validation.
The APK receipt and release.json bind the derived version to the exact source.

### Insider practice run

`workflow_dispatch` needs the workflow on the default branch. From main:

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main \
  -f channel=insider -f publish=false
```

`publish=false` is the manual insider default. The build ends at a complete draft,
invisible to anonymous users and `releases/latest`. Inspect its artifact,
SHA256SUMS and release.json. Dispatch with `-f publish=true` to publish. When main
still has the same SHA, discovery validates and reuses the exact draft instead
of rebuilding; publication rechecks all its bytes. If main has advanced, the run
builds its new derived version. An unchanged already-published insider is skipped.
Insider signing and publication have no reviewer approval gate.

### Stable promotion

Choose an already **published** insider prerelease:

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main \
  -f channel=stable -f insider_tag=v0.1.230-insider
```

Preflight requires its tag, release target and release.json to agree on source
and derived version, and checks that exact main SHA's CI. It rebuilds **Opensteer**
(`com.opensteer.opensteer`) from that commit with the same numeric version,
prepares `desktop-vX.Y.Z` and creates a draft. Tim then approves the separate
`publish` environment job to undraft those verified bytes and mark Latest.
The `publish` boolean controls manual insider publication; stable always requests
this approval after drafting. Discovery reuses only a matching draft; already
published stable versions and mismatched targets/assets fail closed.

### Hosted build and keyless proof

`desktop:build-release --out <outside-checkout-directory>` provisions pinned
public Node, PostgreSQL source and cloudflared, relocates PostgreSQL libraries,
and invokes the product's runtime, native helpers, supervisor and packagers.
Production provenance, signer, profile, resource and APK receipt checks remain
enforced. Debugger maps are omitted to retain the 2,048-file runtime manifest
bound. Each command retains its 15-minute limit; configure, make and install
are separate commands. A cold local PostgreSQL build measured 27/79/6 seconds;
hosted timing still needs the first practice run. Only the pnpm store is cached.
No private checkout, login keychain item or signing JSON is required by CI.

Signing uses strict `OPENSTEER_RELEASE_SIGNING_IDENTITY`,
`OPENSTEER_APPLE_TEAM_ID` and `CSC_KEYCHAIN` inputs, compatible with the existing
signing-file contract. API-key notarization uses `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` independently. Packaging notarizes and
staples, and the workflow explicitly validates the staple and Gatekeeper before
preparing its ZIP. `build:agent-phone --release` produces the trusted receipt;
staging and after-pack reverify it. Android builds disable persistent daemons.

For an arm64 Mac with JDK 17+, Android SDK, Go, Node/pnpm and Xcode tools:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build-release --unsigned --out /absolute/proof-inputs
```

This builds a debug APK and ad-hoc contributor app under
`apps/desktop/release/contributor/mac-arm64/`, with development trust, version
0.0.0 and no updater metadata. It never notarizes or launches the app and cannot
be prepared as a distribution: public preparation checks the real Developer ID
team, deep-strict signature and staple. On the shared Mac, use its existing
private checkout's `pnpm heavy --` wrapper; that machinery is not part of this repo.
Never set any `OPENSTEER_DESKTOP_UPDATE_*` variable.

## Tim's one-time setup and rotation

The `release` environment holds signing secrets and has **no required reviewer**
for automatic insider builds. Deployment refs remain branch `main`, tags
`desktop-v*`, and tags `v*-insider`. Only the stable publication job uses the
separate `publish` environment, with required reviewer `timjang3` and **no secrets**.
Tim/maintainers configure these environments before enabling main-push releases; agents
do not change settings. Keep signing secrets scoped to `release`. Tim performs all
credential operations himself; agents never read or operate on key material.

| Environment secret                            | Contents and rotation source                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`                                    | Base64 Developer ID Application .p12, containing only that identity and private key. Export a replacement from Keychain Access → My Certificates → Developer ID Application → File → Export Items, Personal Information Exchange (.p12). Rotate with `CSC_KEY_PASSWORD`.                                                                      |
| `CSC_KEY_PASSWORD`                            | The .p12 export password, without a trailing newline.                                                                                                                                                                                                                                                                                         |
| `APPLE_API_KEY_P8`                            | Raw App Store Connect .p8 contents, **not base64**. Create a replacement Team Key under Users and Access → Integrations → App Store Connect API, with Developer access; download once. Rotate its ID and Issuer together, verify a practice build, then revoke the old key.                                                                   |
| `APPLE_API_KEY_ID`                            | The new App Store Connect key's Key ID, without a trailing newline.                                                                                                                                                                                                                                                                           |
| `APPLE_API_ISSUER`                            | Its Issuer ID, without a trailing newline.                                                                                                                                                                                                                                                                                                    |
| `OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64`       | Base64 permanent PKCS#12 Agent Phone keystore. Back up securely; do not replace its signer during routine credential rotation. Re-export/re-encrypt the same key and update its password together. A different signer strands installed phones and fails the product's pinned signer check.                                                   |
| `OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD`     | Both store password and key password for the current release keystore. Keep both passwords equal when re-encrypting it.                                                                                                                                                                                                                       |
| `MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64` | Base64 Developer ID profile for `B47U2LLKHW.com.opensteer.passwords` (currently Opensteer Passwords Developer ID v1). Download from Apple Developer → Certificates, Identifiers & Profiles → Profiles, or use Tim's existing copy. Regenerate for certificate/profile renewal; validation checks its team, App ID, keychain group and expiry. |
| `MACOS_APP_PROVISIONING_PROFILE_BASE64`       | Existing main-app profile, Opensteer Developer ID v1, `B47U2LLKHW.com.opensteer.opensteer`. Retained in the environment but **unused** by this workflow: the main app claims only allow-jit and embeds no provisioning profile. Renew through the Developer portal if needed elsewhere.                                                       |

The environment variables are `APPLE_TEAM_ID=B47U2LLKHW` and
`OPENSTEER_AGENT_PHONE_KEY_ALIAS=opensteer-agent-phone`. Update the alias only
when re-exporting the same permanent signing key under a new alias. Passwords
uses `com.opensteer.passwords` on both channels; neither Beta's main app nor the
broker requires a separate Beta provisioning profile under the current
entitlement contract.

Tim prepares private files locally, then replaces secrets using stdin. These
commands contain names and paths only; never paste values into logs or chat:

```sh
umask 077
base64 < DeveloperID.p12 > CSC_LINK.txt
base64 < agent-phone.p12 > OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64.txt
base64 < passwords.provisionprofile > MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64.txt
# Only when rotating the stored, currently unused main-app profile:
base64 < app.provisionprofile > MACOS_APP_PROVISIONING_PROFILE_BASE64.txt
# Passwords and IDs are local files without trailing newlines.
gh secret set CSC_LINK --env release --repo steerlabs/opensteer < CSC_LINK.txt
gh secret set CSC_KEY_PASSWORD --env release --repo steerlabs/opensteer < CSC_KEY_PASSWORD.txt
gh secret set APPLE_API_KEY_P8 --env release --repo steerlabs/opensteer < AuthKey.p8
gh secret set APPLE_API_KEY_ID --env release --repo steerlabs/opensteer < APPLE_API_KEY_ID.txt
gh secret set APPLE_API_ISSUER --env release --repo steerlabs/opensteer < APPLE_API_ISSUER.txt
gh secret set OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64 --env release --repo steerlabs/opensteer < OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64.txt
gh secret set OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD --env release --repo steerlabs/opensteer < OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD.txt
gh secret set MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64 --env release --repo steerlabs/opensteer < MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64.txt
gh secret set MACOS_APP_PROVISIONING_PROFILE_BASE64 --env release --repo steerlabs/opensteer < MACOS_APP_PROVISIONING_PROFILE_BASE64.txt
gh variable set APPLE_TEAM_ID --env release --repo steerlabs/opensteer --body B47U2LLKHW
gh variable set OPENSTEER_AGENT_PHONE_KEY_ALIAS --env release --repo steerlabs/opensteer --body opensteer-agent-phone
```

Remove temporary encoded/password files after uploading; retain originals in
Tim's secure backup. Run a practice build after rotation before revoking old
credentials. The workflow writes raw .p8, decoded keystore/profile/certificate
and temporary PEM files with mode 0600, masks the derived signing identity before
printing it, and always deletes those files and its temporary keychain.

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
`release.json`; an explicit mismatch is refused. A draft targets `sourceSha`, so
publication creates a missing tag at the built commit rather than the current main;
a draft with another target is refused. Identical draft bytes are reused,
differing drafts refused. Publication verifies every draft
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
Errors clear readiness and log `desktop.update.failed` with a fixed `reason`:
`signature` (Squirrel's designated-requirement refusal), `downgrade` (its
downgrade guard) or `other`; the native message, which carries URLs and paths, is
never logged. Restart and ordinary quit stop children and destroy
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
