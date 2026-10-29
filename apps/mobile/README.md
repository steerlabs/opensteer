# @opensteer/mobile

The Opensteer iOS and Android app, on Expo SDK 58. `docs/mobile.md` describes what it is and why it
is built this way; this file is only how to run it.

## Running it

The app needs a custom dev client — it registers the `com.opensteer.mobile` scheme the OAuth
callbacks return to, which Expo Go cannot do. Building one also generates `ios/` and `android/`
from `app.config.ts`; neither directory is tracked.

iPhone Duo support requires Xcode 27.1 and an iOS 27.1 runtime. Expo's generated scene lifecycle
owns startup and links; the configuration keeps one scene. Build and export checks alone do not
qualify folding, native OAuth or notification delivery. Use cheap affected tests first,
and reuse one journey per user-facing flow when native acceptance is needed. Native
checks use the reserved VM/device workflow in [Testing](../../docs/testing.md#gui-test-vms).

```sh
pnpm --filter @opensteer/mobile exec expo run:ios --device "iPhone 17 Pro"
pnpm --filter @opensteer/mobile exec expo run:android
```

Pass `--configuration Release` to see the app as it ships: a Debug build runs the development
overlay and Metro's own timing, and neither is what a person gets.

`EXPO_PUBLIC_OPENSTEER_MOCK=1` runs every screen against the in-memory Host in
`@opensteer/client/mock`, with no deployment to sign in to. It is read at build time, so set it on
the `run:ios` / `run:android` command, not afterwards.

Mock mode replaces authentication, the Host and notification registration with simulations, so a
build that is not a development one refuses to run it: the app shows a plain "this build cannot
run" message instead of a simulated product. Two bundle-time literals open that door and nothing
else can — Metro's `__DEV__`, true in a development bundle, and
`EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE=development|preview`, which the build command sets. A Release
native build has `__DEV__` false, so seeing mock mode as it ships needs the profile:

```sh
EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE=development EXPO_PUBLIC_OPENSTEER_MOCK=1 \
  pnpm --filter @opensteer/mobile exec expo run:ios --configuration Release --device "iPhone 17 Pro"
```

Never set `EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE` on a build anyone but a developer will install.

`EXPO_PUBLIC_OPENSTEER_MOCK_HOME=absent` starts the mock Host without Chat, to exercise the
first-message screen. Everything else in the mock stays, so it tests a Deployment with no Home
rather than an empty one. A Chat created in it lasts until the app relaunches, because the mock
Host is in memory; unsent drafts are kept on the phone like any others. It proves nothing about a
real server.

```sh
EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE=development EXPO_PUBLIC_OPENSTEER_MOCK=1 \
  EXPO_PUBLIC_OPENSTEER_MOCK_HOME=absent \
  pnpm --filter @opensteer/mobile exec expo run:ios --configuration Release --device "iPhone 17 Pro"
```

To check that the Metro graph still resolves without building anything native:

```sh
pnpm --filter @opensteer/mobile exec expo export --platform ios --output-dir /tmp/mobile-export-ios
```

## Standalone iPhone beta installation

This is a founder/release installation recipe, not a gate before each feature submission.
Use a clean checkout of the selected commit and keep build products, logs and receipts outside
it. Changes land through pull requests after GitHub `Check` succeeds. Supply the
Account configuration, signing team and reserved device identifier privately; the device must be
paired, reachable and covered by the development provisioning profile. This installs a signed
Release app directly, using the existing `com.opensteer.mobile` identity.

From that checkout, with an absolute `MOBILE_EVIDENCE_DIR` and the private `MOBILE_DEVICE_ID` and
`MOBILE_SIGNING_TEAM` supplied by the operator:

```sh
mkdir -p "$MOBILE_EVIDENCE_DIR"
pnpm install --frozen-lockfile
# Supply the intended Account configuration without mock or development/preview flags.
CI=1 pnpm --filter @opensteer/mobile exec expo prebuild --platform ios --no-install
(cd apps/mobile/ios && pod install)
xcodebuild -workspace apps/mobile/ios/Opensteer.xcworkspace -scheme Opensteer \
  -configuration Release -sdk iphoneos -destination "id=$MOBILE_DEVICE_ID" \
  -derivedDataPath "$MOBILE_EVIDENCE_DIR/DerivedData" \
  DEVELOPMENT_TEAM="$MOBILE_SIGNING_TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates build
MOBILE_APP_PATH="$MOBILE_EVIDENCE_DIR/DerivedData/Build/Products/Release-iphoneos/Opensteer.app"
codesign --verify --deep --strict "$MOBILE_APP_PATH"
test -s "$MOBILE_APP_PATH/main.jsbundle"
xcrun devicectl device install app --device "$MOBILE_DEVICE_ID" "$MOBILE_APP_PATH" \
  --json-output "$MOBILE_EVIDENCE_DIR/install.json" --timeout 120
xcrun devicectl device process launch --device "$MOBILE_DEVICE_ID" com.opensteer.mobile \
  --json-output "$MOBILE_EVIDENCE_DIR/launch.json" --timeout 30
```

Before installation, verify the built Info.plist bundle identifier and version against
`app.config.ts` and the root package version, and confirm mock mode is disabled in the build
inputs. Retain the clean source SHA, tool versions, signing verification, embedded bundle checksum
and build log. Afterwards, record installed app metadata and running process evidence with
`devicectl device info apps` and `devicectl device info processes`. The embedded bundle lets the
app run without Metro. Reusing the app identity updates the existing installation; do not uninstall
it to perform an update.

A successful build, install or process launch does not prove a user journey. For founder/release
acceptance, reuse one journey for the affected flow and record whether the saved deployment
opens and the requested interactions work; do not add an artifact per edge case. Run
GUI/native automated journeys through `pnpm test:vm`; reserve physical devices for their assigned
owner. Keep device identifiers and private configuration out of published receipts.

## Build-time variables

The `EXPO_PUBLIC_*` ones are baked into the bundle and none of them can hold a secret.
`src/config.ts` parses them and refuses to start on a value it does not recognise.

| Variable                                | Meaning                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN`  | The Opensteer Account service this build signs in to. Unset builds have no Account.                                        |
| `EXPO_PUBLIC_OPENSTEER_MOCK`            | `1` runs the app against the mock Host. Anything but `0` or `1` is an error.                                               |
| `EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE`   | `development` or `preview` lets a non-`__DEV__` bundle run mock mode. `production`, or unset, refuses it.                  |
| `EXPO_PUBLIC_OPENSTEER_MOCK_HOME`       | `absent` starts the mock Host without Chat. It needs mock mode, so only where mock mode runs; any other value is an error. |
| `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE` | Path to this Android build's `google-services.json`. Read by `app.config.ts` only; never in the bundle.                    |

`OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE` is a prebuild input, not a bundle variable: Expo's Android
push token is an FCM token and needs the Firebase sender that file names. The file is never
committed — it binds a build to one Firebase project — so the build command supplies it:

```sh
OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE=/path/to/google-services.json \
  pnpm --filter @opensteer/mobile exec expo run:android
```

Set but unusable — empty, or naming a file that is not there — stops the configuration with the
reason rather than failing a native build later. Without it the config omits
`android.googleServicesFile` and records `extra.androidPushConfigured: false`; Settings → Notifications then says "This build was made
without Android push credentials" instead of asking the operating system for a token that cannot
exist. Check either shape with `expo config --type introspect`. iOS needs none of this.
