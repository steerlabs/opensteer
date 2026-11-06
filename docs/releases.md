# Builds and releases

Release builders consume a green main SHA; there is no local release requalification. See
[release.yml](../.github/workflows/release.yml) and the [desktop-builds skill](../.agents/skills/desktop-builds/SKILL.md).
Tim performs every credential operation; agents never read or operate on key material.

## Build inputs and local proof

Contributor builds ([desktop README](../apps/desktop/README.md)) need no Developer ID or
notarization credentials and claim no distribution readiness. Signed local installs reuse
Personal data and permission identity: never run two copies against it. An older app does not
undo migrations, and receipt drift fails closed.

## Signing

Without a signing input, builds use development trust and ad-hoc signatures: helpers compile the
Swift condition `OPENSTEER_DEV_TRUST`, which no runtime variable can enable, and Passwords uses a
separate development store. Any [signing input](../apps/desktop/scripts/signing-input.cjs) selects
its identity even outside a release; keep signing JSON outside the checkout.
`OPENSTEER_DESKTOP_RELEASE=1`, set by `package:mac` and the release scripts, requires a valid
input and never selects development trust. A named keychain is used with no default fallback.

Release trust comes from immutable build inputs and each helper's own Security.framework
signature, never the environment; Apple Development cannot replace Developer ID Application.
Distribution needs hardened runtime, secure timestamps, reviewed entitlements, accepted
notarization and a validated staple and Gatekeeper check; a signature alone proves none of them.
The app and its inherited helpers claim only JIT and audio input (Voice records in Chromium's
helper); the computer-use helper claims Apple events, Contacts and Calendars; the separately
signed Dictation helper claims exactly audio input. Nothing requests speech recognition.

