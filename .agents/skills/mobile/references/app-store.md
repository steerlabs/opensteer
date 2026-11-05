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

From a clean checkout of the selected commit, with an absolute `MOBILE_EVIDENCE_DIR` outside it. A
version's build numbers must only rise, so take the next one from App Store Connect.

```sh
mkdir -p "$MOBILE_EVIDENCE_DIR"
pnpm install --frozen-lockfile
unset EXPO_PUBLIC_OPENSTEER_MOCK EXPO_PUBLIC_OPENSTEER_MOCK_HOME EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE
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
xcodebuild -exportArchive -archivePath "$MOBILE_EVIDENCE_DIR/Opensteer.xcarchive" \
  -exportPath "$MOBILE_EVIDENCE_DIR/export" \
  -exportOptionsPlist "$MOBILE_EVIDENCE_DIR/export.plist" -allowProvisioningUpdates
```

Before exporting, check that the archive's app and extension Info.plists show the same version and
build number, and that its bundle holds the Account origin. Upload warnings about privacy manifests
or export compliance are answers Tim gives in App Store Connect; never declare them on his behalf.
Send a build to external TestFlight before submitting for review.

## Move the push topic

Required. `deploy/account/account.env` keeps `OPENSTEER_APNS_TOPIC=com.opensteer.mobile` until the
first `com.opensteer.opensteer` build ships. When it does, on TestFlight or the App Store, change the
value to `com.opensteer.opensteer`; otherwise that build gets no push. Not before: every main push
deploys that file, the topic is one value, and moving it stops push on `com.opensteer.mobile` builds.

## Review demo server

Reviewers have no computer, and the mock Host is dev-only, so they get a real server Deployment from
[deploy/self-host](../../../../deploy/self-host/README.md) reached through "Other ways to connect",
"Add a server by address". It bypasses the Opensteer Account, and needs a public HTTPS address with a
certificate iOS trusts.

- Use an isolated Linux machine that holds nothing else: no cloud instance role, no production
  credentials, no SSH agent. Expose only TCP 80 and 443.
- Set `OPENSTEER_DEPLOYMENT_KIND=server`, `OPENSTEER_LOCAL_PASSWORD_ENABLED=true`,
  `OPENSTEER_NATIVE_OAUTH_ENABLED=true` and `OPENSTEER_SIGNUP_POLICY=invite-only`.
- Chat needs a Runner and a funded engine: a fresh Deployment has no Workspace or engine. Enroll the
  Runner with `allowedModules: ["agents"]` and connect a dedicated low-budget API key. Set remembered
  access to `approval-required`.
- Create sample conversations by using the product. Leave out anything the listing does not show.
- The reviewer signs in as the owner and can damage this Deployment, so snapshot the database, Host
  data, Runner state and configuration together, and restore all of them after each review.
