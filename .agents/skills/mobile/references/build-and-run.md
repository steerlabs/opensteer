# Build and run the mobile app

Expo Go cannot register the `com.opensteer.mobile` OAuth scheme, so build a custom dev client; that
generates untracked `ios/` and `android/` from `apps/mobile/app.config.ts`. Use a UTF-8 locale
(`LANG=en_US.UTF-8`) and point `xcode-select` at full Xcode. iPhone Duo support needs Xcode 27.1 and
an iOS 27.1 runtime.

```sh
pnpm --filter @opensteer/mobile exec expo run:ios --device "iPhone 17 Pro"
pnpm --filter @opensteer/mobile exec expo run:android
pnpm --filter @opensteer/mobile exec expo export --platform ios --output-dir /tmp/mobile-export-ios
```

The last checks only that the Metro graph resolves. The package's `ios`, `android` and `export`
scripts set `EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN=https://accounts.opensteer.com` and
`EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN=https://app.opensteer.com`; set them on direct Expo, Xcode or
Gradle builds too, or the bundle cannot register Account push or use Connect. To see the app as it
ships, add `--configuration Release` to `run:ios` or `--variant release` to `run:android`. In the iOS Simulator, `pnpm dev` is at
`http://localhost:43100`, with no push.

**Mock mode.** `EXPO_PUBLIC_OPENSTEER_MOCK=1`, set on the build command, runs every screen against
the in-memory Host in `@opensteer/client/mock`. Non-development builds refuse it ("This build cannot
run") unless Metro's `__DEV__` is true or `EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE=development|preview`
is set. Never set the profile on a build anyone but a developer installs.
`EXPO_PUBLIC_OPENSTEER_MOCK_HOME=absent` starts without Chat, for the first-message screen.

```sh
EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE=development EXPO_PUBLIC_OPENSTEER_MOCK=1 \
  pnpm --filter @opensteer/mobile exec expo run:ios --configuration Release --device "iPhone 17 Pro"
```

**Android push** needs the build's private `google-services.json` at prebuild; never commit it.

```sh
OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
  pnpm --filter @opensteer/mobile exec expo run:android
pnpm --filter @opensteer/mobile exec expo config --type introspect
```

Builds and exports do not qualify folding, native OAuth, keyboards, notification delivery, links,
saved-view linking or OS backup protection. Native H.264 viewing needs a binary declaring
`binaryPresentationVersion`; older binaries keep the placeholder after an OTA update.