Passwords' keychain group needs a Developer ID provisioning profile for
`<teamId>.com.opensteer.passwords` in `OPENSTEER_PASSWORDS_PROVISIONING_PROFILE`; a certificate
alone grants no keychain access, and creating either needs an [Apple Developer Program
account](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
Release passkeys would need `OPENSTEER_PASSKEYS_PROFILE` and `OPENSTEER_PASSKEYS_ENTITLEMENTS`;
the workflow supplies neither, so the released app embeds no profile. A fork changes the builder
`appId`, [macos-release-identity.cjs](../apps/desktop/scripts/macos-release-identity.cjs), helper
bundle IDs and peer requirements, Passwords' worker ID and keychain group, and OAuth callbacks
together.

## Public desktop releases

Main pushes outside the workflow's path exclusions build an insider: a signed, notarized Beta
prerelease, never Latest. Shipped notices and agent skills are build inputs, so never exclude all
Markdown. Tags made with `GITHUB_TOKEN` do not retrigger. Preflight waits for the exact SHA's
newest main push CI and `Check`; if a newer main push superseded a cancelled run, the release
skips, and any other failure blocks. A push publishes its insider; a dispatch stops at the draft
unless `publish=true`. Concurrency never cancels a build mid-notarization, so a coalesced stable
dispatch may need redispatch. Never publish an older insider after a newer one: the updater takes
the first eligible feed entry.

Key files and the ephemeral keychain are private and always deleted; release caches never hold
signing material, and CI needs no private checkout or signing JSON. A [launch
check](../scripts/smoke-desktop-release.ts) runs the final app from a disposable Applications copy
with fresh data, refuses any machine but an ephemeral CI runner or the test VM guest, and changes
no shipped behavior.

Publication re-verifies the draft's assets, hashes, `SHA256SUMS`, source and signer with the
workflow commit's publisher; no certification receipt is needed. Provenance and native bundle versions are numeric `X.Y.Z`,
the manifest base plus first-parent commits since it changed ([release-version.cjs](../scripts/release-version.cjs)).
A new base must exceed the last derived version, and a release checkout may differ from its
source only by the exact version stamp.

Stable resolves the exact source from a published immutable insider's provenance and rebuilds
it with the Stable stamp in the `release` environment, including signing, notarization, stapling
and a fresh launch check. Publication verifies matching insider source provenance rather than ZIP
equality. It refuses versions at or below published Stable and requires first-parent main with
green CI. Tim approves publication through the secret-free `publish` environment.

## Tim's one-time setup and rotation

The `release` environment holds the signing secrets with **no required reviewer**, so insiders
build automatically; its deployment refs are `main`, `desktop-v*` and `v*-insider`. Stable
publication alone uses `publish`, with required reviewer `timjang3` and **no secrets**. Tim
configures both and enables immutable GitHub releases; Stable refuses mutable insider
provenance. Agents change no settings.

| Secret                                        | Contents and rotation                                                                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                | Base64 Developer ID Application .p12 holding only that identity and key (Keychain Access → My Certificates → Developer ID Application → File → Export Items, .p12), and its export password. Rotate together.                                   |
| `APPLE_API_KEY_P8`                            | Raw App Store Connect .p8, **not base64**: a Team Key with Developer access (Users and Access → Integrations → App Store Connect API), downloadable once.                                                                                       |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`        | That key's Key ID and Issuer ID. Rotate with the key, practice-build, then revoke the old key.                                                                                                                                                  |
| `OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64`       | Base64 permanent PKCS#12 Agent Phone keystore. Never change its signer: that strands installed phones and fails the pinned signer check. Only re-export or re-encrypt the key.                                                                  |
| `OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD`     | Both store and key password, kept equal.                                                                                                                                                                                                        |
| `MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64` | Base64 Developer ID profile "Opensteer Passwords Developer ID v1" for `B47U2LLKHW.com.opensteer.passwords`, from Apple Developer → Certificates, Identifiers & Profiles → Profiles or Tim's copy. Regenerate on certificate or profile renewal. |
| `MACOS_APP_PROVISIONING_PROFILE_BASE64`       | Main-app profile "Opensteer Developer ID v1" for `B47U2LLKHW.com.opensteer.opensteer`, kept but **unused**: the app embeds no profile. Renew in the Developer portal only if needed elsewhere.                                                  |

Variables: `APPLE_TEAM_ID=B47U2LLKHW`, and `OPENSTEER_AGENT_PHONE_KEY_ALIAS=opensteer-agent-phone`,
changed only when re-exporting the same key under a new alias. Values carry no trailing newline. Tim sets each from a local file on stdin, so no value reaches a
log or chat, keeps originals in his secure backup and practice-builds before revoking old ones:

```sh
umask 077; base64 < DeveloperID.p12 > CSC_LINK.txt   # delete the encoded copy afterwards
gh secret set CSC_LINK --env release --repo steerlabs/opensteer < CSC_LINK.txt
gh variable set APPLE_TEAM_ID --env release --repo steerlabs/opensteer --body B47U2LLKHW
```

## Public Mac download

People install Stable with
`curl -fsSL https://github.com/steerlabs/opensteer/releases/latest/download/install.sh | sh`.
[install.sh](../scripts/install.sh) needs Apple silicon and macOS 13+ and replaces the app only
after it and ShipIt quit, never touching data. Draft tags target the built source, never current
main. Publication verifies every asset before changing visibility or Latest. YAML asset URLs stay
bare filenames because the GitHub provider derives paths from its embedded host. Mirror overrides
need HTTPS except on loopback; private-feed assets never reach the public repository.
[Draft certification](../scripts/public-download/eu-run.ts) optionally installs a draft's actual
ZIP in disposable VMs and never publishes, pushes or changes host firewall or trust settings.

## Automatic updates

Stable and Beta are settings of the one app, `com.opensteer.opensteer`; fresh installs default
to Stable, and switching never downgrades. Stable uses channel `latest`, `desktop-vX.Y.Z` tags
and GitHub Latest; Beta uses channel `insider` and `vX.Y.Z-insider` prereleases, because
channel `beta` accepts legacy semver stable releases and prerelease discovery skips
`desktop-v` tags. Beta package versions are `X.Y.Z-insider`, Stable `X.Y.Z`; both native bundle versions remain
numeric. Squirrel accepts equality, while semver permits Beta to Stable of the same base and
refuses the reverse. Beta displays as “Opensteer (Beta)”; the executable, `Opensteer.app`, data
and credential identities stay fixed. Beta takes
the first eligible Atom entry, not the highest version, so publish in order with every asset
ready. Updates run only from Applications and download only when the person asks. Log only the
fixed failure reason, since native errors carry URLs and paths. Before handing off installation,
hide the window first, since its page depends on everything stopped after it, then stop children
and destroy windows ([updater](../apps/desktop/src/app/desktop-updater.ts)).
Development builds never update; the update-host override works only in release builds
outside CI.

## Personal database snapshots

Before migrating on a new version, the app [snapshots](../apps/desktop/src/supervisor/personal-database-snapshot.ts)
the stopped PostgreSQL cluster: a guard against a bad migration, not a failing disk, that never blocks launch. Restore by
hand with Opensteer and PostgreSQL stopped, setting the current data aside; an older binary alone
is not a restore. Snapshots exclude native browser storage: a restored pre-conversion database
must never recreate or replace an established native directory, and named profiles stay
unavailable until every owning storage root reconciles its inventory ([profile
authority](browser-sessions.md#profile-state)). Restoring runtime storage backwards too is outside
this guarantee.

## Account service

The `account` job ships the Account service on every eligible main push, before that insider
publishes; a failed rollout blocks the insider, and
[deploy-account.sh](../.github/scripts/deploy-account.sh) never rolls live source back. Nobody
deploys it by hand. A Host refuses, with an update instruction, an Account lacking a capability
it needs, never falling back to a weaker path. A reasonless refusal stays retryable: an HTTP
status alone never proves an external effect did not happen. New pods migrate at startup while the previous release serves, so add
first and drop or rename only once no running release reads the old shape. Secrets stay in
Secret Manager; [deploy/account](../deploy/account) holds only their names and versions.

Outside this repo, the GitHub environment `account` (main only) is the sole caller the Workload
Identity provider `github-account-deployer` in `opensteer-admin`'s `github` pool admits. Its
service account, `gha-account-deployer@opensteer-admin`, may push to the `staging` Artifact
Registry, connect to `cell-1` and change only the Account's objects in `opensteer-system`; the
cluster, database, edge, secrets and that Role stay in `opensteer-infra`.
