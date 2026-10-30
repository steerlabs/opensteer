---
name: test-iphone-apps
description: Verify Opensteer iPhone app integrations with Swift wire checks and owned native fixtures.
---

# Test iPhone apps

Use the [cheapest relevant regression checks](../../../docs/testing.md#how-to-test). The Swift
cores and the Swift↔TypeScript wire vectors are pure logic and run on the host;
CI selects them when these packages change:

```sh
pnpm exec tsx scripts/generate-apple-data-contracts.ts
swift test --package-path packages/apple-data
swift test --package-path apps/mobile/modules/iphone-apps/ios
swift build --package-path apps/mobile/modules/iphone-apps/ios --product IphoneAppsVectors
OPENSTEER_IPHONE_APPS_NATIVE_TESTS=1 pnpm exec vitest run tests/iphone-apps-wire.test.ts tests/helper-data-contracts.test.ts
```

The wire test executes the production Swift core and checks its signatures and
frames against the Host's TypeScript implementation. None of these prove real
Calendar, Contacts or Reminders grants; those need the simulator journey or a
manual acceptance check.

The non-simulator journey starts a real Host and a disposable PostgreSQL cluster from the VM payload, then bridges Host WebSocket frames to `IphoneAppsNativeJourney`, which links production Swift proofs, wire and dispatch with explicitly fake Calendar, Location and Photos OS ports. Location and Photos run their production providers behind those ports. Run it from a clean revision with `pnpm test:vm -- --mobile --revision <SHA> bash -c 'set -e; cd ../..; export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; bash apps/mobile/modules/iphone-apps/journey/run-in-vm.sh'`. Its `native-journey-result.json` records the Host frames, signed approvals, fake save count, Location acquisition counters and selected Photos metadata. It explicitly lists real CoreLocation, PhotoKit and consent dialogs as unverified. The wrapper stops PostgreSQL and removes its data directory on every exit. This checks the native core against the Host; the iOS URLSession adapter and real Apple stores need the simulator journey. A simulator pregrant can validate data operations but cannot prove a consent dialog. Retain logs, outcome rows and screenshots only for manual acceptance or release acceptance; label an unavailable simulator or OS dialog **unverified**, never passed. The physical signed Release install and consent journey belong to the reserved phone owner.

In an owned mobile VM, `apps/mobile/modules/iphone-apps/fixture/run.sh <simulator-udid> seed iphone-apps-fixture-<unique-id>` creates one synthetic event, reminder and two contacts. Run it again with `snapshot` and the same marker to inspect the system stores independently of Opensteer. The script requires `OPENSTEER_IPHONE_APPS_EVIDENCE_DIR` outside the checkout for its build and result files; retain them only for manual acceptance or release checks. The script builds a separate Release fixture, writes its result there, and terminates the fixture app before returning. A missing writable calendar or reminder source is a prerequisite failure recorded in the result.
