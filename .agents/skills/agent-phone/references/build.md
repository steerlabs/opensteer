# Build Agent Phone

Needs the repo's Node and pnpm, JDK 17+, Android SDK platform 37 and build tools 36.0.0
(`ANDROID_HOME`, default `~/Library/Android/sdk`). Normal pnpm builds never invoke Gradle.

```sh
pnpm build:agent-phone
apps/agent-phone/gradlew -p apps/agent-phone :app:lint :app:testDebugUnitTest :app:assembleDebug :fixture:assembleDebug
pnpm build:agent-phone --e2e-ca /absolute/path/to/test-ca.pem
```

The debug build writes `opensteer-agent-phone.apk` and `agent-phone.json` to
`apps/web/public/agent-phone/` and `apps/desktop/generated-resources/agent-phone/`, or only to
`--output /absolute/directory`; Gradle originals stay under each module's `build/outputs/apk/`.
`--e2e-ca` builds the TLS test app, manifest and fixture only into `apps/agent-phone/build/e2e/`.

Never combine a test CA with a release, ship test trust, or replace the permanent signer with a
debug or test key: a different signer forces a destructive uninstall. The `updateTest` variant's
generated signer must never overwrite product APKs. Stop Gradle daemons you started with
`apps/agent-phone/gradlew -p apps/agent-phone --stop`.
