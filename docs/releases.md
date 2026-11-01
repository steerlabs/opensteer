# Builds and releases

Release builders consume a green main SHA; there is no local release
requalification. The source contracts are [release.yml](../.github/workflows/release.yml),
[release-plan.mjs](../.github/scripts/release-plan.mjs),
[release-version.cjs](../scripts/release-version.cjs) and
[desktop-public-release.ts](../scripts/desktop-public-release.ts).

## Release evidence

Use the CI run for the exact main SHA. Record commands, results and artifact
digests for the build distributed. Real desktop journeys run in a VM after merge
or on maintainer request. Use [prepare-release](../.agents/skills/prepare-release/SKILL.md)
for dispatch and evidence collection.

## Build inputs and local proof

Contributor builds need no Developer ID or notarization credentials and claim no
distribution readiness. See [the desktop README](../apps/desktop/README.md) and
[install-desktop](../.agents/skills/install-desktop/SKILL.md). Signed local installs
reuse Personal data and permission identity; never run two copies against it.
Downgrading the app does not undo migrations. Receipt drift fails closed.

## Public desktop releases

Eligible main pushes resolve main HEAD and wait for that exact SHA's newest main
CI and Check. Main CI runs coalesce, so if that run was cancelled, main has moved
past the SHA and a newer main push run exists, the release skips as superseded;
any other CI failure still blocks it. Insiders are signed, notarized Beta
prereleases, never Latest. See the workflow's exact path exclusions: shipped
notices and agent skills are build inputs, so a blanket Markdown exclusion is
wrong. There are no schedule, tag-push or PR triggers. GITHUB_TOKEN-created tags
do not retrigger releases.

Per-channel concurrency coalesces pending runs but never cancels a running build
mid-notarization. A coalesced stable dispatch may need redispatch. Never publish
an older insider after a newer one: the updater selects the first eligible feed entry.

Each final signed and notarized build is launched as an ordinary child process
in the ephemeral release VM, from a disposable copy in Applications. The normal
HOME is retained only on these disposable runners, so macOS can
use its existing Keychain. The checker refuses other machines unless they have
`CI=true` and `RUNNER_TEMP` or the repository test-VM guest marker. A fresh data
directory contains only Personal setup intent; the app creates its own database
and credentials. Packaged builds reject Workspace overrides and symlinks. The
checker therefore uses a fresh default Workspace on the disposable machine, refuses
to reuse an existing one, and removes it after the check. The external check observes the
supervisor's published Personal selection, loopback health and visible loaded window, then sends the app's normal
SIGTERM quit and waits for its captured children to exit. The three-minute check
retains logs and an optional VM screenshot on failure. It changes no shipped-app
behavior, launch policy, debugger fuses, Keychain use or environment resolution.
Database upgrade coverage belongs to the migration compatibility tests. VM update
journeys remain optional on-demand tools.

A dispatch of either channel stops at the draft unless `publish=true`. Publication
re-downloads and verifies draft assets, manifest hashes, SHA256SUMS, source identity
and signer. No agent certification receipt is required. Publish jobs run the
workflow commit's publisher, rather than the release source's publisher.

### Derived versions

Both channels use numeric X.Y.Z derived from the base manifest version plus
first-parent commits since its last version-value change. A new base must exceed
the preceding derived version; shallow/nonlinear history fails closed. Only the
byte-exact generated root version stamp is allowed by the source identity guard.
Desktop and Personal runtime use that guard; infra must use it before the
container release-record stage, which retains Git-free manifest validation.
APK receipts and release.json bind version to exact source.

### Stable promotion

Stable rebuilds an already published insider's exact source with the same numeric
version and its distinct stable bundle identity. Tag, target and release.json
must agree; exact-source push CI and the latest completed full main CI must be
green and include the source on first-parent main. Tim approves only publication
of the verified draft via the `publish` environment. Matching drafts are reused;
mismatches and already published stable versions fail closed.

### Hosted build and keyless proof

