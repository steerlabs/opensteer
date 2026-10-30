# Building and signing for macOS

Ordinary builds, checks, tests, integration and development helper builds need no
signing environment. With no signing file they default to development trust and
ad-hoc signing. The helper builders set `OPENSTEER_DEV_TRUST` in Swift for that
mode; runtime environment variables cannot enable it. Passwords uses its separate
development directory and file-backed protected store. Computer use still needs
the person's macOS permissions.

Supplying `OPENSTEER_DESKTOP_SIGNING_FILE` or complete CI signing environment inputs
selects that identity even for a
non-release build. Distribution is an explicit mode: `package:mac` and the release
scripts require a valid input and propagate `OPENSTEER_DESKTOP_RELEASE=1`.
Release mode never selects development trust. The old development environment
flag is not a mode selector.

Both Swift packages build and discover tests on a clean clone without a signing
file or preparation script. Host-safe checks are `swift test --package-path
apps/desktop/native/computer-use --filter ComputerUseCoreTests` and `swift test
--package-path apps/desktop/native/passwords --skip 'SecureEnclaveTests|SnapshotTests'`.
Tests inject fixture teams through the policy seam; ordinary unsigned test runners
receive no release trust. Run GUI/Electron suites through `pnpm test:vm`.
The [build boundary journey](scripts/verify-signing-build.cjs) and
[bundle journey](scripts/verify-signing-bundles.cjs) need no signing keys.

The separate [contributor package command](README.md) uses explicit runtime
inputs and development trust, with ad-hoc signatures and packaged resource
verification. It does not require a release channel or signing credentials.
Development runtime and Electron signatures omit hardened runtime: library
validation cannot match Team IDs between ad-hoc executables and their bundled
libraries. Distribution signing retains hardened runtime.

