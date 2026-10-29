# macOS passkey addon

Desktop main uses `createMacosNativePasskeys()` through `NativePasskeys`. The
controller runs in the main app process because the browser entitlement and the
presenting window belong to that app. No renderer or helper receives a signing
endpoint. Routing and origin authority belong to the caller.

The TypeScript adapter owns request eligibility, byte validation, client-data
binding, outcome projection, and cancellation. Its injected addon seam lets host
tests exercise those policies without a credential provider or a system sheet.
The Objective-C++ shim applies the validated request plan to public
AuthenticationServices browser protocols, retains each controller and its delegate,
and resolves the presentation anchor by window number. Completions use an N-API
thread-safe function to enter JavaScript on Node's loop. The shim guards settlement,
window closure and the absolute deadline independently. Local cancellation removes
the operation before cancelling the controller; late callbacks cannot complete it.

Platform browser APIs require macOS 13.5. Security-key browser APIs require 14.4;
security-key registration transports require 14.5. Availability also checks the
running process's browser entitlement using `SecTaskCopyValueForEntitlement`.
The platform result's attachment property distinguishes a local credential from
hybrid. Public security-key results have no attachment property and are
cross-platform. Public platform results have no transports property; their fallback
is `internal, hybrid`. Older security-key results use an empty transport list.
Platform passkeys are discoverable. A required resident key establishes that for a
security key; either weaker preference leaves discoverability unknown.

The SDK has no public resident-key setter for platform requests and no hybrid
switch on security-key requests. Resident-key preferences apply to security-key
registration. The hybrid switch applies to both platform operations. The first
recognized hint controls it; attachment and assertion transports supply the default
when there is no recognized hint. Attestation is always
`none`. No private SPI is declared or invoked.

## Build

```sh
pnpm --filter @opensteer/desktop build:passkeys-addon
node --test apps/desktop/native/passkeys/check-addon.cjs
```

`toolchain.json` pins Xcode, clang, the SDK, N-API 8 and SHA-256 digests of the four
Node headers. The builder downloads only missing headers, verifies their digests,
compiles arm64 and x86_64, verifies the universal product and stages it into
`dist/passkeys`. N-API avoids an Electron/V8 ABI dependency. The host test loads the
real binary in an unentitled Node process; it never requests a sheet.

Release bundling builds the addon. Development bundling stages an explicitly built
addon if present and otherwise works without Xcode or an addon. Neither development
case adds a provisioning profile or the browser entitlement, so availability is
false. Non-macOS bundling does not build or load this code.

`asarUnpack` keeps the addon at
`app.asar.unpacked/dist/passkeys/opensteer-passkeys.node`. Main loads that absolute
path. Electron Builder signs the `.node` file as nested code with inherited
hardened-runtime entitlements. After-pack verifies its universal slices; after-sign
verifies its signature and team and rejects the browser capability on the addon or
any nested helper app.

## Optional release capability

The default entitlement plists remain unchanged. Supply both inputs for the chosen
release channel:

| Channel | Profile path                        | Entitlement plist path                   |
| ------- | ----------------------------------- | ---------------------------------------- |
| Stable  | `OPENSTEER_PASSKEYS_STABLE_PROFILE` | `OPENSTEER_PASSKEYS_STABLE_ENTITLEMENTS` |
| Beta    | `OPENSTEER_PASSKEYS_BETA_PROFILE`   | `OPENSTEER_PASSKEYS_BETA_ENTITLEMENTS`   |

The entitlement input must contain exactly
`com.apple.developer.web-browser.public-key-credential = true`. The profile must
be a current Developer ID profile granting that capability to the release signing
certificate, team and the exact app ID: `com.opensteer.opensteer` for Stable or
`com.steerlabs.opensteer.beta` for Beta. Wildcard IDs are refused. Inputs for one
channel never enable the other. Development builds refuse these inputs.

`package-macos.ts` validates the inputs, generates a main-app entitlement plist
with the profile's team and app identifiers, and passes that plist and a staged
profile to Electron Builder. The inherited entitlement plist is unchanged. Certificate lookup uses the configured
keychain and requires a single valid matching identity. Before packaging, that
certificate must appear in the profile's `DeveloperCertificates`; after signing,
the app's extracted leaf certificate must appear in the embedded profile. A
same-team certificate rotation therefore requires an updated profile.
After-sign validates the main app's capability, identity, profile grant and expiry,
and compares the embedded profile with the supplied input. A release without these
inputs must contain neither the capability nor an embedded main-app profile.

## Qualification after approval

Host tests cover construction policy, malformed results, CBOR and SPKI decoding,
error mapping, aborts, deadlines, window loss, and late callbacks. They cannot prove
managed-entitlement acceptance or provider behavior. Before enabling this path,
qualify Developer ID signing, embedded profile acceptance, the real sheet and window
anchor, Touch ID, third-party providers, nearby-phone hybrid, security keys,
excluded credentials, cancellation and raw client-data serialization in a signed
app. Check both supported OS version boundaries and Intel/Apple silicon. Run screen
journeys in the repository's disposable VM, or use an explicitly authorized manual
signed-build qualification.
