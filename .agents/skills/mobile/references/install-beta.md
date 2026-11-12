# Install a signed iPhone beta

A founder and release recipe, not a per-change gate. Run it only when Tim asks and supplies the
signing team and device identifier privately. The device must be paired, reachable and in Developer
Mode; a new device needs the team's current Apple Program License Agreement accepted. Reusing
`com.opensteer.opensteer` updates the existing install: never uninstall to update. Bake both origins
into the build: the Account origin enables Account sign-in and Connect; the portal origin enables
account deletion and sharing the Mac download link.

From a clean checkout of the selected commit, with an absolute `MOBILE_EVIDENCE_DIR` outside it and
the private `MOBILE_DEVICE_ID` and `MOBILE_SIGNING_TEAM`:

```sh
mkdir -p "$MOBILE_EVIDENCE_DIR"
pnpm install --frozen-lockfile
unset EXPO_PUBLIC_OPENSTEER_MOCK
export EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN="https://accounts.opensteer.com"
export EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN="https://app.opensteer.com"
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
grep -qF "${EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN:?}" "$MOBILE_APP_PATH/main.jsbundle"
xcrun devicectl device install app --device "$MOBILE_DEVICE_ID" "$MOBILE_APP_PATH" \
  --json-output "$MOBILE_EVIDENCE_DIR/install.json" --timeout 120
xcrun devicectl device process launch --device "$MOBILE_DEVICE_ID" com.opensteer.opensteer \
  --json-output "$MOBILE_EVIDENCE_DIR/launch.json" --timeout 30
```

Before installing, check the built Info.plist bundle ID and version against `app.config.ts` and the
root package version, and that mock mode is off. Keep the source SHA, tool versions, signing
verification, bundle checksum and build log; afterwards record `xcrun devicectl device info apps`
and `xcrun devicectl device info processes`. For acceptance, reuse one journey for the affected
flow. Keep device IDs and private configuration out of published receipts.

## Private preview signing and acceptance

Tim alone registers the App IDs `com.opensteer.opensteer` and
`com.opensteer.opensteer.NotificationService`, creates the App Group
`group.com.opensteer.mobile.notifications` and provisions both targets. Both carry
application-groups only; never add keychain-access-groups. Preview Keychain items use the App Group
explicitly; existing login credentials keep their default group. The extension needs no APNs key,
topic or background mode.

With Tim's provisioning and the device's owner, verify both targets' entitlements and signed
delivery: authenticated text; generic text on tamper, expiry or missing key; before first unlock;
the reinstall marker; Deployment and Account sign-out; foreground suppression. On Android, tap two
successive alerts for one Thread (A then B) and check both navigate; the merged manifest has one
`MESSAGING_EVENT` service, Opensteer's subclass. Unsigned builds qualify none of this.
