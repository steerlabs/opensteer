# Upload to the App Store

Tim's release recipe, not a per-change gate. Run it only when he asks and supplies
`MOBILE_SIGNING_TEAM` privately, on a Mac where Xcode is signed in to that team. Never read, export
or copy signing material.

The listing is `com.opensteer.opensteer`, bound to that bundle ID for good
([why](../../../../docs/mobile.md#identity)). Never delete it: Apple then refuses the ID and the
name. A new version replaces the old one when it is released.

Apple-side prerequisites, all Tim's:

- App IDs `com.opensteer.opensteer` and `com.opensteer.opensteer.NotificationService`, both with the
  App Group `group.com.opensteer.mobile.notifications`; the app also with Push Notifications.
- "iPhone and iPad Apps on Apple Silicon Macs" turned off: the Mac app shares this bundle ID.
- App Review notes pointing at the demo server, with its address and password.

From a clean, full-history checkout of the selected commit, with an absolute `MOBILE_EVIDENCE_DIR`
outside it. The version is the desktop's derived number, not `package.json`'s base: a base would
repeat, and Apple refuses a released version twice. Create that version in App Store Connect. A
version's build numbers must only rise, so take the next one from App Store Connect.

```sh
mkdir -p "$MOBILE_EVIDENCE_DIR"
pnpm install --frozen-lockfile
MOBILE_VERSION=$(node -p 'require("./scripts/release-version.cjs").stampReleaseVersion(process.cwd(), process.argv[1])' "$(git rev-parse HEAD)")
unset EXPO_PUBLIC_OPENSTEER_MOCK EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE
export EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN="https://accounts.opensteer.com"
export EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN="https://app.opensteer.com"
export OPENSTEER_MOBILE_BUILD_NUMBER="<next build number>"
export RCT_USE_RN_DEP=0 RCT_USE_PREBUILT_RNCORE=0
CI=1 pnpm --filter @opensteer/mobile exec expo prebuild --platform ios --no-install
(cd apps/mobile/ios && pod install)
xcodebuild -workspace apps/mobile/ios/Opensteer.xcworkspace -scheme Opensteer \
  -configuration Release -destination generic/platform=iOS \
  -archivePath "$MOBILE_EVIDENCE_DIR/Opensteer.xcarchive" \
  DEVELOPMENT_TEAM="$MOBILE_SIGNING_TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates archive
plutil -create xml1 "$MOBILE_EVIDENCE_DIR/export.plist"
plutil -insert method -string app-store-connect "$MOBILE_EVIDENCE_DIR/export.plist"
plutil -insert destination -string upload "$MOBILE_EVIDENCE_DIR/export.plist"
plutil -insert signingStyle -string automatic "$MOBILE_EVIDENCE_DIR/export.plist"
plutil -insert teamID -string "$MOBILE_SIGNING_TEAM" "$MOBILE_EVIDENCE_DIR/export.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$MOBILE_EVIDENCE_DIR/Opensteer.xcarchive/Info.plist")" = "$MOBILE_VERSION" &&
  xcodebuild -exportArchive -archivePath "$MOBILE_EVIDENCE_DIR/Opensteer.xcarchive" \
  -exportPath "$MOBILE_EVIDENCE_DIR/export" \
  -exportOptionsPlist "$MOBILE_EVIDENCE_DIR/export.plist" -allowProvisioningUpdates
```

Before exporting, check that the archive's app and extension Info.plists show the same version and
build number, and that its bundle holds the Account origin. Upload warnings about privacy manifests
or export compliance are answers Tim gives in App Store Connect; never declare them on his behalf.
Send a build to external TestFlight before submitting for review.

## Review demonstration

Reviewers need a dedicated personal Opensteer on a disposable computer for agent tasks; a team
server runs no agents and cannot replace it. Use a funded test engine account and sample data,
never a person's real credentials or files. Pair the reviewer through the supported personal
remote-access flow, and snapshot the disposable stack for restoration after review.

Demonstrate shared chat separately with the [team-server skill](../../team-server/SKILL.md).
First-owner setup needs public HTTPS and Account adoption; invite the reviewer as a test member.
Keep the personal computer available for agent demonstrations and show offline team chat
separately. Do not use removed server-kind/local-password configuration.
