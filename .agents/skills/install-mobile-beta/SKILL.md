---
name: install-mobile-beta
description: Install a signed standalone Opensteer iPhone beta on the reserved physical device for founder acceptance.
---

# Install mobile beta

This is a founder/release installation recipe, not a gate before each feature submission.
Use a clean checkout of the selected commit and keep build products, logs and receipts outside
it. Changes land through pull requests after GitHub `Check` succeeds. Supply the signing team and
reserved device identifier privately. The device must be paired, reachable and in Developer Mode
(Settings → Privacy & Security). Registering a new device needs the team's current Apple Program
License Agreement accepted. This installs a signed Release app directly, using the existing
`com.opensteer.mobile` identity.

The app reaches a loopback-only Personal Host only through Connect, which needs the Account origin
baked into the bundle. Use the `accountUrl` of the desktop channel the phone pairs with, for example
`apps/desktop/src/releases/desktop-release.beta.json` for Beta. A build without it lists computers
but cannot reach them.

From that checkout, with an absolute `MOBILE_EVIDENCE_DIR` and the private `MOBILE_DEVICE_ID` and
`MOBILE_SIGNING_TEAM` supplied by the operator, and `EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN` set to that
channel's `accountUrl`:

```sh
mkdir -p "$MOBILE_EVIDENCE_DIR"
pnpm install --frozen-lockfile
unset EXPO_PUBLIC_OPENSTEER_MOCK EXPO_PUBLIC_OPENSTEER_MOCK_HOME
export EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN="${EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN:?Set the channel accountUrl}"
# Prebuilt React Native dependencies leave folly, glog and double-conversion unresolved
# when a Release build links, so build React Native from source.
export RCT_USE_RN_DEP=0 RCT_USE_PREBUILT_RNCORE=0
CI=1 pnpm --filter @opensteer/mobile exec expo prebuild --platform ios --no-install
(cd apps/mobile/ios && pod install)
xcodebuild -workspace apps/mobile/ios/Opensteer.xcworkspace -scheme Opensteer \
  -configuration Release -sdk iphoneos -destination "id=$MOBILE_DEVICE_ID" \
  -derivedDataPath "$MOBILE_EVIDENCE_DIR/DerivedData" \
  DEVELOPMENT_TEAM="$MOBILE_SIGNING_TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
MOBILE_APP_PATH="$MOBILE_EVIDENCE_DIR/DerivedData/Build/Products/Release-iphoneos/Opensteer.app"
codesign --verify --deep --strict "$MOBILE_APP_PATH"
test -s "$MOBILE_APP_PATH/main.jsbundle"
grep -qF "${EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN:?}" "$MOBILE_APP_PATH/main.jsbundle"
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

## Private preview signing and acceptance

Tim alone registers/enables the explicit App IDs `com.opensteer.mobile` and
`com.opensteer.mobile.NotificationService`, creates App Group
`group.com.opensteer.mobile.notifications`, associates both App IDs, and regenerates
or permits provisioning profiles for both targets. Agents never access Apple account
credentials or signing material. Both targets carry application-groups only for
preview sharing: do not add keychain-access-groups. Preview Keychain items explicitly
use the App Group identifier; existing login credentials retain their default group.
Parent retains Push Notifications; extension needs no APNs key/topic or background
mode. Account APNs topic stays `com.opensteer.mobile`.

After Tim supplies provisioning, verify both embedded targets' entitlements and
signed physical-device delivery with the reserved device owner: authenticated text,
generic text on tamper/expiry/missing key, before first unlock, reinstall marker,
Deployment and Account sign-out, and foreground suppression. On Android deliver two
successive same-Thread alerts, tap A then B, and verify both navigate. Inspect the
merged manifest for one MESSAGING_EVENT service (Opensteer's subclass). Never record
keys, tokens or decoded payloads in evidence. An unsigned build does not qualify
these checks.
