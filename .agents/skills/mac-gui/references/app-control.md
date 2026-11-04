# Mac app control

Select the cheapest checks that cover the change; core tests stay entirely fake. Fakes prove
ordering and refusal, not real focus, key order, native pixels or signed responsible-process
attribution.

```sh
swift test --package-path apps/desktop/native/computer-use --filter ComputerUseCoreTests
pnpm exec vitest run apps/host/src/computer-use/computer-repl/computer-repl.test.ts packages/protocol/src/computer-use-helper-wire.test.ts tests/computer-use-action-schema.test.ts
pnpm --filter @opensteer/web test:computer-windows
```

Regenerate the helper wire fixture only for an intentional contract change, then review its diff:

```sh
(cd apps/desktop && OPENSTEER_WRITE_WIRE_FIXTURE=1 swift test --package-path native/computer-use --filter HelperWireFixtureTests)
```

## VM journeys

Extend these rather than adding journeys.

```sh
pnpm test:vm -- bash native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh
pnpm test:vm -- --mobile bash -c 'OPENSTEER_RUN_CHROME_BACKGROUND_JOURNEYS=1 OPENSTEER_CHROME_JOURNEY=sweep bash native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/run-vm.sh'
```

**Owner input** covers real AppKit and Electron owner input and decoded H.264. Pass
`OPENSTEER_MAC_OWNER_VIEW_ONLY_JOURNEY=1` for baseline passive checks or
`OPENSTEER_MAC_OWNER_ENGINES=appkit` for one engine into the VM command.

**Chrome background**
([cases](../../../../apps/desktop/native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/README.md)):
`sweep` verifies official stable Chrome, then runs R0 first (`OPENSTEER_CHROME_R0_REPEAT` times),
stopping on any R0 regression or invalid setup. `R0` to `R4` select one case (R2 and R3 run R0
first; R4 runs alone); `all` matches `sweep`; `acceptance` runs R0, R2 and R3.
`OPENSTEER_CHROME_FORCE_AX=1` is a diagnostic precondition, recorded separately. Evidence is under
the run's `guest/chrome-background/`; rows are `pass`, `accepted-limitation`, `regression` or
`invalid`, and exit 1 means a regression or invalid row. Inspect every row and the runner log.

**Window groups**: the registered `windows` journey runs `current`, `settle`, `cancellation`,
`video` and `receipt-switch`. `members` and `focus` (with N6) run only when selected through
`OPENSTEER_WINDOW_GROUP_CASES` on
[test-computer-use-window-groups.sh](../../../../apps/desktop/scripts/test-computer-use-window-groups.sh).
Evidence and `seconds.txt` go under `$OPENSTEER_JOURNEY_OUT`. AX recovery, Stop and deadline gates
and Tab receipts run with host fakes in `FoldedWindowReviewTests`.

## Shipping-path qualification

Qualify real titled AppKit and Chromium windows through the signed helper and renderer, first-run
TCC, localized Services and an app that hangs. Native fixture success does not prove Host and Runner
routing. Minimum-macOS association behavior, native Expo decoding and suppression, real Contacts and
EventKit stores, and Apple account and Messages behavior (including the iMessage channel) need
explicit manual qualification.
