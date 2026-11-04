# Opensteer Agent Phone

The Kotlin Android app that turns a dedicated phone's display into an integrations-only Runner.
[Agent Phone](../../docs/agent-phone.md) holds its authority, privacy and Android constraints; the
[agent-phone skill](../../.agents/skills/agent-phone/SKILL.md) holds prerequisites, builds and
tests. `fixture` is a test app that records Android effects for device tests, which wire tests
cannot prove.

Release builds trust only system CAs, and cleartext is loopback-only in every build. Debug builds
also trust user CAs; the E2E build adds an explicit test CA, and the `updateTest` variant uses a
generated signer and must never use the permanent key. Never ship test trust or replace the
permanent release signer with a test key. See [app/build.gradle.kts](app/build.gradle.kts) and
[Distribution](../../docs/agent-phone.md#distribution).
