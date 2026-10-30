---
name: install-mobile-beta
description: Install a signed standalone Opensteer iPhone beta on the reserved physical device for founder acceptance.
---

# Install mobile beta

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
