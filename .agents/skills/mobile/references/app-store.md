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
- App Review notes naming the dedicated reviewer Google account and the steps below; the
  password goes only in App Store Connect's sign-in fields.

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

The phone reaches a personal Opensteer asynchronously only by Opensteer Account sign-in to a
computer with Connect on; pairing codes expire in ten minutes and there is no password door. So the
reviewer needs a dedicated, always-on personal Opensteer owned by a dedicated Google test account
(an existing test account or a free consumer account works), with no real data, messaging, shell or
private integrations. A team server runs no agents and cannot stand in; show team chat separately with the
[team-server skill](../../team-server/SKILL.md) if at all.

Use an API-compatible desktop release. The demo computer can be a Linux VM running a release
package of an official immutable release:
build at that release's exact source and version with `OPENSTEER_DESKTOP_RELEASE=1`, taking the
Agent Phone APK, manifest and producer receipt unmodified from that release's Mac ZIP
(`Contents/Resources/personal-runtime/web/agent-phone/`), so every release check runs. A
contributor package cannot reach production services. Run it as its own user with Xvfb and an
unlocked Secret Service keyring (Electron refuses `basic_text`), enabled at boot. On it:

1. Settings → AI → Codex → Sign in → Use an API key instead, with a dedicated, spend-capped key;
   turn every other AI service Off so the sharing prompt names only OpenAI.
2. Settings → Account → Sign in with the reviewer Google account, then turn on Use from anywhere.
3. From a fresh simulator or phone: Sign in → Continue with Google, open the computer, accept AI
   sharing, get a reply and a follow-up, and answer a question. To exercise the durable Request
   path, explicitly ask the agent to use `ask_person`. Verify that a Request appears, answering
   it resumes the task and the reply uses the answer; a question written only in prose is no proof.

Snapshot the VM disk before replacing its deployment and after the clean review state is qualified;
restore the whole disk, since database, keyring and agent home travel together. Google may still
challenge an unfamiliar device; one successful sign-in does not prevent later challenges.

For listing screenshots, another trusted licensed runtime may be supplied through `--inputs` and
imported in a disposable guest if the pinned runtime lacks the required device types. Keep the
golden unchanged. Verify a cold boot and native screenshot dimensions, then capture the current app
on each required device; runtime qualification alone proves no app journey.