An ad-hoc contributor build runs the workspace, but a packaged app refuses
unsigned helpers, so computer use and Opensteer Passwords need `pnpm dev` or a
signed package. The contributor command rejects a signing input. A signed package
currently requires `package:mac` and its release inputs, including a trusted
Agent Phone release receipt; see [Signed builds](#signed-builds).

## Signed builds

Hosted builds use `OPENSTEER_RELEASE_SIGNING_IDENTITY`, `OPENSTEER_APPLE_TEAM_ID`
and optional `CSC_KEYCHAIN` (an absolute existing .keychain-db path). These use
the same strict schema below. Inherited fields alongside a signing file must
agree with that file. The signing keychain does not imply a notarization profile:
`APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` can notarize independently.
The release environment and rotation procedure are documented in
[Releases](../../docs/releases.md#tims-one-time-setup-and-rotation).

`package:mac --unsigned` explicitly invokes contributor packaging; it rejects
signing input and release mode, uses ad-hoc signatures and development trust,
writes to release/contributor, and stamps no release build or updater metadata.
This path cannot produce a publishable archive.

Keep the signing JSON outside the checkout and set
`OPENSTEER_DESKTOP_SIGNING_FILE` to its absolute path. Its strict shape is:

```json
{
  "teamId": "ABCDE12345",
  "identity": "Developer ID Application: Example Company (ABCDE12345)",
  "notarizationProfile": "contributor-notary",
  "keychain": "/absolute/path/release.keychain-db"
}
```

`teamId` has ten uppercase letters/digits. The identity must name a Developer ID
Application certificate for that team; its private key must be available in the
build Mac's keychain. `notarizationProfile` is optional and names an existing
notarytool keychain profile, not a password. Release entry points select release mode explicitly.
Missing, invalid or conflicting signing inputs fail the build. Supplying
`--sign` to a helper script requires an exact match with the JSON identity.

`keychain` is optional. When present it must be an absolute path to an existing
`.keychain-db` file. Every Developer ID signing leaf, identity lookup and notary
profile lookup uses that file explicitly; electron-builder receives `CSC_KEYCHAIN`
and `APPLE_KEYCHAIN`, and alternate certificate-import environment inputs are
suppressed. The build does not modify the keychain search list or retry with a
default keychain. When omitted, existing default-keychain behavior is unchanged.
Unlocking the keychain and granting Apple tools access to its
private key remain the build operator's responsibility.

Raw test/integration consumers use a checked-in mode reader and need no generated
module. Every bundling entry replaces that reader with immutable TypeScript
metadata from the current input, including smoke/native-browser builds and cached
rebuilds. Release mode requires a valid input. Swift signing policy has no generated sources: each helper reads its own
signature with Security.framework and requires the peer to carry that team.
Unsigned/ad-hoc self signatures refuse trust. Unsigned non-release helper builds pass the
`OPENSTEER_DEV_TRUST` Swift compilation condition, which enables same-user trust
and the separate development Passwords store. Runtime environment variables cannot
enable it. All peer checks retain Apple's anchor, Developer ID intermediate and
leaf markers, exact bundle IDs and audit tokens. Apple Development cannot replace
Developer ID Application.

Use the existing helper build scripts and `package:mac`; the latter retains the
resource preparation and nested signing gates in
[prepare-release-resources.ts](scripts/prepare-release-resources.ts) and
[after-sign.cjs](scripts/after-sign.cjs). The current release entry point also
requires its existing release/runtime inputs, and its configured signing identity
must match the validated signing input. Packaging derives `OPENSTEER_APPLE_TEAM_ID` and `CSC_NAME`
from the validated input. A notarization profile in the JSON supplies
`APPLE_KEYCHAIN_PROFILE`; otherwise configure one complete credential strategy
accepted by [package-macos.ts](scripts/package-macos.ts).

Forks should use their own bundle IDs. Change the Electron builder `appId`, the
channel identities in `macos-release-identity.cjs`, helper bundle IDs and their
peer requirements together, including Passwords' import worker ID and keychain
group. Identity input changes the team, not those product identifiers. Keep OAuth
callbacks consistent with the fork's bundle IDs.

## Passwords provisioning and distribution

Creating Developer ID certificates and distribution provisioning profiles requires
an [Apple Developer Program account](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
Using the release Passwords keychain group requires a Developer ID provisioning
profile for the broker's explicit App ID and signing certificate. Set
`OPENSTEER_PASSWORDS_PROVISIONING_PROFILE` to that profile's path. The broker build
checks its team, App ID, keychain access group and expiry, then embeds it.
The current identifiers are `<teamId>.com.opensteer.passwords` for the application
identifier and keychain access group; a fork must update these with its own IDs.
The entitlements include `com.apple.application-identifier`,
`com.apple.developer.team-identifier` and `keychain-access-groups`. The sandboxed
import worker has its own entitlements. See the
[broker setup](native/passwords/README.md) and
[builder](scripts/build-passwords-broker.ts) for the exact checks.
A certificate alone does not grant that keychain access. Local development's
file-backed vault does not need this profile or a paid account.

For distribution, retain hardened runtime, secure timestamps and the reviewed
entitlements. The computer-use helper claims Apple events, Contacts and Calendars;
the Electron app retains only its reviewed JIT entitlement. Follow the existing
release entry point for [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
and stapling: submit the signed archive, wait for acceptance, staple the resulting
ticket and validate it before installation. Signing alone does not prove
notarization. Keep credentials in the protected `release` environment; the public
[release workflow](../../.github/workflows/release.yml) handles automation.

`Opensteer Dictation.app` is another separately signed LaunchServices helper.
Its release identity is `com.opensteer.dictation`; development uses
`com.opensteer.dictation.dev`. It requires macOS 26 and arm64, with hardened
runtime and exactly `com.apple.security.device.audio-input`. The helper alone
has `NSMicrophoneUsageDescription`; it has no speech-recognition permission.
The desktop application's entitlement gate is unchanged. Build with
`build:dictation-helper`; packaged digest and entitlement checks retain its
signature rather than signing it again through electron-builder.
