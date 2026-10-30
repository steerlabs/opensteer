---
name: verify-passwords-broker
description: Use when building or testing the native Passwords broker, import worker or Swift/TypeScript wire fixtures.
---

# verify-passwords-broker

From the repo root, build the development broker or run focused pure-logic Swift tests:

```sh
pnpm --filter @opensteer/desktop build:passwords-broker
swift test --package-path apps/desktop/native/passwords --skip "SecureEnclaveTests|SnapshotTests"
```

Add `--filter <class>` for the affected contract. Software keys and scripted authentication must never prompt. Run AppKit `SnapshotTests` only through the disposable VM workflow in `docs/testing.md`. SecureEnclaveTests requires real hardware and does not qualify in a VM; do not count a skip as a pass. Use `apps/desktop/SIGNING.md` for a signed release build when validating protected keychain behavior.

Regenerate shared wire fixtures only for intentional contract changes:

```sh
OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --package-path apps/desktop/native/passwords --filter WireFixtureTests
pnpm exec vitest run packages/protocol/src/passwords-broker-wire.test.ts
```

Inspect the diff in `apps/desktop/native/passwords/Tests/Fixtures/passwords-wire.json`; keep legacy entries readable. Socket evidence defaults to `$TMPDIR/opensteer-passwords-broker-swift-e2e.json`; override with `OPENSTEER_PASSWORDS_BROKER_ARTIFACT`. Window artifacts use `OPENSTEER_PASSWORDS_UI_ARTIFACTS`. Retain only for requested acceptance. Read `apps/desktop/native/passwords/README.md` for secret handling, and use the saved-login journey for end-to-end acceptance.
