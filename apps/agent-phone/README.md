# Opensteer Agent Phone

Kotlin Android app exposing a dedicated phone's display as an integrations-only Runner.
[Agent Phone](../../docs/agent-phone.md) owns authority, privacy, compatibility and Android
traps. The fixture app records Android effects for device tests; wire tests alone cannot.

## Build and verify

Use [build-agent-phone](../../.agents/skills/build-agent-phone/SKILL.md) for SDK prerequisites,
builds and output paths; use [test-agent-phone](../../.agents/skills/test-agent-phone/SKILL.md)
for focused verification. Build configuration lives in [app/build.gradle.kts](app/build.gradle.kts)
and [libs.versions.toml](gradle/libs.versions.toml).

## Release signing and test TLS

Release builds trust system CAs only. Debug builds additionally trust user CAs; the E2E
variant adds its explicit test CA. Cleartext is loopback-only. Never ship test trust or
replace the permanent release signer with a test key. See [network configurations](app/src)
and the [distribution contract](../../docs/agent-phone.md#10-distribution).

## Wire fixtures and device receipts

Use the [test skill](../../.agents/skills/test-agent-phone/SKILL.md) for intentional fixture
regeneration and Keystore/receipt instrumentation. Identity-v1 migration preserves the
Runner key and pairing, discards the approval seed and writes v2 into the same encrypted
slot/Keystore alias. Revocation must compare identity lineage so a stale answer cannot wipe
a replacement. See [runner](app/src/main/kotlin/com/opensteer/agentphone/runner).

## Live display emulator acceptance

Use the [test skill](../../.agents/skills/test-agent-phone/SKILL.md). The native runner uses
the software AVC encoder; it proves neither OEM hardware behavior nor Host/viewer integration.
Instrumentation stops the previous process, so enable accessibility after attaching it.

## Self-update emulator journey

Use the [test skill](../../.agents/skills/test-agent-phone/SKILL.md). Its isolated updateTest
variant uses a generated signer/test CA and injected verified release bytes; it must never
overwrite product APKs or use the permanent release key. Production variants retain the
permanent pin. The journey must preserve identity, pairing, existing access and declines.
