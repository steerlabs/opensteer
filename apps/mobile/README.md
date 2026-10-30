# @opensteer/mobile

See [mobile constraints](../../docs/mobile.md) before changing lifecycle or authority.
Use [build-mobile-app](../../.agents/skills/build-mobile-app/SKILL.md) to run a
custom client and [install-mobile-beta](../../.agents/skills/install-mobile-beta/SKILL.md)
for a signed standalone iPhone install. Expo Go cannot supply this app's native
modules or OAuth scheme. Generated native directories are untracked.

## Build inputs

`src/config.ts` owns bundle configuration; `app.config.ts` owns native prebuild
inputs. Every `EXPO_PUBLIC_*` value is public. Never put secrets there or set a
development/preview profile on a build distributed beyond developers: those
profiles permit simulated authentication and Host behavior in Release bundles.

Android push requires the build's private `google-services.json`, supplied through
`OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE` at prebuild. It binds the app to a Firebase
project and is never committed. Builds without it cannot obtain an FCM token;
iOS does not use it.

Duo support requires Xcode 27.1 and an iOS 27.1 runtime. Preserve Expo's single-scene
lifecycle. Bundle/build success cannot qualify folds, native OAuth, keyboard or
notification delivery; use the reserved [native workflow](../../docs/testing.md#gui-test-vms).
