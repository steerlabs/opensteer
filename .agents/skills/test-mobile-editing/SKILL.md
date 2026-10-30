---
name: test-mobile-editing
description: Test Opensteer mobile remote text input with focused JS checks, native fixtures and actual keyboard recordings.
---

# Test mobile editing

Run shell commands from the checkout root unless a command explicitly changes
directory. Abbreviated source references such as `tests/native/journey.tsx` are
relative to `apps/mobile/modules/remote-text-input`; paths beginning with `apps/`
are relative to the checkout root. Use the reserved VM/device workflow in
`docs/testing.md`; do not run GUI journeys on the host.

Run individual JS checks and the mobile typecheck:

```sh
pnpm exec vitest run apps/mobile/modules/remote-text-input/tests/page.interaction.test.tsx
pnpm exec vitest run apps/mobile/modules/remote-text-input/tests/native-view.interaction.test.tsx
pnpm exec vitest run apps/mobile/src/computers/phone-display.interaction.test.tsx
pnpm exec vitest run apps/mobile/src/screens/workspace-browser.interaction.test.tsx
pnpm --filter @opensteer/mobile typecheck
```

The display component journey uses the actual shared `DisplayStreams`, reducer and clipboard
port with mocked native decoder/input boundaries. It writes `display-journey.json` to
`OPENSTEER_MOBILE_EDITING_EVIDENCE_DIR` (default `/tmp/opensteer-mobile-editing`).
These are scripted interaction checks, not native keyboard traces or native pixel evidence.

`tests/native/journey.tsx` is a separate Metro entry for a built custom Expo client. It mounts
the production page keyboard (negotiated and baseline) and phone controls with the real native
module, reducer, display session and system clipboard port. Its display producer is explicitly
a local protocol fixture; this journey does not qualify a real Host, browser runtime, phone
producer or decoder. `tests/native/serve-journey.ts` proxies Metro on port 18767 through port
18766 and records events in a unique directory under `OPENSTEER_NATIVE_JOURNEY_EVIDENCE_DIR`
(the system temporary directory by default). Run both servers only in a granted device job,
open `com.opensteer.mobile://expo-development-client/?url=` with the coordinator URL encoded,
and stop both servers when finished.

Commit first and run the guest harness:

```sh
pnpm test:vm -- --mobile bash -c 'cd ../mobile; bash modules/remote-text-input/tests/native/run-ios.sh'
```

The iOS harness owns/deletes its simulator and exports XCTest, JSONL and PNG evidence. Its
hardware driver is separate from real US soft typing, autocorrect, predictive, Japanese,
Korean and emoji keyboard recordings. The Android instrumentation drives InputConnection
and does not record Gboard re-composition or swipe-delete. Those need actual keyboard input
with provenance, the shared Android lock, and replay into the shared reducer. Never label
scripted setMarkedText/InputConnection operations as native keyboard recordings. Native GUI
work runs through `pnpm test:vm`; stop the owned emulator, its adb server and release the
Android lock afterward. iOS and Android `expo export` check Metro only.

The Android test APK includes `NativeKeyboardRecorderActivity`, which presents the production
proxy to the actual installed IME and writes ordered packets to app-private
`files/<case>.jsonl`. It does not inject InputConnection calls. Build it from the generated
Android project with `:remote-text-input:assembleDebugAndroidTest`, acquire the Android lock,
install its test APK, and launch `com.opensteer.remotetextinput.NativeKeyboardRecorderActivity`
with `--es case <case-name>`. Preserve the actual keyboard/version, device build, interaction
steps and screenshots with each trace before adding it as a replay fixture.

`NativeKeyboardControlActivity` in the Android test APK is an independent ordinary
`EditText` with no custom `InputConnection` or acknowledgement gate. It records values
and composing spans to `files/<case>.jsonl`. It uses the proxy's keyboard flags by
default; the `standard` Boolean intent extra omits `NO_PERSONALIZED_LEARNING` for a
controlled comparison. Force-stop the test package before changing the case or flags:
Android can deliver a new intent to the existing root Activity without recreating it.
Neither this control nor the proxy recorder qualifies the full Expo/remote target flow.

`tests/native/android/RemoteEditingJourneyTest.kt` runs in the full custom Expo client against
that local protocol fixture. It queues `a` inside the native composition-ending delivery, rotates
the context, then inserts `b` and verifies the target is exactly `ab`. Its baseline case uses the
real RN `InputConnection.performEditorAction` listener to verify Return retains focus and accepts
subsequent typing. These InputConnection regressions exercise native scheduling and blur, not
Japanese/Korean soft-IME qualification. From the checkout root, build the app and its test APK
with `apps/mobile/android/gradlew -p apps/mobile/android -I "$PWD/apps/mobile/modules/remote-text-input/tests/native/app-journey.gradle" :app:assembleDebug :app:assembleDebugAndroidTest`.
The init script wires the fixture into the generated app without changing shipping build inputs.
With the coordinator and Metro running, invoke
`adb shell am instrument -w -e class com.opensteer.remotetextinput.RemoteEditingJourneyTest com.opensteer.mobile.test/androidx.test.runner.AndroidJUnitRunner`.
Complete dev-client onboarding before instrumentation; concurrent `uiautomator` helpers compete
with the instrumentation runner. Run one bounded device group under the Android emulator
lock, then stop the app, emulator, adb and fixture servers.
