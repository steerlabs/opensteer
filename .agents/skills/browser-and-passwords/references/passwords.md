# Passwords

A saved secret must reach only its intended field and appear nowhere in observations, logs or
artifacts.

## Broker and import worker

```sh
pnpm --filter @opensteer/desktop build:passwords-broker
swift test --package-path apps/desktop/native/passwords --skip "SecureEnclaveTests|SnapshotTests"
```

Add `--filter <class>` for the affected contract. Software keys and scripted authentication must
never prompt. AppKit `SnapshotTests` run only in the VM; `SecureEnclaveTests` need real hardware.
Development tests cannot establish signed release keychain behavior (an unsigned store returns
`errSecMissingEntitlement`).

The failure inventory is the test code in `Tests/PasswordsCoreTests` and
`Tests/PasswordsBrokerTests`. Keep coverage of rollback and checkpoint ordering, credential-byte
preservation, peer verification, current consent and revision checks, cancellation after waits,
secret-free output, import isolation and cross-version scope; `PasswordsAnywhereTests` covers
protocol 4 and 5 consent.

Regenerate the wire fixture only for an intentional contract change, then review
`apps/desktop/native/passwords/Tests/Fixtures/passwords-wire.json` and keep legacy entries readable:

```sh
OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --package-path apps/desktop/native/passwords --filter WireFixtureTests
pnpm exec vitest run packages/protocol/src/passwords-broker-wire.test.ts
```

Socket evidence defaults to `$TMPDIR/opensteer-passwords-broker-swift-e2e.json`
(`OPENSTEER_PASSWORDS_BROKER_ARTIFACT` overrides); window artifacts use
`OPENSTEER_PASSWORDS_UI_ARTIFACTS`.

## Saved logins

```sh
pnpm exec vitest run apps/host/src/browser/password-sign-in-service.test.ts apps/desktop/src/passwords/login-authority.test.ts packages/protocol/src/login-envelope.test.ts apps/desktop/src/passwords/login-envelope.test.ts
pnpm test:integration apps/host/src/browser/browser-sign-in-tool.integration.test.ts apps/host/src/browser/browser-source-service.integration.test.ts
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh saved-password
pnpm test:vm -- pnpm test:electron-passwords
```

The VM journey needs a zero-match leak scan over observations, logs and artifacts. For a real phone
receiver, run `agent-phone-passwords.device.test.ts` through the
[agent-phone skill](../../agent-phone/references/testing.md); receiver unit tests do not prove a
device completed sign-in.
