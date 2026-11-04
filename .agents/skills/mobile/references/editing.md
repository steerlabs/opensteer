# Remote editing and display viewing

Paths under `tests/native/` are relative to `apps/mobile/modules/remote-text-input`. Never label
scripted `setMarkedText` or `InputConnection` operations as keyboard recordings: autocorrect,
predictive, Japanese, Korean, emoji and Gboard re-composition or swipe-delete need actual keyboard
input with provenance, replayed into the shared reducer. `expo export` checks Metro only.

```sh
pnpm exec vitest run apps/mobile/modules/remote-text-input/tests/page.interaction.test.tsx apps/mobile/modules/remote-text-input/tests/native-view.interaction.test.tsx apps/mobile/src/computers/phone-display.interaction.test.tsx apps/mobile/src/screens/workspace-browser.interaction.test.tsx
pnpm --filter @opensteer/mobile typecheck
```

The display journey mocks the native decoder and input and writes `display-journey.json` to
`OPENSTEER_MOBILE_EDITING_EVIDENCE_DIR` (default `/tmp/opensteer-mobile-editing`).

## Native journeys

`tests/native/journey.tsx` is a Metro entry for a built custom client, with the real native module,
reducer, display session and clipboard but a local protocol fixture as producer: it qualifies no
real Host, phone producer or decoder. `tests/native/serve-journey.ts` proxies Metro on 18767 through
18766 and records events under `OPENSTEER_NATIVE_JOURNEY_EVIDENCE_DIR`. Run both servers only in a
granted device job, open `com.opensteer.mobile://expo-development-client/?url=` with the coordinator
URL encoded, and stop both after.

Commit first. The iOS harness owns its simulator and exports XCTest, JSONL and PNG evidence:

```sh
pnpm test:vm -- --mobile bash -c 'cd ../mobile; bash modules/remote-text-input/tests/native/run-ios.sh'
```

On Android, `tests/native/android/RemoteEditingJourneyTest.kt` runs the full client against the
fixture (composition-ending delivery, then Return keeping focus); it tests scheduling and blur, not
soft IMEs. With the coordinator and Metro up and dev-client onboarding done, and no concurrent
`uiautomator` helpers, under the shared Android emulator lock:

```sh
apps/mobile/android/gradlew -p apps/mobile/android -I "$PWD/apps/mobile/modules/remote-text-input/tests/native/app-journey.gradle" :app:assembleDebug :app:assembleDebugAndroidTest
adb -s <serial> shell am instrument -w -e class com.opensteer.remotetextinput.RemoteEditingJourneyTest com.opensteer.mobile.test/androidx.test.runner.AndroidJUnitRunner
```

**Keyboard recordings.** Build `:remote-text-input:assembleDebugAndroidTest` from the generated
project, take the Android lock and install the test APK. Launch
`com.opensteer.remotetextinput.NativeKeyboardRecorderActivity` with `--es case <case-name>`: it
shows the production proxy to the installed IME and writes `files/<case>.jsonl`.
`NativeKeyboardControlActivity` is a plain `EditText` control; the Boolean extra `standard` drops
`NO_PERSONALIZED_LEARNING`. Force-stop the test package before changing case or flags. Keep the
keyboard and version, device build, steps and screenshots with each trace before adding it as a
replay fixture.

## Viewer editing on web and desktop

```sh
pnpm exec vitest run apps/web/src/components/phone-display.test.tsx packages/client/src/integrations/phone-display-stream.test.ts apps/host/src/computer-use/display-editing-viewer.journey.test.ts
pnpm test:vm -- bash ../web/scripts/run-display-editing-desktop-smoke.sh
pnpm test:vm -- bash ../web/scripts/run-display-editing-viewer-checks.sh
```

The Host journey runs real display routes over TCP with fake authorization and producers;
`OPENSTEER_DISPLAY_EDITING_EVIDENCE_DIR` keeps its report and wire, and its `baseline-host` cases
strip viewer opt-in rather than run an old Host. The VM smoke uses a fake producer with the real
decoder and transport (`artifacts/display-editing/`); the batched checks add the Chromium viewer
journey (`artifacts/display-editing-browser`). Neither qualifies target applications.

## H.264 display fixtures

Fixtures in `apps/mobile/modules/phone-display/tests/native/fixtures` are VideoToolbox Baseline, no
B-frames, 2.5 Mbps, GOP 60, Annex B with AUD and SPS/PPS on keyframes. `mac.h264` (1512×982) and
`resized.h264` (1280×800) are two concatenated lavfi colour sources, lime then blue, rate 2, 0.5 s
each, encoded with
`-frames:v 2 -c:v h264_videotoolbox -profile:v baseline -bf 0 -g 60 -b:v 2500k -bsf:v h264_metadata=aud=insert -f h264`.
`mac-high.h264` re-encodes `mac.h264` with `-profile:v constrained_high`. `noisy.h264` is one frame
of `nullsrc=size=1920x1248:rate=30,geq=lum=random(1)*255:cb=random(2)*255:cr=random(3)*255` with
`-frames:v 1` and the same options. The 128×128 lime key and blue delta use the same recipe.