`desktop:build-release --out <outside-checkout-directory>` provisions pinned
public Node, PostgreSQL source and cloudflared, relocates PostgreSQL libraries,
and invokes the product's runtime, native helpers, supervisor and packagers.
Production provenance, signer, profile, resource and APK receipt checks remain
enforced. Debugger maps are omitted to retain the 2,048-file runtime manifest
bound. Each command retains its 15-minute limit; configure, make and install
are separate commands. A cold local PostgreSQL build measured 27/79/6 seconds;
hosted timing still needs the first practice run. The release workflow also caches
unsigned PostgreSQL, SwiftPM objects and Gradle dependencies under release-only
keys bound to their source inputs and toolchains. It never restores a partial key
or caches signing material. PR native proofs build cold on the release runner and
Xcode.
No private checkout, login keychain item or signing JSON is required by CI.

Signing uses strict `OPENSTEER_RELEASE_SIGNING_IDENTITY`,
`OPENSTEER_APPLE_TEAM_ID` and `CSC_KEYCHAIN` inputs, compatible with the existing
signing-file contract. API-key notarization uses `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` independently. Packaging notarizes and
staples, and the workflow explicitly validates the staple and Gatekeeper before
preparing its ZIP. `build:agent-phone --release` produces the trusted receipt;
staging and after-pack reverify it. Android builds disable persistent daemons.

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

Prepare verifies bundle/channel identity, source, numeric version, arm64 executable,
Developer ID team/signature, notarization, Gatekeeper and embedded updater policy.
Draft tags target the built source, never current main. Identical draft bytes may
be reused; differing bytes fail. Publication verifies every asset before changing
visibility/Latest and checks anonymous downloads. Published reruns only verify.

Install the public stable app with:

```sh
curl -fsSL https://github.com/steerlabs/opensteer/releases/latest/download/install.sh | sh
```

The installer requires Apple silicon and macOS 13+, pins Latest once and checks
checksum, identity, version, executable, signer and Gatekeeper. It serializes
installation, rejects symlinks/conflicting identities and waits for app/ShipIt
shutdown before rename/restore replacement without touching data. An intact equal
or newer signed copy opens without replacement; recheck after quit because ShipIt
may have installed an update. See [install.sh](../scripts/install.sh).

Mirror overrides require HTTPS except loopback HTTP. Private-feed assets cannot
be published to the public repository. YAML asset URLs remain filenames because
the GitHub provider derives paths from its embedded host.

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

Updates run only from Applications; the move prompt precedes supervised children. Readiness requires native `update-downloaded`, proving Squirrel staged
and validated the bundle. Never log native errors carrying URLs/paths; log only
the fixed reason. Stop children and destroy windows before handing off installation.
Both channels refuse downgrades. Bundle entries must remain owner-writable for
ShipIt. See [updater](../apps/desktop/src/app/desktop-updater.ts),
[shutdown](../apps/desktop/src/app/desktop-shutdown.ts) and
[policy](../apps/desktop/src/releases/desktop-update-policy.ts).
Development omits updates. Mirror overrides are release-only and forbidden in CI;
the embedded feed records them for verification.

## Personal database snapshots

Before migrating on a new app version, snapshot the stopped PostgreSQL cluster.
This is a migration safety net, not a disk backup or a startup gate: failures
must not prevent launch. APFS clones share disk failure risk. A completed snapshot
has `snapshot.json`; retain the newest three. See
[snapshot implementation](../apps/desktop/src/supervisor/personal-database-snapshot.ts).

Restore with Opensteer and PostgreSQL stopped, preserving the current data for
recovery. Installing an older binary alone is not a restore. A database snapshot
does not include native browser storage, and restoring a preconversion DB must
not revive its old vault seed as authority.

Recovery requires a Host that understands native profiles, with named-profile
execution unavailable until every profile-owning runtime storage root reconciles
its inventory, including deletion tombstones. Personal reconciles Main before
named-profile ticket issuance. On Account-attached Deployments, reopening profiles
elsewhere before their owners reconcile is unsupported. An unavailable owner
leaves recovery incomplete and never authorizes importing an old seed elsewhere.
Runtime claims advance existing ownership; they do not recreate missing ownership
or grants. Restoring both the DB and runtime storage backwards is outside this
guarantee. See [profile authority](browser-sessions.md#profile-state) and
[runtime admission](host-boundaries.md#compatibility).

## Release gates

Signing alone proves no notarization. Distribution requires hardened runtime,
secure timestamps, reviewed entitlements, accepted notarization and a validated
staple/Gatekeeper assessment. Passwords also requires its matching provisioning
profile; see [SIGNING.md](../apps/desktop/SIGNING.md#passwords-provisioning-and-distribution).

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
