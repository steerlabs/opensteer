# Opensteer Agent Phone

Kotlin Android app that offers a dedicated phone's whole display to agents as an
`integrations`-only Runner. [Agent Phone](../../docs/agent-phone.md) owns setup, access,
security and runtime behavior; `fixture/` is the receipt-recording app for device tests.

Test selection follows [Testing](../../docs/testing.md#how-to-test):
use cheap focused regressions and reuse one journey per user-facing flow. These
recipes are available checks, not a per-change matrix. Preserve journey artifacts
only for manual acceptance or release checks; scripts may emit their own diagnostic files.

## Build and verify

Run these commands from the repository root, using its Node/pnpm pins. Install JDK 17 or newer,
Android SDK platform 36 and build tools 36.0.0. The build script uses `ANDROID_HOME`, falling
back to `~/Library/Android/sdk`. Gradle and Android/Kotlin dependency versions are pinned in
this project.

```sh
pnpm build:agent-phone
apps/agent-phone/gradlew -p apps/agent-phone :app:lint :app:testDebugUnitTest :app:assembleDebug :fixture:assembleDebug
pnpm exec vitest run packages/runner-auth/src/agent-phone-vectors.test.ts packages/runner-auth/src/agent-phone-wire.test.ts tests/computer-use-action-schema.test.ts
```

The Gradle line is the Android gate CI's `android` job and release checks run: lint, the JVM
unit tests and the debug app and fixture builds.

`pnpm build:agent-phone` builds the debug Agent Phone APK and writes:

| Destination                                     | Files                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| `apps/web/public/agent-phone/`                  | `opensteer-agent-phone.apk`, `agent-phone.json` |
| `apps/desktop/generated-resources/agent-phone/` | Same APK and manifest                           |

The manifest records the build type and comes from the signed APK, including SHA-256, size,
minimum SDK, version and signing-certificate digest. The script checks that APK debuggability
matches the selected build type and requires exactly one signer and APK Signature Scheme v2
or v3; a release must carry the pinned signer. `--output <directory>` writes the pair only
there instead. Gradle's original outputs remain under `app/build/outputs/apk/` and
`fixture/build/outputs/apk/`. Generated outputs are not source files.

Distributed release APKs come only from a release build: it runs
`pnpm build:agent-phone --release --output <directory>` on frozen source and records the
receipt that desktop packaging and the images verify. A desktop release package refuses any
other APK. Development packages may carry a debug build or none. A normal pnpm build does not
invoke Gradle.

## Release signing and test TLS

```sh
pnpm build:agent-phone --release
pnpm build:agent-phone --e2e-ca /absolute/path/to/test-ca.pem
```

A release requires all four environment variables:

- `OPENSTEER_AGENT_PHONE_KEYSTORE`
- `OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD`
- `OPENSTEER_AGENT_PHONE_KEY_ALIAS`
- `OPENSTEER_AGENT_PHONE_KEY_PASSWORD`

A release build supplies them: the keystore path and alias, and one password for both store
and key. Gradle's
`verifyReleaseSigning` fails a release build without them; nothing falls back to debug
signing. Only the permanent key passes the pinned-signer check. Debug and release APKs use the
same package name, so switching signing keys requires uninstalling and losing app data.
Versioning follows
root `package.json`: `versionName = major.minor.patch`,
`versionCode = major * 1,000,000 + minor * 1,000 + patch`, with minor/patch below 1000.

The network security configurations are static XML. Release builds trust system CAs only
([`main`](app/src/main/res/xml/network_security_config.xml)); debug builds also trust
user-installed CAs ([`debug`](app/src/debug/res/xml/network_security_config_debug.xml)). Each
allows cleartext only to `localhost` and `127.0.0.1`. `--e2e-ca` passes `-PopensteerE2eCa`,
which copies the PEM into the debug build's resources and selects
[`e2e`](app/src/e2e/res/xml/network_security_config_e2e.xml), which also trusts it, so device
E2E can use a TLS Host without putting ADB in the Runner's network data path. It also builds
the debug fixture APK and writes `opensteer-agent-phone.apk`, `agent-phone.json` and
`agent-phone-fixture.apk` only to `apps/agent-phone/build/e2e/`; it leaves the web and desktop
artifacts untouched. Normal debug and release builds do not build the fixture. Combining
`--release` and `--e2e-ca` fails.

[libs.versions.toml](gradle/libs.versions.toml) pins OkHttp 5.4.0 because 5.5.0 requires
compileSdk 37 while this app compiles against 36. Bouncy Castle supplies Ed25519 on API levels
before Android's platform implementation. Runtime dependency notices live in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Wire fixtures and device receipts

Normal Kotlin tests compare the TypeScript golden vectors and Kotlin wire fixture; they do
not rewrite source fixtures. For intentional changes only, use
`OPENSTEER_WRITE_AGENT_PHONE_VECTORS=1` with the TypeScript vector test and
then `OPENSTEER_WRITE_WIRE_FIXTURE=1` with Kotlin tests, serially in that order, then run both sides
again without write flags. The
[Host wire test](../../packages/runner-auth/src/agent-phone-wire.test.ts) verifies the Kotlin
frames with the production parsers and signature verifiers.

The end-to-end suite in `apps/host/src/agent-phone`
([how to run it](../../docs/agent-phone.md#11-verification)) builds with `--e2e-ca` and
installs `apps/agent-phone/build/e2e/agent-phone-fixture.apk` itself. The fixture app is
`com.opensteer.agentphone.fixture`; its SQLite-backed provider records interactions in order
and survives fixture process death. Read or clear receipts with:

```sh
adb shell content query --uri content://com.opensteer.agentphone.fixture.receipts/receipts
adb shell content delete --uri content://com.opensteer.agentphone.fixture.receipts/receipts
```

Receipts contain `_id`, `at`, `kind` and `detail`. Use them to verify effects alongside screenshots;
a wire fixture alone cannot verify an Android gesture or lifecycle recovery.

The fixture's text-receipt regression uses real Android Views and SQLite. It distinguishes
accessibility writes from repeated text callbacks, including identical writes and rejected
attempts. Run it on a dedicated emulator; it replaces the fixture's receipt history:

```sh
apps/agent-phone/gradlew -p apps/agent-phone :fixture:assembleDebug :fixture:assembleDebugAndroidTest
adb -s emulator-5570 install -r apps/agent-phone/fixture/build/outputs/apk/debug/fixture-debug.apk
adb -s emulator-5570 install -r apps/agent-phone/fixture/build/outputs/apk/androidTest/debug/fixture-debug-androidTest.apk
adb -s emulator-5570 shell am instrument -w -r com.opensteer.agentphone.fixture.test/com.opensteer.agentphone.fixture.TextReceiptInstrumentation
```

For manual acceptance or a release check, save the JSON with its device artifacts. All five cases must report `passed: true`
and the native result must be `INSTRUMENTATION_CODE: -1`.

Version-2 identity JSON keeps the Runner signing key and removes the approval seed. The reader
accepts version 1, discards `approvalKeySeed` and preserves the Runner key, Runner/Deployment/enrollment
ids, pairing target and generation. The next write uses v2. The encrypted slot remains
`identity.v1.sealed` with the same Keystore alias. Revocation compares Runner id, Deployment id,
enrollment id and Runner key, so a stale answer cannot wipe a replacement enrollment or key.

The identity regression uses the real Android Keystore and production identity slot.
Select this check for identity-storage regressions on a dedicated **unpaired** emulator; it refuses an
existing identity, creates test identities and deletes them when finished:

```sh
apps/agent-phone/gradlew -p apps/agent-phone assembleDebug assembleDebugAndroidTest
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5570 install -r apps/agent-phone/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5570 shell am instrument -w -r com.opensteer.agentphone.test/com.opensteer.agentphone.runner.IdentityStoreInstrumentation
```

For manual acceptance or a release check, save the output beside its journey artifacts. Every case must report `passed: true` with
`INSTRUMENTATION_CODE: -1`. The checks cover v1→v2 migration, encrypted-file and key deletion,
same-lineage rename/retarget/generation changes, replacement identities and concurrent pairing.

## Live display emulator acceptance

Build the native display instrumentation, then run the selected API on a dedicated emulator:

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" apps/agent-phone/gradlew -p apps/agent-phone \
  :app:assembleDebug :fixture:assembleDebug :app:assembleDebugAndroidTest \
  -PopensteerInstrumentation=com.opensteer.agentphone.display.DisplayInstrumentation
python3 apps/agent-phone/scripts/test-display.py --api 36 --artifacts /absolute/path/to/evidence
```

Use `--api 30` or `--api 33` for those platform boundaries; run selected APIs
sequentially. The `--artifacts` directory is also the runner's working output,
not an additional handoff requirement for every change.

The runner requires `ffmpeg` and `ffprobe`, boots only the named AVD on `emulator-5580`, refuses an occupied
port, uses 4 GiB RAM, read-only disks and `-no-snapshot-save`, and shuts it down in `finally`.
It disables animations and allows 60 seconds for first-boot work to settle before timing. The
static-start case enforces 1000 ms from the projection request to the first keyframe callback.
Other lifecycle cases use a five-second acquisition bound and record their latency, including
recovery after SIGKILL. Every subprocess has a deadline. It never selects a physical device or stops the ADB server.
Artifacts include app-op readback, static-start milliseconds, refresh IDR and frame count,
landscape geometry, wake/protection generations, active-projection process death and fresh
restart, H.264 access units, independently decoded secure-window pixel metrics, logs and
`SHA256SUMS` and installed APK hashes. A loopback WebSocket peer checks the production
runtime's data path, delayed-ack recovery, owner tap/text/submit, stale observations on release,
agent drag/drop receipts, protection lift, power states, one encoder recovery followed by
failure, and socket failure isolation. The runner enables accessibility after instrumentation
starts, because Android stops the previous process when attaching instrumentation.
These are emulator measurements using the software AVC encoder; they establish neither OEM
hardware behavior nor Host/viewer integration.

The Host/device display journey also verifies independent owner/task authority, real lease expiry,
decoded fixture and protected pixels, recovery and viewer fairness. Its display fixture omits the
password field Android automatically redacts during screen sharing; the original fixture retains
the password-input journeys. All device commands use the selected emulator's explicit serial.

To include the production Expo tile and full-view components on both native platforms, first build
the matching Expo Android debug APK and iOS simulator app, then run:

```sh
OPENSTEER_AGENT_PHONE_API=36 \
OPENSTEER_AGENT_PHONE_EXPO=1 \
OPENSTEER_EXPO_IOS_SIMULATOR=<iPhone-simulator-UDID> \
OPENSTEER_EXPO_IOS_APP=/absolute/path/to/Opensteer.app \
OPENSTEER_EXPO_ANDROID_APK=/absolute/path/to/app-debug.apk \
OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR=/absolute/path/to/evidence \
pnpm test:agent-phone -- apps/host/src/agent-phone/agent-phone-display.device.test.ts
```

This uses a separate Metro test entry, real Host authentication and the shared display transport.
It saves decoded viewer screenshots, bundles and lifecycle events. A second Android emulator is
needed to keep the viewer separate from the producing phone; the harness shuts down devices it
boots. The Expo scenario reserves loopback ports 18766 and 18767.

## Self-update emulator journey

For the network self-update flow, use a dedicated emulator and explicit serial:

```sh
ANDROID_SERIAL=emulator-5592 OPENSTEER_AGENT_PHONE_API=36 \
OPENSTEER_AGENT_PHONE_SELF_UPDATE=1 \
OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR=/absolute/path/to/update-evidence \
pnpm test:agent-phone apps/host/src/agent-phone/agent-phone-update.device.test.ts
```

Select API 30 or 33 when that platform boundary needs checking. API 30 records
and taps only the emulator's system Update prompt.
The cutover starts with a real protocol-3, proof-format-2, identity-v1 APK built from baseline
commit `8bfad329`, with a lower versionCode and the same generated test signer as the new APK.
After enrollment, switching to the new Host must refuse it as `agent-phone-outdated`, then the
phone updates over the authenticated network channel without a USB reinstall. The journey checks
preserved identity, pairing and existing access, no new connection for a previously declined
phone, a v2 identity after write/restart and no phone approval prompt.

The test builds an isolated `updateTest` variant with a generated test key and test CA;
that variant is nondebuggable and has a test-only signer pin. Production release/debug
variants always embed the permanent release pin and never trust the test CA as a system root.
The test supplies its verified release bytes directly to the Host's injected release port;
production obtains them only from its startup-verified distribution. Neither this journey nor
its fixture builds overwrite product APKs or use the permanent release key. `result.json`,
Host logs, screenshots and `SHA256SUMS` record identity, installer/app-op readback, unsafe-release
refusals, consent status and the live connection after replacement.
