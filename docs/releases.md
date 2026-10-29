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
public-repository hosted `macos-15` runner. No paid runner is required. Stable is
`Opensteer` (`com.opensteer.opensteer`); beta is `Opensteer Beta`
(`com.steerlabs.opensteer.beta`). Stable becomes Latest; beta is a prerelease and
never Latest. Legacy `v*` tags do not trigger this workflow.

Commit the release version on main and wait for its CI evidence. The workflow
checks that the selected source is an ancestor of main. To release, Tim runs:

```sh
# Choose one; substitute the version already committed on main.
git tag desktop-v1.2.3-beta.1 MAIN_COMMIT_SHA
git push public refs/tags/desktop-v1.2.3-beta.1
# Stable:
git tag desktop-v1.2.3 MAIN_COMMIT_SHA
git push public refs/tags/desktop-v1.2.3
```

Approve the build's `release` environment request, inspect the draft and its
checksums, then approve the separate publish job. Never move a release tag.
The APK, signed and notarized app, ZIP and updater metadata must all identify
the selected source and version. Packaging notarizes through electron-builder
(`mac.notarize: true`), validates its staple and assesses Gatekeeper; the workflow
also explicitly runs `stapler validate` and `spctl` before preparing assets.

### Practice run and promotion

`workflow_dispatch` needs this workflow on the default branch. Run it from main
with `publish=false` (the default):

```sh
gh workflow run release.yml --repo steerlabs/opensteer --ref main \
  -f ref=MAIN_COMMIT_SHA -f channel=beta -f version=1.2.3-beta.1 -f publish=false
```

This requires build approval and ends at a draft release. Drafts are invisible
to anonymous users and `releases/latest`. Review the prepared artifact, SHA256SUMS
and release.json. To promote, dispatch again with the same source, channel and
version and `-f publish=true`. Preflight reuses the existing draft only if its
`sourceSha`, `version` and `channel` match; it skips rebuilding and drafting.
The publish environment approval therefore promotes those exact bytes. The
publication tool must reverify the draft assets against release.json before
promotion. Already published versions are rejected. Do not delete or replace
draft assets between verification and approval.

### Integration contracts and current blockers

This workflow targets the public-download tooling's agreed electron-updater
GitHub interface: `prepare`, `draft`, `publish` take `--channel stable|beta`;
prepare emits `latest-mac.yml` or `beta-mac.yml`, ZIP, SHA256SUMS and release.json.
The manifest must include `sourceSha`, `version` and `channel` for draft reuse.
Draft creation must attach release.json and target `sourceSha` when creating the
tag. Publish must verify
assets, set stable Latest, and keep beta prerelease and never Latest.

The reference branch `public-mac-download-port` at `bdef59450` still has the old
stable-only JSON feed, no channel argument, and no channel manifest field. It
has not been merged here. Public main also lacks `desktop:public-release`.
These integrations must land before a hosted release can succeed:

- `scripts/release-identity.cjs` reads the root package version, rejects
  prereleases and dirty checkouts, and passes it through desktop buildVersion,
  extraMetadata.version and both macOS version fields. The workflow supplies
  `OPENSTEER_RELEASE_VERSION` and `OPENSTEER_SOURCE_REVISION`; it does not rewrite
  package.json. Beta assumes the full `X.Y.Z-beta.N` identity is accepted and
  stamped consistently. Android's Gradle version parser also currently rejects
  prereleases; agree its numeric versionCode policy before shipping beta.
- `package-macos.ts` requires `OPENSTEER_DESKTOP_SIGNING_FILE` with Developer ID
  identity and teamId before using electron-builder credentials. The current
  signing.keychain path also selects an Apple keychain notarization strategy,
  conflicting with API-key notarization. Hosted signing must support the
  ephemeral keychain with the API-key strategy without a login keychain profile.
  `MAC_CERTIFICATE_PASSWORD` maps to electron-builder’s `CSC_KEY_PASSWORD`;
  no extra secret name is needed.
- Resource preparation requires a proven Personal runtime (including Node and
  PostgreSQL), explicit process-supervisor binary and digest, cloudflared
  version/binary/digest, optional PortableFS installer/digest, and runner provenance.
  The current local release orchestrator supplies these from local configuration;
  this workflow has no reviewed hosted provisioning contract for them. If enabled,
  PortableFS defaults to a sibling `../portablefs/scripts/install.sh` outside
  the checkout. Packaging fails closed when required inputs are absent.
