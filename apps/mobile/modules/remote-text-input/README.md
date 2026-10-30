# Remote text input

`src/editing-proxy.tsx` is the Expo adapter shared by browser, phone and Mac viewers.
It holds the current `@opensteer/client/editing` state and calls
`reduceEditing` directly for every event, preserving native delivery order. The shared core owns
command bindings, verified replacements, selection movement, composition transactions and
held-key cleanup. Native snapshots include the declared UTF-16 `markedRange` boundary.
This module requires a rebuilt custom mobile client; a Metro export alone cannot add it
to an installed binary.

UIKit uses `UITextView`/`UITextInput`; Android wraps `EditText.onCreateInputConnection`,
including marked ranges, replacements, hardware keys and clipboard actions. Events are parsed
at the bridge. Each native default waits for its acknowledgement. Event-generated proxy `set` instructions
travel in that numbered acknowledgement, after its default and before the FIFO drains later
input. The native side refuses sets while text is marked. Old-context text is fenced, while
composition endings, blur and key releases reach the reducer so transactions and held keys can
close. Pointer interruptions commit the old preedit before target pointer dispatch; pointer
and command interruptions request the native composition-ending API from an effect. The reset
returned by the actual composition-end event travels in that event's acknowledgement. Context replacement also uses this FIFO: the old marked text ends with
its old context ID, and its acknowledgement precedes resetting text and applying the new field
traits. Input queued for the new context remains behind that boundary. React does not issue a
second finish or reset command for a context replacement. Removed native views cannot report
late command failures to their replacements. Refused or stale editing keeps the keyboard
focused; authoritative blur, Done and release still dismiss it. Queued keys sample composition state when
dispatched, after earlier context and composition work. Android requests the soft keyboard
when the native window gains focus. A standalone soft Return carries line-break intent
to the shared reducer, which emits an Enter action. Android clipboard chords use the
native intent path independently of the proxy’s local selection; copied text comes from
the target.

`apps/mobile/src/browser/browser-editing.ts` uses `hostClient.browserFrames.editing.target`. The shared client owns
negotiation, socket order, exact legacy projection, clipboard operation IDs, parts and results.
Only the active page activates clipboard delivery; the old socket observer is removed.
`src/legacy-input.tsx` supplies plain baseline typing when no editing context is available.
It disables corrections and refuses replacements rather than rebuilding the remote field.
Return submits with `submitBehavior="submit"`, retaining native focus for continued typing.
An explicit Backspace sends one down/up key pair, including when the proxy has text; its local
deletion echo updates only that proxy. Plain insertions pass through the shared legacy projection to `clipboard.paste`; keystrokes
with text project to `input.key`.

Phone task and Mac owner screens opt in to interaction; grid previews keep baseline passive sockets.
`apps/mobile/src/computers/display-input.tsx` retains the display transport with `editing: 1`, and mounts this proxy while the person uses Keyboard. The shared
`DisplayEditingSession` owns editing context, operations, correlated receipts, clipboard results
and bounded paste batches. Connection and display-generation changes retire pending
operations. The native view keeps preedit local and maps touches through the displayed frame's
letterboxing and generation, cancelling a touch on layout changes. Copy results use
`expo-clipboard`; empty/refused results leave it alone. Cut and nontext paste are visibly
refused. Blur, Done, leaving and backgrounding reset input and cancel local composition.

The native clipboard port writes plain text, HTML (with OS-derived plain text) or an image in
arrival order. Expo's public API cannot atomically preserve arbitrary mixed image/HTML or
multiple items; unsupported formats are reported. Neither native bridge compilation nor a
scripted component journey qualifies a real soft keyboard.

Mac owner views on Android accept shared input with their own owner-view authority.
See [the shared display contract](../../../../docs/computer-use.md#negotiated-mac-owner-input).
iOS Mac video is unavailable.

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
