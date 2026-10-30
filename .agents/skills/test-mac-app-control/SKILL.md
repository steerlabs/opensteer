---
name: test-mac-app-control
description: Use when changing Mac app observation, background input, owner viewing or the helper wire contract.
---

# Test Mac app control

Run from the repository root. Select the cheapest checks that cover the change:

```sh
swift test --package-path apps/desktop/native/computer-use --filter ComputerUseCoreTests
pnpm exec vitest run apps/host/src/computer-use/computer-repl/computer-repl.test.ts
pnpm exec vitest run packages/protocol/src/computer-use-helper-wire.test.ts tests/computer-use-action-schema.test.ts
pnpm --filter @opensteer/web test:computer-windows
```

Keep core tests entirely fake; never drive host windows, focus or input. For real
AppKit/Electron owner input and decoded H.264, run the existing journey in the VM:

```sh
pnpm test:vm -- bash native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh
```

Use `OPENSTEER_MAC_OWNER_VIEW_ONLY_JOURNEY=1` for baseline passive checks or
`OPENSTEER_MAC_OWNER_ENGINES=appkit` for one engine, passed into the VM command.
Use the ChromeBackgroundJourney fixture README for background-key cases. Extend
the existing flow rather than duplicate journeys. Treat skipped/partial cases as
unproven. Stop every process you start, including on failure.

Regenerate the wire fixture only for an intentional contract change, then inspect
its diff:

```sh
(cd apps/desktop && OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --package-path native/computer-use --filter HelperWireFixtureTests)
```

For shipping-path changes, qualify real titled AppKit/Chromium windows through the
signed helper and renderer. Check first-run TCC, localized Services and an app
that hangs. Native fixture success does not prove Host/Runner routing or signed
responsible-process attribution. Arrange explicit manual qualification for real
Contacts/EventKit stores and Apple-account Messages behavior; never use personal
stores as unattended test fixtures. Use the repository testing and release
references for VM infrastructure and release procedures.
