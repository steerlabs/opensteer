---
name: build-mobile-app
description: Build and run the Opensteer custom Expo client on an owned simulator or device, including mock mode.
---

# Build and run mobile

The app needs a custom dev client — it registers the `com.opensteer.mobile` scheme the OAuth
callbacks return to, which Expo Go cannot do. Building one also generates `ios/` and `android/`
from `app.config.ts`; neither directory is tracked.

iPhone Duo support requires Xcode 27.1 and an iOS 27.1 runtime. Expo's generated scene lifecycle
owns startup and links; the configuration keeps one scene. Build and export checks alone do not
qualify folding, native OAuth or notification delivery. Use cheap affected tests first,
and reuse one journey per user-facing flow when native acceptance is needed. Native
checks use the reserved VM/device workflow in [Testing](../../../docs/testing.md#gui-test-vms).

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

Set `LANG=en_US.UTF-8` (or another UTF-8 locale). Point `xcode-select` at full
Xcode, not Command Line Tools. In the iOS Simulator, the Mac loopback reaches
`pnpm dev` at `http://localhost:43100`; no Account service means no push.
Run GUI work only in the reserved VM/device workflow in `docs/testing.md`.
Stop Metro, servers and owned devices after the check.

For Android push, provide the private prebuild file:

```sh
OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
  pnpm --filter @opensteer/mobile exec expo run:android
pnpm --filter @opensteer/mobile exec expo config --type introspect
```

Never commit that file. See `docs/mobile.md#6-notifications` for push delivery constraints.
