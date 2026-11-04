# Test Agent Phone

Use the cheapest check for the changed contract; run device and database suites one at a time.
Device suites uninstall packages and change settings, so use only a reserved device. Afterwards stop
emulators you booted with `adb -s <serial> emu kill`, an `adb` server you started with
`adb kill-server`, and Gradle daemons with `apps/agent-phone/gradlew -p apps/agent-phone --stop`;
leave caller-owned devices running. Verify stream pixels by independent decoding (`FLAG_SECURE`
redaction). WebUSB needs the existing Electron VM journey.

```sh
pnpm exec vitest run packages/runner-auth/src/agent-phone-vectors.test.ts packages/runner-auth/src/agent-phone-wire.test.ts tests/computer-use-action-schema.test.ts apps/host/src/computer-use/display-stream-hub.test.ts
apps/agent-phone/gradlew -p apps/agent-phone :app:lint :app:testDebugUnitTest :app:assembleDebug :fixture:assembleDebug
```

Regenerate fixtures only for an intentional wire change: the TypeScript vector test with
`OPENSTEER_WRITE_AGENT_PHONE_VECTORS=1`, then the Kotlin tests with
`OPENSTEER_WRITE_WIRE_FIXTURE=1`, serially; rerun both without the flags.

## Emulator device suites

Install PostgreSQL, the Android SDK and the AVD `opensteer-agent-phone-<api>` for each API you
select (for example 30, 33, 36); the harness boots it headless unless `ANDROID_SERIAL` names a
caller-owned device. Pick the affected API boundaries and one file under
`apps/host/src/agent-phone/`: `agent-phone.device.test.ts` (setup and control),
`agent-phone-display.device.test.ts` (view and edit), `agent-phone-passwords.device.test.ts` (saved
login), `agent-phone-agent.device.test.ts` (real agent) or `agent-phone-update.device.test.ts`
(self-update).

```sh
OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone -- apps/host/src/agent-phone/agent-phone.device.test.ts
OPENSTEER_AGENT_PHONE_API=33 pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-display.device.test.ts -t 'native phone editing'
ANDROID_SERIAL=emulator-5592 OPENSTEER_AGENT_PHONE_API=36 OPENSTEER_AGENT_PHONE_SELF_UPDATE=1 pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-update.device.test.ts
```

- The update journey builds its own same-test-signer baseline; never substitute product keys. It
  must keep identity, pairing, access and declines.
- Real-agent runs need `OPENSTEER_AGENT_PHONE_AGENT_ENGINE=claude` or `codex`, its sign-in, and a
  non-loopback IPv4 origin both emulator and Runner reach (`10.0.2.2` is not shared).
- `OPENSTEER_AGENT_PHONE_REBOOTS=10` is for release qualification (default 1).
- Soak only for an explicit soak purpose: `OPENSTEER_AGENT_PHONE_API=36 pnpm test:agent-phone:soak`.
  Require at least 99% successful scheduled cycles, missed cycles counting as failures, and no
  duplicate fixture effects. Controls are in `agent-phone.soak.test.ts`.

## Instrumentation

Native display, with ffmpeg and ffprobe installed and `emulator-5580` free; the runner stops its own
emulator, not the `adb` server, and accessibility is enabled after attaching:

```sh
apps/agent-phone/gradlew -p apps/agent-phone :app:assembleDebug :fixture:assembleDebug :app:assembleDebugAndroidTest -PopensteerInstrumentation=com.opensteer.agentphone.display.DisplayInstrumentation
python3 apps/agent-phone/scripts/test-display.py --api 36 --artifacts /absolute/path/to/evidence
```

Keystore identity, on a dedicated **unpaired** emulator (it uses the production slot and refuses an
existing identity):

```sh
apps/agent-phone/gradlew -p apps/agent-phone assembleDebug assembleDebugAndroidTest
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5570 shell am instrument -w -r com.opensteer.agentphone.test/com.opensteer.agentphone.runner.IdentityStoreInstrumentation
```

Fixture receipts: build `:fixture:assembleDebug :fixture:assembleDebugAndroidTest`, install both
APKs from `apps/agent-phone/fixture/build/outputs/apk/`, and instrument
`com.opensteer.agentphone.fixture.test/com.opensteer.agentphone.fixture.TextReceiptInstrumentation`.
It replaces receipt history; require every case `passed: true` and `INSTRUMENTATION_CODE: -1`.
Inspect and clear effects on the selected serial:

```sh
adb -s emulator-5570 shell content query --uri content://com.opensteer.agentphone.fixture.receipts/receipts
adb -s emulator-5570 shell content delete --uri content://com.opensteer.agentphone.fixture.receipts/receipts
```

## Expo viewer and benchmark

Expo viewer acceptance: build the native apps with the [mobile skill](../../mobile/SKILL.md),
reserve a second emulator and ports 18766 and 18767, and set `OPENSTEER_AGENT_PHONE_EXPO=1`,
`OPENSTEER_EXPO_IOS_SIMULATOR=<UDID>`, `OPENSTEER_EXPO_IOS_APP=/absolute/Opensteer.app` and
`OPENSTEER_EXPO_ANDROID_APK=/absolute/app-debug.apk` on the display journey.

Display benchmark, with Playwright's pinned Chromium and a dedicated booted emulator you keep
owning:

```sh
ANDROID_SERIAL=emulator-5600 OPENSTEER_AGENT_PHONE_API=33 pnpm bench:phone-display
```

It uses the real phone, Host, client and headless WebCodecs over LAN, 4G and weak-cell proxy
profiles, and cleans up its own Host, databases, browser and proxies.
`OPENSTEER_PHONE_BENCH_WINDOW=1` measures negotiated viewer credit,
`OPENSTEER_PHONE_BENCH_WINDOWS=0,1,0,1,0,1` alternates three comparisons on one boot,
`OPENSTEER_PHONE_BENCH_OUT` sets an external evidence directory. For API 36 idle traffic,
`OPENSTEER_PHONE_BENCH_IDLE_MS=240000` must show several idle keyframes, one in the second half, and
frames throughout; encoders may
[count the I-frame interval in frames](https://developer.android.com/reference/android/media/MediaFormat#KEY_I_FRAME_INTERVAL),
so compare payload and wire rates separately. Canvas age and swipe-to-frame time are not screen or
input latency.

## Evidence

Set `OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR` outside the checkout, separately per suite, API and
engine (a suite may clear it), and verify `shasum -a 256 -c summary.sha256` or the real-agent
`SHA256SUMS`. Changes to reboot, OEM suspension or Advanced Protection behavior still need hardware.