- Agent Phone signing needs a key alias and key password as well as the two
  requested keystore secrets. Set the environment variable `AGENT_PHONE_KEY_ALIAS`
  to the existing key alias. The workflow assumes its key password equals the
  keystore password, matching the local release helper. The signer must match
  `packages/protocol/src/agent-phone-release.json`. Desktop after-pack verifies
  the embedded release APK. Resource preparation also requires the trusted APK
  release receipt and its digest; `build:agent-phone --release` alone does not
  supply the release orchestrator’s receipt contract.

No installed login items, external private repository or private npm dependency
was identified as a requirement in these entry points. This is a source review,
not hosted-build evidence; the runtime inputs above remain blockers.

## Tim's one-time setup

Tim performs all commands below on his own machine. Agents must never receive,
read or operate on key material. None of these steps are performed by the
implementation agent. Keep the seven named secrets in the `release` environment,
not repository or organization secrets. Both build and publish require approval.

Create the environment with Tim as reviewer, allow his release approvals, disable admin
bypass, and restrict deployment refs to main and desktop release tags:

```sh
TIM_ID=$(gh api user --jq .id)
gh api --method PUT repos/steerlabs/opensteer/environments/release \
  --input - <<EOF_SETUP
{"reviewers":[{"type":"User","id":$TIM_ID}],"prevent_self_review":false,"can_admins_bypass":false,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF_SETUP
gh api --method POST repos/steerlabs/opensteer/environments/release/deployment-branch-policies \
  -f name=main -f type=branch
gh api --method POST repos/steerlabs/opensteer/environments/release/deployment-branch-policies \
  -f 'name=desktop-v*' -f type=tag
```

Self-review is allowed so Tim can approve his own tag pushes and dispatches.
Inspect existing environments before applying PUT; existing ref policies need
not be recreated.

In Keychain Access, select **My Certificates**, expand the **Developer ID
Application** identity, select the certificate and private key, then **File →
Export Items…**, format **Personal Information Exchange (.p12)**. Save as
`DeveloperID.p12` and choose an export password. The certificate must include its
private key. Store the password in a local file without a trailing newline.

In App Store Connect, open **Users and Access → Integrations → App Store Connect
API → Team Keys**, create a key with the Developer role for notarization, and
record its Key ID and Issuer ID. Download `AuthKey.p8` once and store it securely.
This is an App Store Connect API key, not an Apple ID password. Put the two IDs
in local files without trailing newlines.

Using the existing permanent Agent Phone release keystore, prepare files and
upload each secret (replace paths with Tim's own files):

```sh
umask 077
base64 < DeveloperID.p12 > MAC_CERTIFICATE_P12_BASE64.txt
base64 < AuthKey.p8 > APPLE_API_KEY_P8_BASE64.txt
base64 < agent-phone.keystore > AGENT_PHONE_KEYSTORE_BASE64.txt
# Create the password/ID files locally using a password manager or editor.
gh secret set MAC_CERTIFICATE_P12_BASE64 --env release --repo steerlabs/opensteer < MAC_CERTIFICATE_P12_BASE64.txt
gh secret set MAC_CERTIFICATE_PASSWORD --env release --repo steerlabs/opensteer < MAC_CERTIFICATE_PASSWORD.txt
gh secret set APPLE_API_KEY_P8_BASE64 --env release --repo steerlabs/opensteer < APPLE_API_KEY_P8_BASE64.txt
gh secret set APPLE_API_KEY_ID --env release --repo steerlabs/opensteer < APPLE_API_KEY_ID.txt
gh secret set APPLE_API_ISSUER --env release --repo steerlabs/opensteer < APPLE_API_ISSUER.txt
gh secret set AGENT_PHONE_KEYSTORE_BASE64 --env release --repo steerlabs/opensteer < AGENT_PHONE_KEYSTORE_BASE64.txt
gh secret set AGENT_PHONE_KEYSTORE_PASSWORD --env release --repo steerlabs/opensteer < AGENT_PHONE_KEYSTORE_PASSWORD.txt
gh variable set AGENT_PHONE_KEY_ALIAS --env release --repo steerlabs/opensteer --body EXISTING_KEY_ALIAS
```

Remove the temporary encoded/password files after uploading; retain the originals
in Tim's secure backup. Never set `OPENSTEER_DESKTOP_UPDATE_FEED_URL`: the updater
uses the GitHub provider and its channel metadata.

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
