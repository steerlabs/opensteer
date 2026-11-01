---
name: test-agent-phone
description: Select and run focused Agent Phone wire, Android instrumentation, emulator or self-update checks when changing phone behavior.
---

# Test Agent Phone

Use the cheapest check for the changed contract. Read [Testing](../../../docs/testing.md)
and [phone constraints](../../../docs/agent-phone.md). Run device/database suites sequentially;
reserve one owner per emulator/USB phone. Device suites uninstall packages and change settings.
Never select an incidental physical phone. `ANDROID_SERIAL` selects a caller-owned device.

```sh
pnpm exec vitest run packages/runner-auth/src/agent-phone-vectors.test.ts packages/runner-auth/src/agent-phone-wire.test.ts tests/computer-use-action-schema.test.ts
pnpm exec vitest run apps/host/src/computer-use/display-stream-hub.test.ts
apps/agent-phone/gradlew -p apps/agent-phone :app:lint :app:testDebugUnitTest :app:assembleDebug :fixture:assembleDebug
```

Regenerate fixtures only for intentional wire changes: run the TypeScript vector test with
`OPENSTEER_WRITE_AGENT_PHONE_VECTORS=1`, then Kotlin tests with
`OPENSTEER_WRITE_WIRE_FIXTURE=1`, serially. Rerun both without write flags.

Install PostgreSQL, Android SDK and the selected named AVD (`opensteer-agent-phone-30`,
`opensteer-agent-phone-33` or `opensteer-agent-phone-36`). The harness boots headless.
Select one file under `apps/host/src/agent-phone/`: `agent-phone.device.test.ts` (setup/control),
`agent-phone-display.device.test.ts` (view/edit), `agent-phone-passwords.device.test.ts`
(saved login), `agent-phone-agent.device.test.ts` (real agent), or
`agent-phone-update.device.test.ts` (update).

```sh
OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone -- apps/host/src/agent-phone/agent-phone.device.test.ts
OPENSTEER_AGENT_PHONE_API=33 pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-display.device.test.ts -t 'native phone editing'
ANDROID_SERIAL=emulator-5592 OPENSTEER_AGENT_PHONE_API=36 OPENSTEER_AGENT_PHONE_SELF_UPDATE=1 pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-update.device.test.ts
```

Select API boundaries affected by the change, not a default full matrix. The update journey
builds its own same-test-signer older baseline. Do not manually replace it with product keys.
Real-agent runs require `OPENSTEER_AGENT_PHONE_AGENT_ENGINE=claude` or `codex`, that engine's
sign-in and a non-loopback IPv4 origin reachable by both emulator and Runner; `10.0.2.2`
is not a shared origin. An unavailable engine is skipped, not passed.

For native encoding/lifecycle acceptance, install ffmpeg/ffprobe and use an unoccupied
`emulator-5580` port. The runner shuts down its own emulator in `finally`, not the ADB server:

```sh
apps/agent-phone/gradlew -p apps/agent-phone :app:assembleDebug :fixture:assembleDebug :app:assembleDebugAndroidTest -PopensteerInstrumentation=com.opensteer.agentphone.display.DisplayInstrumentation
python3 apps/agent-phone/scripts/test-display.py --api 36 --artifacts /absolute/path/to/evidence
```

For Keystore identity regressions use a dedicated **unpaired** emulator; instrumentation
creates/deletes identities in the production slot and refuses an existing identity:

```sh
apps/agent-phone/gradlew -p apps/agent-phone assembleDebug assembleDebugAndroidTest
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5570 shell am instrument -w -r com.opensteer.agentphone.test/com.opensteer.agentphone.runner.IdentityStoreInstrumentation
```

For fixture receipt regressions substitute `:fixture:assembleDebug :fixture:assembleDebugAndroidTest`,
install the two APKs from `fixture/build/outputs/apk/`, and instrument
`com.opensteer.agentphone.fixture.test/com.opensteer.agentphone.fixture.TextReceiptInstrumentation`.
This replaces receipt history. Require every case `passed: true` and `INSTRUMENTATION_CODE: -1`.
Inspect actual effects with an explicit selected serial:

```sh
adb -s emulator-5570 shell content query --uri content://com.opensteer.agentphone.fixture.receipts/receipts
adb -s emulator-5570 shell content delete --uri content://com.opensteer.agentphone.fixture.receipts/receipts
```

For Expo viewer acceptance, build matching native apps using the mobile instructions, then
set `OPENSTEER_AGENT_PHONE_EXPO=1`, `OPENSTEER_EXPO_IOS_SIMULATOR=<UDID>`,
`OPENSTEER_EXPO_IOS_APP=/absolute/Opensteer.app` and
`OPENSTEER_EXPO_ANDROID_APK=/absolute/app-debug.apk` on the display journey. Reserve a second
Android emulator and ports 18766/18767. Do not create a separate mobile build workflow here.

Use `OPENSTEER_AGENT_PHONE_REBOOTS=10` for release qualification (default 1). Only for an
explicit long-soak purpose, run `OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone:soak`;
require at least 99% successful scheduled cycles and no duplicate fixture effects, counting
missed cycles as failures. See the soak source for duration/seed controls.

For display performance, boot a dedicated emulator first and run
`ANDROID_SERIAL=emulator-5600 OPENSTEER_AGENT_PHONE_API=33 pnpm bench:phone-display`.
The benchmark uses the real phone, Host, shared client and headless Chromium WebCodecs;
install Playwright's pinned Chromium first. It reuses the mobile network proxy's LAN,
4G and weak-cell profiles without changing system networking. Set
`OPENSTEER_PHONE_BENCH_WINDOW=1` to measure negotiated viewer credit,
`OPENSTEER_PHONE_BENCH_WINDOWS=0,1,0,1,0,1` for three alternating comparisons on one boot, and
`OPENSTEER_PHONE_BENCH_OUT` to an external evidence directory. It cleans up its Host,
database clones, browser and proxies; the caller still owns the selected emulator.
Canvas output and relay-to-canvas age do not measure a physical viewer's screen latency.
For API 36 idle traffic, set `OPENSTEER_PHONE_BENCH_IDLE_MS=240000`. Require multiple
idle keyframes, one in the second half, and received frames throughout the window.
Encoders can [convert the I-frame interval to a frame count](https://developer.android.com/reference/android/media/MediaFormat#KEY_I_FRAME_INTERVAL),
so low static-frame cadence stretches the configured period. Compare payload and wire rates separately.
The ADB swipe-to-next-frame metric is workload timing, not remote input effect latency.

For manual acceptance/release evidence, set `OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR` outside
the checkout, separately per suite/API/engine (a suite may clear it). Verify
`shasum -a 256 -c summary.sha256` or the real-agent `SHA256SUMS`; redact PIN digits.
ADB checks do not prove WebUSB; use the existing Electron VM journey for that.

On completion or failure, stop each server/capture loop you started with `kill <recorded-pid>`;
stop emulators you booted with `adb -s <serial> emu kill`, and an ADB server you started with
`adb kill-server`. Leave explicitly selected caller-owned devices running. Stop Gradle daemons
started for this work with `apps/agent-phone/gradlew -p apps/agent-phone --stop`.
