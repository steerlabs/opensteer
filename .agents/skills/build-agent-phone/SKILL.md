---
name: build-agent-phone
description: Build Agent Phone APKs or verify Android build prerequisites for development, test TLS or release artifact production.
---

# Build Agent Phone

Run from the repo root with its Node/pnpm pins, JDK 17+, SDK platform 37 and build tools
36.0.0. Set `ANDROID_HOME` if the SDK is not at `~/Library/Android/sdk`.

```sh
pnpm build:agent-phone
apps/agent-phone/gradlew -p apps/agent-phone :app:lint :app:testDebugUnitTest :app:assembleDebug :fixture:assembleDebug
```

The debug build writes APK/manifest pairs to `apps/web/public/agent-phone/` and
`apps/desktop/generated-resources/agent-phone/`. Use `--output /absolute/directory` to write
only there. Gradle originals remain under each module's `build/outputs/apk/`.
Normal pnpm builds do not invoke Gradle.

For TLS device tests:

```sh
pnpm build:agent-phone --e2e-ca /absolute/path/to/test-ca.pem
```

This writes the test APK, manifest and fixture only to `apps/agent-phone/build/e2e/`.
Never combine test CA and release. Release artifact production follows [Releases](../../../docs/releases.md);
use `pnpm build:agent-phone --release --output /absolute/directory` with the permanent key
via `OPENSTEER_AGENT_PHONE_KEYSTORE`, `OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD`,
`OPENSTEER_AGENT_PHONE_KEY_ALIAS` and `OPENSTEER_AGENT_PHONE_KEY_PASSWORD`.
Never substitute debug signing; a different signer requires destructive uninstall.

Stop Gradle daemons started for this work with `apps/agent-phone/gradlew -p apps/agent-phone --stop`.
Stop any additional server/capture process by its recorded PID (`kill <pid>`), any emulator
you booted with `adb -s <serial> emu kill`, and an ADB server you started with `adb kill-server`.
Do not stop another owner's processes; clean up after failures too.
