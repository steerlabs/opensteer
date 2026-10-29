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

[Desktop release](../.github/workflows/release.yml) uses GitHub's public-repository
hosted macOS arm64 runner. `desktop-vX.Y.Z` builds **Opensteer**
(`com.opensteer.opensteer`), published Latest. `vX.Y.Z-insider` builds
**Opensteer Beta** (`com.steerlabs.opensteer.beta`), published as a prerelease and
never Latest. No other `v*` tag triggers a release.

Both apps have plain numeric `X.Y.Z` versions from the root package.json, exactly
matching the numeric part of the tag. There is one Beta per version: bump the
version for every Beta. The first public release is 0.1.220. Beta's updater uses
channel `insider`; `beta` remains the product build channel name.

Commit the version on main and wait for its CI evidence. Tim chooses one:

```sh
git tag v0.1.220-insider MAIN_COMMIT_SHA
git push public refs/tags/v0.1.220-insider
# Stable:
git tag desktop-v0.1.220 MAIN_COMMIT_SHA
git push public refs/tags/desktop-v0.1.220
```

Approve the build's `release` environment request, inspect its complete draft,
then approve the separate publish job. A Beta is published only after its draft
is complete. Never backfill an older Beta after a newer one: the updater picks
the first eligible feed entry. Never move a release tag.

### Practice run and exact-byte promotion

`workflow_dispatch` requires this workflow on the default branch. From main:

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main \
  -f ref=MAIN_COMMIT_SHA -f channel=beta -f version=0.1.220 -f publish=false
```

`publish=false` is the default. After build approval, this stops at a draft,
invisible to anonymous users and `releases/latest`. Inspect the prepared artifact,
SHA256SUMS and release.json. To promote, dispatch again with the same source,
channel and version and `-f publish=true`. Preflight verifies the existing draft's
`sourceSha`, `version` and `channel`, skips rebuilding and drafting, and requests
publish approval. The publication tool verifies those exact draft bytes before
promotion. Already published versions are rejected. Never replace draft assets
between verification and approval.

### Build inputs and local proof

`pnpm desktop:build-release --out /absolute/build-directory` requires a clean
checkout. It downloads checksum-pinned official Node, PostgreSQL source and
cloudflared; compiles and relocates PostgreSQL; builds and signs the supervisor;
and invokes the product's Personal runtime, Computer Use, Passwords and desktop
packagers. The Personal runtime's source provenance, native input proofs and
resource digests remain enforced. No sibling checkout, private infrastructure,
login keychain item or local signing JSON is needed.

The workflow first runs `pnpm build:agent-phone --release`. With its source and
version environment, that producer writes and verifies the trusted APK receipt.
The desktop builder pins that receipt and verifies it again during staging and
packaging. The phone's permanent signer check is unchanged.

Signing uses `OPENSTEER_RELEASE_SIGNING_IDENTITY`, `OPENSTEER_APPLE_TEAM_ID` and
`CSC_KEYCHAIN`, validated by the same strict contract as the existing optional
signing JSON. Matching inherited values remain compatible with a signing file;
conflicting values fail. API-key notarization uses `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, independently of the signing keychain.
Packaging notarizes and staples; the workflow also runs explicit staple and
Gatekeeper checks before preparing the ZIP.

For a keyless packaging proof on an arm64 Mac with the Android SDK, JDK 17 or
newer, Go, Node/pnpm and Xcode command-line tools:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build-release --unsigned --out /absolute/proof-inputs
```

This builds a debug APK and uses `package:mac --unsigned`, an explicit contributor
mode with development trust and ad-hoc signatures. Its app is under
`apps/desktop/release/contributor/mac-arm64/`. It does not stamp release build
metadata or generate updater metadata, and cannot be prepared for publication:
public prepare requires the Developer ID identity, deep-strict signature and a
valid notarization staple. No notarization or app launch runs in this proof.
On the shared development Mac, wrap this command with the existing private
checkout's `pnpm heavy --`; the public repo does not carry that local machinery.
Every Android build disables persistent Gradle/Kotlin daemons.

The public-download tooling owns updater configuration and publication.
`prepare --channel stable|beta --app-zip --version --source-sha --out` emits the
ZIP and blockmap, SHA256SUMS and release.json. Stable adds latest-mac.yml and
install.sh; Beta adds insider-mac.yml. `draft --dir --repo` reads the manifest
channel, attaches release.json and targets its source SHA. `publish --repo --tag`
verifies the draft, makes stable Latest, and keeps Beta prerelease and never
Latest. Never set any `OPENSTEER_DESKTOP_UPDATE_*` variable.

## Tim's one-time setup and rotation

The `release` environment is already configured with required reviewer
`timjang3`. Deployment refs are branch `main`, tags `desktop-v*`, and tags
`v*-insider`. Keep signing secrets scoped to that environment. Tim performs all
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
